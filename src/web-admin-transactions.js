// Port of the standalone durable maintenance boundary. A gateway write is
// issued once, after the journal records intent. Recovery never repeats it.
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebAdminError } from './web-admin-auth.js';
import { WebGatewayRejected } from './web-admin-gateway.js';
import { requireWeb, object, exact, integer } from './web-admin-common.js';
import { WebAdminFiles, webDigest } from './web-admin-files.js';

const gatewayId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
const stages = ['preparing', 'writing', 'verified', 'resuming', 'recovery_required', 'complete'];
const operations = ['save_user', 'delete_user', 'rotate_pin', 'save_alarm', 'save_lockout', 'reset_lockout', 'keypad_send'];
export function webJournalWithoutSecrets(value, depth = 0) {
  requireWeb(depth <= 64, 'invalid_journal_payload');
  if (!value || typeof value !== 'object') return;
  for (const [key, row] of Object.entries(value)) {
    requireWeb(!['pin', 'new_pin', 'repeat_pin', 'code', 'code0', 'password', 'key', 'token', 'credential'].includes(key.toLowerCase()), 'journal_credentials_forbidden');
    webJournalWithoutSecrets(row, depth + 1);
  }
}
export function validateWebTransaction(tx, gateway = tx?.gateway) {
  requireWeb(object(tx) && tx.schema === 1 && gatewayId(gateway) && tx.gateway === gateway && typeof tx.id === 'string' && /^[0-9a-f]{32}$/.test(tx.id) &&
    typeof tx.identity === 'string' && /^[0-9A-F]{16}$/.test(tx.identity) && integer(tx.alarm, 1, 255) && operations.includes(tx.operation) && stages.includes(tx.stage) &&
    typeof tx.write_attempted === 'boolean' && typeof tx.verified === 'boolean' && object(tx.intent) && object(tx.participants) && Array.isArray(tx.paused) &&
    Object.entries(tx.participants).every(([name, version]) => gatewayId(name) && version === 1) && new Set(tx.paused).size === tx.paused.length && tx.paused.every(name => Object.hasOwn(tx.participants, name)) &&
    typeof tx.snapshot_digest === 'string' && /^[0-9a-f]{64}$/.test(tx.snapshot_digest), 'transaction_invalid');
  webJournalWithoutSecrets(tx); return tx;
}
export class WebAdminTransactionStore {
  constructor(storagePath) { this.files = new WebAdminFiles(storagePath); }
  name(gateway) { requireWeb(gatewayId(gateway), 'invalid_gateway'); return 'web-transaction-' + gateway + '.json'; }
  read(gateway) { return this.files.read(this.name(gateway), tx => validateWebTransaction(tx, gateway)); }
  write(tx) { return this.files.write(this.name(tx.gateway), tx, validateWebTransaction); }
}
export class WebAdminTransactions {
  constructor({ store, participants = new Map(), evidence, enrollmentGuard = async () => {}, clock = () => performance.now() / 1000 }) {
    for (const [name, participant] of participants) requireWeb(gatewayId(name) && participant.api_version === 1 && ['preflight', 'pause', 'verify', 'resume'].every(method => typeof participant[method] === 'function'), 'maintenance_participant_incompatible');
    Object.assign(this, { store, participants, evidence, enrollmentGuard, clock });
    this.reviews = new Map(); this.busy = false; this.storageUncertain = false;
  }
  async locked(gateway, operation) {
    requireWeb(gatewayId(gateway), 'invalid_gateway'); requireWeb(!this.busy, 'transaction_in_progress');
    requireWeb(!this.storageUncertain, 'transaction_storage_review_required');
    this.busy = true; try { return await operation(); } finally { this.busy = false; }
  }
  async load(gateway) { requireWeb(gatewayId(gateway), 'invalid_gateway'); const value = await this.store.read(gateway); return value ? validateWebTransaction(value, gateway) : null; }
  async save(tx) {
    validateWebTransaction(tx);
    try { await this.store.write(structuredClone(tx)); }
    catch { this.storageUncertain = true; throw new WebAdminError('transaction_storage_review_required'); }
  }
  required(tx) {
    requireWeb(Object.entries(tx.participants).every(([name, version]) => this.participants.get(name)?.api_version === version), 'registered_maintenance_participant_unavailable');
    return Object.keys(tx.participants).map(name => this.participants.get(name));
  }
  async guard(gateway) {
    requireWeb(!this.storageUncertain, 'transaction_storage_review_required'); await this.enrollmentGuard();
    const tx = await this.load(gateway);
    if (tx && tx.stage !== 'complete') { this.required(tx); throw new WebAdminError('transaction_recovery_required'); }
  }
  async status(gateway) {
    requireWeb(!this.storageUncertain, 'transaction_storage_review_required');
    const tx = await this.load(gateway); if (!tx) return { stage: 'none' };
    return { ...Object.fromEntries(['id', 'stage', 'operation', 'alarm', 'write_attempted', 'verified'].map(key => [key, tx[key]])),
      participants_available: Object.entries(tx.participants).every(([name, version]) => this.participants.get(name)?.api_version === version), automatic_retry: false,
      homebridge: Object.hasOwn(tx.participants, 'homebridge'), outcome: !tx.write_attempted ? 'not_sent' : tx.definite_rejection ? 'rejected' : tx.verified ? tx.intent.outcome ?? 'applied' : 'unknown' };
  }
  async execute({ context, backup, snapshot, intent, validateAgain, write, verify, credential }) {
    webJournalWithoutSecrets(context); webJournalWithoutSecrets(intent); webJournalWithoutSecrets(snapshot);
    const immutable = structuredClone({ context, snapshot, intent });
    return this.locked(context.gateway, async () => {
      context = immutable.context; snapshot = immutable.snapshot; intent = immutable.intent;
      await this.guard(context.gateway);
      for (const participant of this.participants.values()) await participant.guard?.();
      const selected = new Map();
      for (const [name, participant] of this.participants) if (!participant.applies || await participant.applies(structuredClone(context))) selected.set(name, participant);
      context = { ...context, maintenance_participants: [...selected.keys()] };
      try { for (const participant of selected.values()) await participant.preflight(structuredClone(context)); }
      catch { throw new WebAdminError('maintenance_preflight_failed'); }
      const tx = { ...context, schema: 1, id: randomBytes(16).toString('hex'), stage: 'preparing', participants: Object.fromEntries([...selected].map(([name, participant]) => [name, participant.api_version])),
        intent, paused: [], write_attempted: false, verified: false, snapshot_digest: webDigest(snapshot), backup: null };
      await this.save(tx); // Durable before any participant is paused.
      try {
        for (const [name, participant] of selected) { tx.paused.push(name); await this.save(tx); await participant.pause(structuredClone(tx)); }
        if (backup) {
          requireWeb(backup.api_version === 1, 'backup_adapter_incompatible'); tx.backup = await backup.save(context, snapshot); await this.save(tx);
          requireWeb(object(tx.backup) && tx.backup.schema === 1 && typeof tx.backup.credential_backup === 'boolean', 'backup_receipt_invalid');
        }
        requireWeb(await validateAgain(), 'settings_changed_refresh');
        if (this.evidence?.prepare) await this.evidence.prepare(structuredClone(tx), credential);
        tx.stage = 'writing'; tx.write_attempted = true; await this.save(tx);
        let result;
        try { result = await write(); }
        catch (error) {
          if (!(error instanceof WebGatewayRejected) || !error.definite) throw error;
          tx.definite_rejection = true; tx.rejection = error.message; tx.verified = true; tx.stage = 'verified'; await this.save(tx); await this.finish(tx);
          return { saved: false, transaction_id: tx.id, rejected: error.message };
        }
        tx.intent = await verify(result); webJournalWithoutSecrets(tx.intent);
        tx.verified = true; tx.stage = 'verified'; await this.save(tx); await this.finish(tx);
        return { saved: true, transaction_id: tx.id, verification: 'gateway_response_and_readback' };
      } catch {
        // Persistence failure is an additional in-memory hold. Never overwrite
        // that uncertainty by attempting another save or releasing participants.
        if (this.storageUncertain) throw new WebAdminError('transaction_storage_review_required');
        tx.stage = 'recovery_required'; await this.save(tx); throw new WebAdminError('transaction_recovery_required');
      }
    });
  }
  async finish(tx) {
    this.required(tx);
    for (const name of tx.paused) await this.participants.get(name).verify(structuredClone(tx));
    tx.stage = 'resuming'; await this.save(tx);
    for (const name of [...tx.paused].reverse()) await this.participants.get(name).resume(structuredClone(tx));
    tx.stage = 'complete'; await this.save(tx);
    for (const name of tx.paused) await this.participants.get(name).complete?.(structuredClone(tx));
  }
  async canResolve(tx, inspect) {
    for (const participant of this.required(tx)) if (participant.recovery_ready && await participant.recovery_ready(structuredClone(tx)) !== true) return false;
    if (!tx.write_attempted || tx.definite_rejection === true) return true;
    if (tx.verified && tx.intent.kind === 'command') return true;
    if (await inspect(structuredClone(tx.intent)) && (tx.verified || tx.intent.sensitive !== true)) return true;
    if (this.evidence) {
      requireWeb(this.evidence.api_version === 1, 'recovery_adapter_incompatible');
      try { return await this.evidence.verify(structuredClone(tx)) === true; } catch { throw new WebAdminError('recovery_evidence_unavailable'); }
    }
    return false;
  }
  review(gateway, identity, inspect) {
    return this.locked(gateway, async () => {
      const tx = await this.load(gateway); requireWeb(tx && tx.stage !== 'complete' && tx.identity === identity, 'no_matching_transaction');
      const ready = await this.canResolve(tx, inspect), token = ready ? randomBytes(24).toString('hex') : null, now = this.clock();
      for (const [key, value] of this.reviews) if (value.gateway === gateway || now >= value.expires) this.reviews.delete(key);
      if (ready) this.reviews.set(token, { gateway, id: tx.id, digest: webDigest(tx), expires: now + 120 });
      return { transaction_id: tx.id, ready, token, reason: ready ? 'review_required' : 'external_verification_required', automatic_retry: false };
    });
  }
  async recover(gateway, identity, body, inspect) {
    requireWeb(exact(body, ['transaction_id', 'token', 'reviewed']) && body.reviewed === true, 'recovery_confirmation_required');
    return this.locked(gateway, async () => {
      const tx = await this.load(gateway), review = this.reviews.get(body.token); this.reviews.delete(body.token);
      requireWeb(tx && review && review.gateway === gateway && review.id === body.transaction_id && tx.id === body.transaction_id && tx.identity === identity && review.digest === webDigest(tx) && this.clock() < review.expires, 'recovery_review_expired');
      requireWeb(await this.canResolve(tx, inspect), 'recovery_evidence_changed'); tx.verified = true;
      try { await this.finish(tx); }
      catch { if (!this.storageUncertain) { tx.stage = 'recovery_required'; await this.save(tx); } throw new WebAdminError(this.storageUncertain ? 'transaction_storage_review_required' : 'transaction_recovery_required'); }
      return { recovered: true, transaction_id: tx.id, gateway_write_replayed: false };
    });
  }
}
