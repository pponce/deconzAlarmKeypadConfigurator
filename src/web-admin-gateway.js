// Port of configurator/gateway.py. One bounded request, no redirects or retry.
import http from 'node:http';
import https from 'node:https';
import { WebAdminError } from './web-admin-auth.js';
import { requireWeb, object, exact, integer, parseWebJson } from './web-admin-common.js';

export const safeGatewayErrors = new Set([
  'invalid_pin', 'invalid_name', 'invalid_remaining_uses', 'revision_required', 'invalid_schedule',
  'revision_conflict', 'pin_required', 'pin_already_assigned', 'current_pin_required',
  'update_failed_or_revision_conflict', 'delete_failed_or_revision_conflict',
  'owner_must_be_unrestricted', 'last_unrestricted_owner_required', 'invalid_keypads', 'user_limit',
  'invalid_lockout_policy', 'managed_users_required', 'invalid_user', 'user_not_found',
  'storage_error', 'invalid_body', 'unknown_field',
]);
export class WebGatewayRejected extends WebAdminError {
  constructor(reason, definite = false) { super(reason); this.definite = definite; }
}

export function validateWebGateways(rows) {
  requireWeb(Array.isArray(rows) && rows.length <= 16, 'gateway_registry_invalid');
  const ids = new Set(), identities = new Set();
  for (const row of rows) {
    requireWeb(exact(row, ['id', 'name', 'identity', 'endpoint', 'key']), 'gateway_registry_invalid');
    requireWeb(typeof row.id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(row.id) && !ids.has(row.id), 'gateway_id_invalid');
    requireWeb(typeof row.identity === 'string' && /^[0-9A-F]{16}$/.test(row.identity) && !identities.has(row.identity), 'gateway_identity_invalid');
    requireWeb(typeof row.name === 'string' && [...row.name].length > 0 && [...row.name].length <= 64, 'gateway_name_invalid');
    requireWeb(typeof row.key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row.key), 'gateway_key_invalid');
    let url; try { url = new URL(row.endpoint); } catch { throw new WebAdminError('gateway_endpoint_invalid'); }
    requireWeb(typeof row.endpoint === 'string' && ['http:', 'https:'].includes(url.protocol) &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && url.port !== '0', 'gateway_endpoint_invalid');
    ids.add(row.id); identities.add(row.identity);
  }
  return structuredClone(rows);
}

export function webGatewayExchange({ url, method, body, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    let request, response, timer, done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) { response?.destroy(); request?.destroy(); reject(new WebAdminError(error)); }
      else resolve(value);
    };
    try {
      const endpoint = new URL(url);
      requireWeb(['http:', 'https:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && integer(timeoutMs, 1, 8000), 'gateway_route_invalid');
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      requireWeb(!data || data.length <= 65536, 'body_rejected');
      request = (endpoint.protocol === 'https:' ? https : http).request(endpoint, {
        method, agent: false, maxHeaderSize: 8192,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Connection: 'close', ...(data ? { 'Content-Length': data.length } : {}) },
      }, reply => {
        response = reply; const chunks = []; let length = 0;
        reply.on('data', chunk => {
          length += chunk.length;
          if (length > 4 * 1024 * 1024) return finish('gateway_response_invalid');
          chunks.push(chunk);
        });
        reply.on('error', () => finish('gateway_result_unknown_no_retry'));
        reply.on('aborted', () => finish('gateway_result_unknown_no_retry'));
        reply.on('end', () => {
          if (done) return;
          try { finish(null, [reply.statusCode, parseWebJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))]); }
          catch { finish('gateway_response_invalid'); }
        });
      });
      request.on('error', () => finish('gateway_result_unknown_no_retry'));
      timer = setTimeout(() => finish('gateway_result_unknown_no_retry'), timeoutMs);
      request.end(data);
    } catch { finish('gateway_result_unknown_no_retry'); }
  });
}

export class WebAdminGateway {
  constructor(registration, { writable = false, exchange = webGatewayExchange } = {}) {
    this.registration = validateWebGateways([registration])[0];
    this.writable = writable; this.transport = exchange;
  }
  exchange(path, method = 'GET', body) {
    requireWeb(typeof path === 'string' && path.startsWith('/') && !/[?#%\\]/.test(path) && !path.includes('..'), 'gateway_route_invalid');
    if (method !== 'GET') {
      requireWeb(this.writable, 'candidate_read_only_required');
      requireWeb(['POST', 'PUT', 'DELETE'].includes(method) && object(body) && /^\/alarmsystems\/(?:users\/[0-9a-f]{32}|[1-9][0-9]{0,2}\/(?:users(?:\/(?:[0-9a-f]{32}|lockout))?|config|disarm|arm_stay|arm_night|arm_away))$/.test(path), 'gateway_route_invalid');
      const collection = path.endsWith('/users'), grant = /^\/alarmsystems\/[1-9][0-9]{0,2}\/users\/(?:[0-9a-f]{32}|lockout)$/.test(path);
      requireWeb(collection ? method === 'POST' : grant ? ['PUT', 'DELETE'].includes(method) : method === 'PUT', 'gateway_route_invalid');
    } else requireWeb(body === undefined, 'gateway_route_invalid');
    return this.transport({ url: this.registration.endpoint.replace(/\/$/, '') + '/api/' + this.registration.key + path, method, body });
  }
  async request(path, method = 'GET', body) {
    const [status, value] = await this.exchange(path, method, body);
    if (Array.isArray(value)) {
      const first = value.find(object), reason = object(first?.error) ? first.error.description : undefined;
      if (safeGatewayErrors.has(reason)) {
        const aid = /^\/alarmsystems\/([1-9][0-9]{0,2})\/users(?:\/.*)?$/.exec(path)?.[1] || '0';
        const definite = method !== 'GET' && [200, 400].includes(status) && value.length === 1 && exact(value[0], ['error']) &&
          value[0].error.type === 7 && value[0].error.address === '/alarmsystems/' + aid + '/users' &&
          !['storage_error', 'update_failed_or_revision_conflict', 'delete_failed_or_revision_conflict'].includes(reason);
        throw new WebGatewayRejected(reason, definite);
      }
      if (status === 200 && value.length && value.every(row => exact(row, ['success']))) return value;
      throw new WebAdminError('gateway_result_unknown_no_retry');
    }
    requireWeb(status === 200 && object(value), 'gateway_response_invalid'); return value;
  }
  async verify(alarm) {
    const config = await this.request('/config');
    requireWeb(String(config.bridgeid ?? '').replaceAll(':', '').toUpperCase() === this.registration.identity, 'gateway_identity_changed');
    if (alarm !== undefined && alarm !== null) {
      requireWeb(integer(alarm, 1, 255), 'invalid_alarm');
      const caps = await this.request('/alarmsystems/' + alarm + '/users/capabilities');
      requireWeb(caps.global_users_version === 2, 'enhanced_plugin_required'); return caps;
    }
    return config;
  }
}
