// User/grant, PIN, alarm-timing and protection changes. The existing movement
// optional integrations are maintenance participants; no movement logic belongs here.
import { isDeepStrictEqual as same } from 'node:util';
import { requireWeb, object, exact, integer } from './web-admin-common.js';
import { webUserPayload, unrestricted, grantFields, identityFields, alarmTimings, lockoutPolicy } from './web-admin-domain.js';
import { projectWebFields } from './web-admin-view.js';
import { webDigest } from './web-admin-files.js';

export const webWriteOperations = new Set(['save_user', 'delete_user', 'rotate_pin', 'save_alarm', 'save_lockout', 'reset_lockout']);
export const webRecoveryOperations = new Set(['review_recovery', 'recover_transaction', 'verify_credential']);
export class WebAdminEditor {
  constructor({ view, identity, transactions, backup, history, authorize, integration, requestDiscovery = () => {}, actor = 'Administrator' }) {
    Object.assign(this, { view, identity, transactions, backup, history, authorize, integration, requestDiscovery, actor });
    this.alarm = view.alarmId; this.client = view.client; this.prefix = '/alarmsystems/' + this.alarm;
  }
  protectOwners(snapshot, uid, payload, deleting) {
    for (const [alarm, grants] of Object.entries(snapshot.grants)) {
      const rows = structuredClone(grants);
      if (alarm === String(this.alarm)) { if (deleting) delete rows[uid]; else rows[uid ?? 'new'] = structuredClone(payload); }
      if (!deleting) for (const [key, row] of Object.entries(rows)) if (key === uid) row.enabled = payload.enabled;
      const managed = snapshot.capabilities[alarm].managed === true || alarm === String(this.alarm) && !deleting;
      requireWeb(!managed || Object.values(rows).some(unrestricted), 'last_unrestricted_owner_required');
    }
  }
  async plan(operation, body, snapshot) {
    await this.authorize?.(operation, body, snapshot);
    const caps = snapshot.capabilities[this.alarm]; requireWeb(!!caps, 'alarm_not_found');
    const plan = { operation, alarm: this.alarm, sensitive: false };
    if (['save_user', 'delete_user'].includes(operation)) {
      const deleting = operation === 'delete_user', preserve = body.preserve_schedule === true;
      if (Object.hasOwn(body, 'preserve_schedule')) {
        requireWeb(preserve && !deleting && !Object.hasOwn(body, 'schedule'), 'invalid_schedule');
        body = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'preserve_schedule'));
      }
      const { uid, alarm, payload } = webUserPayload(body, deleting);
      requireWeb(alarm === this.alarm, 'alarm_context_changed');
      if (!deleting) {
        const keys = payload.keypads.map(pad => pad.source + ':' + pad.endpoint);
        requireWeb(new Set(keys).size === keys.length && payload.keypads.every(pad => pad.source.length === 1 || !pad.source.startsWith('0')), 'invalid_keypads');
        payload.keypads.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) || a.endpoint - b.endpoint);
      }
      const current = snapshot.grants[alarm][uid], identity = snapshot.identities[uid];
      if (preserve) { requireWeb(!!current, 'invalid_schedule'); payload.schedule = structuredClone(current.schedule); }
      if (uid === null) requireWeb(!deleting && payload.revision === 0 && payload.user_revision === 0 && Object.hasOwn(payload, 'pin'), 'new_user_requires_pin');
      else {
        requireWeb(identity && identity.user_revision === payload.user_revision && payload.revision === (current?.revision ?? 0), 'revision_conflict');
        if (deleting) requireWeb(!!current, 'user_not_found');
        else if (!current) {
          requireWeb(Object.hasOwn(payload, 'pin'), 'current_pin_required');
          requireWeb(payload.name === identity.name && payload.enabled === identity.enabled, 'attach_identity_fields_changed');
        } else requireWeb(!Object.hasOwn(payload, 'pin'), 'use_coordinated_pin_change');
      }
      if (caps.managed !== true) requireWeb(!deleting && body.enable_management === true && unrestricted(payload), 'explicit_owner_enrollment_required');
      if (!deleting && payload.schedule != null) requireWeb(caps.schedules === true && caps.schedule_version === 1, 'schedule_plugin_required');
      this.protectOwners(snapshot, uid, payload, deleting);
      Object.assign(plan, { kind: 'grant', uid, path: this.prefix + '/users' + (uid ? '/' + uid : ''), method: deleting ? 'DELETE' : uid ? 'PUT' : 'POST', deleting, sensitive: !deleting && Object.hasOwn(payload, 'pin') });
      let expected = null;
      if (!deleting) {
        expected = Object.fromEntries(Object.entries(payload).filter(([key]) => grantFields.includes(key)));
        const changed = uid === null || payload.name !== identity.name || payload.enabled !== identity.enabled;
        Object.assign(expected, { schedule: payload.schedule ?? null, revision: payload.revision + 1, user_revision: payload.user_revision + Number(changed), id: uid });
        requireWeb(Number.isSafeInteger(expected.revision) && Number.isSafeInteger(expected.user_revision), 'revision_conflict');
      }
      return { plan: { ...plan, expected }, payload };
    }
    if (operation === 'rotate_pin') {
      requireWeb(exact(body, ['id', 'user_revision', 'revision', 'new_pin', 'repeat_pin']) || exact(body, ['id', 'user_revision', 'revision', 'new_pin', 'repeat_pin', 'homebridge_selection']), 'invalid_credential_request');
      const uid = body.id, identity = typeof uid === 'string' && Object.hasOwn(snapshot.identities, uid) ? snapshot.identities[uid] : null;
      requireWeb(identity && ['revision', 'user_revision'].every(key => Number.isSafeInteger(body[key]) && body[key] === identity.user_revision), 'revision_conflict');
      requireWeb(typeof body.new_pin === 'string' && /^[0-9]{4,16}$/.test(body.new_pin) && body.new_pin === body.repeat_pin, 'pins_do_not_match');
      const expected = { ...identity, revision: identity.revision + 1, user_revision: identity.user_revision + 1 };
      requireWeb(Number.isSafeInteger(expected.revision) && Number.isSafeInteger(expected.user_revision), 'revision_conflict');
      Object.assign(plan, { kind: 'identity', uid, path: '/alarmsystems/users/' + uid, method: 'PUT', expected, sensitive: true });
      if (Object.hasOwn(body, 'homebridge_selection')) {
        requireWeb(typeof this.integration?.selectionPlan === 'function', 'homebridge_not_configured');
        plan.homebridge_selection = await this.integration.selectionPlan(this.view.gatewayId, uid, body.homebridge_selection, snapshot);
      }
      return { plan, payload: { ...Object.fromEntries(['name', 'enabled', 'revision', 'user_revision'].map(key => [key, identity[key]])), pin: body.new_pin } };
    }
    if (operation === 'save_alarm') {
      requireWeb(exact(body, ['timings', 'revision']), 'invalid_alarm_timings');
      const expected = alarmTimings(body.timings), current = snapshot.alarm;
      requireWeb(current.timing_supported, 'alarm_plugin_update_required');
      requireWeb(current.state === 'disarmed' && current.target === 'disarmed', 'disarm_before_timing_changes');
      requireWeb(body.revision === current.revision, 'settings_changed_refresh');
      return { plan: { ...plan, kind: 'timings', path: this.prefix + '/config', method: 'PUT', expected }, payload: expected };
    }
    requireWeb(['save_lockout', 'reset_lockout'].includes(operation), 'operation_unavailable');
    const current = await this.view.lockout();
    if (operation === 'save_lockout') {
      const payload = lockoutPolicy(body); requireWeb(payload.revision === current.policy.revision && payload.revision < Number.MAX_SAFE_INTEGER, 'revision_conflict');
      return { plan: { ...plan, kind: 'lockout', path: this.prefix + '/users/lockout', method: 'PUT', expected: { ...payload, revision: payload.revision + 1 } }, payload };
    }
    requireWeb(exact(body, ['reset']) && body.reset === true, 'explicit_reset_required');
    return { plan: { ...plan, kind: 'reset', path: this.prefix + '/users/lockout', method: 'DELETE', expected: current.policy }, payload: { reset: true } };
  }
  async inspect(plan) {
    try {
      await this.client.verify(plan.alarm); const prefix = '/alarmsystems/' + plan.alarm;
      if (plan.kind === 'grant') {
        if (plan.uid === null) return false; // Never guess a created identity by its name.
        const rows = await this.client.request(prefix + '/users');
        return plan.deleting ? !Object.hasOwn(rows, plan.uid) : Object.hasOwn(rows, plan.uid) && same(projectWebFields(rows[plan.uid], grantFields), plan.expected);
      }
      if (plan.kind === 'identity') { const rows = await this.client.request('/alarmsystems/users'); return Object.hasOwn(rows, plan.uid) && same(projectWebFields(rows[plan.uid], identityFields), plan.expected); }
      if (plan.kind === 'timings') { const raw = await this.client.request(prefix); return same(Object.fromEntries(Object.keys(plan.expected).map(key => [key, raw.config?.[key]])), plan.expected); }
      const raw = await this.client.request(prefix + '/users/lockout');
      if (plan.kind === 'lockout') return same(raw.policy, plan.expected);
      if (plan.kind === 'reset') return same(raw.policy, plan.expected) && Array.isArray(raw.keypads) && raw.keypads.every(row => row.remaining_seconds === 0 && row.level === 0);
      return false;
    } catch { return false; }
  }
  async dispatch(operation, original) {
    const tx = this.transactions, gateway = this.view.gatewayId;
    requireWeb(!!tx, 'operation_not_implemented');
    if (operation === 'review_recovery') { requireWeb(exact(original, []), 'invalid_request'); return tx.review(gateway, this.identity, plan => this.inspect(plan)); }
    if (operation === 'recover_transaction') {
      const result = await tx.recover(gateway, this.identity, original, plan => this.inspect(plan)); await this.requestDiscovery(gateway); return result;
    }
    if (operation === 'verify_credential') {
      requireWeb(exact(original, ['transaction_id', 'pin']), 'invalid_credential_request');
      return tx.locked(gateway, async () => {
        const record = await tx.load(gateway); requireWeb(record && record.id === original.transaction_id && record.identity === this.identity, 'no_matching_transaction'); tx.required(record);
        requireWeb(typeof tx.evidence?.submit === 'function', 'local_credential_evidence_required');
        try { return await tx.evidence.submit(record, original.pin); } finally { delete original.pin; }
      });
    }
    requireWeb(webWriteOperations.has(operation), 'operation_unavailable');
    await tx.guard(gateway); requireWeb(original.backup_acknowledged === true, 'policy_backup_acknowledgment_required');
    requireWeb(this.backup?.api_version === 1 && typeof this.history?.add === 'function', 'administration_state_unavailable');
    const body = Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'backup_acknowledged').map(([key, value]) => [key, structuredClone(value)]));
    let payload;
    try {
      const snapshot = await this.view.snapshot(), proposed = await this.plan(operation, body, snapshot), plan = proposed.plan; payload = proposed.payload;
      if (operation === 'reset_lockout' || operation === 'save_lockout' && payload.enabled === false) requireWeb(typeof this.history.closeLockouts === 'function', 'history_state_unavailable');
      await this.integration?.protect(gateway, this.alarm, plan, payload, snapshot);
      const protection = ['save_lockout', 'reset_lockout'].includes(operation);
      if (protection) snapshot.lockout = await this.view.lockout();
      const uid = plan.uid ?? null, identity = snapshot.identities[uid];
      const identityChanged = operation === 'rotate_pin' || operation === 'save_user' && !!identity && ['name', 'enabled'].some(key => payload[key] !== identity[key]);
      const affected = new Set([this.alarm]); if (identityChanged) for (const [id, rows] of Object.entries(snapshot.grants)) if (Object.hasOwn(rows, uid)) affected.add(Number(id));
      const context = { gateway, identity: this.identity, alarm: this.alarm, operation, affected_alarms: [...affected].sort((a, b) => a - b), identity_id: uid, gateway_wide_identity_change: identityChanged,
        ...(plan.homebridge_selection ? { homebridge_selection: plan.homebridge_selection } : {}) };
      const result = await tx.execute({ context, backup: this.backup, snapshot, intent: plan, credential: payload.pin,
        validateAgain: async () => {
          const fresh = await this.view.snapshot(); if (protection) fresh.lockout = await this.view.lockout();
          return webDigest(fresh) === webDigest(snapshot) && same((await this.plan(operation, body, fresh)).plan, plan);
        },
        write: async () => { await this.client.verify(this.alarm); return this.client.request(plan.path, plan.method, payload); },
        verify: async reply => {
          const expected = structuredClone(plan);
          if (plan.kind === 'grant') {
            if (plan.deleting) requireWeb(same(reply, { deleted: plan.uid }), 'gateway_write_unverified');
            else {
              requireWeb(object(reply) && typeof reply.id === 'string' && /^[0-9a-f]{32}$/.test(reply.id), 'gateway_write_unverified');
              if (plan.uid === null) { requireWeb(!Object.hasOwn(snapshot.identities, reply.id), 'gateway_write_unverified'); expected.uid = reply.id; expected.expected.id = reply.id; }
              requireWeb(same(projectWebFields(reply, grantFields), expected.expected), 'gateway_write_unverified');
            }
          } else if (plan.kind === 'identity') requireWeb(same(projectWebFields(reply, identityFields), plan.expected), 'gateway_write_unverified');
          else if (plan.kind === 'timings') {
            const required = Object.entries(plan.expected).map(([key, value]) => ({ success: { [plan.path + '/' + key]: value } }));
            requireWeb(Array.isArray(reply) && reply.length === required.length && required.every(row => reply.some(item => same(row, item))), 'gateway_write_unverified');
          } else requireWeb(object(reply) && same(reply.policy, plan.expected), 'gateway_write_unverified');
          requireWeb(await this.inspect(expected), 'gateway_readback_unverified'); return expected;
        } });
      requireWeb(result.saved, result.rejected);
      if (operation === 'reset_lockout' || operation === 'save_lockout' && payload.enabled === false) {
        requireWeb(typeof this.history.closeLockouts === 'function', 'history_state_unavailable'); await this.history.closeLockouts(gateway, this.alarm);
      }
      await this.history.add(gateway, this.alarm, this.actor, 'Configuration', operation.replaceAll('_', ' '), 'Verified by gateway response and readback');
      await this.requestDiscovery(gateway); return result;
    } finally {
      if (payload) delete payload.pin;
      for (const key of ['pin', 'new_pin', 'repeat_pin']) { delete body[key]; delete original[key]; }
    }
  }
}
