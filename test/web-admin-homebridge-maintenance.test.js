import test from 'node:test';
import assert from 'node:assert/strict';
import { WebHomebridgeMaintenance, homebridgeEligibleUser } from '../src/web-admin-homebridge-maintenance.js';
import { WebAdminTransactions } from '../src/web-admin-transactions.js';

const gid = '0011223344556677', uid = '1'.repeat(32), binding = { gateway: 'test', identity: gid, user: uid, alarms: [1] };
const user = { enabled: true, grant_enabled: true, arm: true, disarm: true, api_arm_disarm: true, remaining_uses: null, schedule: null };
function fixture() {
  let state = { schema: 1, bindings: [], lease: null }, record = null, gatewayWrites = 0, stopped = false, running = true;
  const events = [], journals = [], credentials = { username: 'Owner', password: 'fixture-password' };
  const store = { read: async () => structuredClone(state), write: async row => { journals.push(structuredClone(row)); state = structuredClone(row); events.push(row.lease?.stage ?? 'saved'); } };
  const host = {
    authenticate: async () => { events.push('login'); }, clearAuthentication: async () => { events.push('forget login'); },
    prepare: async selected => { assert.deepEqual(selected, binding); return { bridge: 'AA:BB:CC:DD:EE:FF', pid: 1234 }; },
    stop: async lease => { assert.equal(state.lease.stage, 'stop_requested'); assert.equal(lease.id, state.lease.id); stopped = true; running = false; events.push('stop'); },
    assertStopped: async () => { assert.equal(stopped, true); },
    snapshotStopped: async (lease, pin) => { assert.equal(stopped, true); assert.equal(pin, 'fixture-pin'.replace('fixture-pin', '2468')); events.push('private backup'); },
    verifyGateway: async () => { events.push('check gateway'); },
    verifySnapshot: async () => {},
    noWriteState: async (lease, tx) => { assert.equal(tx.write_attempted, false); await host.verifyGateway(lease, tx); return stopped ? 'stopped' : 'running'; },
    verifyNoWriteRunning: async (lease, tx) => { assert.equal(tx.write_attempted, false); await host.verifyGateway(lease, tx); assert.equal(running, true); },
    commitStopped: async (lease, { applied }) => { assert.equal(stopped, true); events.push(applied ? 'save pin' : 'keep previous pin'); },
    start: async () => { assert.equal(state.lease.stage, 'start_requested'); events.push('start'); stopped = false; running = true; },
    verifyRunning: async () => { assert.equal(running, true); events.push('readback'); },
  };
  const integration = new WebHomebridgeMaintenance({ store, registrations: [{ id: 'test', identity: gid }], host });
  const tx = new WebAdminTransactions({ store: { read: async () => structuredClone(record), write: async row => { record = structuredClone(row); journals.push(structuredClone(row)); } },
    participants: new Map([['homebridge', integration]]) });
  const input = { context: { gateway: 'test', identity: gid, alarm: 1, operation: 'rotate_pin', identity_id: uid, homebridge_selection: { previous: null, binding } },
    snapshot: { grants: {} }, intent: { kind: 'identity', sensitive: true, expected: {} }, validateAgain: async () => true,
    write: async () => { gatewayWrites++; events.push('gateway write'); return {}; }, verify: async () => { events.push('verify gateway response'); return input.intent; } };
  const run = (confirmed = true) => integration.withRequest({ pin: '2468', confirmed, credentials }, () => tx.execute(input));
  return { integration, host, tx, input, events, journals, credentials, store, run, state: () => state, record: () => record, writes: () => gatewayWrites };
}

test('unconfigured Homebridge stays visible with a readiness reason and no service action', async () => {
  const f = fixture(); f.host.readiness = async () => ({ configured: false, error: 'homebridge_child_identity_invalid' });
  const status = await f.integration.viewStatus();
  assert.equal(status.configured, false); assert.equal(status.error, 'homebridge_child_identity_invalid');
  assert.deepEqual(status.bindings, []); assert.deepEqual(f.events, []);
});

