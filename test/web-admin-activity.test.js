import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WebAdminActivity } from '../src/web-admin-activity.js';
const reference = JSON.parse(await readFile(new URL('./fixtures/web-admin-read-parity.json', import.meta.url)));
function fixture() {
  const data = structuredClone(reference), connected = new Map();
  const history = { scopes: async () => data.history.scopes, rows: async (gateway, alarm, limit) => {
    assert.equal(gateway, 'test'); assert.equal(limit, 5000); return data.history.rows[alarm];
  }, days: async () => 90 };
  const activity = new WebAdminActivity({ registrations: new Map([['test', { name: 'Synthetic gateway' }]]),
    catalog: new Map([['test', data.expected.inventory]]), connected, history });
  return { activity, data, connected, history };
}
test('activity options and rows match Python including offline historic alarms and category priority', async () => {
  const f = fixture();
  assert.deepEqual(await f.activity.options(), reference.history.options);
  assert.deepEqual(await f.activity.query(reference.history.query), reference.history.expected);
  const keypad = await f.activity.query({ gateway: 'test', alarm: 1, categories: ['keypad'] });
  assert.equal(keypad.rows.length, 1); assert.equal(keypad.rows[0].action, 'Disarm');
  const expired = await f.activity.query({ gateway: 'test', alarm: 3, categories: ['deconz'] });
  assert.equal(expired.rows[0].category, 'deconz'); assert.equal(expired.rows[0].alarm_name, 'Alarm 3');
  assert.equal(expired.connected, false); f.connected.set('test', true);
  assert.equal((await f.activity.query(reference.history.query)).connected, true);
});
test('history filters reject ambiguous or unknown scope and projection excludes private storage fields', async () => {
  const f = fixture();
  for (const body of [
    { gateway: null, alarm: 1, categories: [] }, { gateway: 'unknown', alarm: null, categories: [] },
    { gateway: 'test', alarm: 255, categories: [] }, { gateway: null, alarm: null, categories: ['keypad', 'keypad'] },
    { gateway: null, alarm: null, categories: ['unknown'] }, { gateway: null, alarm: null, categories: [], extra: true },
  ]) await assert.rejects(f.activity.query(body));
  f.data.history.rows[1][0].event_key = 'internal';
  f.data.history.rows[1][0].secret = 'synthetic-secret';
  assert.equal(JSON.stringify(await f.activity.query(reference.history.query)).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(await f.activity.query(reference.history.query)).includes('event_key'), false);
});
test('history remains bounded, sorts ties by sequence and cannot claim unavailable storage is empty', async () => {
  const f = fixture();
  f.data.history.rows[1] = Array.from({ length: 220 }, (_, i) => ({ ...f.data.history.rows[1][0], seq: i + 1 }));
  const result = await f.activity.query({ gateway: 'test', alarm: 1, categories: ['keypad', 'deconz', 'administration'] });
  assert.equal(result.rows.length, 200); assert.equal(result.rows[0].seq, 220);
  f.history.scopes = null; await assert.rejects(f.activity.options(), /operation_not_implemented/);
});
