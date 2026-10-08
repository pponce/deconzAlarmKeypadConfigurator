// Private storage owned by the standalone administration process. No constructor
// creates directories, starts services, reads another plugin, or contacts devices.
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { WebAdminError } from './web-admin-auth.js';
import { requireWeb, object, parseWebJson } from './web-admin-common.js';

export function webDigest(value) {
  // Python's sort_keys/ensure_ascii/compact encoding, for policy revisions.
  const quote = value => JSON.stringify(value).replace(/[\u0080-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  function encode(item, depth = 0) {
    requireWeb(depth <= 64, 'invalid_journal_payload');
    if (item === null) return 'null';
    if (typeof item === 'string') return quote(item);
    if (typeof item === 'boolean') return String(item);
    if (typeof item === 'number') { requireWeb(Number.isSafeInteger(item), 'invalid_journal_payload'); return String(item); }
    if (Array.isArray(item)) return '[' + item.map(row => encode(row, depth + 1)).join(',') + ']';
    requireWeb(object(item) && [Object.prototype, null].includes(Object.getPrototypeOf(item)), 'invalid_journal_payload');
    return '{' + Object.keys(item).sort().map(key => quote(key) + ':' + encode(item[key], depth + 1)).join(',') + '}';
  }
  return createHash('sha256').update(encode(value)).digest('hex');
}

export const webPrivateFile = (info, limit) => info.isFile() && info.nlink === 1 && !(info.mode & 0o077) && info.size <= limit && (!process.getuid || info.uid === process.getuid());
export async function webPrivateDirectory(directory) {
  const info = await lstat(directory);
  requireWeb(info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o077) && (!process.getuid || info.uid === process.getuid()), 'web_private_storage_invalid');
  return directory;
}
export async function webReadPrivate(file, limit = 4 * 1024 * 1024) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    requireWeb(webPrivateFile(await handle.stat(), limit), 'web_private_storage_invalid');
    const data = await handle.readFile(); requireWeb(data.length <= limit, 'web_private_storage_invalid'); return data;
  } finally { await handle?.close(); }
}
export async function webWritePrivate(directory, name, value, limit = 4 * 1024 * 1024) {
  requireWeb(/^[a-z][a-z0-9-]*\.json$/.test(name), 'web_private_storage_invalid');
  const raw = Buffer.from(JSON.stringify(value) + '\n'); requireWeb(raw.length <= limit, 'web_private_storage_too_large');
  let file, temp, folder;
  try {
    await webPrivateDirectory(directory);
    const target = path.join(directory, name);
    try { requireWeb(webPrivateFile(await lstat(target), limit), 'web_private_storage_invalid'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    temp = path.join(directory, '.' + name + '-' + randomBytes(12).toString('hex'));
    file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(raw); await file.sync(); await file.close(); file = null;
    await rename(temp, target); temp = null;
    folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); await folder.sync();
  } catch { throw new WebAdminError('web_private_storage_write_failed'); }
  finally { await file?.close(); await folder?.close(); if (temp) await unlink(temp).catch(() => {}); }
}
export class WebAdminFiles {
  constructor(storagePath) { this.storagePath = storagePath; }
  async directory() { return webPrivateDirectory(path.join(await realpath(this.storagePath), 'deconz-keypad-admin')); }
  async read(name, validate, limit) {
    try {
      requireWeb(/^web-[a-z0-9-]+\.json$/.test(name), 'web_private_storage_invalid');
      const directory = await this.directory(); let raw;
      try { raw = await webReadPrivate(path.join(directory, name), limit); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      const value = parseWebJson(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      requireWeb(validate(value), 'web_private_storage_invalid'); return value;
    } catch { throw new WebAdminError('web_private_storage_invalid'); }
  }
  async write(name, value, validate, limit) {
    const copy = structuredClone(value); requireWeb(/^web-[a-z0-9-]+\.json$/.test(name) && validate(copy), 'web_private_storage_invalid');
    return webWritePrivate(await this.directory(), name, copy, limit);
  }
}
