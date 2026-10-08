import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WebAdminEditor } from '../src/web-admin-editor.js';
import { WebAdminView } from '../src/web-admin-view.js';
import { WebAdminTransactions } from '../src/web-admin-transactions.js';
import { webSchedulePolicy } from '../src/web-admin-schedule.js';

const reference = JSON.parse(await readFile(new URL('./fixtures/web-admin-read-parity.json', import.meta.url)));
function fixture() {
  const data = structuredClone(reference), calls = [], audit = [];
  let record = null;
  const client = {
    verify: async alarm => alarm ? data.capabilities[alarm] : { bridgeid: '0011223344556677' },
    request: async (path, method = 'GET', body) => {
      calls.push([method, path]);
      if (method === 'GET') { assert.ok(Object.hasOwn(data.responses, path), path); return structuredClone(data.responses[path]); }
      assert.equal(method, 'PUT'); assert.equal(path, '/alarmsystems/1/config');
      Object.assign(data.responses['/alarmsystems/1'].config, body);
      return Object.entries(body).map(([key, value]) => ({ success: { [path + '/' + key]: value } }));
    },
  };
  const transactions = new WebAdminTransactions({ store: { read: async () => structuredClone(record), write: async value => { record = structuredClone(value); } } });
  const view = new WebAdminView({ gatewayId: 'test', name: 'Synthetic gateway', alarm: 1, client });
  const editor = new WebAdminEditor({ view, identity: '0011223344556677', transactions,
    backup: { api_version: 1, save: async () => ({ schema: 1, credential_backup: false }) }, history: { add: async (...row) => audit.push(row) } });
  return { editor, view, client, data, calls, transactions, audit, record: () => structuredClone(record) };
}
for (const row of reference.plans) test('Python write plan: ' + row.name, async () => {
  const f = fixture();
  if (row.error) await assert.rejects(f.editor.plan(row.operation, structuredClone(row.body), structuredClone(row.snapshot)), error => error.message === row.error);
  else assert.deepEqual(await f.editor.plan(row.operation, structuredClone(row.body), structuredClone(row.snapshot)), row.expected);
  assert.ok(f.calls.every(([method]) => method === 'GET'));
});
for (const row of reference.schedules) test('Python schedule: ' + row.body.timezone + ' ' + row.body.expires_local, () => {
  if (row.error) assert.throws(() => webSchedulePolicy(row.body), error => error.message === row.error);
  else assert.deepEqual(webSchedulePolicy(row.body), row.expected);
});
test('one verified alarm write uses the durable boundary and creates a scoped audit entry', async () => {
  const f = fixture(), row = reference.plans.find(row => row.name === 'disarmed alarm timers');
  const result = await f.editor.dispatch('save_alarm', { ...structuredClone(row.body), backup_acknowledged: true });
  assert.equal(result.saved, true); assert.equal(f.record().stage, 'complete');
  assert.deepEqual(f.calls.filter(([method]) => method !== 'GET'), [['PUT', '/alarmsystems/1/config']]);
  assert.equal(f.audit.length, 1); assert.deepEqual(f.audit[0].slice(0, 4), ['test', 1, 'Administrator', 'Configuration']);
});
test('a changed policy after backup prevents delivery, while an uncertain reply remains held without automatic retry', async () => {
  const row = reference.plans.find(row => row.name === 'disarmed alarm timers'), input = () => ({ ...structuredClone(row.body), backup_acknowledged: true });
  const f = fixture(); f.editor.backup.save = async () => {
    f.data.responses['/alarmsystems/1'].config.armed_stay_entry_delay += 3;
    return { schema: 1, credential_backup: false };
  };
  await assert.rejects(f.editor.dispatch('save_alarm', input()), /transaction_recovery_required/);
  assert.equal(f.calls.some(([method]) => method !== 'GET'), false); assert.equal(f.record().write_attempted, false);
  const g = fixture(), original = g.client.request;
  g.client.request = async (...args) => { const result = await original(...args); if (args[1] === 'PUT') throw Error('Lost response'); return result; };
  await assert.rejects(g.editor.dispatch('save_alarm', input()), /transaction_recovery_required/);
  await assert.rejects(g.editor.dispatch('save_alarm', input()), /transaction_recovery_required/);
  assert.equal(g.calls.filter(([method]) => method !== 'GET').length, 1); assert.equal(g.audit.length, 0);
});
