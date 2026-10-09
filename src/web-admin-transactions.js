// Port of the standalone durable maintenance boundary. A gateway write is
// issued once, after the journal records intent. Recovery never repeats it.
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebAdminError } from './web-admin-auth.js';
import { WebGatewayRejected } from './web-admin-gateway.js';
import { requireWeb, object, exact, integer } from './web-admin-common.js';
import { WebAdminFiles, webDigest } from './web-admin-files.js';

const failureReasons = new Set(['homebridge_binding_changed', 'homebridge_child_not_running', 'homebridge_binding_invalid', 'homebridge_cli_unavailable', 'homebridge_cli_discovery_failed', 'homebridge_pin_write_unverified', 'homebridge_ui_result_unknown', 'homebridge_ui_response_invalid', 'homebridge_restart_unverified',
  'homebridge_process_unverified', 'homebridge_process_changed', 'homebridge_file_unavailable', 'homebridge_cache_schema_unsupported',
  'homebridge_accessory_identity_changed', 'homebridge_backup_invalid', 'homebridge_configuration_changed', 'homebridge_login_required',
  'web_private_storage_write_failed', 'web_private_storage_invalid', 'web_private_storage_too_large', 'homebridge_storage_review_required',
  'homebridge_cache_changed', 'homebridge_saved_pin_unverified', 'homebridge_gateway_revision_changed', 'maintenance_devices_require_review',
  'controller_busy', 'controller_held', 'controller_unavailable', 'maintenance_held', 'maintenance_transaction_conflict',
  'maintenance_verification_required', 'physical_confirmation_required', 'physical_preparation_required',
  'door_read_failed', 'door_response_invalid', 'door_blocked', 'bolt_read_failed', 'bolt_unreachable', 'bolt_response_invalid',
  'bolt_gateway_identity_mismatch', 'bolt_resource_identity_mismatch', 'bolt_feedback_mismatch',
  'motor_not_idle', 'relay_not_idle', 'homebridge_cache_owner_unavailable', 'homebridge_file_permissions_invalid',
  'homebridge_cache_write_unverified', 'homebridge_alarm_inventory_unavailable', 'homebridge_alarm_mapping_changed',
  'homebridge_gateway_identity_changed', 'homebridge_user_must_remain_unrestricted', 'private_storage_write_failed',
  'homebridge_alarm_api_unavailable', 'homebridge_alarm_api_not_ready', 'homebridge_alarm_api_response_invalid',
  'gateway_result_unknown_no_retry', 'gateway_response_invalid', 'gateway_identity_changed',
  'maintenance_step_failed']);
