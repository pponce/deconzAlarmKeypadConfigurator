import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WebAdminBackend } from '../src/web-admin-backend.js';
import { WebAdminError } from '../src/web-admin-auth.js';
import { webAdminRoute } from '../src/web-admin-routes.js';

const reference = JSON.parse(await readFile(new URL('./fixtures/web-admin-read-parity.json', import.meta.url)));
const admin = { role: 'admin' }, regular = { role: 'regular' };
const registration = { id: 'test', name: 'Synthetic gateway', identity: '0011223344556677', endpoint: 'http://127.0.0.1:1', key: 'synthetic-private-key' };
test('standalone does not expose controller routes or operations', async () => {
  const backend = new WebAdminBackend({ accessMode: 'manage' });
  for (const operation of ['controller_settings', 'controller_timings_save']) await assert.rejects(backend.dispatch(admin, operation, {}), /operation_not_implemented/);
  assert.throws(() => webAdminRoute({ method: 'GET', url: '/api/controller', headers: {}, rawHeaders: [] }, {}), /route_not_found/);
});

function fixture(options = {}) {
  const data = structuredClone(reference), calls = [], transactions = { status: async () => ({ stage: 'none' }) };
  const backend = new WebAdminBackend({ registrations: [registration], transactions,
    gatewayFactory: row => ({
      verify: async alarm => { calls.push([row.id, 'verify', alarm]); return alarm ? data.capabilities[alarm] : { bridgeid: row.identity }; },
      request: async (path, method = 'GET') => {
        assert.equal(method, 'GET'); calls.push([row.id, method, path]); assert.ok(Object.hasOwn(data.responses, path), path);
        return structuredClone(data.responses[path]);
      },
    }), ...options });
  const scoped = (operation, body = {}, session = admin, gateway = 'test', alarm = 1) => backend.dispatch(session, 'gateway_request', { gateway, alarm, operation, body });
  return { backend, scoped, data, calls, transactions };
}
function request(method, url, headers = {}) {
  return { method, url, headers, rawHeaders: Object.entries(headers).flat() };
}

test('original page routes retain explicit gateway/alarm scope and reject ambiguous headers', () => {
  assert.deepEqual(webAdminRoute(request('GET', '/api/administration', { 'x-configurator-gateway': 'test', 'x-configurator-alarm': '1' }), {}), {
    operation: 'gateway_request', body: { gateway: 'test', alarm: 1, operation: 'administration', body: {} },
  });
  assert.deepEqual(webAdminRoute(request('POST', '/api/users/save', { 'x-configurator-gateway': 'test', 'x-configurator-alarm': '2' }), { id: null }).body,
    { gateway: 'test', alarm: 2, operation: 'save_user', body: { id: null } });
  assert.equal(webAdminRoute(request('GET', '/api/settings', { 'x-configurator-gateway': 'test' }), {}).operation, 'installation_settings');
  assert.throws(() => webAdminRoute(request('GET', '/api/alarm', { 'x-configurator-alarm': '1' }), {}), /invalid_gateway_request/);
  const duplicate = request('GET', '/api/inventory', { 'x-configurator-gateway': 'test' });
  duplicate.rawHeaders.push('X-Configurator-Gateway', 'second');
  assert.throws(() => webAdminRoute(duplicate, {}), /invalid_gateway_request/);
  for (const [method, url] of [['GET', '/api/users/save'], ['POST', '/api/alarm'], ['GET', '/api/extensions/controller/settings']]) {
    assert.throws(() => webAdminRoute(request(method, url), {}), /route_not_found/);
  }
});

test('gateway list stays private and read requests reach the captured reference contract', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.backend.dispatch(admin, 'gateways', {}), { gateways: [{ id: 'test', name: registration.name, connected: false }] });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.scoped('administration'), reference.expected.administration);
  assert.deepEqual(await f.scoped('alarm'), reference.expected.alarm);
  assert.deepEqual(await f.scoped('lockout'), reference.expected.lockout);
  const catalog = await f.backend.dispatch(admin, 'gateways', {});
  assert.equal(catalog.gateways[0].connected, false); // REST reads cannot prove a live collector.
  assert.equal(JSON.stringify(catalog).includes(registration.key), false);
  assert.equal(JSON.stringify(catalog).includes(registration.endpoint), false);
  assert.deepEqual(f.backend.catalog.get('test'), reference.expected.inventory);
  f.backend.connected.set('test', true);
  assert.equal((await f.backend.dispatch(admin, 'gateways', {})).gateways[0].connected, true);
  assert.deepEqual(await f.backend.dispatch(regular, 'activity_options', {}), await f.backend.dispatch(regular, 'gateways', {}));
});

