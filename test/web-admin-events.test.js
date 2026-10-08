import test from 'node:test';
import assert from 'node:assert/strict';
import { WebAdminEventProjection, WebAdminDebugCapture } from '../src/web-admin-events.js';

function fixture() {
  const now = Date.parse('2099-01-01T00:00:00.000Z');
  const projection = new WebAdminEventProjection({ 1: ['3'], 2: ['4'] }, { clock: () => now });
  const event = { t: 'event', r: 'alarmsystems', e: 'access', id: 1, sensor_id: '3', event_id: 'a'.repeat(32), timestamp: new Date(now).toISOString(),
    user_id: 'user-test', action: 'disarmed', uses_consumed: 1, remaining_uses: 5 };
  return { now, projection, event, read: changes => projection.read(JSON.stringify({ ...event, ...changes })) };
}
test('event projection accepts only fresh, scoped events and omits all unrecognized credentials', () => {
  const f = fixture(), [row] = f.read({ code: '1234', pin: '5678', api_key: 'synthetic-secret' });
  assert.deepEqual(row, { type: 'access', key: 'a'.repeat(32), timestamp: '2099-01-01T00:00:00.000Z', alarm: '1', sensor: '3', user: 'user-test', action: 'disarmed', uses: 1, remaining: 5 });
  for (const change of [{ id: 2 }, { id: 99 }, { sensor_id: 9 }, { timestamp: new Date(f.now - 2000).toISOString() }, { timestamp: new Date(f.now + 11000).toISOString() }, { uses_consumed: 2 }, { event_id: 'bad' }]) assert.deepEqual(f.read(change), []);
  assert.deepEqual(f.projection.read('{"id":1,"id":2}'), []);
  assert.deepEqual(f.projection.read(JSON.stringify({ ...f.event, unused: 'é'.repeat(524288) })), []);
});
test('alarm state establishes a baseline; removed alarms and rejected REST codes cannot disclose a user', () => {
  const f = fixture(), state = armstate => JSON.stringify({ t: 'event', r: 'alarmsystems', e: 'changed', id: 1, state: { armstate } });
  assert.deepEqual(f.projection.read(state('disarmed')), []);
  assert.equal(f.projection.read(state('armed_away'))[0].type, 'alarm_state');
  assert.deepEqual(f.projection.read(state('armed_away')), []);
  assert.deepEqual(f.read({ e: 'alarm_command', source: 'rest', result: 'rejected', uses_consumed: 0, action: 'disarm' }), [{ type: 'rest', key: 'a'.repeat(32), timestamp: '2099-01-01T00:00:00.000Z', alarm: '1', action: 'disarm', result: 'rejected' }]);
  f.projection.update({ 2: ['4'] }); assert.deepEqual(f.projection.read(state('disarmed')), []);
  f.projection.update({ 1: ['3'] }); assert.deepEqual(f.projection.read(state('disarmed')), []);
});
test('lockout details require a bounded future deadline and debug captures use anonymous aliases', () => {
  const f = fixture(); let clock = 100;
  const debug = new WebAdminDebugCapture({ clock: () => clock });
  const [event] = f.read({ result: 'rejected', action: 'invalid_code', uses_consumed: 0, lockout: true, lockout_level: 2, locked_until: f.now + 30000 });
  assert.equal(event.remaining_seconds, 30);
  assert.equal(f.read({ result: 'rejected', action: 'invalid_code', uses_consumed: 0, lockout: true, lockout_level: 2, locked_until: f.now + 3600001 })[0].locked_until, undefined);
  debug.observe(event); assert.equal(debug.status().events.length, 0);
  debug.command({ action: 'start' }); debug.observe({ ...event, user: 'private-user', sensor: 'private-sensor', code: '1234' }); debug.observe(event);
  const status = debug.status(); assert.equal(status.events[1].event, 'event-1'); assert.equal(status.events[2].repeated_event_id, true);
  for (const forbidden of ['private-user', 'private-sensor', '1234', event.key]) assert.equal(JSON.stringify(status).includes(forbidden), false);
  clock += 600; debug.observe(event); assert.equal(debug.status().active, false); assert.equal(debug.status().events.length, 3);
  debug.command({ action: 'start' }); for (let i = 0; i < 250; i++) debug.observe(event);
  assert.equal(debug.status().events.length, 200); assert.equal(debug.status().dropped, 51);
  debug.command({ action: 'clear' }); assert.deepEqual(debug.status().events, []);
});
