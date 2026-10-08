import { open, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Fault, requireValue } from './fault.js';

// One standalone admin process may own this storage. A crash leaves an inert record;
// reclaim only when its PID no longer exists. No hardware action on recovery.
export async function acquireOwnership(storagePath) {
  const file = path.join(storagePath, 'deconz-keypad-admin', 'owner.json');
  const nonce = randomUUID(); let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw new Fault('ownership_unavailable');
      const reader = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let meta, value;
      try {
        meta = await reader.stat(); requireValue(meta.isFile() && meta.size <= 256 && meta.nlink === 1 && meta.uid === process.getuid?.() && !(meta.mode & 0o077), 'ownership_requires_review');
        value = JSON.parse(await reader.readFile('utf8'));
      } finally { await reader.close(); }
      requireValue(Number.isInteger(value.pid) && value.pid > 0, 'ownership_requires_review');
      let alive = true; try { process.kill(value.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      requireValue(!alive, 'admin_already_running');
      // Serialize stale reclamation, so two restarting instances cannot both
      // unlink a new owner's record after observing the same dead PID.
      const reclaim = await open(file + '.reclaim', constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { const current = await lstat(file); requireValue(current.ino === meta.ino && current.dev === meta.dev, 'ownership_changed'); await unlink(file); }
      finally { await reclaim.close(); await unlink(file + '.reclaim'); }
    }
  }
  requireValue(handle, 'ownership_unavailable');
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); await handle.sync(); }
  catch { await handle.close(); throw new Fault('ownership_unavailable'); }
  const meta = await handle.stat(); await handle.close(); let released = false;
  return async () => {
    if (released) return; released = true;
    try { const current = await lstat(file); if (current.ino === meta.ino && current.dev === meta.dev) await unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  };
}

