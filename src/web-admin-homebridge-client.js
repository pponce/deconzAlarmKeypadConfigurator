// Supported Homebridge UI REST controls. Authentication is explicit and kept
// only in memory; no auth.json reading, signed-token fabrication, shell or sudo.
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { WebAdminError } from './web-admin-auth.js';
import { requireWeb, object, exact, integer, parseWebJson } from './web-admin-common.js';

const bridgeId = value => typeof value === 'string' && /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(value);
const now = () => performance.now();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function homebridgeUiOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new WebAdminError('homebridge_ui_address_invalid'); }
  requireWeb(typeof value === 'string' && ['http:', 'https:'].includes(url.protocol) &&
    ['127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/' &&
    !url.username && !url.password && !url.search && !url.hash && url.port !== '0', 'homebridge_ui_address_invalid');
  return url.origin;
}

// Never propagate request objects, response text, HTTP headers or transport
// errors: they can contain the username, password or authorization token.
export function homebridgeUiExchange({ origin, route, method = 'GET', body, authorization, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    let request, response, timer, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { response?.destroy(); request?.destroy(); reject(new WebAdminError(error)); }
      else resolve(value);
    };
    try {
      const endpoint = new URL(homebridgeUiOrigin(origin) + route);
      requireWeb(/^\/api\/[a-z0-9/:-]+$/.test(route) && !route.includes('..') &&
        ['GET', 'POST', 'PUT'].includes(method) && integer(timeoutMs, 1, 8000), 'homebridge_ui_request_invalid');
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      requireWeb(!data || data.length <= 16384, 'homebridge_ui_request_invalid');
      requireWeb(authorization === undefined || typeof authorization === 'string' && /^[A-Za-z0-9_.-]{1,8192}$/.test(authorization), 'homebridge_ui_request_invalid');
      request = (endpoint.protocol === 'http:' ? http : https).request(endpoint, {
        method, agent: false, maxHeaderSize: 8192,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Connection: 'close',
          ...(data ? { 'Content-Length': data.length } : {}), ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}) },
      }, reply => {
        response = reply; const chunks = []; let length = 0;
        // A redirect must never carry authentication to another service.
        if (reply.statusCode >= 300 && reply.statusCode < 400) return finish('homebridge_ui_redirect_rejected');
        reply.on('data', chunk => {
          length += chunk.length;
          if (length > 4 * 1024 * 1024) return finish('homebridge_ui_response_invalid');
          chunks.push(chunk);
        });
        reply.on('aborted', () => finish('homebridge_ui_result_unknown'));
        reply.on('error', () => finish('homebridge_ui_result_unknown'));
        reply.on('end', () => {
          if (settled) return;
          try {
            const value = parseWebJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            finish(null, { status: reply.statusCode, value });
          } catch { finish('homebridge_ui_response_invalid'); }
        });
      });
      request.on('error', () => finish('homebridge_ui_result_unknown'));
      timer = setTimeout(() => finish('homebridge_ui_result_unknown'), timeoutMs); request.end(data);
    } catch { finish('homebridge_ui_request_invalid'); }
  });
}

