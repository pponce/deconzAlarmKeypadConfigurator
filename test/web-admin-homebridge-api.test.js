import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebHomebridgeApiHost } from '../src/web-admin-homebridge-api.js';
import { WebHomebridgeMaintenance } from '../src/web-admin-homebridge-maintenance.js';
import { WebAdminTransactions } from '../src/web-admin-transactions.js';

const identity = '0011223344556677', bridge = 'AA:BB:CC:DD:EE:FF', uid = '1'.repeat(32);
const binding = { gateway: 'test', identity, user: uid, alarms: [1, 2] };
async function fixture(t, clearLogs = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'official-pin-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'deconz-keypad-admin'), { mode: 0o700 });
  const plugin = path.join(root, 'plugin'); await mkdir(plugin);
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: 'homebridge-deconz', version: '99.0.0', bin: { ui: 'ui.js' } }));
  await writeFile(path.join(plugin, 'ui.js'), '// synthetic discovery command');
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ platforms: [{ platform: 'config', port: 8581 }, { platform: 'deCONZ', _bridge: { username: bridge } }] }), { mode: 0o600 });
  let state = { schema: 1, bindings: [], lease: null }, record = null;
  const events = [], journals = [], pins = { 'alarm-1': '1111', 'alarm-2': '2222' };
  const control = { losePut: false, rejectPut: false, failClear: false, failSnapshot: false, wrongGateway: false, wrongMapping: false };
  const status = { pid: 8123, status: 'ok', manuallyStopped: false };
  const client = { bridge, async login() {}, close() {}, async status() { return { ...status }; },
    async waitFor(check) { assert.equal(await check(status), true); return { ...status }; },
    async command() { throw Error('New API updates must not send service commands'); },
    async clearLogs() { assert.equal(record.stage, 'complete'); events.push('clear logs'); if (control.failClear) throw Error('synthetic secret must not escape'); return { cleared: true }; },
  };
  const host = new WebHomebridgeApiHost({ storagePath: root, registrations: [{ id: 'test', identity }], pluginRoot: () => plugin,
    stamp: async pid => String(pid), clientFactory: () => client,
    runDiscovery: async (node, args, options) => {
      assert.deepEqual(args.slice(1), ['-U', bridge, '-G', identity, 'discover']);
      assert.equal(options.env.HOMEBRIDGE_DIR, root);
      return { stdout: JSON.stringify([{ username: bridge, gid: control.wrongGateway ? 'FFFFFFFFFFFFFFFF' : identity, uiPort: 12345, childBridge: true }]) };
    },
    exchange: async request => {
      const url = new URL(request.url); assert.equal(url.origin, 'http://127.0.0.1:12345');
      const route = url.pathname.replace('/gateways/' + identity, '');
      const inventory = Object.fromEntries(Object.keys(pins).map((id, i) => [id, { type: 'alarmsystems', resources: ['/alarmsystems/' + (control.wrongMapping ? 9 : i + 1)] }]));
      if (route === '/accessories') return [200, inventory];
      const id = route.split('/')[2]; assert.ok(id in pins);
      if (request.method === 'PUT') {
        assert.equal(record.verified, true); assert.equal(state.lease.stage, 'api_write_requested');
        const secret = JSON.parse(await readFile(path.join(root, 'deconz-keypad-admin', 'web-homebridge-api-update.json')));
        assert.ok(secret.requested.includes(id)); assert.equal(route, '/accessories/' + id + '/settings');
        assert.deepEqual(Object.keys(request.body), ['pin']); events.push('put ' + id);
        if (control.rejectPut) throw Error('request outcome unknown');
        pins[id] = request.body.pin;
        if (control.losePut) throw Error('reply lost');
        return [200, { pin: pins[id] }];
      }
      return [200, { id, ...inventory[id], settings: { pin: pins[id] } }];
    },
  });
  host.verifyGateway = async () => { events.push('gateway check'); };
  const snapshot = host.snapshotApi.bind(host);
  host.snapshotApi = async (...args) => { if (control.failSnapshot) throw Error('storage unavailable'); return snapshot(...args); };
  const store = { read: async () => structuredClone(state), write: async value => { state = structuredClone(value); journals.push(structuredClone(value)); } };
  const integration = new WebHomebridgeMaintenance({ store, registrations: [{ id: 'test', identity }], host });
  const transactions = new WebAdminTransactions({ store: { read: async () => structuredClone(record), write: async value => { record = structuredClone(value); journals.push(structuredClone(value)); } }, participants: new Map([['homebridge', integration]]) });
  const input = { context: { gateway: 'test', identity, alarm: 1, operation: 'rotate_pin', identity_id: uid, homebridge_selection: { previous: null, binding } },
    snapshot: {}, intent: { kind: 'identity', sensitive: true, expected: {} }, validateAgain: async () => true,
    write: async () => { events.push('gateway write'); return {}; }, verify: async () => input.intent };
  const credentials = () => ({ username: 'Owner', password: 'synthetic-password' });
  const run = () => integration.withRequest({ pin: '2468', confirmed: true, credentials: credentials(), clearLogs }, () => transactions.execute(input));
  const recover = async () => {
    await integration.authorizeRecovery(record, credentials());
    const review = await transactions.review('test', identity, async () => true); assert.equal(review.ready, true);
    const result = await transactions.recover('test', identity, { transaction_id: review.transaction_id, token: review.token, reviewed: true }, async () => true);
    await integration.afterTransaction({ ...result, saved: record.write_attempted && !record.definite_rejection });
    await host.clearAuthentication();
  };
  return { host, root, client, control, input, run, recover, integration, transactions, events, pins, journals, state: () => state, record: () => record, store };
}

