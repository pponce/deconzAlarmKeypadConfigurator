// Policy snapshots in Homebridge-owned storage. These do not contain gateway
// credentials or claim to be credential backups. Never restore automatically.
import { lstat, mkdir, readdir, rmdir, unlink, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { WebAdminFiles, webPrivateDirectory, webReadPrivate, webWritePrivate } from './web-admin-files.js';
import { webJournalWithoutSecrets } from './web-admin-transactions.js';
import { requireWeb, object, integer, parseWebJson } from './web-admin-common.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const namePattern = /^web-policy-[0-9a-f]{32}$/;
const parse = bytes => parseWebJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
export class WebAdminPolicyBackup {
  api_version = 1;
  credential_backup = false;
  constructor(storagePath, { clock = Date.now, cleanupNotice = () => {} } = {}) { this.files = new WebAdminFiles(storagePath); this.clock = clock; this.cleanupNotice = cleanupNotice; }
  async directory() {
    const directory = path.join(await this.files.directory(), 'web-admin-backups');
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return webPrivateDirectory(directory);
  }
  async save(context, snapshot) {
    requireWeb(typeof context.identity === 'string' && /^[0-9A-F]{16}$/.test(context.identity), 'backup_scope_invalid');
    webJournalWithoutSecrets(snapshot);
    const root = await this.directory(), name = 'web-policy-' + randomBytes(16).toString('hex'), folder = path.join(root, name);
    await mkdir(folder, { mode: 0o700 });
    const policy = { schema: 1, gateway_identity: context.identity, policy: structuredClone(snapshot) };
    await webWritePrivate(folder, 'policy.json', policy, 16 * 1024 * 1024);
    const receipt = { schema: 1, kind: 'gateway-policy', credential_backup: false, snapshot: name,
      sha256: hash(await webReadPrivate(path.join(folder, 'policy.json'), 16 * 1024 * 1024)), automatic_restore: false, created_ms: this.clock() };
    requireWeb(integer(receipt.created_ms, 1, Number.MAX_SAFE_INTEGER), 'backup_date_invalid');
    await webWritePrivate(folder, 'receipt.json', receipt, 65536);
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
    try { await this.retain(root, context.identity, receipt); }
    catch { this.cleanupNotice('Automatic backup cleanup deferred; new snapshot retained.'); }
    return receipt;
  }
  async inspect(root, name, identity) {
    requireWeb(namePattern.test(name), 'backup_retention_name_invalid');
    const folder = path.join(root, name); await webPrivateDirectory(folder); const info = await lstat(folder);
    requireWeb((await readdir(folder)).sort().join(',') === 'policy.json,receipt.json', 'backup_retention_contents_changed');
    const raw = await webReadPrivate(path.join(folder, 'policy.json'), 16 * 1024 * 1024);
    const policy = parse(raw), receipt = parse(await webReadPrivate(path.join(folder, 'receipt.json'), 65536));
    requireWeb(receipt.schema === 1 && receipt.kind === 'gateway-policy' && receipt.snapshot === name && receipt.credential_backup === false && receipt.automatic_restore === false &&
      integer(receipt.created_ms, 1, Number.MAX_SAFE_INTEGER) && receipt.sha256 === hash(raw) && policy.schema === 1 && policy.gateway_identity === identity && object(policy.policy), 'backup_retention_scope_changed');
    return { name, receipt, dev: info.dev, ino: info.ino };
  }
  async retain(root, identity, latest) {
    const current = await this.inspect(root, latest.snapshot, identity); requireWeb(JSON.stringify(current.receipt) === JSON.stringify(latest), 'backup_retention_latest_changed');
    const others = [];
    for (const name of (await readdir(root)).sort()) {
      if (name === latest.snapshot || !namePattern.test(name)) continue;
      try { others.push(await this.inspect(root, name, identity)); } catch { /* Unknown/partial/marked/shared snapshots are retained. */ }
    }
    others.sort((a, b) => b.receipt.created_ms - a.receipt.created_ms || b.name.localeCompare(a.name));
    // Keep this operation's snapshot even if the wall clock went backwards.
    for (const item of others.slice(19)) {
      try {
        const fresh = await this.inspect(root, item.name, identity); requireWeb(JSON.stringify(fresh) === JSON.stringify(item), 'backup_retention_snapshot_changed');
        const folder = path.join(root, item.name);
        await unlink(path.join(folder, 'policy.json')); await unlink(path.join(folder, 'receipt.json'));
        const info = await lstat(folder); requireWeb(info.dev === item.dev && info.ino === item.ino, 'backup_retention_snapshot_changed');
        await rmdir(folder); // Never recursive; an unexpected extra file blocks deletion.
      } catch { this.cleanupNotice('Automatic backup cleanup incomplete; snapshot retained or partially retired.'); }
    }
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  status(registrations) { return registrations.map(row => ({ gateway: row.id, kind: 'gateway-policy', credential_backup: false })); }
}
