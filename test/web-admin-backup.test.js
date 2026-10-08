import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WebAdminPolicyBackup } from '../src/web-admin-backup.js';

const context = { identity: '0011223344556677' }, snapshot = { identities: {}, grants: {} };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'web-backup-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'deconz-keypad-admin'), { mode: 0o700 });
  let now = 1000; const notices = [];
  const backup = new WebAdminPolicyBackup(root, { clock: () => now++, cleanupNotice: value => notices.push(value) });
  return { root, backup, notices, setClock: value => { now = value; } };
}
test('automatic policy snapshots retain the latest twenty per identity, including a backwards clock', async t => {
  const f = await fixture(t), created = [];
  for (let i = 0; i < 21; i++) created.push(await f.backup.save(context, snapshot));
  const root = await f.backup.directory(); assert.equal((await readdir(root)).length, 20);
  await assert.rejects(stat(path.join(root, created[0].snapshot)), { code: 'ENOENT' });
  f.setClock(1); const latest = await f.backup.save(context, snapshot);
  assert.equal((await readdir(root)).length, 20); assert.ok((await stat(path.join(root, latest.snapshot))).isDirectory());
  assert.equal(latest.credential_backup, false); assert.equal(latest.automatic_restore, false);
  assert.equal((await stat(path.join(root, latest.snapshot, 'policy.json'))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, latest.snapshot, 'policy.json'), 'utf8')), { schema: 1, gateway_identity: context.identity, policy: snapshot });
  const other = await f.backup.save({ identity: 'FFEEDDCCBBAA9988' }, snapshot);
  assert.equal((await readdir(root)).length, 21); assert.ok((await stat(path.join(root, other.snapshot))).isDirectory());
});
test('retention preserves marked, partial, changed, symlinked and unrelated directories', async t => {
  const f = await fixture(t), root = await f.backup.directory();
  const marked = await f.backup.save(context, snapshot); await writeFile(path.join(root, marked.snapshot, '.keep'), 'retain');
  const changed = await f.backup.save(context, snapshot); await writeFile(path.join(root, changed.snapshot, 'policy.json'), '{}');
  const partial = 'web-policy-' + 'f'.repeat(32); await mkdir(path.join(root, partial), { mode: 0o700 });
  const outside = path.join(f.root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'untouched'), 'untouched');
  const linked = 'web-policy-' + 'e'.repeat(32); await symlink(outside, path.join(root, linked));
  await mkdir(path.join(root, 'migration-backup'), { mode: 0o700 });
  for (let i = 0; i < 22; i++) await f.backup.save(context, snapshot);
  for (const name of [marked.snapshot, changed.snapshot, partial, linked, 'migration-backup']) assert.ok((await readdir(root)).includes(name));
  assert.equal(await readFile(path.join(outside, 'untouched'), 'utf8'), 'untouched');
});
test('a credential-bearing snapshot is rejected before any backup is created', async t => {
  const f = await fixture(t);
  await assert.rejects(f.backup.save(context, { nested: { new_pin: '1234' } }), /journal_credentials_forbidden/);
  assert.deepEqual(await readdir(path.join(f.root, 'deconz-keypad-admin')), []);
});
