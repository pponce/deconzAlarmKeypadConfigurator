import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WebAdminView } from '../src/web-admin-view.js';
const reference = JSON.parse(await readFile(new URL('./fixtures/web-admin-read-parity.json', import.meta.url)));
function fixture() {
  const data = structuredClone(reference), calls = [];
  const client = {
    verify: async aid => { calls.push(['verify', aid]); return aid ? data.capabilities[aid] : { bridgeid: '0011223344556677' }; },
    request: async (path, method = 'GET') => {
      assert.equal(method, 'GET'); calls.push(['GET', path]); assert.ok(Object.hasOwn(data.responses, path), path); return structuredClone(data.responses[path]);
    },
  };
  const view = new WebAdminView({ gatewayId: 'test', name: 'Synthetic gateway', alarm: 1, client,
    transactionStatus: async () => ({ stage: 'none' }) });
  return { view, data, calls };
}
for (const method of ['inventory', 'alarm', 'users', 'lockout', 'snapshot', 'administration']) {
  test(method + ' matches captured Python reference output without mutations', async () => {
    const { view, calls } = fixture(); assert.equal(calls.length, 0);
    const actual = await view[method](); assert.deepEqual(actual, reference.expected[method]);
    assert.equal(JSON.stringify(actual).includes('synthetic-never-project'), false);
  });
}
test('ambiguous keypad radio identity does not claim a lockout belongs to either device', async () => {
  const { view, data } = fixture(); data.responses['/sensors']['5'] = { ...data.responses['/sensors']['3'], name: 'Duplicate radio' };
  const result = await view.lockout();
  for (const row of result.keypads.filter(row => ['3', '5'].includes(row.id))) {
    assert.equal(row.known, false); assert.equal(row.level, null); assert.equal(row.remaining_seconds, null);
  }
  assert.equal(result.unmatched_keypads.length, 2);
  assert.equal(JSON.stringify(result).includes('11223344556677'), false);
});
test('invalid alarm IDs and duplicate lockout addresses fail rather than projecting misleading state', async () => {
  const f = fixture(); f.data.responses['/alarmsystems']['256'] = {};
  await assert.rejects(f.view.inventory(), /gateway_response_invalid/);
  const g = fixture(), path = '/alarmsystems/1/users/lockout';
  g.data.responses[path].keypads.push({ ...g.data.responses[path].keypads[0], source: '0011223344556677' });
  await assert.rejects(g.view.lockout(), /gateway_response_invalid/);
});
