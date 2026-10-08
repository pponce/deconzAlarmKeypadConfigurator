import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebAdminAuth, WebAdminError, initialWebAccounts, validateWebAccounts } from '../src/web-admin-auth.js';
import { createWebAdminHandler, createWebAdminServer } from '../src/web-admin-server.js';

const password = 'synthetic-admin-password';
async function fixture() {
  let record = await initialWebAccounts('Owner', password), now = 0, uncertain = false;
  const store = {
    read: async () => structuredClone(record),
    write: async ({ expectedRevision, record: next }) => {
      if (record.revision !== expectedRevision) throw new WebAdminError('web_account_changed');
      record = structuredClone(next);
      if (uncertain) throw Error('synthetic private write detail');
    },
  };
  const auth = new WebAdminAuth({ store, clock: () => now });
  const token = await auth.login('owner', password);
  const add = (name = 'Guest') => auth.manageAccount(token, {
    action: 'save', expected_revision: record.revision, current_password: password,
    id: null, username: name, role: 'regular', enabled: true,
    password: 'synthetic-guest-password', repeat_password: 'synthetic-guest-password',
  });
  return { auth, token, add, record: () => structuredClone(record), advance: seconds => { now += seconds; },
    external: fn => { fn(record); record.revision++; }, uncertain: () => { uncertain = true; } };
}

