// Read-only port of View, DomainMethods, Editor.snapshot and presentation.overview.
import { createHash } from 'node:crypto';
import { requireWeb, object, integer } from './web-admin-common.js';
import { userFields, identityFields, grantFields, alarmModes, alarmStates, alarmTimingFields, alarmTimings, lockoutPolicy } from './web-admin-domain.js';

const label = (value, fallback) => typeof value === 'string' && value ? [...value].slice(0, 64).join('') : fallback;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const alarmId = value => typeof value === 'string' && /^[1-9][0-9]{0,2}$/.test(value) && integer(Number(value), 1, 255);
const userId = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const keypadKey = pad => pad ? pad.source + ':' + pad.endpoint : null;
export function projectWebFields(raw, fields) {
  requireWeb(object(raw) && fields.every(key => Object.hasOwn(raw, key)), 'gateway_response_invalid');
  const result = Object.fromEntries(fields.map(key => [key, structuredClone(raw[key])]));
  if (fields.includes('keypads')) {
    requireWeb(Array.isArray(result.keypads) && result.keypads.every(pad => object(pad) && typeof pad.source === 'string' && integer(pad.endpoint, 1, 240)), 'gateway_response_invalid');
    result.keypads.sort((a, b) => order(a.source, b.source) || a.endpoint - b.endpoint);
  }
  return result;
}

