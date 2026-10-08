// Explicitly started, read-only collection. Browser refresh never controls it.
import { WebAdminGateway } from './web-admin-gateway.js';
import { WebAdminView } from './web-admin-view.js';
import { WebAdminEventProjection } from './web-admin-events.js';
import { requireWeb, object, integer } from './web-admin-common.js';

export class WebAdminCollector {
  constructor({ backend, interval = () => 60, gatewayFactory = row => new WebAdminGateway(row), socketFactory = url => new WebSocket(url) }) {
    Object.assign(this, { backend, interval, gatewayFactory, socketFactory }); this.running = false; this.states = new Map();
  }
  start() {
    if (this.running) return; this.running = true;
    for (const [id, registration] of this.backend.registrations) {
      const state = { id, registration, socket: null, timer: null, generation: 0, pending: Promise.resolve(), discovering: false }; this.states.set(id, state); this.schedule(state, 0);
    }
  }
  schedule(state, milliseconds) { clearTimeout(state.timer); if (this.running) state.timer = setTimeout(() => { void this.refresh(state); }, milliseconds); }
  requestDiscovery(gateway) { const state = this.states.get(gateway); if (state && this.running) { if (state.discovering) state.refreshAgain = true; else this.schedule(state, 0); } }
  async verifyLockouts(state, client, alarms) {
    const history = this.backend.history;
    for (const alarm of Object.keys(alarms).map(Number)) {
      if (!this.running) return;
      const pending = await history.dueLockouts(state.id, alarm); if (!pending.length) continue;
      let rows;
      try {
        await client.verify(alarm); const raw = await client.request('/alarmsystems/' + alarm + '/users/lockout');
        requireWeb(object(raw.policy) && typeof raw.policy.enabled === 'boolean' && Array.isArray(raw.keypads) && raw.keypads.every(row => object(row) && integer(row.locked_until, 0, Number.MAX_SAFE_INTEGER) && integer(row.remaining_seconds, 0, Number.MAX_SAFE_INTEGER)), 'gateway_response_invalid'); rows = raw.keypads;
      } catch { for (const row of pending) await history.lockoutVerification(state.id, alarm, row.episode, false); continue; }
      for (const row of pending) {
        const matches = rows.filter(value => value.locked_until === row.deadline);
        if (matches.some(value => value.remaining_seconds > 0)) continue;
        await history.lockoutVerification(state.id, alarm, row.episode, (matches.length ? matches : rows).every(value => value.remaining_seconds === 0));
      }
    }
  }
  async discover(state) {
    const client = this.gatewayFactory(state.registration), view = new WebAdminView({ gatewayId: state.id, name: state.registration.name, client });
    const inventory = await view.inventory(), config = await client.verify();
    requireWeb(integer(config.websocketport, 1, 65535), 'websocket_port_missing');
    const endpoint = new URL(state.registration.endpoint), url = (endpoint.protocol === 'https:' ? 'wss://' : 'ws://') + endpoint.hostname + ':' + config.websocketport + '/';
    const alarms = Object.fromEntries(inventory.alarms.map(alarm => [String(alarm.id), inventory.keypads.filter(pad => pad.alarm_ids.includes(alarm.id)).map(pad => pad.id)]));
    await this.verifyLockouts(state, client, alarms);
    const users = await client.request('/alarmsystems/users'); requireWeb(object(users), 'gateway_response_invalid');
    const names = new Map(Object.entries(users).filter(([, row]) => object(row) && typeof row.name === 'string').map(([id, row]) => [id, [...row.name].slice(0, 64).join('')]));
    return { inventory, url, alarms, names };
  }
  refresh(state) {
    if (!this.running || state.discovering) return state.discovery;
    state.discovering = true;
    state.discovery = this.refreshActive(state).finally(() => { state.discovering = false; });
    return state.discovery;
  }
  async refreshActive(state) {
    const generation = state.generation;
    try {
      const fresh = await this.discover(state);
      if (!this.running || generation !== state.generation) return;
      this.backend.catalog.set(state.id, fresh.inventory);
      if (state.socket) {
        requireWeb(fresh.url === state.url, 'event_endpoint_changed'); state.projection.update(fresh.alarms); state.names = fresh.names;
      } else this.connect(state, fresh);
      const interval = this.interval(); requireWeb(integer(interval, 10, 3600), 'discovery_interval_invalid');
      this.schedule(state, (state.refreshAgain ? 0 : interval * 1000)); state.refreshAgain = false;
    } catch { await this.disconnect(state); this.schedule(state, 5000); }
  }
  enqueue(state, event) {
    // The queue contains only bounded projected events, never raw frames/codes.
    if ((state.queued ?? 0) >= 256) { void this.disconnect(state).then(() => this.schedule(state, 5000)); return; }
    state.queued = (state.queued ?? 0) + 1;
    const generation = state.generation;
    state.pending = state.pending.then(async () => { if (this.running && generation === state.generation) await this.record(state, event); })
      .catch(async () => { await this.disconnect(state); this.schedule(state, 5000); })
      .finally(() => { state.queued--; });
  }
  connect(state, fresh) {
    Object.assign(state, { names: fresh.names, url: fresh.url, projection: new WebAdminEventProjection(fresh.alarms) });
    const socket = this.socketFactory(fresh.url), generation = ++state.generation; state.socket = socket;
    const alive = () => this.running && state.socket === socket && generation === state.generation;
    state.openTimer = setTimeout(() => { if (alive()) void this.disconnect(state).then(() => this.schedule(state, 5000)); }, 8000);
    socket.onopen = () => { if (!alive()) return; clearTimeout(state.openTimer); this.backend.connected.set(state.id, true); this.enqueue(state, { type: 'ready' }); };
    socket.onmessage = event => { if (alive() && this.backend.connected.get(state.id)) for (const row of state.projection.read(event.data)) this.enqueue(state, row); };
    socket.onerror = socket.onclose = () => { if (alive()) void this.disconnect(state).then(() => this.schedule(state, 5000)); };
  }
  async record(state, event) {
    const history = this.backend.history, alarms = state.projection.alarms;
    if (event.type === 'ready') {
      for (const id of Object.keys(alarms)) { this.backend.debugCaptures.get(state.id + ':' + id)?.observe(event); await history.add(state.id, Number(id), 'System', 'Observer', 'Connected', 'Live collection resumed; events during gaps are unavailable'); } return;
    }
    if (!Object.hasOwn(alarms, event.alarm)) return;
    this.backend.debugCaptures.get(state.id + ':' + event.alarm)?.observe(event);
    const args = [state.id, Number(event.alarm)], user = () => state.names.get(event.user) ?? 'Deleted or unknown user';
    if (event.type === 'alarm_state') await history.add(...args, 'Alarm', 'deCONZ', event.state.replaceAll('_', ' '), 'Observed state; no person or physical output inferred', null, event.timestamp);
    else if (event.type === 'rest') await history.add(...args, event.result === 'rejected' ? 'Unknown' : user(), 'REST/API', event.action.replaceAll('_', ' '), {
      accepted: 'Accepted by deCONZ; actual state reported separately', rejected: 'Credential rejected; alarm unchanged', failed: 'Credential accepted; alarm target failed',
    }[event.result], event.key, event.timestamp);
    else if (event.type === 'access') await history.add(...args, user(), 'Keypad', event.action.replaceAll('_', ' '), 'Accepted; ' + event.uses + ' use consumed', event.key, event.timestamp);
    else if (event.type === 'invalid') {
      if (event.locked && event.locked_until) await history.lockoutEvent(...args, event);
      else await history.add(...args, 'Unknown', 'Keypad', 'Code rejected', 'Rejected by deCONZ', event.key, event.timestamp);
    }
  }
  async disconnect(state) {
    const connected = this.backend.connected.get(state.id) === true; this.backend.connected.set(state.id, false); state.generation++;
    clearTimeout(state.openTimer); const socket = state.socket; state.socket = null;
    if (socket) { socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; try { socket.close(); } catch { /* Already closed. */ } }
    if (connected) for (const alarm of Object.keys(state.projection?.alarms ?? {})) {
      this.backend.debugCaptures.get(state.id + ':' + alarm)?.observe({ type: 'disconnected' });
      try { await this.backend.history.add(state.id, Number(alarm), 'System', 'Observer', 'Disconnected', 'History gap; no replay'); } catch { /* Private-storage errors never expose raw events. */ }
    }
  }
  async close() {
    this.running = false;
    for (const state of this.states.values()) { clearTimeout(state.timer); await this.disconnect(state); await state.discovery; await state.pending; }
    this.states.clear();
  }
}
