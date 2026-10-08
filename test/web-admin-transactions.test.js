import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebAdminTransactions, WebAdminTransactionStore } from '../src/web-admin-transactions.js';
import { WebGatewayRejected } from '../src/web-admin-gateway.js';
import { webDigest } from '../src/web-admin-files.js';

const context = { gateway: 'test', identity: '0011223344556677', alarm: 1, operation: 'save_alarm' };
function fixture(options = {}) {
  let record = null, now = 0, writes = 0;
  const events = [], snapshots = [];
  const store = { read: async () => structuredClone(record), write: async tx => { record = structuredClone(tx); snapshots.push(structuredClone(tx)); events.push('journal:' + tx.stage); } };
  const participant = { api_version: 1, preflight: async () => events.push('preflight'), pause: async tx => {
    assert.ok(record.paused.includes('controller')); assert.equal(record.id, tx.id); events.push('pause');
  }, verify: async () => events.push('participant verify'), resume: async () => events.push('resume') };
  const transactions = new WebAdminTransactions({ store, participants: new Map([['controller', participant]]), clock: () => now, ...options });
  const input = { context, snapshot: { state: 'synthetic' }, intent: { kind: 'timings', alarm: 1, sensitive: false, expected: {} },
    backup: { api_version: 1, save: async () => { events.push('backup'); return { schema: 1, credential_backup: false }; } },
    validateAgain: async () => { events.push('revalidate'); return true; },
    write: async () => { assert.equal(record.stage, 'writing'); assert.equal(record.write_attempted, true); writes++; events.push('write'); return {}; },
    verify: async () => { events.push('readback'); return input.intent; }, credential: 'synthetic-never-journal-credential' };
  return { transactions, input, store, participant, events, snapshots, writes: () => writes, record: () => structuredClone(record), advance: n => { now += n; } };
}
const confirmation = review => ({ transaction_id: review.transaction_id, token: review.token, reviewed: true });

