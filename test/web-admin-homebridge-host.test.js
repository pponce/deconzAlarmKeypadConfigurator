import test from 'node:test';
import { WebAdminError } from '../src/web-admin-auth.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebHomebridgeHost, homebridgeAlarmContext, editedHomebridgeCache, replaceHomebridgeCache, readHomebridgeFile } from '../src/web-admin-homebridge-host.js';

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
  const dataRoot = path.join(root, 'standalone-data');
  await mkdir(dataRoot, { mode: 0o700 });
  await mkdir(path.join(root, 'accessories'), { mode: 0o700 }); await mkdir(path.join(dataRoot, 'deconz-keypad-admin'), { mode: 0o700 });
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
  const host = new WebHomebridgeHost({ storagePath: dataRoot, homebridgeStoragePath: root, registrations: [{ id: 'test', identity }], clientFactory: () => client,
    stamp: async id => stopped || id !== pid ? null : String(pid),
    exchange: async request => { assert.equal(request.method, 'GET'); return [200, { 'alarm-1': { type: 'alarmsystems', resources: ['/alarmsystems/1'] } }]; },
    gatewayFactory: () => ({ async verify() {}, async request(route) { return route === '/alarmsystems/users' ? { [uid]: expected } : { [uid]: grant }; } }),
  });
  host.verifySources = async () => {};
  return { root, dataRoot, target, host, calls, expected, config };
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

test('readiness identifies the configuration file and failed policy without exposing its host path or contents', async t => {
  const f = await fixture(t), file = path.join(f.root, 'config.json');
  await chmod(file, 0o664);
  assert.deepEqual(await f.host.readiness(), { configured: false, error: 'homebridge_file_unavailable',
    file_check: { scope: 'configuration', file: 'config.json', reason: 'writable_by_others' } });
  await chmod(file, 0o600);
  assert.deepEqual(await f.host.readiness(), { configured: true, error: null });
  await rm(file);
  const missing = await f.host.readiness();
  assert.deepEqual(missing, { configured: false, error: 'homebridge_file_unavailable',
    file_check: { scope: 'configuration', file: 'config.json', reason: 'missing' } });
  assert.equal(JSON.stringify(missing).includes(f.root), false); assert.deepEqual(f.calls, []);
});

test('readiness identifies a missing reviewed source file without relaxing the source checks', async t => {
  const f = await fixture(t), plugin = path.join(f.root, 'node_modules', 'homebridge-deconz');
  const library = path.join(plugin, 'node_modules', 'homebridge-lib');
  await mkdir(library, { recursive: true });
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: 'homebridge-deconz', version: '1.3.5' }), { mode: 0o644 });
  await chmod(path.join(plugin, 'package.json'), 0o664);
  await writeFile(path.join(library, 'package.json'), JSON.stringify({ name: 'homebridge-lib', version: '8.1.5', main: 'index.js' }), { mode: 0o644 });
  await writeFile(path.join(library, 'index.js'), '', { mode: 0o644 });
  f.host.pluginRoot = () => plugin;
  delete f.host.verifySources;
  assert.deepEqual(await f.host.readiness(), { configured: false, error: 'homebridge_file_unavailable',
    file_check: { scope: 'plugin', file: 'lib/DeconzService/AlarmSystem.js', reason: 'missing' } });
  await mkdir(path.join(plugin, 'lib', 'DeconzService'), { recursive: true });
  const source = path.join(plugin, 'lib', 'DeconzService', 'AlarmSystem.js');
  await writeFile(source, 'synthetic modified source'); await chmod(source, 0o664);
  assert.deepEqual(await f.host.readiness(), { configured: false, error: 'homebridge_source_changed_review_required' });
  assert.deepEqual(f.calls, []);
});

test('readiness refuses arbitrary file diagnostic labels and reasons', async t => {
  const f = await fixture(t);
  f.host.verifySources = async () => {
    const error = Error('homebridge_file_unavailable');
    error.fileCheck = { scope: 'plugin', file: '/private/fixture-secret', reason: 'read_failed' }; throw error;
  };
  assert.deepEqual(await f.host.readiness(), { configured: false, error: 'homebridge_file_unavailable' });
});

