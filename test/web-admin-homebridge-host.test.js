import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebHomebridgeHost, homebridgeAlarmContext, editedHomebridgeCache, replaceHomebridgeCache } from '../src/web-admin-homebridge-host.js';

const identity = '0011223344556677', uid = '1'.repeat(32), bridge = 'AA:BB:CC:DD:EE:FF';
const SECURITY = '0000007E-0000-1000-8000-0026BB765291';
const binding = { gateway: 'test', identity, user: uid, alarms: [1] };
const mapping = { 1: 'alarm-1' }, grant = { enabled: true, grant_enabled: true, arm: true, disarm: true, api_arm_disarm: true, remaining_uses: null, schedule: null };
const cache = () => [
  { platform: 'deCONZ', context: { className: 'Gateway', id: identity, uiPort: 12345 } },
  { platform: 'deCONZ', services: [{ UUID: SECURITY }], context: { id: 'alarm-1', context: { gid: identity }, [SECURITY]: { pin: '1111', preserved: true } } },
  { platform: 'OtherPlugin', context: { pin: '2222', preserved: true } },
];
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'web-alarm-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'accessories'), { mode: 0o700 }); await mkdir(path.join(root, 'deconz-keypad-admin'), { mode: 0o700 });
  const target = path.join(root, 'accessories', 'cachedAccessories.AABBCCDDEEFF');
  await writeFile(target, JSON.stringify(cache()), { mode: 0o600 });
  const config = { platforms: [{ platform: 'config', port: 8581 }, { platform: 'deCONZ', _bridge: { username: bridge } }] };
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  const calls = []; let pid = 1234, stopped = false;
  const client = { bridge, close() {}, async login(credentials) { assert.equal(credentials.username, 'Owner'); },
    async status() { return { pid, manuallyStopped: stopped, status: stopped ? 'down' : 'ok', plugin: 'homebridge-deconz' }; },
    async waitFor(check) { const state = await this.status(); assert.equal(await check(state), true); return state; },
    async command(action) { calls.push(action); if (action === 'stop') stopped = true; else { stopped = false; pid = 5678; } } };
  const expected = { id: uid, name: 'Owner', enabled: true, revision: 2, user_revision: 2 };
  const host = new WebHomebridgeHost({ storagePath: root, registrations: [{ id: 'test', identity }], clientFactory: () => client,
    stamp: async id => stopped || id !== pid ? null : String(pid),
    exchange: async request => { assert.equal(request.method, 'GET'); return [200, { 'alarm-1': { type: 'alarmsystems', resources: ['/alarmsystems/1'] } }]; },
    gatewayFactory: () => ({ async verify() {}, async request(route) { return route === '/alarmsystems/users' ? { [uid]: expected } : { [uid]: grant }; } }),
  });
  host.verifySources = async () => {};
  return { root, target, host, calls, expected, config };
}

test('readiness reports a fixed prerequisite reason and never leaks private exception details', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.host.readiness(), { configured: true, error: null });
  delete f.config.platforms[1]._bridge;
  await writeFile(path.join(f.root, 'config.json'), JSON.stringify(f.config), { mode: 0o600 });
  assert.deepEqual(await f.host.readiness(), { configured: false, error: 'homebridge_child_identity_invalid' });
  f.config.platforms[1]._bridge = { username: bridge };
  f.config.platforms[0].ssl = { selfSigned: true };
  await writeFile(path.join(f.root, 'config.json'), JSON.stringify(f.config), { mode: 0o600 });
  assert.deepEqual(await f.host.readiness(), { configured: false, error: 'homebridge_local_http_ui_required' });
  delete f.config.platforms[0].ssl;
  await writeFile(path.join(f.root, 'config.json'), JSON.stringify(f.config), { mode: 0o600 });
  f.host.verifySources = async () => { throw Error('homebridge_source_changed_review_required'); };
  assert.deepEqual(await f.host.readiness(), { configured: false, error: 'homebridge_source_changed_review_required' });
  f.host.verifySources = async () => { throw Error('private fixture path and credential'); };
  assert.deepEqual(await f.host.readiness(), { configured: false, error: 'homebridge_sources_unavailable' });
  assert.equal(await f.host.available(), false); assert.deepEqual(f.calls, []);
});

test('offline cache transform changes only the precisely mapped alarm PIN', () => {
  const before = cache(), after = JSON.parse(editedHomebridgeCache(Buffer.from(JSON.stringify(before)), binding, mapping, '3333'));
  assert.equal(homebridgeAlarmContext(after, identity, 'alarm-1').pin, '3333');
  homebridgeAlarmContext(after, identity, 'alarm-1').pin = '1111'; assert.deepEqual(after, before);
  assert.throws(() => editedHomebridgeCache(Buffer.from(JSON.stringify(before)), binding, { 1: 'missing' }, '3333'), /homebridge_accessory_identity_changed/);
  assert.throws(() => editedHomebridgeCache(Buffer.from(JSON.stringify(before)), binding, mapping, 'bad'), /invalid_pin/);
});
test('confirmed stop, private backup, compare-and-replace and restart readback preserve unrelated cache data', async t => {
  const f = await fixture(t); await f.host.authenticate({ username: 'Owner', password: 'synthetic' });
  const lease = { id: 'a'.repeat(32), binding, host: await f.host.prepare(binding) };
  await f.host.stop(lease); await f.host.assertStopped(lease); await f.host.snapshotStopped(lease, '3333');
  assert.equal(homebridgeAlarmContext(JSON.parse(await readFile(f.target)), identity, 'alarm-1').pin, '1111');
  await f.host.commitStopped(lease, { applied: true });
  assert.equal((await stat(f.target)).mode & 0o777, 0o600);
  await f.host.start(lease);
  await f.host.verifyRunning(lease, { write_attempted: true, definite_rejection: false, intent: { expected: f.expected } });
  assert.deepEqual(f.calls, ['stop', 'start']);
  const after = JSON.parse(await readFile(f.target)); assert.equal(after[2].context.pin, '2222');
  const backup = path.join(f.root, 'deconz-keypad-admin', 'web-homebridge-private-backup.json');
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
});
test('cache compare-and-replace rejects concurrent edits and linked files without overwriting either', async t => {
  const f = await fixture(t), original = await readFile(f.target), changed = Buffer.from(JSON.stringify([...cache(), { concurrent: true }]));
  await writeFile(f.target, changed);
  await assert.rejects(replaceHomebridgeCache(f.target, original, Buffer.from('[]'), async () => {}), /homebridge_cache_changed/);
  assert.deepEqual(await readFile(f.target), changed);
  const link = path.join(f.root, 'accessories', 'linked'); await symlink(f.target, link);
  await assert.rejects(replaceHomebridgeCache(link, changed, Buffer.from('[]'), async () => {}), /homebridge_file_unavailable/);
  assert.deepEqual(await readFile(f.target), changed);
});
test('configuration or gateway identity changes prevent offline PIN preparation', async t => {
  const f = await fixture(t); await f.host.authenticate({ username: 'Owner', password: 'synthetic' });
  const lease = { id: 'a'.repeat(32), binding, host: await f.host.prepare(binding) };
  f.config.platforms[0].port = 9999; await writeFile(path.join(f.root, 'config.json'), JSON.stringify(f.config));
  await assert.rejects(f.host.stop(lease), /homebridge_configuration_changed/); assert.deepEqual(f.calls, []);
  await assert.rejects(f.host.prepare({ ...binding, identity: 'FFEEDDCCBBAA9988' }), /homebridge_binding_changed/);
});