export class WebHomebridgeClient {
  #token = null;
  #expires = 0;
  constructor({ origin, bridge, exchange = homebridgeUiExchange, clock = now, sleep = delay }) {
    requireWeb(bridgeId(bridge), 'homebridge_child_identity_invalid');
    this.origin = homebridgeUiOrigin(origin); this.bridge = bridge;
    Object.assign(this, { exchange, clock, sleep }); this.sent = new Set();
  }
  close() { this.#token = null; this.#expires = 0; }
  async login(credentials) {
    this.close();
    requireWeb(exact(credentials, ['username', 'password']) || exact(credentials, ['username', 'password', 'otp']), 'homebridge_login_required');
    requireWeb(typeof credentials.username === 'string' && credentials.username.length > 0 && credentials.username.length <= 256 &&
      typeof credentials.password === 'string' && credentials.password.length > 0 && credentials.password.length <= 1024 &&
      (!Object.hasOwn(credentials, 'otp') || typeof credentials.otp === 'string' && /^[0-9]{6}$/.test(credentials.otp)), 'homebridge_login_required');
    let result;
    try { result = await this.exchange({ origin: this.origin, route: '/api/auth/login', method: 'POST', body: credentials }); }
    catch { throw new WebAdminError('homebridge_login_unavailable'); }
    finally { credentials.password = ''; if (Object.hasOwn(credentials, 'otp')) credentials.otp = ''; }
    requireWeb(result.status === 200 || result.status === 201, 'homebridge_login_rejected');
    requireWeb(typeof result.value?.access_token === 'string' && /^[A-Za-z0-9_.-]{1,8192}$/.test(result.value.access_token), 'homebridge_login_rejected');
    this.#token = result.value.access_token; this.#expires = this.clock() + 5 * 60 * 1000;
    try {
      // This endpoint requires Homebridge administrator permission. A successful
      // login or an unverified JWT claim alone is not sufficient authorization.
      const config = await this.#request('/api/config-editor');
      const rows = config?.platforms?.filter(row => row?.platform === 'deCONZ');
      requireWeb(Array.isArray(rows) && rows.length === 1 && rows[0]._bridge?.username?.toUpperCase() === this.bridge &&
        !config.disabledPlugins?.includes('homebridge-deconz') &&
        (!config.plugins || config.plugins.includes('homebridge-deconz')), 'homebridge_configuration_changed');
      const status = await this.status(); requireWeb(status.plugin === 'homebridge-deconz', 'homebridge_child_identity_changed');
      return { authenticated: true, bridge: this.bridge, expires_in: 300 };
    } catch (error) { this.close(); throw error; }
  }
  async #request(route, method = 'GET') {
    requireWeb(this.#token && this.clock() < this.#expires, 'homebridge_login_required');
    const reads = ['/api/config-editor', '/api/status/homebridge/child-bridges'];
    const writes = ['stop', 'start', 'restart'].map(action => '/api/server/' + action + '/' + this.bridge.toLowerCase());
    requireWeb(method === 'GET' ? reads.includes(route) : method === 'PUT' && writes.includes(route), 'homebridge_ui_request_invalid');
    let result;
    try { result = await this.exchange({ origin: this.origin, route, method, authorization: this.#token }); }
    catch { throw new WebAdminError('homebridge_ui_result_unknown'); }
    if ([401, 403].includes(result.status)) { this.close(); throw new WebAdminError('homebridge_login_required'); }
    requireWeb(result.status === 200, 'homebridge_ui_result_unknown'); return result.value;
  }
  async status() {
    const rows = await this.#request('/api/status/homebridge/child-bridges');
    requireWeb(Array.isArray(rows), 'homebridge_ui_response_invalid');
    const found = rows.filter(row => row?.username?.toUpperCase() === this.bridge);
    requireWeb(found.length === 1 && found[0].plugin === 'homebridge-deconz', 'homebridge_child_identity_changed');
    const row = found[0];
    requireWeb(['pending', 'ok', 'down'].includes(row.status) && typeof row.manuallyStopped === 'boolean' &&
      (row.pid == null || integer(row.pid, 1, Number.MAX_SAFE_INTEGER)), 'homebridge_ui_response_invalid');
    // The upstream metadata includes pairing codes; never return those.
    return { bridge: this.bridge, plugin: row.plugin, status: row.status, pid: row.pid ?? null, manuallyStopped: row.manuallyStopped };
  }
  async command(action, transactionId, confirmed) {
    requireWeb(['stop', 'start', 'restart'].includes(action) && typeof transactionId === 'string' && /^[0-9a-f]{32}$/.test(transactionId), 'homebridge_restart_request_invalid');
    requireWeb(confirmed === true, 'homebridge_restart_confirmation_required');
    const key = transactionId + ':' + action;
    requireWeb(!this.sent.has(key), 'homebridge_command_already_requested');
    // The caller must persist its matching intent before calling. This in-memory
    // guard is additional protection and never substitutes for a durable lease.
    this.sent.add(key);
    const result = await this.#request('/api/server/' + action + '/' + this.bridge.toLowerCase(), 'PUT');
    requireWeb(object(result) && result.ok === true, 'homebridge_ui_result_unknown');
    return { requested: true, verified: false }; // An ACK does not prove a stop.
  }
  async waitFor(predicate, timeoutMs = 30000) {
    requireWeb(typeof predicate === 'function' && integer(timeoutMs, 1, 30000), 'homebridge_restart_request_invalid');
    const deadline = this.clock() + timeoutMs;
    while (true) {
      const state = await this.status();
      if (await predicate(state)) return state;
      requireWeb(this.clock() < deadline, 'homebridge_restart_unverified');
      await this.sleep(Math.min(500, deadline - this.clock()));
    }
  }
}
