// Authenticated original-browser API transport. Unimplemented administration
// endpoints fail explicitly. Homebridge startup integration remains separate.
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { WebAdminError } from './web-admin-auth.js';
import { parseWebJson } from './web-admin-common.js';
import { webAdminRoute } from './web-admin-routes.js';

const LIMIT = 65536;
const requireValue = (condition, code) => { if (!condition) throw new WebAdminError(code); };
const shape = (body, fields) => Object.keys(body).sort().join(',') === [...fields].sort().join(',');
const cookie = token => '__Host-configurator=' + token + (token ? '' : '; Max-Age=0') + '; Secure; HttpOnly; SameSite=Strict; Path=/';
function tokenOf(request) {
  const matches = (request.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith('__Host-configurator='));
  requireValue(matches.length <= 1, 'login_required');
  return matches[0]?.slice('__Host-configurator='.length) || '';
}
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function headerCount(request, name) {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === name) count++;
  return count;
}
async function readBody(request) {
  requireValue(!request.headers['transfer-encoding'] && headerCount(request, 'content-length') === 1 &&
    /^[0-9]+$/.test(request.headers['content-length'] || ''), 'body_rejected');
  const length = Number(request.headers['content-length']);
  requireValue(length > 0 && length <= LIMIT && request.headers['content-type']?.split(';')[0] === 'application/json', 'body_rejected');
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; requireValue(bytes <= LIMIT && bytes <= length, 'body_rejected'); chunks.push(chunk); }
  requireValue(bytes === length, 'body_rejected');
  let body;
  try { body = parseWebJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new WebAdminError('body_rejected'); }
  requireValue(body && typeof body === 'object' && !Array.isArray(body), 'body_rejected');
  return body;
}

export function createWebAdminHandler({ origin, auth, assets = new Map(), backend, web, available = () => true }) {
  const publicUrl = new URL(origin);
  requireValue(publicUrl.protocol === 'https:' && publicUrl.origin === origin && !publicUrl.username && !publicUrl.password, 'web_origin_invalid');
  return async (request, response) => {
    function send(status, value, { type = 'application/json', setCookie } = {}) {
      const bytes = type === 'application/json' ? Buffer.from(JSON.stringify(value)) : Buffer.from(value);
      response.writeHead(status, {
        'Content-Type': type + (type.startsWith('text/') || type === 'application/json' ? '; charset=utf-8' : ''),
        'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; frame-src 'self'; frame-ancestors 'none'; form-action 'self'",
        ...(setCookie ? { 'Set-Cookie': setCookie } : {}),
      });
      response.end(bytes);
    }
    try {
      requireValue(available(), 'web_admin_stopping');
      requireValue(headerCount(request, 'host') === 1 && request.headers.host === publicUrl.host, 'host_rejected');
      requireValue(!request.url.includes('?') && !request.url.includes('#'), 'query_not_allowed');
      requireValue(headerCount(request, 'origin') <= 1 &&
        (!request.headers.origin || request.headers.origin === origin) &&
        ['same-origin', 'none'].includes(request.headers['sec-fetch-site'] || 'same-origin'), 'origin_rejected');
      requireValue(['GET', 'POST'].includes(request.method), 'method_not_allowed');
      let body = {};
      if (request.method === 'POST') {
        requireValue(request.headers.origin === origin, 'origin_required');
        body = await readBody(request);
      }
      requireValue(available(), 'web_admin_stopping');
      if (request.method === 'GET' && assets.has(request.url)) {
        const asset = assets.get(request.url); return send(200, asset.content, { type: asset.type });
      }
      if (request.method === 'POST' && request.url === '/api/login') {
        requireValue(shape(body, ['username', 'password']), 'body_rejected');
        const token = await auth.login(body.username, body.password);
        return send(200, auth.public(await auth.session(token)), { setCookie: cookie(token) });
      }
      const token = tokenOf(request), session = await auth.session(token);
      if (request.method === 'POST') requireValue(headerCount(request, 'x-csrf-token') === 1 && sameSecret(request.headers['x-csrf-token'], session.csrf), 'csrf_rejected');
      if (request.method === 'GET' && request.url === '/api/session') return send(200, auth.public(session));
      if (request.method === 'POST' && request.url === '/api/logout') {
        requireValue(shape(body, []), 'body_rejected'); await auth.logout(token);
        return send(200, {}, { setCookie: cookie('') });
      }
      if (request.method === 'POST' && request.url === '/api/account/password') {
        const result = await auth.changePassword(token, body); return send(200, result, { setCookie: cookie('') });
      }
      if (request.url === '/api/accounts') {
        if (request.method === 'GET') return send(200, await auth.accounts(token));
        const result = await auth.manageAccount(token, body);
        return send(200, result, { setCookie: result.sign_in_required ? cookie('') : undefined });
      }
      if (backend) {
        const route = webAdminRoute(request, body);
        const result = await auth.authorized(token, principal => backend.dispatch(principal, route.operation, route.body));
        return send(200, route.operation === 'installation_settings' ? { ...result, web: { ...web, origin } } : result);
      }
      // Explicitly unavailable until the domain port and parity tests exist.
      return send(503, { error: 'operation_not_implemented' });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (!(error instanceof WebAdminError)) return send(503, { error: 'service_unavailable_private_details_omitted' });
      const status = ['login_required', 'login_failed'].includes(error.message) ? 401 : error.message === 'forbidden' ? 403 : error.message === 'operation_not_implemented' ? 503 : 400;
      send(status, { error: error.message });
    }
  };
}

export function createWebAdminServer({ tls, ...options }) {
  requireValue(tls?.key && tls?.cert, 'tls_configuration_required');
  // Caller must explicitly listen; this factory cannot activate itself.
  const server = https.createServer({ ...tls, maxHeaderSize: 16384, requestTimeout: 10000, headersTimeout: 10000 }, createWebAdminHandler(options));
  server.maxConnections = 32;
  server.on('close', () => { void options.auth.close(); });
  return server;
}
