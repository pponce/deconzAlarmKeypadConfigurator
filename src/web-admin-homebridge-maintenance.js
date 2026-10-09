// Restart-aware participant for the existing administration transaction. The
// host port owns the reviewed PIN storage operation; this participant owns the
// durable sequence and must never infer success from a restart acknowledgement.
import { isDeepStrictEqual as same } from 'node:util';
import { WebAdminFiles } from './web-admin-files.js';
import { requireWeb, object, exact, integer } from './web-admin-common.js';
import { webJournalWithoutSecrets } from './web-admin-transactions.js';

const stages = ['stop_requested', 'stopped', 'api_preparing', 'api_prepared', 'api_write_requested', 'pin_saved', 'start_requested', 'running', 'complete'];
const gatewayId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
export function validateAlarmBinding(row) {
  requireWeb(exact(row, ['gateway', 'identity', 'user', 'alarms']) && gatewayId(row.gateway) &&
    typeof row.identity === 'string' && /^[0-9A-F]{16}$/.test(row.identity) &&
    typeof row.user === 'string' && /^[0-9a-f]{32}$/.test(row.user) && Array.isArray(row.alarms) &&
    row.alarms.length > 0 && row.alarms.every(id => integer(id, 1, 255)) &&
    same(row.alarms, [...new Set(row.alarms)].sort((a, b) => a - b)), 'homebridge_binding_invalid');
  return row;
}
export const homebridgeEligibleUser = row => !!row && ['enabled', 'grant_enabled', 'arm', 'disarm', 'api_arm_disarm'].every(key => row[key] === true) &&
  row.remaining_uses === null && row.schedule === null;
function validateState(row) {
  requireWeb(exact(row, ['schema', 'bindings', 'lease']) && row.schema === 1 && Array.isArray(row.bindings) && row.bindings.length <= 16, 'homebridge_state_invalid');
  row.bindings.forEach(validateAlarmBinding);
  requireWeb(new Set(row.bindings.map(binding => binding.gateway)).size === row.bindings.length, 'homebridge_state_invalid');
  if (row.lease !== null) {
    const lease = row.lease;
    requireWeb(exact(lease, ['id', 'gateway', 'binding', 'previous', 'stage', 'host']) &&
      typeof lease.id === 'string' && /^[0-9a-f]{32}$/.test(lease.id) && lease.gateway === lease.binding?.gateway &&
      stages.includes(lease.stage) && object(lease.host), 'homebridge_state_invalid');
    validateAlarmBinding(lease.binding); if (lease.previous !== null) validateAlarmBinding(lease.previous);
  }
  webJournalWithoutSecrets(row); return row;
}
export class WebHomebridgeMaintenanceStore {
  constructor(storagePath) { this.files = new WebAdminFiles(storagePath); }
  async read() { return await this.files.read('web-homebridge-maintenance.json', validateState) ?? { schema: 1, bindings: [], lease: null }; }
  write(row) { return this.files.write('web-homebridge-maintenance.json', row, validateState); }
}