test('reviewed sources accept service-group writes while configuration and PIN-cache reads remain strict', async t => {
  const f = await fixture(t), file = path.join(f.root, 'package.json');
  await writeFile(file, '{"name":"synthetic"}', { mode: 0o644 });
  assert.equal((await readHomebridgeFile(file)).toString(), '{"name":"synthetic"}');
  await chmod(file, 0o664);
  await assert.rejects(readHomebridgeFile(file), /homebridge_file_unavailable/);
  assert.equal((await readHomebridgeFile(file, 1024, { allowServiceGroupWrite: true })).toString(), '{"name":"synthetic"}');
  const getgid = process.getgid;
  try {
    process.getgid = () => getgid() + 1;
    await assert.rejects(readHomebridgeFile(file, 1024, { allowServiceGroupWrite: true }), /homebridge_file_unavailable/);
  } finally { process.getgid = getgid; }
  await chmod(file, 0o666);
  await assert.rejects(readHomebridgeFile(file, 1024, { allowServiceGroupWrite: true }), /homebridge_file_unavailable/);
  const link = path.join(f.root, 'package-link.json'); await symlink(file, link);
  await assert.rejects(readHomebridgeFile(link, 1024, { allowServiceGroupWrite: true }), /homebridge_file_unavailable/);
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
  const backup = path.join(f.dataRoot, 'deconz-keypad-admin', 'web-homebridge-private-backup.json');
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

test('no-write restoration checks preserve the existing PIN and need no private backup', async t => {
  const f = await fixture(t); await f.host.authenticate({ username: 'Owner', password: 'synthetic' });
  const lease = { id: 'a'.repeat(32), binding, host: await f.host.prepare(binding) };
  const tx = { write_attempted: false, intent: { expected: { ...f.expected, revision: 3, user_revision: 3 } } };
  const before = await readFile(f.target);
  assert.equal(await f.host.noWriteState(lease, tx), 'running');
  await f.host.verifyNoWriteRunning(lease, tx); assert.deepEqual(f.calls, []);
  await f.host.stop(lease);
  assert.equal(await f.host.noWriteState(lease, tx), 'stopped');
  await f.host.start(lease); await f.host.verifyNoWriteRunning(lease, tx);
  assert.deepEqual(await readFile(f.target), before);
  await assert.rejects(readFile(path.join(f.dataRoot, 'deconz-keypad-admin', 'web-homebridge-private-backup.json')), { code: 'ENOENT' });
  await assert.rejects(f.host.noWriteState(lease, { ...tx, write_attempted: true }), /homebridge_gateway_write_unverified/);
  await assert.rejects(f.host.verifyNoWriteRunning(lease, { ...tx, write_attempted: true }), /homebridge_gateway_write_unverified/);
});

test('private storage failure is discovered before a service stop', async t => {
  const f = await fixture(t); await f.host.authenticate({ username: 'Owner', password: 'synthetic' });
  await chmod(path.join(f.dataRoot, 'deconz-keypad-admin'), 0o755);
  await assert.rejects(f.host.prepare(binding), /web_private_storage_invalid/); assert.deepEqual(f.calls, []);
});

async function restartedFixture(t) {
  const f = await fixture(t); await f.host.authenticate({ username: 'Owner', password: 'synthetic' });
  f.lease = { id: 'b'.repeat(32), binding, host: await f.host.prepare(binding) };
  await f.host.stop(f.lease); await f.host.snapshotStopped(f.lease, '3333');
  await f.host.commitStopped(f.lease, { applied: true }); await f.host.start(f.lease);
  f.tx = { write_attempted: true, definite_rejection: false, intent: { expected: f.expected } };
  let time = 0; f.host.clock = () => time; f.host.sleep = async ms => { time += ms; };
  return f;
}

test('restart waits for device API transport without repeating stop, start or cache writes', async t => {
  const f = await restartedFixture(t), exchange = f.host.exchange, before = await readFile(f.target);
  let reads = 0;
  f.host.exchange = async request => {
    assert.equal(request.method, 'GET'); assert.ok(request.timeoutMs > 0 && request.timeoutMs <= 8000);
    if (++reads <= 2) throw new WebAdminError('gateway_result_unknown_no_retry');
    return exchange(request);
  };
  await f.host.verifyRunning(f.lease, f.tx);
  assert.equal(reads, 3); assert.deepEqual(f.calls, ['stop', 'start']);
  assert.deepEqual(await readFile(f.target), before);
});

test('device API deadline is bounded and a later read-only recovery succeeds', async t => {
  const f = await restartedFixture(t), exchange = f.host.exchange;
  let reads = 0;
  f.host.exchange = async () => { reads++; return [503, {}]; };
  await assert.rejects(f.host.verifyRunning(f.lease, f.tx), /homebridge_alarm_api_not_ready/);
  assert.equal(f.host.clock(), 30000); assert.equal(reads, 60);
  f.host.exchange = exchange; await f.host.verifyRunning(f.lease, f.tx);
  assert.deepEqual(f.calls, ['stop', 'start']);
});

test('readiness polling does not retry malformed replies, changed mapping or unknown exceptions', async t => {
  const f = await restartedFixture(t);
  for (const [reply, reason] of [
    [() => { throw new WebAdminError('gateway_response_invalid'); }, 'homebridge_alarm_api_response_invalid'],
    [() => [200, {}], 'homebridge_alarm_mapping_changed'],
    [() => { throw Error('synthetic unknown error'); }, 'synthetic unknown error'],
  ]) {
    let reads = 0; f.host.exchange = async () => { reads++; return reply(); };
    await assert.rejects(f.host.verifyRunning(f.lease, f.tx), new RegExp(reason)); assert.equal(reads, 1);
  }
  assert.deepEqual(f.calls, ['stop', 'start']);
});

test('readiness polling stops when the child process changes', async t => {
  const f = await restartedFixture(t); let reads = 0;
  f.host.exchange = async () => { reads++; throw new WebAdminError('gateway_result_unknown_no_retry'); };
  f.host.sleep = async () => { f.host.client.status = async () => ({ pid: 9999, status: 'ok', manuallyStopped: false }); };
  await assert.rejects(f.host.verifyRunning(f.lease, f.tx), /homebridge_process_changed/);
  assert.equal(reads, 1); assert.deepEqual(f.calls, ['stop', 'start']);
});