test('official discovery and PIN API update both alarms without any cache file, source hashes, library version or service restart', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.host.readiness(), { configured: true, error: null });
  assert.equal((await f.run()).saved, true); assert.deepEqual(f.pins, { 'alarm-1': '2468', 'alarm-2': '2468' });
  assert.equal(f.record().stage, 'complete'); assert.equal(f.state().lease.stage, 'complete');
  assert.deepEqual(f.state().bindings, [binding]); assert.equal(f.events.includes('clear logs'), false);
  assert.equal(f.events.filter(x => x === 'gateway write').length, 1);
  assert.equal(JSON.stringify(f.journals).includes('2468'), false); assert.equal(JSON.stringify(f.journals).includes('synthetic-password'), false);
  await assert.rejects(readFile(path.join(f.root, 'accessories', 'cachedAccessories.AABBCCDDEEFF')), /ENOENT/);
});
test('opted-in log clearing runs once after full success; clearing failure never leaves the PIN update pending', async t => {
  for (const fail of [false, true]) {
    const f = await fixture(t, true); f.control.failClear = fail; await f.run();
    assert.equal(f.record().stage, 'complete'); assert.equal((await f.integration.status()).pending, false);
    assert.equal(await f.integration.logStatus(f.record().id), fail ? 'failed' : 'cleared');
    await f.integration.afterTransaction({ transaction_id: f.record().id, saved: true });
    assert.equal(f.events.filter(x => x === 'clear logs').length, 1);
  }
});
test('lost API replies are resolved from live readback without repeating either PIN write', async t => {
  const f = await fixture(t); f.control.losePut = true; await f.run();
  assert.equal(f.events.filter(x => x.startsWith('put ')).length, 2); assert.equal(f.record().stage, 'complete');
});
test('uncertain API writes remain held and cannot silently repeat during recovery', async t => {
  const f = await fixture(t, true); f.control.rejectPut = true;
  await assert.rejects(f.run(), /transaction_recovery_required/);
  await f.host.authenticate({ username: 'Owner', password: 'synthetic-password' });
  const review = await f.transactions.review('test', identity, async () => true);
  assert.equal(review.ready, false); assert.equal(f.events.filter(x => x.startsWith('put ')).length, 1);
  assert.equal(f.events.includes('clear logs'), false);
});
test('failure before any PIN write can be cancelled with no restart, log deletion or backup requirement', async t => {
  const f = await fixture(t, true); f.control.failSnapshot = true;
  await assert.rejects(f.run(), /transaction_recovery_required/); assert.equal(f.record().write_attempted, false);
  await f.recover(); assert.equal(f.record().stage, 'complete'); assert.equal(f.events.includes('clear logs'), false);
  assert.equal(f.events.some(x => x.startsWith('put ') || x === 'gateway write'), false);
  assert.equal(await f.integration.logStatus(f.record().id), 'skipped');
});
test('late completion failure recovers without replaying writes and retains log opt-in across reload', async t => {
  const f = await fixture(t, true); const complete = f.integration.complete.bind(f.integration); let fail = true;
  f.integration.complete = async tx => { if (fail) { fail = false; throw Error('synthetic failure'); } return complete(tx); };
  await assert.rejects(f.run(), /transaction_recovery_required/); assert.equal(f.events.includes('clear logs'), false);
  await f.recover(); assert.equal(f.events.filter(x => x.startsWith('put ')).length, 2);
  assert.equal(f.events.filter(x => x === 'gateway write').length, 1); assert.equal(f.events.filter(x => x === 'clear logs').length, 1);
});
test('wrong gateway or alarm mapping prevents gateway and Homebridge writes', async t => {
  for (const key of ['wrongGateway', 'wrongMapping']) {
    const f = await fixture(t); f.control[key] = true;
    await assert.rejects(f.run(), /maintenance_preflight_failed/);
    assert.equal(f.events.includes('gateway write'), false); assert.equal(f.events.some(x => x.startsWith('put ')), false);
  }
});