test('confirmed PIN transaction records each service intent before acting and publishes binding only after restart verification', async () => {
  const f = fixture(); assert.equal((await f.integration.status()).pending, false);
  assert.equal((await f.run()).saved, true); assert.equal(f.writes(), 1);
  for (const [first, second] of [['stop_requested', 'stop'], ['private backup', 'gateway write'], ['verify gateway response', 'save pin'], ['start_requested', 'start'], ['readback', 'complete']]) {
    assert.ok(f.events.indexOf(first) < f.events.indexOf(second), first + ' precedes ' + second);
  }
  assert.deepEqual(f.state().bindings, [binding]); assert.equal(f.state().lease.stage, 'complete');
  assert.equal(f.credentials.password, '');
  assert.equal(JSON.stringify(f.journals).includes('2468'), false);
  assert.equal(JSON.stringify(f.journals).includes('fixture-password'), false);
});
test('missing confirmation prevents authentication, stop and the deCONZ PIN write', async () => {
  const f = fixture(); await assert.rejects(f.run(false), /homebridge_restart_confirmation_required/);
  assert.deepEqual(f.events, []); assert.equal(f.writes(), 0); assert.equal(f.state().lease, null);
});
test('unknown gateway outcome keeps Homebridge stopped and does not commit a PIN or new binding', async () => {
  const f = fixture(), write = f.input.write;
  f.input.write = async () => { await write(); throw Error('reply lost'); };
  await assert.rejects(f.run(), /transaction_recovery_required/);
  assert.equal(f.writes(), 1); assert.equal(f.state().lease.stage, 'stopped'); assert.deepEqual(f.state().bindings, []);
  assert.equal(f.events.includes('save pin'), false); assert.equal(f.events.includes('start'), false);
  assert.equal((await f.tx.review('test', gid, async () => true)).ready, false);
  await assert.rejects(f.integration.guard(), /homebridge_shared_service_recovery_required/);
});
test('an uncertain start is reviewed through readback without repeating the start or gateway write', async () => {
  const f = fixture(), start = f.host.start;
  f.host.start = async lease => { await start(lease); throw Error('reply lost'); };
  await assert.rejects(f.run(), /transaction_recovery_required/);
  assert.equal(f.state().lease.stage, 'start_requested'); assert.equal(f.record().verified, true);
  const review = await f.tx.review('test', gid, async () => true); assert.equal(review.ready, true);
  await f.tx.recover('test', gid, { transaction_id: review.transaction_id, token: review.token, reviewed: true }, async () => true);
  assert.equal(f.events.filter(row => row === 'start').length, 1); assert.equal(f.writes(), 1);
  assert.equal(f.state().lease.stage, 'complete');
});
test('a failed durable stop intent prevents the stop and leaves a storage hold', async () => {
  const f = fixture(); f.store.write = async () => { throw Error('disk unavailable'); };
  await assert.rejects(f.run(), /transaction_recovery_required/);
  assert.equal(f.events.includes('stop'), false); assert.equal(f.writes(), 0);
  await assert.rejects(f.integration.guard(), /homebridge_storage_review_required/);
});
test('a stop acknowledgement without stopped-state evidence cannot reach the gateway write', async () => {
  const f = fixture(); f.host.assertStopped = async () => { throw Error('still running'); };
  await assert.rejects(f.run(), /transaction_recovery_required/);
  assert.equal(f.writes(), 0); assert.equal(f.state().lease.stage, 'stop_requested');
  assert.equal(await f.integration.recovery_ready(f.record()), true);
});
test('changing a Homebridge binding requires unrestricted grants and cannot silently remove an alarm', async () => {
  const f = fixture();
  assert.equal(homebridgeEligibleUser(user), true);
  assert.equal(homebridgeEligibleUser({ ...user, schedule: {} }), false);
  const snapshot = { grants: { 1: { [uid]: user } } };
  assert.deepEqual(await f.integration.selectionPlan('test', uid, { expected_user_id: null, alarms: [1] }, snapshot), { previous: null, binding });
  await f.run();
  await assert.rejects(f.integration.selectionPlan('test', uid, { expected_user_id: null, alarms: [1] }, snapshot), /homebridge_binding_changed/);
  await assert.rejects(f.integration.protect('test', 1, { operation: 'delete_user', uid, deleting: true }, {}, snapshot), /homebridge_user_must_remain_unrestricted/);
  await assert.rejects(f.integration.protect('test', 1, { operation: 'save_user', uid }, { ...user, enabled: false }, snapshot), /homebridge_user_must_remain_unrestricted/);
});

test('missing backup before any PIN write can be cancelled without inventing a backup or replaying a write', async () => {
  const f = fixture(); f.host.snapshotStopped = async () => { throw Error('private payload must not escape'); };
  await assert.rejects(f.run(), /transaction_recovery_required/);
  const review = await f.tx.review('test', gid, async () => true);
  assert.equal(review.ready, true); assert.deepEqual(review.diagnostics, []);
  await f.tx.recover('test', gid, { transaction_id: review.transaction_id, token: review.token, reviewed: true }, async () => true);
  assert.equal(f.writes(), 0); assert.equal(f.events.includes('save pin'), false);
  assert.equal(f.events.includes('private backup'), false);
  assert.equal(f.events.filter(x => x === 'start').length, 1);
  assert.deepEqual(f.state().bindings, []); assert.equal(f.state().lease.stage, 'complete');
  assert.equal(f.record().stage, 'complete'); assert.equal((await f.tx.status('test')).outcome, 'not_sent');
});