test('unknown/missing scope and unavailable mutations cannot choose another gateway or issue writes', async () => {
  const f = fixture();
  await assert.rejects(f.scoped('alarm', {}, admin, 'unknown'), /gateway_not_registered/);
  await assert.rejects(f.scoped('alarm', {}, admin, 'test', null), /explicit_alarm_required/);
  await assert.rejects(f.scoped('alarm', {}, admin, 'test', 0), /invalid_alarm/);
  await assert.rejects(f.scoped('inventory', { unexpected: true }), /invalid_request/);
  for (const operation of ['save_user', 'delete_user', 'rotate_pin', 'save_alarm', 'save_lockout', 'reset_lockout', 'keypad_send']) {
    await assert.rejects(f.scoped(operation), /operation_not_implemented/);
  }
  await assert.rejects(f.backend.dispatch(admin, 'alarm', {}), /operation_not_implemented/);
  assert.equal(f.calls.length, 0);
});

test('regular projection protects owners across alarms and omits private identities and recovery details', async () => {
  const hidden = 'b'.repeat(32), f = fixture({ hiddenUsers: async () => [hidden] });
  // Add a hidden identity with grants on both alarms; the source contains only synthetic data.
  const owner = 'a'.repeat(32);
  f.data.responses['/alarmsystems/users'][hidden] = { ...f.data.responses['/alarmsystems/users'][owner], id: hidden, name: 'Integration' };
  for (const alarm of [1, 2]) f.data.responses['/alarmsystems/' + alarm + '/users'][hidden] = {
    ...f.data.responses['/alarmsystems/' + alarm + '/users'][owner], id: hidden, name: 'Integration', owner: false,
  };
  f.transactions.status = async () => ({ stage: 'recovery_required', transaction_id: 'private', participants: ['private'] });
  const result = await f.scoped('administration', {}, regular);
  assert.equal(JSON.stringify(result).includes(hidden), false);
  assert.ok(result.identities.every(row => row.read_only));
  assert.ok(result.alarms.every(alarm => alarm.users.every(row => row.read_only)));
  assert.equal(Object.hasOwn(result, 'homebridge_binding'), false);
  assert.deepEqual(result.transaction, { stage: 'held', pending: true, administrator_required: true });
  assert.equal(result.pin_rotation_available, false);
  assert.deepEqual(await f.backend.dispatch(regular, 'setup', {}), { access_mode: 'observe', extensions: [], onboarding_required: false });
  for (const operation of ['overview', 'editor', 'history', 'save_alarm', 'keypad_send']) await assert.rejects(f.scoped(operation, {}, regular), /forbidden/);
  await assert.rejects(f.scoped('save_user', {}, regular), /operation_not_implemented/);
  await assert.rejects(f.backend.dispatch(regular, 'installation_settings', {}), /forbidden/);
});

test('offline status/history does not contact the gateway and regular errors omit recovery details', async () => {
  const f = fixture({ history: { rows: async (gateway, alarm, limit) => {
    assert.deepEqual([gateway, alarm, limit], ['test', 1, 200]); return [{ action: 'Synthetic history' }];
  } } });
  assert.deepEqual(await f.scoped('history'), { rows: [{ action: 'Synthetic history' }], connected: false });
  assert.deepEqual(await f.scoped('transaction_status', {}, regular), { stage: 'none', pending: false, administrator_required: false });
  assert.equal(f.calls.length, 0);
  f.transactions.status = async () => { throw new WebAdminError('homebridge_maintenance_recovery_required'); };
  await assert.rejects(f.scoped('transaction_status', {}, regular), /^Error: administrator_attention_required$/);
  await assert.rejects(f.scoped('transaction_status'), /homebridge_maintenance_recovery_required/);
});