test('durable intent and policy backup precede the single write; only verified state resumes participants', async () => {
  const f = fixture(); const result = await f.transactions.execute(f.input);
  assert.equal(result.saved, true); assert.equal(f.writes(), 1); assert.equal(f.record().stage, 'complete');
  assert.ok(f.events.indexOf('backup') < f.events.indexOf('write'));
  assert.ok(f.events.indexOf('revalidate') < f.events.indexOf('write'));
  assert.ok(f.events.indexOf('participant verify') < f.events.indexOf('resume'));
  assert.equal(JSON.stringify(f.snapshots).includes(f.input.credential), false);
  assert.deepEqual((await f.transactions.status('test')).outcome, 'applied');
});
test('lost reply holds subsequent changes and reviewed non-sensitive readback resolves without replay', async () => {
  const f = fixture(), actualWrite = f.input.write;
  f.input.write = async () => { await actualWrite(); throw Error('Lost reply'); };
  await assert.rejects(f.transactions.execute(f.input), /transaction_recovery_required/);
  assert.equal(f.record().stage, 'recovery_required'); assert.equal(f.events.includes('resume'), false);
  await assert.rejects(f.transactions.execute(f.input), /transaction_recovery_required/); assert.equal(f.writes(), 1);
  const review = await f.transactions.review('test', context.identity, async () => true);
  assert.equal(review.ready, true);
  const result = await f.transactions.recover('test', context.identity, confirmation(review), async () => true);
  assert.equal(result.gateway_write_replayed, false); assert.equal(f.writes(), 1);
});
test('policy readback cannot prove an uncertain PIN update; evidence must come from the trusted adapter', async () => {
  const f = fixture(); f.input.context = { ...context, operation: 'rotate_pin' }; f.input.intent = { kind: 'identity', sensitive: true };
  f.input.verify = async () => { throw Error('Response/readback uncertain'); };
  await assert.rejects(f.transactions.execute(f.input), /transaction_recovery_required/);
  const review = await f.transactions.review('test', context.identity, async () => true);
  assert.equal(review.ready, false); assert.equal(review.token, null);
  await assert.rejects(f.transactions.recover('test', context.identity, { ...confirmation(review), verified: true }, async () => true), /recovery_confirmation_required/);
  f.transactions.evidence = { api_version: 1, verify: async () => true };
  const fresh = await f.transactions.review('test', context.identity, async () => true);
  assert.equal(fresh.ready, true); assert.equal(f.writes(), 1);
});
test('preflight failure does not pause; a failed pause was journaled and can be recovered as not sent', async () => {
  const f = fixture(); f.participant.preflight = async () => { throw Error('No readiness'); };
  await assert.rejects(f.transactions.execute(f.input), /maintenance_preflight_failed/);
  assert.equal(f.record(), null); assert.equal(f.writes(), 0);
  const g = fixture(); g.participant.pause = async tx => { assert.deepEqual(g.record().paused, ['controller']); throw Error('Pause uncertain'); };
  await assert.rejects(g.transactions.execute(g.input), /transaction_recovery_required/);
  assert.equal((await g.transactions.status('test')).outcome, 'not_sent');
  assert.equal((await g.transactions.review('test', context.identity, async () => false)).ready, true);
});
test('journal failure before delivery prevents a write and holds all further work', async () => {
  const f = fixture(), persist = f.store.write;
  f.store.write = async tx => { await persist(tx); if (tx.stage === 'writing') throw Error('Directory sync uncertain'); };
  await assert.rejects(f.transactions.execute(f.input), /transaction_storage_review_required/);
  assert.equal(f.writes(), 0); assert.equal(f.events.includes('resume'), false);
  await assert.rejects(f.transactions.execute(f.input), /transaction_storage_review_required/);
  const restarted = new WebAdminTransactions({ store: f.store, participants: new Map([['controller', f.participant]]) });
  assert.equal((await restarted.status('test')).outcome, 'unknown');
  await assert.rejects(restarted.guard('test'), /transaction_recovery_required/);
});
test('definite gateway rejection completes maintenance without claiming a saved change', async () => {
  const f = fixture(); f.input.write = async () => { throw new WebGatewayRejected('revision_conflict', true); };
  const result = await f.transactions.execute(f.input);
  assert.equal(result.saved, false); assert.equal(result.rejected, 'revision_conflict');
  assert.equal(f.record().stage, 'complete'); assert.equal((await f.transactions.status('test')).outcome, 'rejected');
});
test('missing participants after restart cannot release a maintenance hold', async () => {
  const f = fixture(); f.participant.resume = async () => { throw Error('Resume failed'); };
  await assert.rejects(f.transactions.execute(f.input), /transaction_recovery_required/);
  const restarted = new WebAdminTransactions({ store: f.store });
  assert.equal((await restarted.status('test')).participants_available, false);
  await assert.rejects(restarted.review('test', context.identity, async () => true), /registered_maintenance_participant_unavailable/);
});
test('recovery review expires, is consumed once, and rechecks current evidence', async () => {
  const f = fixture(); f.input.validateAgain = async () => false;
  await assert.rejects(f.transactions.execute(f.input), /transaction_recovery_required/);
  const old = await f.transactions.review('test', context.identity, async () => true); f.advance(120);
  await assert.rejects(f.transactions.recover('test', context.identity, confirmation(old), async () => true), /recovery_review_expired/);
  f.participant.recovery_ready = async () => true;
  const changed = await f.transactions.review('test', context.identity, async () => true);
  f.participant.recovery_ready = async () => false;
  await assert.rejects(f.transactions.recover('test', context.identity, confirmation(changed), async () => true), /recovery_evidence_changed/);
  f.participant.recovery_ready = async () => true;
  await assert.rejects(f.transactions.recover('test', context.identity, confirmation(changed), async () => true), /recovery_review_expired/);
});
test('credentials are rejected from snapshots and concurrent maintenance is not queued for replay', async () => {
  const f = fixture(); await assert.rejects(f.transactions.execute({ ...f.input, snapshot: { pin: '1234' } }), /journal_credentials_forbidden/);
  assert.equal(f.record(), null);
  let release, started; const ready = new Promise(resolve => { started = resolve; });
  f.input.validateAgain = async () => { started(); await new Promise(resolve => { release = resolve; }); return true; };
  const first = f.transactions.execute(f.input); await ready;
  await assert.rejects(f.transactions.execute(f.input), /transaction_in_progress/); release(); await first; assert.equal(f.writes(), 1);
});
test('transaction persistence survives restart, uses private modes, and rejects shared/corrupt/symlink files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'web-tx-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'deconz-keypad-admin'); await mkdir(directory, { mode: 0o700 });
  const store = new WebAdminTransactionStore(root), f = fixture();
  await f.transactions.execute(f.input); await store.write(f.record());
  const filename = path.join(directory, 'web-transaction-test.json');
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  const restarted = new WebAdminTransactions({ store, participants: new Map([['controller', f.participant]]) });
  assert.equal((await restarted.status('test')).stage, 'complete');
  await chmod(filename, 0o644); await assert.rejects(store.read('test'), /web_private_storage_invalid/); await chmod(filename, 0o600);
  const raw = await readFile(filename, 'utf8'); await writeFile(filename, raw.replace('"schema":1', '"schema":1,"schema":1'));
  await assert.rejects(store.read('test'), /web_private_storage_invalid/);
  await rm(filename); const target = path.join(root, 'untouched'); await writeFile(target, 'untouched'); await symlink(target, filename);
  await assert.rejects(store.write(f.record()), /web_private_storage_write_failed/); assert.equal(await readFile(target, 'utf8'), 'untouched');
});
test('policy digest matches Python compact ASCII JSON for Unicode data', () => {
  assert.equal(webDigest({ name: 'Jos\u00e9 \ud83d\ude00', rows: [true, null, 7] }), 'bd6f1231eaa6e8f4a361cf197bfe861cec6521cafada757e21818e6805a003f6');
});
