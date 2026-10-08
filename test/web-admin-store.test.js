import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebAdminAccountStore } from '../src/web-admin-store.js';
import { WebAdminAuth } from '../src/web-admin-auth.js';

const password = 'synthetic-admin-password';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-admin-accounts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'deconz-keypad-admin');
  await mkdir(directory, { mode: 0o700 });
  return { root, filename: path.join(directory, 'web-accounts.json'), store: new WebAdminAccountStore(root) };
}

test('trusted initialization persists a private verifier and login survives process-state replacement', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.read(), /web_account_setup_required/);
  assert.deepEqual(await f.store.initialize('Owner', password), { configured: true });
  const raw = await readFile(f.filename, 'utf8');
  assert.equal(raw.includes(password), false);
  assert.equal((await stat(f.filename)).mode & 0o777, 0o600);
  const auth = new WebAdminAuth({ store: new WebAdminAccountStore(f.root) });
  const token = await auth.login('Owner', password);
  assert.equal((await auth.session(token)).role, 'admin');
  await assert.rejects(f.store.initialize('SomeoneElse', password), /web_account_already_configured/);
  assert.equal(await readFile(f.filename, 'utf8'), raw);
});

test('competing initialization has one winner and never overwrites an existing account', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.store.initialize('One', password), f.store.initialize('Two', password)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal((await f.store.read()).accounts[0].username, 'One');
});

test('queued revision writes accept one winner and snapshot input before it can change', async t => {
  const f = await fixture(t); await f.store.initialize('Owner', password);
  const one = await f.store.read(); one.revision++; one.accounts[0].username = 'One';
  const two = structuredClone(one); two.accounts[0].username = 'Two';
  const first = f.store.write({ expectedRevision: 1, record: one });
  one.accounts[0].username = 'MutatedAfterSubmit';
  const results = await Promise.allSettled([first, f.store.write({ expectedRevision: 1, record: two })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal((await f.store.read()).accounts[0].username, 'One');
  await assert.rejects(f.store.write({ expectedRevision: 2, record: two }), /web_account_changed/);
});

test('invalid or shared storage is held for review and cannot be silently initialized', async t => {
  const f = await fixture(t);
  await writeFile(f.filename, 'interrupted-json', { mode: 0o600 });
  await assert.rejects(f.store.initialize('Owner', password), /private_storage_invalid/);
  assert.equal(await readFile(f.filename, 'utf8'), 'interrupted-json');
  await rm(f.filename); await f.store.initialize('Owner', password);
  await chmod(f.filename, 0o644);
  await assert.rejects(f.store.read(), /private_storage_invalid/);
  await assert.rejects(f.store.initialize('Replacement', password), /private_storage_invalid/);
});

test('account-store symlinks are rejected without touching their targets', async t => {
  const f = await fixture(t), target = path.join(f.root, 'unrelated.json');
  await writeFile(target, 'keep this file', { mode: 0o600 });
  await symlink(target, f.filename);
  await assert.rejects(f.store.initialize('Owner', password), /private_storage_invalid/);
  assert.equal(await readFile(target, 'utf8'), 'keep this file');
});
