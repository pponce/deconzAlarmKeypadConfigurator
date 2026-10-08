import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFile, stat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { webBrowserFixture } from '../scripts/web-admin-browser-fixture.mjs';
import { startStandalone } from '../src/standalone.js';
import { StandaloneConfig, verifyRegistration, validateStandaloneConfig, defaultServer } from '../src/standalone-config.js';
import { WebAdminBackend } from '../src/web-admin-backend.js';
import { WebHomebridgeHost } from '../src/web-admin-homebridge-host.js';

async function fixture(t) {
  const f = await webBrowserFixture(); t.after(() => f.close());
  await f.enable({ homebridge: false });
  let cookie, csrf;
  async function request(route, body, { scoped = true, origin = f.origin } = {}) {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = https.request(f.origin + route, { rejectUnauthorized: false, method: bytes ? 'POST' : 'GET', headers: {
        ...(bytes ? { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
        ...(cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
        ...(scoped ? { 'X-Configurator-Gateway': 'deconz', 'X-Configurator-Alarm': '1' } : {}),
      } }, res => {
        let raw = ''; res.on('data', chunk => raw += chunk); res.on('end', () => {
          const value = JSON.parse(raw); if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
          if (value.csrf) csrf = value.csrf; resolve({ status: res.statusCode, value });
        });
      }); req.on('error', reject); req.end(bytes);
    });
  }
  const login = await request('/api/login', { username: 'Owner', password: f.password }); assert.equal(login.status, 200);
  return { ...f, request, login: () => request('/api/login', { username: 'Owner', password: f.password }) };
}

test('standalone HTTPS login, administration, direct keypad and duplicate suppression need no Homebridge', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.writes, []);
  const setup = (await f.request('/api/setup')).value;
  assert.equal(setup.deployment.label, 'Standalone Node.js admin'); assert.equal(setup.homebridge.configured, false);
  assert.equal(JSON.stringify(setup).includes('synthetic_key'), false);
  const view = await f.request('/api/administration'); assert.equal(view.status, 200); assert.ok(view.value.identities.length > 0);
  assert.equal((await f.request('/api/keypad')).value.available, true);
  const body = { code: '1234', mode: 'disarm', request_id: 'd'.repeat(32) };
  assert.equal((await f.request('/api/keypad/send', body)).value.result, 'accepted');
  assert.equal((await f.request('/api/keypad/send', body)).value.result, 'duplicate');
  assert.deepEqual(f.writes, [['PUT', '/alarmsystems/1/disarm']]);
  assert.equal((await f.request('/api/controller', undefined, { scoped: false })).value.error, 'route_not_found');
  assert.equal((await f.request('/api/keypad/send', { ...body, request_id: 'e'.repeat(32) }, { origin: 'https://other.invalid' })).value.error, 'origin_rejected');
  const data = path.join(f.storagePath, 'deconz-keypad-admin');
  assert.equal((await stat(path.join(data, 'web-standalone.json'))).mode & 0o777, 0o600);
  assert.equal((await readFile(path.join(data, 'web-accounts.json'), 'utf8')).includes(f.password), false);
  assert.equal((await readFile(path.join(data, 'web-transaction-deconz.json'), 'utf8')).includes('1234'), false);
  await f.restart(); await f.login();
  assert.equal((await f.request('/api/keypad/send', body)).value.result, 'duplicate'); assert.equal(f.writes.length, 1);
});

test('one process owns the data; denied second startup does not stop the first', async t => {
  const f = await fixture(t);
  await assert.rejects(startStandalone({ storagePath: f.storagePath }), /admin_already_running/);
  assert.equal((await f.request('/api/administration')).status, 200); assert.deepEqual(f.writes, []);
});

test('verified connection edits keep keys private, hold gateway actions, and activate only after restart', async t => {
  const f = await fixture(t), before = (await f.request('/api/settings')).value;
  const gateway = { ...before.gateways[0], name: 'Updated gateway', key: '' };
  const saved = await f.request('/api/setup/gateway', { revision: before.revision, gateway });
  assert.equal(saved.status, 200); assert.equal(saved.value.restart_required, true);
  assert.equal(JSON.stringify(saved.value).includes('synthetic_key'), false);
  assert.equal((await f.request('/api/keypad/send', { code: '1234', mode: 'disarm', request_id: 'f'.repeat(32) })).value.error, 'standalone_restart_required');
  assert.equal((await f.request('/api/settings')).value.restart_required, true);
  assert.deepEqual(f.writes, []);
  await f.restart(); await f.login();
  assert.equal((await f.request('/api/settings')).value.restart_required, false);
  assert.equal((await f.request('/api/gateways')).value.gateways[0].name, 'Updated gateway');
});

test('observation mode and regular accounts cannot change server connections', async () => {
  let calls = 0;
  const backend = new WebAdminBackend({ accessMode: 'observe', setup: { gateway: () => calls++ } });
  await assert.rejects(backend.dispatch({ role: 'admin' }, 'setup_gateway', {}), /forbidden/);
  backend.accessMode = 'manage';
  await assert.rejects(backend.dispatch({ role: 'regular' }, 'setup_gateway', {}), /forbidden/); assert.equal(calls, 0);
});

test('gateway setup only reads config; identity changes and malformed endpoints cannot be saved', async () => {
  const entry = { id: 'deconz', name: 'Test', key: 'synthetic_key', endpoint: 'http://127.0.0.1:12345', identity: '' }, calls = [];
  const options = { gatewayFactory: row => ({ request: async route => { calls.push(route); return { bridgeid: '00:11:22:33:44:55:66:77' }; } }) };
  const row = await verifyRegistration(entry, options); assert.equal(row.identity, '0011223344556677'); assert.deepEqual(calls, ['/config']);
  await assert.rejects(verifyRegistration({ ...row, identity: 'FFFFFFFFFFFFFFFF' }, options), /gateway_identity_changed/);
  await assert.rejects(verifyRegistration({ ...entry, endpoint: 'http://admin:password@localhost' }, options), /gateway_endpoint_invalid/);
  assert.equal(calls.length, 2);
  assert.throws(() => validateStandaloneConfig({ schema: 1, revision: 1, server: { ...defaultServer(), origin: 'http://localhost:9443' }, gateways: [row], homebridge: null }), /web_origin_invalid/);
});

test('optional Homebridge reads its own storage while private backups remain in standalone storage', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'standalone-homebridge-')); t.after(() => rm(root, { recursive: true, force: true }));
  const admin = path.join(root, 'admin'), hb = path.join(root, 'homebridge');
  await mkdir(admin); await mkdir(path.join(admin, 'deconz-keypad-admin'), { mode: 0o700 }); await mkdir(hb);
  await writeFile(path.join(hb, 'config.json'), JSON.stringify({ platforms: [{ platform: 'deCONZ', _bridge: { username: 'AA:BB:CC:DD:EE:FF' } }, { platform: 'config', port: 8581 }] }), { mode: 0o600 });
  const host = new WebHomebridgeHost({ storagePath: admin, homebridgeStoragePath: hb, registrations: [] });
  const config = await host.configuration();
  assert.equal(config.cache, path.join(hb, 'accessories/cachedAccessories.AABBCCDDEEFF'));
  assert.equal(await host.files.directory(), path.join(admin, 'deconz-keypad-admin'));
});
