// Node port of the named-account/session contract in configurator/server.py.
// Store is injected; this module never starts a listener or contacts devices.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';

const derive = promisify(scrypt);
const accountFields = ['id', 'username', 'role', 'enabled', 'salt', 'password_hash'];
export class WebAdminError extends Error {}
const requireValue = (condition, code) => { if (!condition) throw new WebAdminError(code); };
const shape = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const usernameValid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const passwordLength = value => typeof value === 'string' ? [...value].length : -1;
const publicFields = row => Object.fromEntries(['id', 'username', 'role', 'enabled'].map(key => [key, row[key]]));
const sameAccount = (a, b) => !!a && !!b && accountFields.every(key => a[key] === b[key]);

export function validateWebAccounts(record) {
  requireValue(shape(record, ['schema', 'revision', 'accounts']) && record.schema === 2 &&
    Number.isSafeInteger(record.revision) && record.revision > 0 && Array.isArray(record.accounts) &&
    record.accounts.length > 0 && record.accounts.length <= 64, 'web_account_invalid');
  const ids = new Set(), names = new Set();
  for (const row of record.accounts) {
    requireValue(shape(row, accountFields) && typeof row.id === 'string' && /^[a-f0-9]{32}$/.test(row.id) &&
      !ids.has(row.id) && usernameValid(row.username) && ['admin', 'regular'].includes(row.role) &&
      typeof row.enabled === 'boolean' && typeof row.salt === 'string' && /^[a-f0-9]{32}$/.test(row.salt) &&
      typeof row.password_hash === 'string' && /^[a-f0-9]{128}$/.test(row.password_hash), 'web_account_invalid');
    requireValue(!names.has(row.username.toLowerCase()), 'username_in_use');
    ids.add(row.id); names.add(row.username.toLowerCase());
  }
  requireValue(record.accounts.some(row => row.enabled && row.role === 'admin'), 'last_admin_required');
  return record;
}