export class WebHomebridgeMaintenance {
  #request = null;
  #prepared = null;
  constructor({ store, registrations, host }) {
    Object.assign(this, { store, registrations: new Map(registrations.map(row => [row.id, row.identity])), host });
    this.api_version = 1; this.uncertain = false;
  }
  async state() { return validateState(await this.store.read()); }
  async save(row) {
    validateState(row);
    try { await this.store.write(structuredClone(row)); }
    catch { this.uncertain = true; throw Error('homebridge_storage_review_required'); }
  }
  async guard() {
    requireWeb(!this.uncertain, 'homebridge_storage_review_required');
    const row = await this.state(); requireWeb(!row.lease || row.lease.stage === 'complete', 'homebridge_shared_service_recovery_required');
  }
  async status() {
    const row = await this.state();
    const readiness = typeof this.host.readiness === 'function' ? await this.host.readiness() :
      { configured: typeof this.host.available !== 'function' || await this.host.available(), error: null };
    return { ...readiness, profile: 'homebridge-child-bridge', pending: this.uncertain || !!row.lease && row.lease.stage !== 'complete',
      bindings: row.bindings.map(({ gateway, user, alarms }) => ({ gateway, user, alarms })) };
  }
  async viewStatus() { return this.status(); }
  async hiddenUsers(gateway) { return (await this.state()).bindings.filter(row => row.gateway === gateway).map(row => row.user); }
  async authorizeRecovery(transaction, credentials) {
    if (!transaction.paused.includes('homebridge')) {
      try { await this.host.authenticate(credentials); return { authorized: true, transaction_id: transaction.id }; }
      finally { if (object(credentials)) { credentials.password = ''; if (Object.hasOwn(credentials, 'otp')) credentials.otp = ''; } }
    }
    const row = await this.current(transaction);
    requireWeb(row.lease.stage !== 'complete', 'no_matching_transaction');
    try { await this.host.authenticate(credentials); return { authorized: true, transaction_id: transaction.id }; }
    finally { if (object(credentials)) { credentials.password = ''; if (Object.hasOwn(credentials, 'otp')) credentials.otp = ''; } }
  }
  async selectionPlan(gateway, user, value, snapshot) {
    requireWeb(!this.uncertain, 'homebridge_storage_review_required');
    const row = await this.state(), previous = row.bindings.find(binding => binding.gateway === gateway) ?? null;
    requireWeb(exact(value, ['expected_user_id', 'alarms']) && value.expected_user_id === (previous?.user ?? null), 'homebridge_binding_changed');
    const binding = validateAlarmBinding({ gateway, identity: this.registrations.get(gateway), user, alarms: value.alarms });
    requireWeb(!previous || previous.identity === binding.identity, 'homebridge_gateway_identity_changed');
    requireWeb(!previous || previous.alarms.every(id => binding.alarms.includes(id)), 'homebridge_alarm_removal_requires_review');
    requireWeb(binding.alarms.every(id => homebridgeEligibleUser(snapshot.grants[id]?.[user])), 'unrestricted_homebridge_user_required');
    return { previous: structuredClone(previous), binding: structuredClone(binding) };
  }
  async protect(gateway, alarm, plan, payload, snapshot) {
    await this.guard();
    const binding = (await this.state()).bindings.find(row => row.gateway === gateway);
    if (plan.homebridge_selection) return true;
    if (!binding || binding.user !== plan.uid) return false;
    if (plan.operation === 'rotate_pin') {
      requireWeb(binding.alarms.every(id => homebridgeEligibleUser(snapshot.grants[id]?.[binding.user])), 'homebridge_user_must_remain_unrestricted');
      return true;
    }
    if (plan.operation === 'save_user') requireWeb(payload.enabled === true, 'homebridge_user_must_remain_unrestricted');
    if (binding.alarms.includes(alarm) && ['save_user', 'delete_user'].includes(plan.operation)) {
      requireWeb(!plan.deleting && homebridgeEligibleUser(payload), 'homebridge_user_must_remain_unrestricted');
    }
    return false;
  }
  async applies(context) {
    const binding = (await this.state()).bindings.find(row => row.gateway === context.gateway);
    return context.operation === 'rotate_pin' && (!!context.homebridge_selection || binding?.user === context.identity_id);
  }
  // This scope is entered only by authenticated Admin dispatch, after the
  // browser's explicit PIN confirmation. Homebridge login is only needed for
  // optional log clearing (or a legacy host).
  async withRequest({ pin, confirmed, credentials, clearLogs = false }, operation) {
    requireWeb(!this.#request, 'homebridge_update_in_progress');
    requireWeb(confirmed === true, 'homebridge_restart_confirmation_required');
    requireWeb(typeof pin === 'string' && /^[0-9]{4,16}$/.test(pin), 'invalid_pin');
    requireWeb(typeof clearLogs === 'boolean', 'invalid_request');
    this.#request = { pin, confirmed, clearLogs };
    try {
      if (clearLogs || typeof this.host.applyApi !== 'function') await this.host.authenticate(credentials);
      const result = await operation();
      await this.afterTransaction(result); return result;
    }
    finally {
      this.#request = null; this.#prepared = null;
      if (object(credentials)) { credentials.password = ''; if (Object.hasOwn(credentials, 'otp')) credentials.otp = ''; }
      await this.host.clearAuthentication();
    }
  }
  async preflight(context) {
    await this.guard(); requireWeb(this.#request?.confirmed === true, 'homebridge_restart_confirmation_required');
    const row = await this.state(), previous = row.bindings.find(binding => binding.gateway === context.gateway) ?? null;
    const selection = context.homebridge_selection;
    if (selection) requireWeb(same(selection.previous, previous), 'homebridge_binding_changed');
    const binding = validateAlarmBinding(selection?.binding ?? previous);
    requireWeb(binding.gateway === context.gateway && binding.identity === context.identity && binding.user === context.identity_id &&
      this.registrations.get(binding.gateway) === binding.identity, 'homebridge_binding_changed');
    const prepared = await this.host.prepare(structuredClone(binding)); webJournalWithoutSecrets(prepared);
    this.#prepared = { previous, binding, host: { ...prepared, clearLogs: this.#request.clearLogs, logClearState: this.#request.clearLogs ? 'pending' : 'not_requested' } };
  }
  async pause(tx) {
    requireWeb(this.#prepared && this.#request?.confirmed === true, 'homebridge_restart_confirmation_required');
    const row = await this.state(); requireWeb(!row.lease || row.lease.stage === 'complete', 'homebridge_shared_service_recovery_required');
    if (this.#prepared.host.mode === 'api') {
      row.lease = { id: tx.id, gateway: tx.gateway, ...structuredClone(this.#prepared), stage: 'api_preparing' };
      await this.save(row);
      await this.host.snapshotApi(structuredClone(row.lease), this.#request.pin);
      row.lease.stage = 'api_prepared'; await this.save(row); return;
    }
    row.lease = { id: tx.id, gateway: tx.gateway, ...structuredClone(this.#prepared), stage: 'stop_requested' };
    await this.save(row); // Durable before the first service request.
    await this.host.stop(structuredClone(row.lease));
    await this.host.assertStopped(structuredClone(row.lease));
    // Private credential backup belongs to the host adapter, never this journal.
    await this.host.snapshotStopped(structuredClone(row.lease), this.#request.pin);
    row.lease.stage = 'stopped'; await this.save(row);
  }
  async current(tx) {
    requireWeb(!this.uncertain, 'homebridge_storage_review_required');
    const row = await this.state(), lease = row.lease;
    requireWeb(lease && lease.id === tx.id && lease.gateway === tx.gateway && lease.binding.identity === tx.identity, 'homebridge_transaction_changed');
    return row;
  }
  noWriteRestore(tx, lease) {
    return tx.write_attempted === false && (lease.stage === 'stop_requested' || lease.host.restoreWithoutPin === true);
  }
  async verify(tx) {
    const row = await this.current(tx), lease = row.lease;
    if (lease.host.mode === 'api') {
      await this.host.verifyGateway(structuredClone(lease), structuredClone(tx));
      const applied = tx.write_attempted && !tx.definite_rejection;
      if (!applied) { await this.host.checkApi(lease, { applied: false }); return; }
      requireWeb(tx.verified === true, 'homebridge_gateway_write_unverified');
      if (['start_requested', 'running', 'complete'].includes(lease.stage)) {
        await this.host.verifyApiRunning(lease, tx); return;
      }
      requireWeb(['api_prepared', 'api_write_requested', 'pin_saved'].includes(lease.stage), 'homebridge_snapshot_unverified');
      lease.stage = 'api_write_requested'; await this.save(row);
      await this.host.applyApi(structuredClone(lease));
      lease.stage = 'pin_saved'; await this.save(row); return;
    }
    if (this.noWriteRestore(tx, lease)) {
      await this.host.noWriteState(structuredClone(lease), structuredClone(tx));
      lease.host.restoreWithoutPin = true; await this.save(row); return;
    }
    await this.host.verifyGateway(structuredClone(lease), structuredClone(tx));
    if (['start_requested', 'running', 'complete'].includes(lease.stage)) {
      await this.host.verifyRunning(structuredClone(lease), structuredClone(tx)); return;
    }
    await this.host.assertStopped(structuredClone(lease));
    requireWeb(lease.stage !== 'stop_requested', 'homebridge_snapshot_unverified');
    const applied = tx.write_attempted && !tx.definite_rejection;
    requireWeb(!applied || tx.verified === true, 'homebridge_gateway_write_unverified');
    // The host must compare-and-replace and recognize an already-applied result.
    // Recovery may verify the same intent but must never perform a gateway PUT.
    await this.host.commitStopped(structuredClone(lease), { applied });
    lease.stage = 'pin_saved'; await this.save(row);
  }
  async resume(tx) {
    const row = await this.current(tx), lease = row.lease;
    if (lease.host.mode === 'api') {
      await this.host.verifyApiRunning(structuredClone(lease), structuredClone(tx));
      if (lease.stage !== 'complete') { lease.stage = 'running'; await this.save(row); } return;
    }
    if (lease.host.restoreWithoutPin === true) {
      requireWeb(tx.write_attempted === false, 'homebridge_gateway_write_unverified');
      const state = await this.host.noWriteState(structuredClone(lease), structuredClone(tx));
      if (state === 'stopped') {
        // One explicit recovery attempt, after fresh stopped-state evidence.
        // A subsequent user-authorized recovery may retry only if still stopped.
        lease.stage = 'start_requested'; await this.save(row);
        try { await this.host.start(structuredClone(lease)); }
        catch { /* Resolve a lost ACK through readback; never resend here. */ }
      }
      await this.host.verifyNoWriteRunning(structuredClone(lease), structuredClone(tx));
      if (lease.stage !== 'complete') { lease.stage = 'running'; await this.save(row); }
      return;
    }
    if (lease.stage === 'pin_saved') {
      lease.stage = 'start_requested'; await this.save(row);
      await this.host.start(structuredClone(lease));
    }
    requireWeb(['start_requested', 'running', 'complete'].includes(lease.stage), 'homebridge_restart_unverified');
    await this.host.verifyRunning(structuredClone(lease), structuredClone(tx));
    if (lease.stage !== 'complete') { lease.stage = 'running'; await this.save(row); }
  }
  async complete(tx) {
    const row = await this.current(tx), lease = row.lease;
    requireWeb(['running', 'complete'].includes(lease.stage), 'homebridge_restart_unverified');
    const expected = tx.write_attempted && !tx.definite_rejection ? lease.binding : lease.previous;
    const current = row.bindings.find(binding => binding.gateway === lease.gateway) ?? null;
    requireWeb(same(current, lease.previous) || same(current, expected), 'homebridge_binding_changed');
    row.bindings = row.bindings.filter(binding => binding.gateway !== lease.gateway);
    if (expected) row.bindings.push(structuredClone(expected));
    lease.stage = 'complete'; await this.save(row);
  }
  async recovery_ready(tx, diagnostics = []) {
    let check = 'saved_operation';
    try {
      const row = await this.current(tx), lease = row.lease;
      if (lease.host.mode === 'api') {
        check = 'gateway_state'; await this.host.verifyGateway(lease, tx);
        check = 'homebridge_api';
        if (['start_requested', 'running', 'complete'].includes(lease.stage)) await this.host.verifyApiRunning(lease, tx);
        else await this.host.checkApi(lease, { applied: tx.write_attempted && !tx.definite_rejection, prepared: true });
        return true;
      }
      if (this.noWriteRestore(tx, lease)) {
        check = 'restore_service';
        await this.host.noWriteState(structuredClone(lease), structuredClone(tx)); return true;
      }
      check = 'gateway_state';
      await this.host.verifyGateway(structuredClone(lease), structuredClone(tx));
      check = 'child_bridge_state';
      if (['start_requested', 'running', 'complete'].includes(lease.stage)) await this.host.verifyRunning(structuredClone(lease), structuredClone(tx));
      else {
        check = 'private_backup';
        requireWeb(lease.stage !== 'stop_requested', 'homebridge_snapshot_unverified');
        check = 'child_bridge_stopped';
        await this.host.assertStopped(structuredClone(lease));
        check = 'private_backup';
        await this.host.verifySnapshot(structuredClone(lease));
      }
      return true;
    } catch (error) {
      const allowed = new Set(['homebridge_snapshot_unverified', 'homebridge_backup_changed', 'homebridge_cache_changed', 'homebridge_gateway_revision_changed', 'homebridge_gateway_identity_changed', 'homebridge_user_must_remain_unrestricted', 'homebridge_configuration_changed', 'homebridge_login_required', 'homebridge_transaction_changed', 'homebridge_storage_review_required', 'homebridge_file_unavailable', 'homebridge_saved_pin_unverified', 'homebridge_process_changed', 'homebridge_process_unverified', 'homebridge_alarm_mapping_changed']);
      for (const code of ['homebridge_alarm_api_unavailable', 'homebridge_alarm_api_not_ready', 'homebridge_alarm_api_response_invalid', 'homebridge_cli_discovery_failed', 'homebridge_pin_write_unverified', 'homebridge_restart_unverified']) allowed.add(code);
      diagnostics.push({ participant: 'homebridge', check, reason: allowed.has(error.message) ? error.message : 'verification_failed' });
      return false;
    }
  }
  async logStatus(transactionId) {
    const row = await this.state();
    return row.lease?.id === transactionId ? row.lease.host.logClearState ?? 'not_requested' : 'not_requested';
  }
  async method(transactionId) {
    const row = await this.state(); return row.lease?.id === transactionId && row.lease.host.mode === 'api' ? 'api' : 'legacy';
  }
  // Called only after the entire transaction has completed. Optional cleanup
  // never participates in PIN recovery, never replays, and never clears a hold.
  async afterTransaction(result) {
    if (!result?.transaction_id) return;
    let row;
    try {
      row = await this.state(); const lease = row.lease;
      if (lease?.id !== result.transaction_id || lease.stage !== 'complete' || lease.host.logClearState !== 'pending') return;
      const applied = same(row.bindings.find(item => item.gateway === lease.gateway), lease.binding) && result.saved !== false;
      if (!applied) { lease.host.logClearState = 'skipped'; await this.store.write(row); return; }
      lease.host.logClearState = 'requested'; await this.store.write(row); // Durable before deletion.
      try { await this.host.clearLogs(); lease.host.logClearState = 'cleared'; }
      catch { lease.host.logClearState = 'failed'; }
      await this.store.write(row);
    } catch { /* A cleanup failure must not reopen a completed PIN transaction. */ }
  }
}
