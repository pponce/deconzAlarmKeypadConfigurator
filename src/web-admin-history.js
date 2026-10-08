// Bounded, gateway-identity-bound history and an independent non-expiring
// virtual-keypad request ledger. Uses Node's documented SQLite API when enabled.
import { constants } from 'node:fs';
import { open, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { WebAdminError } from './web-admin-auth.js';
import { WebAdminFiles, webPrivateFile } from './web-admin-files.js';
import { requireWeb, exact, integer } from './web-admin-common.js';

const truncate = (value, limit) => [...value].slice(0, limit).join('');
const historySchema = `
  CREATE TABLE activity (seq INTEGER PRIMARY KEY, event_key TEXT UNIQUE, time TEXT, user TEXT, source TEXT, action TEXT, result TEXT);
  CREATE TABLE lockout_request_groups (seq INTEGER PRIMARY KEY, episode TEXT, count INTEGER, last_stamp TEXT);
  CREATE TABLE lockout_pending (episode TEXT PRIMARY KEY, deadline INTEGER, source TEXT, unavailable INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE lockout_receipts (event_key TEXT PRIMARY KEY, episode TEXT, stamp TEXT);
  CREATE TABLE history_meta (key TEXT PRIMARY KEY, value TEXT);
`;
const ledgerSchema = 'CREATE TABLE requests(gateway TEXT, identity TEXT, alarm INTEGER, id TEXT, created INTEGER, PRIMARY KEY(gateway,identity,alarm,id));';
const appId = 0x47445741, maxBytes = 512 * 1024 * 1024;
export class WebAdminHistory {
  constructor(storagePath, registrations, { clock = Date.now } = {}) {
    this.files = new WebAdminFiles(storagePath); this.registrations = registrations; this.clock = clock;
    this.pending = Promise.resolve(); this.last = null;
  }
  serial(operation) { const result = this.pending.then(operation); this.pending = result.catch(() => {}); return result; }
  scope(gateway, alarm) { requireWeb(typeof gateway === 'string' && this.registrations.has(gateway) && /^[a-z][a-z0-9-]{0,31}$/.test(gateway) && integer(alarm, 1, 255), 'invalid_history_scope'); }
  name(gateway, alarm) { this.scope(gateway, alarm); return 'web-activity-' + gateway + '-alarm-' + alarm + '.sqlite'; }
  async database(name, schema, action) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    requireWeb(major === 22 && minor >= 13 || major >= 24, 'web_admin_node_update_required');
    let db, file, created = false;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const root = await this.files.directory(), filename = path.join(root, name);
      try { file = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); created = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; file = await open(filename, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      const info = await file.stat(); requireWeb(webPrivateFile(info, maxBytes) && (created || info.size > 0), 'history_path_invalid');
      // SQLite opens sidecars itself. Reject pre-existing unsafe journal/WAL/SHM
      // paths before opening, even though this backend uses DELETE journaling.
      for (const suffix of ['-journal', '-wal', '-shm']) {
        try { requireWeb(webPrivateFile(await lstat(filename + suffix), maxBytes), 'history_path_invalid'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      db = new DatabaseSync(filename);
      const current = await lstat(filename); requireWeb(current.dev === info.dev && current.ino === info.ino && webPrivateFile(current, maxBytes), 'history_path_invalid');
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      if (created) {
        db.exec('PRAGMA journal_mode=DELETE; PRAGMA max_page_count=131072; BEGIN IMMEDIATE;');
        try { db.exec(schema + '; PRAGMA application_id=' + appId + '; PRAGMA user_version=1; COMMIT;'); } catch (error) { db.exec('ROLLBACK'); throw error; }
        const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
      } else requireWeb(db.prepare('PRAGMA application_id').get().application_id === appId && db.prepare('PRAGMA user_version').get().user_version === 1, 'history_database_invalid');
      requireWeb(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type IN ('trigger','view')").get().n === 0, 'history_database_invalid');
      db.exec('BEGIN IMMEDIATE');
      try { const result = action(db); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
    } catch (error) { if (error instanceof WebAdminError) throw error; throw new WebAdminError('history_storage_unavailable'); }
    finally { db?.close(); await file?.close(); }
  }
  async days() { return (await this.files.read('web-activity-retention.json', row => exact(row, ['days']) && [1, 3, 7, 30, 90].includes(row.days)))?.days ?? 90; }
  run(gateway, alarm, action) {
    const name = this.name(gateway, alarm), identity = this.registrations.get(gateway).identity;
    return this.serial(async () => {
      const days = await this.days(), now = this.clock();
      return this.database(name, historySchema, db => {
        const row = db.prepare("SELECT value FROM history_meta WHERE key='gateway_identity'").get();
        requireWeb(!row || row.value === identity, 'history_gateway_identity_changed');
        if (!row) db.prepare("INSERT INTO history_meta VALUES('gateway_identity', ?)").run(identity);
        return action(db, { name, days, now });
      });
    });
  }
  prune(db, { days, now }) {
    db.prepare('DELETE FROM activity WHERE julianday(time) < julianday(?)').run(new Date(now - days * 86400000).toISOString());
    db.prepare('DELETE FROM lockout_pending WHERE deadline < ?').run(now - days * 86400000);
    db.exec('DELETE FROM activity WHERE seq NOT IN (SELECT seq FROM activity ORDER BY seq DESC LIMIT 5000); DELETE FROM lockout_request_groups WHERE seq NOT IN (SELECT seq FROM activity);');
  }
  cleared(db) { return db.prepare("SELECT value FROM history_meta WHERE key='cleared_before'").get()?.value ?? '1970-01-01T00:00:00Z'; }
  afterClear(db, stamp) { return db.prepare('SELECT julianday(?) > julianday(?) AS later').get(stamp, this.cleared(db)).later === 1; }
  insert(db, state, user, source, action, result, key = null, stamp = new Date(state.now).toISOString()) {
    requireWeb([user, source, action, result, stamp].every(value => typeof value === 'string') && Number.isFinite(Date.parse(stamp)) && (key === null || typeof key === 'string' && key.length <= 512), 'history_event_invalid');
    if (!this.afterClear(db, stamp)) return;
    const row = db.prepare('INSERT OR IGNORE INTO activity(event_key,time,user,source,action,result) VALUES(?,?,?,?,?,?)').run(key, stamp, truncate(user, 64), truncate(source, 32), truncate(action, 64), truncate(result, 160));
    if (row.changes) this.last = { name: state.name, seq: Number(row.lastInsertRowid) };
    return row;
  }
  add(gateway, alarm, user, source, action, result, key = null, stamp) { return this.run(gateway, alarm, (db, state) => { this.insert(db, state, user, source, action, result, key, stamp); this.prune(db, state); }); }
  rows(gateway, alarm, limit = 100) {
    requireWeb(integer(limit, 1, 5000), 'invalid_history_filter');
    return this.run(gateway, alarm, (db, state) => { this.prune(db, state); return db.prepare('SELECT seq,time,user,source,action,result FROM activity ORDER BY seq DESC LIMIT ?').all(limit).map(row => ({ ...row })); });
  }
  clear(gateway, alarm) { return this.run(gateway, alarm, (db, state) => {
    db.exec('DELETE FROM activity; DELETE FROM lockout_pending; DELETE FROM lockout_request_groups;'); this.last = null;
    db.prepare("INSERT OR REPLACE INTO history_meta VALUES('cleared_before', ?)").run(new Date(state.now).toISOString());
  }); }
  expire(gateway, alarm) { return this.run(gateway, alarm, (db, state) => this.prune(db, state)); }
  async scopes() {
    const root = await this.files.directory(), rows = [];
    for (const name of (await readdir(root)).sort()) {
      const match = /^web-activity-([a-z][a-z0-9-]{0,31})-alarm-([1-9][0-9]{0,2})\.sqlite$/.exec(name);
      if (!match || !this.registrations.has(match[1]) || !integer(Number(match[2]), 1, 255)) continue;
      requireWeb(webPrivateFile(await lstat(path.join(root, name)), maxBytes), 'history_path_invalid'); rows.push({ gateway: match[1], alarm: Number(match[2]) });
    }
    return rows;
  }
  setDays(body) { return this.serial(async () => {
    requireWeb(exact(body, ['days', 'expected_days', 'confirmed']) && [1, 3, 7, 30].includes(body.days) && Number.isSafeInteger(body.expected_days) && typeof body.confirmed === 'boolean', 'invalid_history_retention');
    const current = await this.days(); requireWeb(body.expected_days === current, 'history_retention_changed_reload');
    requireWeb(body.days >= current || body.confirmed, 'history_confirmation_required');
    await this.files.write('web-activity-retention.json', { days: body.days }, row => exact(row, ['days']) && [1, 3, 7, 30].includes(row.days)); return { retention_days: body.days };
  }); }
  closeLockouts(gateway, alarm) { return this.run(gateway, alarm, db => db.exec('UPDATE lockout_pending SET finished=1')); }
  dueLockouts(gateway, alarm) { return this.run(gateway, alarm, (db, state) => { this.prune(db, state); return db.prepare('SELECT episode,deadline,source FROM lockout_pending WHERE finished=0 AND deadline <= ?').all(state.now).map(row => ({ ...row })); }); }
  lockoutVerification(gateway, alarm, episode, expired) { return this.run(gateway, alarm, (db, state) => {
    const row = db.prepare('SELECT source,unavailable FROM lockout_pending WHERE episode=? AND finished=0').get(episode); if (!row || !expired && row.unavailable) return;
    this.insert(db, state, 'System', row.source, expired ? 'Lockout expired' : 'Lockout status unavailable', expired ? 'Recorded deadline passed; fresh deCONZ status confirms this lockout is no longer active' : 'Recorded deadline passed; unable to confirm this lockout ended. Status checks will continue', episode + (expired ? ':expired' : ':unavailable'));
    db.prepare(expired ? 'UPDATE lockout_pending SET finished=1 WHERE episode=?' : 'UPDATE lockout_pending SET unavailable=1 WHERE episode=?').run(episode); this.prune(db, state);
  }); }
  lockoutEvent(gateway, alarm, event) { return this.run(gateway, alarm, (db, state) => {
    requireWeb(typeof event.key === 'string' && event.key.length <= 512 && typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp)) && integer(event.locked_until, 1, 4102444800000) && integer(event.remaining_seconds, 0, 604800) && integer(event.level, 0, 3), 'history_event_invalid');
    if (!this.afterClear(db, event.timestamp)) return;
    const episode = 'lockout:' + (event.sensor ?? 'unknown') + ':' + event.locked_until;
    const inserted = db.prepare('INSERT OR IGNORE INTO lockout_receipts VALUES(?,?,?)').run(event.key, episode, event.timestamp); if (!inserted.changes) return;
    const count = db.prepare('SELECT count(*) AS n FROM lockout_receipts WHERE episode=? AND julianday(stamp)>julianday(?)').get(episode, this.cleared(db)).n;
    const minutes = Math.floor(event.remaining_seconds / 60), seconds = event.remaining_seconds % 60, duration = minutes ? minutes + 'm ' + seconds + 's' : seconds + 's';
    const expiry = new Date(event.locked_until).toISOString().replace(/\.\d{3}Z$/, '+00:00'), source = event.keypad_label ?? 'Keypad';
    this.insert(db, state, 'Unknown', source, 'Lockout detected', 'Level ' + event.level + ' of 3; ' + duration + ' remaining when first observed; expires ' + expiry + '.', episode, event.timestamp);
    db.prepare('INSERT OR IGNORE INTO lockout_pending(episode,deadline,source) VALUES(?,?,?)').run(episode, event.locked_until, truncate(source, 32));
    if (count > 1) {
      const latest = db.prepare('SELECT g.seq,g.count,g.last_stamp FROM lockout_request_groups g JOIN activity a ON a.seq=g.seq WHERE g.episode=? ORDER BY g.seq DESC LIMIT 1').get(episode);
      const extend = latest && this.last?.name === state.name && this.last.seq === latest.seq && Date.parse(event.timestamp) >= Date.parse(latest.last_stamp);
      const requests = extend ? latest.count + 1 : 1, detail = requests + ' keypad request(s) blocked; last request ' + event.timestamp + '. Not a PIN-attempt count.';
      if (extend) { db.prepare('UPDATE activity SET result=? WHERE seq=?').run(truncate(detail, 160), latest.seq); db.prepare('UPDATE lockout_request_groups SET count=?,last_stamp=? WHERE seq=?').run(requests, event.timestamp, latest.seq); }
      else {
        this.insert(db, state, 'Unknown', source, 'Requests blocked during lockout', detail, episode + ':requests:' + event.key, event.timestamp);
        db.prepare('INSERT INTO lockout_request_groups VALUES(?,?,?,?)').run(this.last.seq, episode, 1, event.timestamp);
      }
      this.last = { name: state.name, seq: extend ? latest.seq : this.last.seq };
    }
    db.prepare('DELETE FROM lockout_receipts WHERE julianday(stamp)<julianday(?)').run(new Date(state.now - 90 * 86400000).toISOString());
    db.exec('DELETE FROM lockout_receipts WHERE rowid NOT IN (SELECT rowid FROM lockout_receipts ORDER BY rowid DESC LIMIT 10000)'); this.prune(db, state);
  }); }
  reserveRequest(gateway, alarm, id) {
    this.scope(gateway, alarm); requireWeb(typeof id === 'string' && /^[0-9a-f]{32}$/.test(id), 'invalid_keypad_request');
    return this.serial(() => this.database('web-keypad-requests.sqlite', ledgerSchema, db => db.prepare('INSERT OR IGNORE INTO requests VALUES(?,?,?,?,?)').run(gateway, this.registrations.get(gateway).identity, alarm, id, this.clock()).changes === 1));
  }
}