export class WebAdminView {
  constructor({ gatewayId, name, alarm = null, client, onInventory = () => {}, transactionStatus, homebridgeStatus = () => null }) {
    requireWeb(alarm === null || integer(alarm, 1, 255), 'invalid_alarm');
    Object.assign(this, { gatewayId, name, alarmId: alarm, client, onInventory, transactionStatus, homebridgeStatus });
    this.names = new Map();
  }
  gateway(suffix = '', { alarm = false, targetAlarm = this.alarmId } = {}) {
    requireWeb(integer(targetAlarm, 1, 255), 'explicit_alarm_required');
    requireWeb(['', '/capabilities', '/lockout'].includes(suffix), 'gateway_route_invalid');
    return this.client.request('/alarmsystems/' + targetAlarm + (alarm ? '' : '/users') + suffix);
  }
  async inventory() {
    await this.client.verify();
    const alarms = await this.client.request('/alarmsystems'), sensors = await this.client.request('/sensors');
    requireWeb(object(alarms) && object(sensors), 'gateway_response_invalid');
    const rows = [];
    for (const [aid, row] of Object.entries(alarms)) {
      requireWeb(alarmId(aid) && object(row), 'gateway_response_invalid');
      const caps = await this.client.verify(Number(aid));
      rows.push({ id: Number(aid), name: label(row.name, 'Alarm ' + aid), managed: caps.managed === true, state: row.state?.armstate ?? 'unknown' });
    }
    const pads = [];
    for (const [sid, row] of Object.entries(sensors)) {
      if (!object(row) || row.type !== 'ZHAAncillaryControl') continue;
      requireWeb(/^[0-9]+$/.test(sid), 'gateway_response_invalid');
      const identity = row.uniqueid, assigned = Object.entries(alarms).filter(([, alarm]) => typeof identity === 'string' && object(alarm.devices) && Object.hasOwn(alarm.devices, identity)).map(([aid]) => Number(aid));
      const match = typeof identity === 'string' && /^([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){7})-([0-9a-fA-F]{2})(?:-[0-9a-fA-F]{4})?$/.exec(identity);
      const address = match && integer(parseInt(match[2], 16), 1, 240) ? { source: BigInt('0x' + match[1].replaceAll(':', '')).toString(16), endpoint: parseInt(match[2], 16) } : null;
      pads.push({ id: sid, name: label(row.name, 'Keypad ' + sid), alarm_ids: assigned, reachable: row.config?.reachable === true, address });
    }
    const result = { gateway: { id: this.gatewayId, name: this.name }, alarms: rows.sort((a, b) => a.id - b.id), keypads: pads };
    await this.onInventory(structuredClone(result)); return result;
  }
  async alarm() {
    const caps = await this.gateway('/capabilities'), raw = await this.gateway('', { alarm: true });
    requireWeb(object(raw.config) && object(raw.state), 'gateway_response_invalid');
    const timings = alarmTimings(Object.fromEntries(alarmTimingFields.map(key => [key, raw.config[key]])));
    requireWeb(alarmModes.includes(raw.config.armmode) && alarmStates.includes(raw.state.armstate) && integer(raw.state.seconds_remaining, 0, 255), 'gateway_response_invalid');
    // Preserve Python json.dumps(..., sort_keys=True) spacing for revision parity.
    const serialized = '{' + Object.keys(timings).sort().map(key => JSON.stringify(key) + ': ' + timings[key]).join(', ') + '}';
    return { state: raw.state.armstate, target: raw.config.armmode, seconds_remaining: raw.state.seconds_remaining, timings,
      revision: createHash('sha256').update(serialized).digest('hex'), timing_supported: caps.alarm_timing_version === 1, rest_activity: caps.rest_command_events === true && caps.managed === true };
  }
  async users(targetAlarm = this.alarmId) {
    const raw = await this.gateway('', { targetAlarm }); requireWeb(object(raw), 'gateway_response_invalid');
    const result = Object.entries(raw).map(([id, row]) => {
      requireWeb(userId(id) && object(row) && row.id === id, 'gateway_response_invalid');
      return { ...projectWebFields(row, userFields), schedule: structuredClone(row.schedule ?? null) };
    });
    if (targetAlarm === this.alarmId) this.names = new Map(result.map(row => [row.id, row.name]));
    return result.sort((a, b) => Number(!a.owner) - Number(!b.owner) || order(a.name, b.name) || order(a.id, b.id));
  }
  async lockout() {
    const caps = await this.gateway('/capabilities'); requireWeb(caps.keypad_lockout_version === 1, 'lockout_plugin_update_required');
    const raw = await this.gateway('/lockout'); requireWeb(object(raw.policy) && Array.isArray(raw.keypads), 'gateway_response_invalid');
    const policy = lockoutPolicy(raw.policy), states = new Map();
    for (const row of raw.keypads) {
      requireWeb(object(row) && integer(row.level, 0, 3) && integer(row.remaining_seconds, 0, Number.MAX_SAFE_INTEGER) && typeof row.source === 'string' && /^[0-9a-fA-F]{1,16}$/.test(row.source) && integer(row.endpoint, 1, 240), 'gateway_response_invalid');
      const key = BigInt('0x' + row.source).toString(16) + ':' + row.endpoint;
      requireWeb(!states.has(key), 'gateway_response_invalid'); states.set(key, { level: row.level, remaining_seconds: row.remaining_seconds });
    }
    const inventory = await this.inventory(), pads = inventory.keypads.filter(pad => pad.alarm_ids.includes(this.alarmId));
    const keys = pads.map(pad => keypadKey(pad.address)), matched = new Set();
    const rows = pads.map((pad, i) => {
      const key = keys[i], known = key !== null && keys.filter(item => item === key).length === 1;
      if (known) matched.add(key);
      return { id: pad.id, name: pad.name, known, ...(known ? states.get(key) ?? { level: 0, remaining_seconds: 0 } : { level: null, remaining_seconds: null }) };
    });
    return { policy, keypads: rows, managed: caps.managed === true, unmatched_keypads: [...states].filter(([key]) => !matched.has(key)).map(([, state]) => state) };
  }
  async snapshot() {
    requireWeb(integer(this.alarmId, 1, 255), 'explicit_alarm_required'); await this.client.verify(this.alarmId);
    const raw = await this.client.request('/alarmsystems/users'); requireWeb(object(raw), 'gateway_response_invalid');
    const identities = Object.fromEntries(Object.entries(raw).map(([id, row]) => {
      requireWeb(userId(id) && row?.id === id, 'gateway_response_invalid'); return [id, projectWebFields(row, identityFields)];
    }));
    const alarms = await this.client.request('/alarmsystems'); requireWeb(object(alarms) && Object.hasOwn(alarms, this.alarmId), 'alarm_not_found');
    const grants = {}, capabilities = {};
    for (const id of Object.keys(alarms)) {
      requireWeb(alarmId(id), 'gateway_response_invalid'); const caps = await this.client.verify(Number(id));
      capabilities[id] = Object.fromEntries(['managed', 'schedules', 'schedule_version', 'keypad_lockout_version'].map(key => [key, caps[key] ?? null]));
      const users = await this.client.request('/alarmsystems/' + id + '/users'); requireWeb(object(users), 'gateway_response_invalid');
      grants[id] = Object.fromEntries(Object.entries(users).map(([uid, row]) => {
        requireWeb(Object.hasOwn(identities, uid) && row?.id === uid, 'gateway_response_invalid'); return [uid, projectWebFields(row, grantFields)];
      }));
    }
    return { identities, grants, capabilities, alarm: await this.alarm() };
  }
  async administration() {
    const inventory = await this.inventory(), snapshot = await this.snapshot();
    const alarms = inventory.alarms.map(alarm => {
      const pads = inventory.keypads.filter(p => p.alarm_ids.includes(alarm.id) && p.address).map(p => ({ ...p.address, name: p.name }));
      const known = new Set(pads.map(keypadKey));
      for (const grant of Object.values(snapshot.grants[alarm.id])) for (const pad of grant.keypads) {
        if (!known.has(keypadKey(pad))) { pads.push({ ...pad, name: 'Previously allowed keypad (not discovered)' }); known.add(keypadKey(pad)); }
      }
      return { ...alarm, users: Object.values(snapshot.grants[alarm.id]), keypads: pads };
    });
    const current = alarms.find(alarm => alarm.id === this.alarmId), caps = snapshot.capabilities[this.alarmId];
    requireWeb(!!current && typeof this.transactionStatus === 'function', 'administration_state_unavailable');
    const hb = await this.homebridgeStatus();
    return { identities: Object.values(snapshot.identities), alarms, users: current.users, keypads: current.keypads, managed: current.managed,
      schedules: caps.schedules === true && caps.schedule_version === 1, homebridge_sync: false, homebridge_available: hb !== null && hb.configured !== false,
      ...(hb === null ? {} : { homebridge_status: { configured: hb.configured !== false, error: hb.error ?? null, ...(hb.file_check ? { file_check: hb.file_check } : {}) } }),
      homebridge_binding: hb?.bindings?.find(b => b.gateway === this.gatewayId) ?? null, transaction: await this.transactionStatus(this.gatewayId) };
  }
}