async function verifier(password) {
  requireValue(passwordLength(password) >= 8 && passwordLength(password) <= 256, 'password_length_invalid');
  const salt = randomBytes(16).toString('hex');
  const digest = await derive(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return { salt, password_hash: digest.toString('hex') };
}

// Trusted local setup only. Never expose this as anonymous account creation.
export async function initialWebAccounts(username, password) {
  requireValue(usernameValid(username), 'username_invalid');
  return validateWebAccounts({ schema: 2, revision: 1, accounts: [{
    id: randomBytes(16).toString('hex'), username, role: 'admin', enabled: true, ...await verifier(password),
  }] });
}

export class WebAdminAuth {
  constructor({ store, clock = () => performance.now() / 1000 }) {
    this.store = store; this.clock = clock; this.record = null;
    this.sessions = new Map(); this.attempts = []; this.pending = Promise.resolve();
  }
  serial(fn) {
    const result = this.pending.then(fn);
    this.pending = result.catch(() => {});
    return result;
  }
  async refresh() {
    const next = validateWebAccounts(await this.store.read());
    const old = this.record;
    // Compare complete accounts even if a faulty store reuses a revision.
    for (const [token, session] of this.sessions) {
      const before = old?.accounts.find(row => row.id === session.account_id);
      const after = next.accounts.find(row => row.id === session.account_id);
      if (!sameAccount(before, after) || !after.enabled) this.sessions.delete(token);
      else session.revision = next.revision;
    }
    this.record = structuredClone(next);
  }
  limit() {
    const now = this.clock(); this.attempts = this.attempts.filter(at => now - at < 60);
    requireValue(this.attempts.length < 6, 'login_rate_limited'); this.attempts.push(now);
  }
  async verify(password, account, code = 'login_failed') {
    requireValue(passwordLength(password) >= 0 && passwordLength(password) <= 256, code);
    const digest = await derive(password, Buffer.from(account.salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    requireValue(timingSafeEqual(digest, Buffer.from(account.password_hash, 'hex')), code);
  }
  active(token) {
    const session = this.sessions.get(token), now = this.clock();
    if (!session || now >= session.expires || now >= session.idle) {
      this.sessions.delete(token); throw new WebAdminError('login_required');
    }
    session.idle = now + 1800;
    return session;
  }
  public(session) {
    return { csrf: session.csrf, account_id: session.account_id, username: session.username,
      role: session.role, username_required: false };
  }
  login(username, password) {
    return this.serial(async () => {
      await this.refresh(); this.limit();
      const account = typeof username === 'string' && this.record.accounts.find(row => row.username.toLowerCase() === username.toLowerCase());
      // Unknown users incur the same KDF without revealing account existence.
      await this.verify(password, account || this.record.accounts[0]);
      requireValue(account && account.enabled, 'login_failed');
      const now = this.clock();
      for (const [token, session] of this.sessions) if (now >= session.expires || now >= session.idle) this.sessions.delete(token);
      requireValue(this.sessions.size < 12, 'session_limit');
      const token = randomBytes(32).toString('base64url');
      this.sessions.set(token, { csrf: randomBytes(32).toString('base64url'), expires: now + 8 * 3600,
        idle: now + 1800, account_id: account.id, username: account.username, role: account.role, revision: this.record.revision });
      return token;
    });
  }
  session(token) {
    return this.serial(async () => { await this.refresh(); return { ...this.active(token) }; });
  }
  authorized(token, operation) {
    // Keep account disablement/role changes serialized with the authorized
    // operation, matching the old broker's account + operation lock boundary.
    return this.serial(async () => { await this.refresh(); return operation({ ...this.active(token) }); });
  }
  logout(token) { return this.serial(() => { this.sessions.delete(token); }); }
  accounts(token) {
    return this.serial(async () => {
      await this.refresh(); const session = this.active(token);
      return { revision: this.record.revision, account: this.public(session),
        ...(session.role === 'admin' ? { accounts: this.record.accounts.map(publicFields) } : {}) };
    });
  }
  async write(accounts) {
    const next = validateWebAccounts({ schema: 2, revision: this.record.revision + 1, accounts });
    try {
      await this.store.write({ expectedRevision: this.record.revision, record: next });
      await this.refresh();
    } catch (error) {
      // An uncertain durable write cannot leave old sessions authorized.
      this.sessions.clear(); throw error;
    }
  }
  changePassword(token, body) {
    return this.serial(async () => {
      requireValue(shape(body, ['current_password', 'new_password', 'repeat_password']), 'body_rejected');
      await this.refresh(); const session = this.active(token); this.limit();
      const accounts = structuredClone(this.record.accounts), account = accounts.find(row => row.id === session.account_id);
      await this.verify(body.current_password, account, 'current_password_incorrect');
      requireValue(body.new_password === body.repeat_password, 'passwords_do_not_match');
      requireValue(body.new_password !== body.current_password, 'password_unchanged');
      Object.assign(account, await verifier(body.new_password));
      await this.write(accounts);
      return { changed: true, sign_in_required: true };
    });
  }
  manageAccount(token, body) {
    return this.serial(async () => {
      await this.refresh(); const session = this.active(token);
      requireValue(session.role === 'admin', 'forbidden');
      const common = ['action', 'expected_revision', 'current_password', 'id'];
      requireValue(body?.action === 'delete' ? shape(body, common) : body?.action === 'save' &&
        shape(body, [...common, 'username', 'role', 'enabled', 'password', 'repeat_password']), 'body_rejected');
      requireValue(body.expected_revision === this.record.revision, 'web_account_changed');
      this.limit();
      await this.verify(body.current_password, this.record.accounts.find(row => row.id === session.account_id), 'current_password_incorrect');
      const accounts = structuredClone(this.record.accounts), found = accounts.find(row => row.id === body.id);
      requireValue(body.id === null || (typeof body.id === 'string' && !!found), 'account_not_found');
      if (body.action === 'delete') {
        requireValue(!!found, 'account_not_found'); accounts.splice(accounts.indexOf(found), 1);
      } else {
        requireValue(usernameValid(body.username), 'username_invalid');
        requireValue(['admin', 'regular'].includes(body.role) && typeof body.enabled === 'boolean', 'body_rejected');
        requireValue(typeof body.password === 'string' && body.password === body.repeat_password, 'passwords_do_not_match');
        const account = found || { id: randomBytes(16).toString('hex') };
        if (!found || body.password) Object.assign(account, await verifier(body.password));
        Object.assign(account, { username: body.username, role: body.role, enabled: body.enabled });
        if (!found) accounts.push(account);
      }
      await this.write(accounts);
      return { changed: true, sign_in_required: !this.sessions.has(token) };
    });
  }
  close() { return this.serial(() => { this.sessions.clear(); }); }
}
