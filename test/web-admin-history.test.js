import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WebAdminHistory } from '../src/web-admin-history.js';

const reference = JSON.parse(await readFile(new URL('./fixtures/web-admin-read-parity.json', import.meta.url)));
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'web-history-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'deconz-keypad-admin'); await mkdir(directory, { mode: 0o700 });
  const registrations = new Map([['test', { identity: '0011223344556677' }]]); let now = Date.parse('2099-01-01T12:00:00Z');
  const create = () => new WebAdminHistory(root, registrations, { clock: () => now });
  return { root, directory, registrations, create, history: create(), advance: n => { now += n; }, now: () => now };
}
test('durable scoped history matches Python rows and survives restart with private permissions', async t => {
  const f = await fixture(t);
  for (const scope of reference.history.scopes) for (const row of [...reference.history.rows[scope.alarm]].reverse()) {
    await f.history.add(scope.gateway, scope.alarm, row.user, row.source, row.action, row.result, null, row.time);
  }
  const restarted = f.create();
  for (const scope of reference.history.scopes) assert.deepEqual(await restarted.rows(scope.gateway, scope.alarm, 5000), reference.history.rows[scope.alarm]);
  assert.deepEqual(await restarted.scopes(), reference.history.scopes);
  assert.equal((await stat(path.join(f.directory, 'web-activity-test-alarm-1.sqlite'))).mode & 0o777, 0o600);
});
test('clear ignores delayed old events but never permits reuse of a virtual keypad request ID', async t => {
  const f = await fixture(t), id = 'a'.repeat(32), stamp = new Date(f.now()).toISOString();
  assert.equal(await f.history.reserveRequest('test', 1, id), true);
  await f.history.add('test', 1, 'Owner', 'Keypad', 'Request', 'Accepted', 'event-1', stamp);
  f.advance(1000); await f.history.clear('test', 1);
  await f.history.add('test', 1, 'Owner', 'Keypad', 'Request', 'Accepted', 'delayed', stamp);
  assert.deepEqual(await f.history.rows('test', 1), []);
  const restarted = f.create(); assert.equal(await restarted.reserveRequest('test', 1, id), false);
  f.advance(1000); await restarted.add('test', 1, 'Owner', 'Keypad', 'Request', 'Accepted', 'event-2');
  await restarted.add('test', 1, 'Owner', 'Keypad', 'Request', 'Accepted', 'event-2');
  assert.equal((await restarted.rows('test', 1)).length, 1);
  assert.equal((await stat(path.join(f.directory, 'web-keypad-requests.sqlite'))).mode & 0o777, 0o600);
});
test('retention changes need a fresh revision and explicit shortening confirmation', async t => {
  const f = await fixture(t); await f.history.add('test', 1, 'Owner', 'Keypad', 'Request', 'Accepted');
  f.advance(2 * 86400000); assert.equal((await f.history.rows('test', 1)).length, 1);
  await assert.rejects(f.history.setDays({ days: 1, expected_days: 90, confirmed: false }), /history_confirmation_required/);
  await f.history.setDays({ days: 1, expected_days: 90, confirmed: true });
  assert.equal((await f.history.rows('test', 1)).length, 0);
  await assert.rejects(f.history.setDays({ days: 7, expected_days: 90, confirmed: true }), /history_retention_changed_reload/);
  assert.equal(await f.create().days(), 1);
});
test('lockout episodes deduplicate, group adjacent blocked requests and split after other activity or restart', async t => {
  const f = await fixture(t), deadline = f.now() + 60000;
  const event = key => ({ key, sensor: '30', timestamp: new Date(f.now()).toISOString(), locked_until: deadline, remaining_seconds: 60, level: 1, keypad_label: 'Synthetic keypad' });
  await f.history.lockoutEvent('test', 1, event('one')); await f.history.lockoutEvent('test', 1, event('one'));
  f.advance(1000); await f.history.lockoutEvent('test', 1, event('two'));
  f.advance(1000); await f.history.lockoutEvent('test', 1, event('three'));
  let rows = await f.history.rows('test', 1); assert.equal(rows.length, 2); assert.match(rows[0].result, /^2 keypad request\(s\) blocked/);
  await f.history.add('test', 2, 'Other', 'deCONZ', 'Intervening event', 'Observed');
  f.advance(1000); await f.history.lockoutEvent('test', 1, event('four'));
  assert.equal((await f.history.rows('test', 1)).length, 3);
  const restarted = f.create(); f.advance(1000); await restarted.lockoutEvent('test', 1, event('five'));
  assert.equal((await restarted.rows('test', 1)).length, 4);
  f.advance(60000); const pending = await restarted.dueLockouts('test', 1); assert.equal(pending.length, 1);
  await restarted.lockoutVerification('test', 1, pending[0].episode, false);
  await restarted.lockoutVerification('test', 1, pending[0].episode, false);
  assert.equal((await restarted.rows('test', 1)).filter(row => row.action === 'Lockout status unavailable').length, 1);
  assert.equal((await restarted.dueLockouts('test', 1)).length, 1);
  await restarted.lockoutVerification('test', 1, pending[0].episode, true);
  assert.equal((await restarted.dueLockouts('test', 1)).length, 0);
});
test('identity reassignment and symlinked database files fail without reading another gateway history', async t => {
  const f = await fixture(t); await f.history.add('test', 1, 'Owner', 'Keypad', 'Request', 'Accepted');
  f.registrations.set('test', { identity: 'FFEEDDCCBBAA9988' });
  await assert.rejects(f.create().rows('test', 1), /history_gateway_identity_changed/);
  const outside = path.join(f.root, 'untouched'); await writeFile(outside, 'untouched');
  await symlink(outside, path.join(f.directory, 'web-activity-test-alarm-3.sqlite'));
  await assert.rejects(f.history.rows('test', 3), /history_storage_unavailable/);
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
});
