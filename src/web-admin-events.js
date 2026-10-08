// Read-only event projection adapted from the original observe.cjs. Raw frames,
// entered codes, gateway keys and rejected credential values are never retained.
import { performance } from 'node:perf_hooks';
import { parseWebJson, requireWeb, exact, integer } from './web-admin-common.js';

const states = ['disarmed', 'armed_stay', 'armed_night', 'armed_away', 'exit_delay', 'entry_delay', 'not_ready', 'in_alarm', 'arming_stay', 'arming_night', 'arming_away'];
export class WebAdminEventProjection {
  constructor(alarms, { clock = Date.now } = {}) { this.clock = clock; this.started = clock(); this.states = new Map(); this.update(alarms); }
  update(alarms) {
    requireWeb(alarms && Object.entries(alarms).every(([id, pads]) => /^[1-9][0-9]{0,2}$/.test(id) && Number(id) <= 255 && Array.isArray(pads) && pads.every(pad => typeof pad === 'string' && /^[0-9]+$/.test(pad))), 'observation_invalid');
    this.alarms = structuredClone(alarms); for (const id of this.states.keys()) if (!Object.hasOwn(alarms, id)) this.states.delete(id);
  }
  read(raw) {
    const rows = [];
    try {
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 1048576) return rows;
      const e = parseWebJson(raw), alarm = String(e.id);
      if (e.t !== 'event' || e.r !== 'alarmsystems' || !Object.hasOwn(this.alarms, alarm)) return rows;
      if (e.e === 'changed' && states.includes(e.state?.armstate)) {
        if (this.states.has(alarm) && this.states.get(alarm) !== e.state.armstate) rows.push({ type: 'alarm_state', state: e.state.armstate, timestamp: new Date(this.clock()).toISOString(), alarm });
        this.states.set(alarm, e.state.armstate);
      }
      const stamp = Date.parse(e.timestamp);
      if (!Number.isFinite(stamp) || stamp < this.started - 1000 || Math.abs(this.clock() - stamp) > 10000 || typeof e.event_id !== 'string' || !/^[0-9a-f]{32}$/.test(e.event_id)) return rows;
      const common = { key: e.event_id, timestamp: new Date(stamp).toISOString(), alarm };
      if (e.e === 'alarm_command' && e.source === 'rest') {
        if (e.uses_consumed !== 0 || !['disarm', 'arm_stay', 'arm_night', 'arm_away'].includes(e.action) || !['accepted', 'rejected', 'failed'].includes(e.result)) return rows;
        if (e.result !== 'rejected' && (typeof e.user_id !== 'string' || e.user_id.length > 128)) return rows;
        rows.push({ type: 'rest', ...common, action: e.action, result: e.result, ...(e.result === 'rejected' ? {} : { user: e.user_id }) }); return rows;
      }
      if (e.e !== 'access' || !this.alarms[alarm].includes(String(e.sensor_id))) return rows;
      common.sensor = String(e.sensor_id);
      if (e.result === 'rejected') {
        if (e.action !== 'invalid_code' || e.uses_consumed !== 0) return rows;
        const details = {};
        if (e.lockout === true && integer(e.lockout_level, 1, 3) && Number.isSafeInteger(e.locked_until) && e.locked_until > stamp && e.locked_until - stamp <= 3600000) Object.assign(details, {
          level: e.lockout_level, locked_until: e.locked_until, remaining_seconds: Math.ceil((e.locked_until - stamp) / 1000),
        });
        rows.push({ type: 'invalid', ...common, locked: e.lockout === true, ...details }); return rows;
      }
      if (e.result !== undefined && e.result !== 'accepted' || typeof e.user_id !== 'string' || e.user_id.length > 128 || !['disarmed', 'already_disarmed', 'armed_stay', 'armed_away', 'armed_night'].includes(e.action) || ![0, 1].includes(e.uses_consumed) || !(e.remaining_uses === null || Number.isSafeInteger(e.remaining_uses) && e.remaining_uses >= 0)) return rows;
      rows.push({ type: 'access', ...common, user: e.user_id, action: e.action, uses: e.uses_consumed, remaining: e.remaining_uses });
    } catch { /* Malformed frames are ignored without logging raw contents. */ }
    return rows;
  }
}
export class WebAdminDebugCapture {
  constructor({ clock = () => performance.now() / 1000 } = {}) { this.clock = clock; this.clear(); }
  clear() { this.started = 0; this.until = 0; this.events = []; this.keys = new Map(); this.deadlines = new Map(); this.dropped = 0; }
  active() { return this.clock() < this.until; }
  append(row) { if (this.events.length >= 200) this.dropped++; else this.events.push({ elapsed_ms: Math.round((this.clock() - this.started) * 1000), ...row }); }
  observe(event) {
    if (!this.active() || !['ready', 'disconnected', 'access', 'invalid'].includes(event.type)) return;
    if (this.events.length >= 200) { this.dropped++; return; }
    const row = { kind: event.type };
    if (typeof event.key === 'string' && /^[0-9a-f]{32}$/.test(event.key)) {
      const repeat = this.keys.has(event.key); if (!repeat) this.keys.set(event.key, 'event-' + (this.keys.size + 1));
      Object.assign(row, { event: this.keys.get(event.key), repeated_event_id: repeat });
    }
    const stamp = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN; if (Number.isFinite(stamp)) row.event_unix_ms = stamp;
    if (event.type === 'invalid') row.locked = event.locked === true;
    if (integer(event.level, 1, 3)) row.level = event.level;
    if (integer(event.remaining_seconds, 1, 3600)) row.remaining_seconds = event.remaining_seconds;
    if (Number.isSafeInteger(event.locked_until) && event.locked_until > 0) {
      if (!this.deadlines.has(event.locked_until)) this.deadlines.set(event.locked_until, 'lockout-' + (this.deadlines.size + 1)); row.lockout = this.deadlines.get(event.locked_until);
    }
    this.append(row);
  }
  command(body) {
    requireWeb(exact(body, ['action']) && ['start', 'stop', 'clear', 'wrong_attempt', 'valid_attempt'].includes(body.action), 'invalid_debug_action');
    if (body.action === 'clear') this.clear();
    else if (body.action === 'start') { this.clear(); this.started = this.clock(); this.until = this.started + 600; this.append({ kind: 'capture_started' }); }
    else if (body.action === 'stop') { if (this.active()) this.append({ kind: 'capture_stopped' }); this.until = 0; }
    else { requireWeb(this.active(), 'debug_capture_not_active'); this.append({ kind: 'operator_marker', marker: body.action }); }
    return this.status();
  }
  status() { return { schema: 1, scope: 'selected_gateway_alarm', active: this.active(), seconds_left: Math.max(0, Math.floor(this.until - this.clock())), dropped: this.dropped, zigbee_sequence_available: false, events: structuredClone(this.events) }; }
}