test('unknown diagnostic errors cannot expose credentials or paths', async () => {
  const f = fixture(); f.host.snapshotStopped = async () => { throw Error('backup interrupted'); };
  await assert.rejects(f.run(), /transaction_recovery_required/);
  f.host.verifyGateway = async () => { throw Error('/private/path secret=2468'); };
  const review = await f.tx.review('test', gid, async () => true);
  assert.deepEqual(review.diagnostics, [{ participant: 'homebridge', check: 'restore_service', reason: 'verification_failed' }]);
  assert.equal(JSON.stringify(review).includes('2468'), false);
});

test('stop rejected before delivery cancels without stopping or starting an already running bridge', async () => {
  const f = fixture(); f.host.stop = async () => { throw Error('homebridge_ui_result_unknown'); };
  await assert.rejects(f.run(), /transaction_recovery_required/);
  assert.equal((await f.tx.status('test')).failure_reason, 'homebridge_ui_result_unknown');
  const review = await f.tx.review('test', gid, async () => true);
  await f.tx.recover('test', gid, { transaction_id: review.transaction_id, token: review.token, reviewed: true }, async () => true);
  assert.equal(f.writes(), 0); assert.equal(f.events.includes('stop'), false); assert.equal(f.events.includes('start'), false);
  assert.equal(f.record().stage, 'complete');
});

test('lost start response during cancellation resolves through readback without another service request', async () => {
  const f = fixture(); f.host.snapshotStopped = async () => { throw Error('interrupted'); };
  await assert.rejects(f.run(), /transaction_recovery_required/);
  const start = f.host.start; f.host.start = async lease => { await start(lease); throw Error('lost ack'); };
  const review = await f.tx.review('test', gid, async () => true);
  await f.tx.recover('test', gid, { transaction_id: review.transaction_id, token: review.token, reviewed: true }, async () => true);
  assert.equal(f.events.filter(x => x === 'start').length, 1); assert.equal(f.writes(), 0);
  assert.equal(f.record().stage, 'complete');
});

test('an uncertain gateway PIN write can never take the no-write cancellation path', async () => {
  const f = fixture(), write = f.input.write;
  f.input.write = async () => { await write(); throw Error('lost gateway response'); };
  await assert.rejects(f.run(), /transaction_recovery_required/);
  const state = f.state(); state.lease.stage = 'stop_requested'; await f.store.write(state);
  f.host.noWriteState = async () => { assert.fail('no-write branch must not run'); };
  const review = await f.tx.review('test', gid, async () => true);
  assert.equal(review.ready, false); assert.equal(f.writes(), 1);
  assert.equal(f.events.includes('start'), false); assert.equal(f.record().stage, 'recovery_required');
});

test('participant completion failure keeps transaction pending and can finish on explicit recovery', async () => {
  const f = fixture(), complete = f.integration.complete.bind(f.integration); let fail = true;
  f.integration.complete = async tx => { if (fail) { fail = false; throw Error('completion interrupted'); } return complete(tx); };
  await assert.rejects(f.run(), /transaction_recovery_required/);
  assert.equal(f.record().stage, 'recovery_required');
  const review = await f.tx.review('test', gid, async () => true);
  await f.tx.recover('test', gid, { transaction_id: review.transaction_id, token: review.token, reviewed: true }, async () => true);
  assert.equal(f.writes(), 1); assert.equal(f.events.filter(x => x === 'start').length, 1);
  assert.equal(f.record().stage, 'complete'); assert.deepEqual(f.state().bindings, [binding]);
});

test('a failed service restoration remains recoverable after restart and a new explicit authorization', async () => {
  const f = fixture(); f.host.snapshotStopped = async () => { throw Error('interrupted backup'); };
  await assert.rejects(f.run(), /transaction_recovery_required/);
  const start = f.host.start; f.host.start = async () => { throw Error('unavailable'); };
  let review = await f.tx.review('test', gid, async () => true);
  await assert.rejects(f.tx.recover('test', gid, { transaction_id: review.transaction_id, token: review.token, reviewed: true }, async () => true), /transaction_recovery_required/);
  assert.equal(f.state().lease.stage, 'start_requested');
  assert.equal(f.record().stage, 'recovery_required'); assert.equal(f.writes(), 0);
  const recovered = new WebHomebridgeMaintenance({ store: f.store, registrations: [{ id: 'test', identity: gid }], host: f.host });
  f.tx.participants.set('homebridge', recovered); f.host.start = start;
  await recovered.authorizeRecovery(f.record(), { username: 'Owner', password: 'synthetic' });
  review = await f.tx.review('test', gid, async () => true);
  await f.tx.recover('test', gid, { transaction_id: review.transaction_id, token: review.token, reviewed: true }, async () => true);
  assert.equal(f.record().stage, 'complete'); assert.equal(f.writes(), 0);
  assert.equal(f.events.filter(x => x === 'start').length, 1); assert.deepEqual(f.state().bindings, []);
});
