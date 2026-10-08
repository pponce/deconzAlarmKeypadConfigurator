// Offline activity-page projection. The history port owns durable storage,
// retention and identity binding; these reads never discover or contact devices.
import { requireWeb, object, exact, integer } from './web-admin-common.js';
export const webActivityCategories = ['keypad', 'deconz', 'administration'];
export function webActivityCategory(row) {
  if (['Lockout detected', 'Lockout expired', 'Lockout status unavailable'].includes(row.action)) return 'deconz';
  if (['Keypad', 'Browser keypad'].includes(row.source) || row.source.startsWith('Keypad · ')) return 'keypad';
  if (row.user === 'Administrator' || row.source === 'Configuration') return 'administration';
  return 'deconz';
}
export class WebAdminActivity {
  constructor({ registrations, catalog, connected, history }) { Object.assign(this, { registrations, catalog, connected, history }); }
  async scopes() {
    requireWeb(typeof this.history?.scopes === 'function', 'operation_not_implemented');
    const rows = await this.history.scopes(), seen = new Set();
    requireWeb(Array.isArray(rows), 'history_state_invalid');
    return rows.filter(row => {
      requireWeb(object(row) && typeof row.gateway === 'string' && integer(row.alarm, 1, 255), 'history_state_invalid');
      const key = row.gateway + ':' + row.alarm;
      requireWeb(!seen.has(key), 'history_state_invalid'); seen.add(key);
      return this.registrations.has(row.gateway);
    });
  }
  async options(scopes = undefined) {
    const stored = scopes ?? await this.scopes();
    return { gateways: [...this.registrations].map(([id, row]) => {
      const alarms = new Map((this.catalog.get(id)?.alarms ?? []).map(alarm => [alarm.id, { id: alarm.id, name: alarm.name, observed: true }]));
      for (const scope of stored) if (scope.gateway === id && !alarms.has(scope.alarm)) alarms.set(scope.alarm, { id: scope.alarm, name: 'Alarm ' + scope.alarm, observed: false });
      return { id, name: row.name, connected: this.connected.get(id) === true, alarms: [...alarms.values()].sort((a, b) => a.id - b.id) };
    }) };
  }
  async query(body) {
    requireWeb(exact(body, ['gateway', 'alarm', 'categories']), 'invalid_history_filter');
    const { gateway, alarm, categories } = body;
    requireWeb(gateway === null || typeof gateway === 'string' && this.registrations.has(gateway), 'gateway_not_registered');
    requireWeb(alarm === null || integer(alarm, 1, 255), 'invalid_history_filter');
    requireWeb(alarm === null || gateway !== null, 'history_alarm_requires_gateway');
    requireWeb(Array.isArray(categories) && categories.length <= 3 && categories.every(value => webActivityCategories.includes(value)) && new Set(categories).size === categories.length, 'invalid_history_filter');
    requireWeb(typeof this.history?.rows === 'function' && typeof this.history?.days === 'function', 'operation_not_implemented');
    const scopes = await this.scopes(), { gateways } = await this.options(scopes), lookup = new Map(gateways.map(row => [row.id, row]));
    if (alarm !== null) requireWeb(lookup.get(gateway).alarms.some(row => row.id === alarm), 'alarm_not_found');
    const rows = [];
    for (const scope of scopes.filter(row => (gateway === null || row.gateway === gateway) && (alarm === null || row.alarm === alarm))) {
      const source = lookup.get(scope.gateway), selected = source.alarms.find(row => row.id === scope.alarm);
      const history = await this.history.rows(scope.gateway, scope.alarm, 5000);
      requireWeb(Array.isArray(history) && history.length <= 5000, 'history_state_invalid');
      for (const raw of history) {
        requireWeb(object(raw) && integer(raw.seq, 1, Number.MAX_SAFE_INTEGER) && ['time', 'user', 'source', 'action', 'result'].every(key => typeof raw[key] === 'string'), 'history_state_invalid');
        const category = webActivityCategory(raw);
        if (categories.includes(category)) rows.push({ ...Object.fromEntries(['seq', 'time', 'user', 'source', 'action', 'result'].map(key => [key, raw[key]])),
          category, gateway_id: source.id, gateway_name: source.name, alarm_id: selected.id, alarm_name: selected.name });
      }
    }
    const stamp = value => { const n = Date.parse(value.time); return Number.isFinite(n) ? n : 0; };
    rows.sort((a, b) => stamp(b) - stamp(a) || b.seq - a.seq);
    const retention = await this.history.days(); requireWeb([1, 3, 7, 30, 90].includes(retention), 'invalid_history_retention');
    const sources = gateways.filter(row => gateway === null || row.id === gateway);
    return { rows: rows.slice(0, 200), retention_days: retention, limit: 200, connected: sources.length > 0 && sources.every(row => row.connected) };
  }
  async clear(body) {
    requireWeb(exact(body, ['gateway', 'alarm', 'confirmed']) && body.confirmed === true, 'history_confirmation_required');
    requireWeb(typeof this.history?.clear === 'function', 'operation_not_implemented');
    const { gateway, alarm } = body;
    requireWeb(gateway === null || typeof gateway === 'string' && this.registrations.has(gateway), 'gateway_not_registered');
    requireWeb(alarm === null || integer(alarm, 1, 255), 'invalid_history_filter');
    requireWeb(alarm === null || gateway !== null, 'history_alarm_requires_gateway');
    const scopes = await this.scopes();
    if (alarm !== null) requireWeb((await this.options(scopes)).gateways.find(row => row.id === gateway).alarms.some(row => row.id === alarm), 'alarm_not_found');
    for (const row of scopes) if ((gateway === null || row.gateway === gateway) && (alarm === null || row.alarm === alarm)) await this.history.clear(row.gateway, row.alarm);
    return { cleared: true };
  }
  async retention(body) {
    requireWeb(typeof this.history?.setDays === 'function' && typeof this.history?.expire === 'function', 'operation_not_implemented');
    const result = await this.history.setDays(body);
    for (const row of await this.scopes()) await this.history.expire(row.gateway, row.alarm);
    return result;
  }
}