const failureReason = error => failureReasons.has(error?.message) ? error.message : 'maintenance_step_failed';
const failureSteps = new Set(['pause', 'backup', 'revalidate', 'credential_evidence', 'gateway_write', 'gateway_readback', 'verify', 'resume', 'complete']);
const failureParticipants = new Set(['homebridge', 'coordinator', 'controller', 'gateway', 'backup', 'integration']);
const failureKinds = new Set(['coded_error', 'permission_denied', 'missing_file', 'io_error', 'type_error', 'unexpected_error']);
function failureKind(error) {
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'permission_denied';
  if (error?.code === 'ENOENT') return 'missing_file';
  if (['EIO', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE'].includes(error?.code)) return 'io_error';
  if (error instanceof TypeError) return 'type_error';
  return failureReason(error) === 'maintenance_step_failed' ? 'unexpected_error' : 'coded_error';
}
const diagnosticFiles = new Set(['web-admin-homebridge-host.js', 'web-admin-homebridge-api.js', 'web-admin-homebridge-maintenance.js', 'web-admin-homebridge-client.js', 'web-admin-transactions.js']);
function failureLocation(error) {
  const root = new URL('./', import.meta.url).href;
  for (const line of String(error?.stack ?? '').split('\n').slice(1, 20)) {
    const at = line.indexOf(root); if (at < 0) continue;
    const match = /^([a-z-]+\.js):(\d{1,6}):(\d{1,6})(?:\)|$)/.exec(line.slice(at + root.length));
    if (match && diagnosticFiles.has(match[1])) return { file: match[1], line: Number(match[2]), column: Number(match[3]) };
  }
  return null;
}
function publicFailure(value) {
  if (!value || !failureSteps.has(value.step) || !failureParticipants.has(value.participant) || !failureReasons.has(value.reason) || !failureKinds.has(value.kind)) return null;
  const location = value.location;
  const safeLocation = location && diagnosticFiles.has(location.file) && integer(location.line, 1, 999999) && integer(location.column, 1, 999999) ? { file: location.file, line: location.line, column: location.column } : null;
  return { step: value.step, participant: value.participant, reason: value.reason, kind: value.kind, location: safeLocation };
}
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
  async step(tx, participant, step, operation) {
    try { return await operation(); }
    catch (error) {
      tx.failure = { step, participant: failureParticipants.has(participant) ? participant : 'integration', reason: failureReason(error), kind: failureKind(error), location: failureLocation(error) };
      throw error;
    }
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
      homebridge: Object.hasOwn(tx.participants, 'homebridge'), failure_reason: failureReasons.has(tx.failure_reason) ? tx.failure_reason : null, failure: publicFailure(tx.failure), outcome: !tx.write_attempted ? 'not_sent' : tx.definite_rejection ? 'rejected' : tx.verified ? tx.intent.outcome ?? 'applied' : 'unknown' };
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
      catch (error) { throw new WebAdminError('maintenance_preflight_failed:' + failureReason(error) + ':' + failureKind(error)); }
      const tx = { ...context, schema: 1, id: randomBytes(16).toString('hex'), stage: 'preparing', participants: Object.fromEntries([...selected].map(([name, participant]) => [name, participant.api_version])),
        intent, paused: [], write_attempted: false, verified: false, snapshot_digest: webDigest(snapshot), backup: null };
      await this.save(tx); // Durable before any participant is paused.
      try {
        for (const [name, participant] of selected) { tx.paused.push(name); await this.save(tx); await this.step(tx, name, 'pause', () => participant.pause(structuredClone(tx))); }
        if (backup) {
          requireWeb(backup.api_version === 1, 'backup_adapter_incompatible'); tx.backup = await this.step(tx, 'backup', 'backup', () => backup.save(context, snapshot)); await this.save(tx);
          requireWeb(object(tx.backup) && tx.backup.schema === 1 && typeof tx.backup.credential_backup === 'boolean', 'backup_receipt_invalid');
        }
        await this.step(tx, 'gateway', 'revalidate', async () => requireWeb(await validateAgain(), 'settings_changed_refresh'));
        if (this.evidence?.prepare) await this.step(tx, 'gateway', 'credential_evidence', () => this.evidence.prepare(structuredClone(tx), credential));
        tx.stage = 'writing'; tx.write_attempted = true; await this.save(tx);
        let result;
        try { result = await this.step(tx, 'gateway', 'gateway_write', write); }
        catch (error) {
          if (!(error instanceof WebGatewayRejected) || !error.definite) throw error;
          tx.definite_rejection = true; tx.rejection = error.message; tx.verified = true; tx.stage = 'verified'; await this.save(tx); await this.finish(tx);
          return { saved: false, transaction_id: tx.id, rejected: error.message };
        }
        tx.intent = await this.step(tx, 'gateway', 'gateway_readback', () => verify(result)); webJournalWithoutSecrets(tx.intent);
        tx.verified = true; tx.stage = 'verified'; await this.save(tx); await this.finish(tx);
        return { saved: true, transaction_id: tx.id, verification: 'gateway_response_and_readback' };
      } catch (error) {
        tx.failure_reason = failureReason(error);
        // Persistence failure is an additional in-memory hold. Never overwrite
        // that uncertainty by attempting another save or releasing participants.
        if (this.storageUncertain) throw new WebAdminError('transaction_storage_review_required');
        tx.stage = 'recovery_required'; await this.save(tx); throw new WebAdminError('transaction_recovery_required');
      }
    });
  }
  async finish(tx) {
    this.required(tx);
    for (const name of tx.paused) await this.step(tx, name, 'verify', () => this.participants.get(name).verify(structuredClone(tx)));
    tx.stage = 'resuming'; await this.save(tx);
    for (const name of [...tx.paused].reverse()) await this.step(tx, name, 'resume', () => this.participants.get(name).resume(structuredClone(tx)));
    // Commit participant completion before clearing the transaction banner.
    // A failed completion remains recoverable and each participant is idempotent.
    for (const name of [...tx.paused].reverse()) await this.step(tx, name, 'complete', () => this.participants.get(name).complete?.(structuredClone(tx)));
    tx.stage = 'complete'; await this.save(tx);
  }
  async canResolve(tx, inspect, diagnostics = []) {
    this.required(tx);
    for (const name of tx.paused) {
      const participant = this.participants.get(name);
      if (participant.recovery_ready && await participant.recovery_ready(structuredClone(tx), diagnostics) !== true) {
        if (!diagnostics.length) diagnostics.push({ participant: 'integration', check: 'maintenance', reason: 'verification_failed' });
        return false;
      }
    }
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
      const diagnostics = [];
      const ready = await this.canResolve(tx, inspect, diagnostics), token = ready ? randomBytes(24).toString('hex') : null, now = this.clock();
      for (const [key, value] of this.reviews) if (value.gateway === gateway || now >= value.expires) this.reviews.delete(key);
      if (ready) this.reviews.set(token, { gateway, id: tx.id, digest: webDigest(tx), expires: now + 120 });
      return { transaction_id: tx.id, ready, token, reason: ready ? 'review_required' : 'external_verification_required', diagnostics, automatic_retry: false };
    });
  }
  async recover(gateway, identity, body, inspect) {
    requireWeb(exact(body, ['transaction_id', 'token', 'reviewed']) && body.reviewed === true, 'recovery_confirmation_required');
    return this.locked(gateway, async () => {
      const tx = await this.load(gateway), review = this.reviews.get(body.token); this.reviews.delete(body.token);
      requireWeb(tx && review && review.gateway === gateway && review.id === body.transaction_id && tx.id === body.transaction_id && tx.identity === identity && review.digest === webDigest(tx) && this.clock() < review.expires, 'recovery_review_expired');
      requireWeb(await this.canResolve(tx, inspect), 'recovery_evidence_changed'); tx.verified = true;
      try { await this.finish(tx); }
      catch (error) { if (!this.storageUncertain) { tx.failure_reason = failureReason(error); tx.stage = 'recovery_required'; await this.save(tx); } throw new WebAdminError(this.storageUncertain ? 'transaction_storage_review_required' : 'transaction_recovery_required'); }
      return { recovered: true, transaction_id: tx.id, gateway_write_replayed: false };
    });
  }
}
