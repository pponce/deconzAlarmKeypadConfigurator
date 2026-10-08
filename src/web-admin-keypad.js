// Original virtual-keypad request contract, with explicit in-process host ports.
// Only the one submit closure receives the PIN; hooks receive outcome and mode.
import { isDeepStrictEqual as same } from 'node:util';
import { performance } from 'node:perf_hooks';
import { requireWeb, exact, integer } from './web-admin-common.js';

const modes = { disarm: 'disarmed', arm_stay: 'armed_stay', arm_away: 'armed_away', arm_night: 'armed_night' };
export function classifyWebKeypad(status, value, alarm, mode) {
  const prefix = '/alarmsystems/' + alarm;
  if (status === 200 && same(value, [{ success: { [prefix + '/config/armmode']: modes[mode] } }])) return 'accepted';
  if ([200, 400].includes(status) && Array.isArray(value) && value.length === 1 && exact(value[0], ['error']) &&
    value[0].error?.type === 7 && value[0].error.address === prefix + '/code0' && value[0].error.description === 'invalid value, [redacted], for parameter, code0') return 'rejected';
  requireWeb(false, 'keypad_result_unknown_no_retry');
}
export class WebAdminKeypad {
  constructor({ gateway, identity, alarm, client, transactions, history, begin, accessMode, clock = () => performance.now() / 1000 }) {
    Object.assign(this, { gateway, identity, alarm, client, transactions, history, begin, accessMode, clock });
  }
  ready() { return typeof this.transactions?.execute === 'function' && typeof this.history?.reserveRequest === 'function' && typeof this.history?.add === 'function' && typeof this.begin === 'function'; }
  async status(body) {
    requireWeb(exact(body, []), 'invalid_keypad_request');
    requireWeb((await this.client.verify(this.alarm)).managed === true, 'keypad_managed_alarm_required');
    return { available: this.accessMode === 'manage' && this.ready(), physical_lockout: false };
  }
  async send(body) {
    requireWeb(exact(body, ['code', 'mode', 'request_id']) && typeof body.code === 'string' && /^[0-9]{1,16}$/.test(body.code) && Object.hasOwn(modes, body.mode) && typeof body.request_id === 'string' && /^[a-f0-9]{32}$/.test(body.request_id), 'invalid_keypad_request');
    requireWeb(this.ready(), 'operation_not_implemented'); requireWeb(this.accessMode === 'manage', 'candidate_read_only_required');
    const { mode, request_id: id } = body; let code = body.code;
    try {
      await this.transactions.guard(this.gateway);
      const hook = await this.begin(this.clock());
      requireWeb(hook === null || hook?.api_version === 1 && typeof hook.after === 'function' && typeof hook.failed === 'function', 'keypad_extension_api_incompatible');
      await this.status({}); requireWeb(integer(this.alarm, 1, 255), 'invalid_alarm');
      if (!await this.history.reserveRequest(this.gateway, this.alarm, id)) return { result: 'duplicate', extension: 'Duplicate request ignored; no retry', mode };
      const audit = (action, result, key) => this.history.add(this.gateway, this.alarm, 'Browser operator', 'Browser keypad', action, result, key);
      await audit('Request submitted', mode.replaceAll('_', ' ') + '; ' + code.length + ' digit(s); credential omitted', 'browser-submit:' + id);
      let outcome = 'unknown', classified = 'unknown';
      try {
        const intent = { kind: 'command', alarm: this.alarm, sensitive: true, mode };
        await this.transactions.execute({ context: { gateway: this.gateway, identity: this.identity, alarm: this.alarm, operation: 'keypad_send' }, snapshot: {}, intent,
          validateAgain: async () => true,
          write: async () => { await this.client.verify(this.alarm); return this.client.exchange('/alarmsystems/' + this.alarm + '/' + mode, 'PUT', { code0: code }); },
          verify: async ([status, value]) => { classified = classifyWebKeypad(status, value, this.alarm, mode); return { ...intent, outcome: classified }; } });
        // A completed command transaction has an exact classified result; an
        // acknowledgement describes the alarm API result, not physical state.
        outcome = classified;
        requireWeb(['accepted', 'rejected'].includes(outcome), 'keypad_result_unknown_no_retry');
        if (hook) await hook.after(outcome, mode);
      } catch {
        if (hook) await hook.failed(outcome);
        const note = hook?.note ?? null;
        await audit('Request result unavailable', 'No automatic retry.' + (note ? ' ' + note : ''), 'browser-result:' + id);
        return { result: outcome, extension: note, mode, uncertain: true };
      } finally { code = ''; }
      const note = hook?.note ?? null;
      await audit(outcome === 'accepted' ? 'Code accepted' : 'Code rejected', mode.replaceAll('_', ' ') + (note ? '; ' + note : ''), 'browser-result:' + id);
      return { result: outcome, extension: note, mode };
    } finally { code = ''; delete body.code; }
  }
}