test('named-account validation retains required administrator and rejects duplicate names', async () => {
  const f = await fixture(); const value = f.record();
  value.accounts[0].role = 'regular'; assert.throws(() => validateWebAccounts(value), /last_admin_required/);
  const duplicate = f.record(); duplicate.accounts.push({ ...duplicate.accounts[0], id: 'f'.repeat(32), username: 'owner' });
  assert.throws(() => validateWebAccounts(duplicate), /username_in_use/);
});
test('regular accounts cannot create accounts; unrelated changes keep administrator signed in', async () => {
  const f = await fixture(); assert.equal((await f.add()).sign_in_required, false);
  const token = await f.auth.login('GUEST', 'synthetic-guest-password');
  const listing = await f.auth.accounts(token); assert.equal(listing.accounts, undefined);
  await assert.rejects(f.auth.manageAccount(token, {}), /forbidden/);
  assert.equal((await f.auth.session(f.token)).username, 'Owner');
  assert.equal(JSON.stringify(await f.auth.accounts(f.token)).includes('password_hash'), false);
});
test('changed or disabled accounts lose their sessions; unchanged accounts keep theirs', async () => {
  const f = await fixture(); await f.add(); const guest = await f.auth.login('Guest', 'synthetic-guest-password');
  f.external(record => { record.accounts.find(row => row.username === 'Guest').enabled = false; });
  await assert.rejects(f.auth.session(guest), /login_required/);
  assert.equal((await f.auth.session(f.token)).role, 'admin');
});
test('current password, revision checks and final administrator protection apply', async () => {
  const f = await fixture(), id = f.record().accounts[0].id;
  await assert.rejects(f.auth.manageAccount(f.token, { action: 'delete', id, expected_revision: 0, current_password: password }), /web_account_changed/);
  await assert.rejects(f.auth.manageAccount(f.token, { action: 'delete', id, expected_revision: 1, current_password: 'wrong' }), /current_password_incorrect/);
  await assert.rejects(f.auth.manageAccount(f.token, { action: 'delete', id, expected_revision: 1, current_password: password }), /web_account_invalid|last_admin_required/);
  assert.equal(f.record().accounts.length, 1);
});
test('password change invalidates the affected login and does not store plaintext', async () => {
  const f = await fixture(); const next = 'synthetic-new-password';
  assert.deepEqual(await f.auth.changePassword(f.token, { current_password: password, new_password: next, repeat_password: next }), { changed: true, sign_in_required: true });
  await assert.rejects(f.auth.session(f.token), /login_required/);
  await assert.rejects(f.auth.login('Owner', password), /login_failed/);
  assert.ok(await f.auth.login('Owner', next));
  assert.equal(JSON.stringify(f.record()).includes(next), false);
});
test('idle expiry, absolute expiry, rate limiting and shutdown match the reference limits', async () => {
  const f = await fixture(); f.advance(1800); await assert.rejects(f.auth.session(f.token), /login_required/);
  const g = await fixture();
  for (let i = 0; i < 16; i++) { g.advance(1700); await g.auth.session(g.token); }
  g.advance(1700); await assert.rejects(g.auth.session(g.token), /login_required/);
  const h = await fixture();
  for (let i = 0; i < 5; i++) await assert.rejects(h.auth.login('unknown', 'wrong'), /login_failed/);
  await assert.rejects(h.auth.login('Owner', password), /login_rate_limited/);
  h.advance(61); assert.ok(await h.auth.login('Owner', password));
  await h.auth.close(); await assert.rejects(h.auth.session(h.token), /login_required/);
});
test('uncertain writes invalidate sessions instead of retaining old authorization', async () => {
  const f = await fixture(); f.uncertain(); await assert.rejects(f.add());
  await assert.rejects(f.auth.session(f.token), /login_required/);
});
test('an in-flight authorized operation completes before account disablement, and subsequent work is denied', async () => {
  const f = await fixture(); await f.add();
  const guest = await f.auth.login('Guest', 'synthetic-guest-password'), guestRow = f.record().accounts.find(row => row.username === 'Guest');
  let release, started;
  const began = new Promise(resolve => { started = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const events = [];
  const operation = f.auth.authorized(guest, async principal => { assert.equal(principal.role, 'regular'); events.push('started'); started(); await hold; events.push('finished'); });
  await began;
  const disable = f.auth.manageAccount(f.token, {
    action: 'save', expected_revision: f.record().revision, current_password: password,
    id: guestRow.id, username: guestRow.username, role: 'regular', enabled: false, password: '', repeat_password: '',
  }).then(() => { events.push('disabled'); });
  const queued = f.auth.authorized(guest, () => { throw Error('disabled account reached the backend'); });
  release(); await Promise.all([operation, disable]);
  await assert.rejects(queued, /login_required/);
  assert.deepEqual(events, ['started', 'finished', 'disabled']);
});

async function transport(t, auth, options = {}) {
  const handler = createWebAdminHandler({ origin: 'https://admin.example.test', auth, ...options,
    assets: new Map([['/', { type: 'text/html', content: '<!doctype html><title>Synthetic login</title>' }]]) });
  const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (path, { method = 'GET', body, rawBody, headers = {} } = {}) => {
    const raw = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
        headers: { Host: 'admin.example.test', ...(raw ? { Origin: 'https://admin.example.test', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {}), ...headers },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: new Headers(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])), text: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', reject);
      });
      request.on('error', reject); request.end(raw);
    });
  };
}
test('transport enforces Host, Origin, CSRF, secure cookies and explicit unavailable operations', async t => {
  const f = await fixture(), request = await transport(t, f.auth);
  assert.equal((await request('/', { headers: { Host: 'evil.example' } })).status, 400);
  assert.equal((await request('/api/session')).status, 401);
  const login = await request('/api/login', { method: 'POST', body: { username: 'Owner', password } });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict; Path=\//);
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = JSON.parse(login.text).csrf;
  assert.equal((await request('/api/session', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await request('/api/logout', { method: 'POST', body: {}, headers: { Cookie: cookie } })).text, '{"error":"csrf_rejected"}');
  assert.equal((await request('/api/logout', { method: 'POST', body: {}, headers: { Cookie: cookie, Origin: 'https://evil.example', 'X-CSRF-Token': csrf } })).status, 400);
  const unsupported = await request('/api/users/save', { method: 'POST', body: {}, headers: { Cookie: cookie, 'X-CSRF-Token': csrf } });
  assert.equal(unsupported.status, 503); assert.equal(JSON.parse(unsupported.text).error, 'operation_not_implemented');
  const logout = await request('/api/logout', { method: 'POST', body: {}, headers: { Cookie: cookie, 'X-CSRF-Token': csrf } });
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/api/session', { headers: { Cookie: cookie } })).status, 401);
});
test('unexpected failures are sanitized and listeners require explicit TLS configuration', async t => {
  const request = await transport(t, { session: async () => { throw Error('private token/path'); } });
  const result = await request('/api/session'); assert.equal(result.status, 503); assert.equal(result.text.includes('private token'), false);
  assert.throws(() => createWebAdminServer({ origin: 'https://admin.example.test' }), /tls_configuration_required/);
});
test('browser transport dispatches only authenticated scoped requests and rejects duplicate JSON keys before the backend', async t => {
  const f = await fixture(), calls = [];
  const request = await transport(t, f.auth, { backend: { dispatch: async (principal, operation, body) => {
    calls.push({ principal, operation, body }); return { ok: true };
  } } });
  const login = await request('/api/login', { method: 'POST', body: { username: 'Owner', password } });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': JSON.parse(login.text).csrf,
    'X-Configurator-Gateway': 'test', 'X-Configurator-Alarm': '2' };
  assert.equal((await request('/api/administration', { headers })).status, 200);
  assert.equal(calls[0].principal.role, 'admin');
  assert.equal(calls[0].operation, 'gateway_request');
  assert.deepEqual(calls[0].body, { gateway: 'test', alarm: 2, operation: 'administration', body: {} });
  for (const rawBody of ['{"reset":true,"reset":false}', '{"reset":true,"res\\u0065t":false}']) {
    const result = await request('/api/lockout/reset', { method: 'POST', headers, rawBody });
    assert.equal(result.status, 400); assert.equal(JSON.parse(result.text).error, 'body_rejected');
  }
  assert.equal(calls.length, 1);
  f.external(record => { record.accounts[0].salt = 'f'.repeat(32); });
  assert.equal((await request('/api/administration', { headers })).status, 401);
  assert.equal(calls.length, 1);
});
