import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { parseWebJson } from '../src/web-admin-common.js';
import { WebAdminGateway, WebGatewayRejected, validateWebGateways, webGatewayExchange } from '../src/web-admin-gateway.js';

const registration = { id: 'test', name: 'Synthetic gateway', identity: '0011223344556677', endpoint: 'http://127.0.0.1:1', key: 'synthetic-key' };
const uid = 'a'.repeat(32);
test('strict JSON rejects duplicate keys, malformed/nonfinite data and deep nesting', () => {
  assert.deepEqual(parseWebJson('{"x":[true,null,{"s":"a\\\"b"}],"n":-1.25e2}'), { x: [true, null, { s: 'a"b' }], n: -125 });
  for (const value of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"n":1e999}', '[NaN]', '[1,]', '{"x":1}{}', '"bad\nstring"', '['.repeat(66) + '0' + ']'.repeat(66)]) assert.throws(() => parseWebJson(value));
});
test('registration validates exact private shape and independent gateway identities', () => {
  assert.deepEqual(validateWebGateways([registration]), [registration]);
  for (const endpoint of ['http://user:secret@localhost', 'http://localhost/api', 'file:///tmp/example', 'http://localhost/?key=synthetic', 'http://localhost:0']) {
    assert.throws(() => validateWebGateways([{ ...registration, endpoint }]), /gateway_endpoint_invalid/);
  }
  assert.throws(() => validateWebGateways([registration, { ...registration, id: 'second' }]), /gateway_identity_invalid/);
  assert.throws(() => validateWebGateways([{ ...registration, key: 'key/extra-path' }]), /gateway_key_invalid/);
});
test('construction performs no I/O; identity/capability reads do not permit commands', async () => {
  const calls = []; let identity = registration.identity, version = 2;
  const gateway = new WebAdminGateway(registration, { exchange: async request => {
    calls.push(request); return [200, request.url.endsWith('/config') ? { bridgeid: identity } : { global_users_version: version }];
  } });
  assert.equal(calls.length, 0);
  await gateway.verify(1); assert.equal(calls.length, 2); assert.ok(calls.every(row => row.method === 'GET' && row.body === undefined));
  assert.throws(() => gateway.exchange('/alarmsystems/1/disarm', 'PUT', { code0: '1234' }), /candidate_read_only_required/);
  identity = 'FFEEDDCCBBAA0099'; await assert.rejects(gateway.verify(1), /gateway_identity_changed/);
  identity = registration.identity; version = 1; await assert.rejects(gateway.verify(1), /enhanced_plugin_required/);
});
test('writable gateway permits only the reference routes and methods', async () => {
  const calls = [], gateway = new WebAdminGateway(registration, { writable: true, exchange: async value => { calls.push(value); return [200, {}]; } });
  for (const [path, method] of [['/config', 'PUT'], ['/alarmsystems/1/users', 'PUT'], ['/alarmsystems/1/disarm', 'POST'], ['/alarmsystems/1/users/' + uid, 'POST'], ['/alarmsystems/1/../config', 'PUT'], ['/alarmsystems/1/users?extra=1', 'POST']]) assert.throws(() => gateway.exchange(path, method, {}), /gateway_route_invalid/);
  for (const [path, method] of [['/alarmsystems/1/users', 'POST'], ['/alarmsystems/1/users/' + uid, 'PUT'], ['/alarmsystems/1/users/lockout', 'DELETE'], ['/alarmsystems/users/' + uid, 'PUT'], ['/alarmsystems/1/disarm', 'PUT']]) await gateway.exchange(path, method, {});
  assert.equal(calls.length, 5);
});
test('only exact validation rejections prove non-application; unknown details never escape', async () => {
  let reply;
  const gateway = new WebAdminGateway(registration, { writable: true, exchange: async () => reply });
  for (const [reason, address, definite] of [['invalid_pin', '/alarmsystems/1/users', true], ['invalid_pin', '/alarmsystems/2/users', false], ['storage_error', '/alarmsystems/1/users', false]]) {
    reply = [400, [{ error: { type: 7, address, description: reason } }]];
    await assert.rejects(gateway.request('/alarmsystems/1/users/' + uid, 'PUT', {}), error => error instanceof WebGatewayRejected && error.message === reason && error.definite === definite);
  }
  reply = [400, [{ error: { type: 7, description: 'private supplied credential' } }]];
  await assert.rejects(gateway.request('/alarmsystems/1/users/' + uid, 'PUT', {}), /gateway_result_unknown_no_retry/);
  reply = [200, [{ success: {} }, { error: { description: 'invalid_pin' } }]];
  await assert.rejects(gateway.request('/alarmsystems/1/users/' + uid, 'PUT', {}), /gateway_result_unknown_no_retry/);
});

test('actual bounded transport refuses redirects, duplicate JSON and slow responses without retrying', async t => {
  let requests = 0, redirected = 0, mode = 'normal';
  const server = http.createServer((req, res) => {
    requests++; if (req.url === '/redirected') redirected++;
    if (mode === 'redirect') { res.writeHead(302, { Location: '/redirected' }); res.end('{}'); }
    else if (mode === 'duplicate') res.end('{"ok":true,"ok":false}');
    else if (mode === 'slow') { res.writeHead(200); res.write('{'); }
    else if (mode === 'large') res.end(' '.repeat(4 * 1024 * 1024 + 1));
    else { res.writeHead(400); res.end('[{"error":{"description":"invalid_pin"}}]'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = 'http://127.0.0.1:' + server.address().port + '/synthetic';
  assert.deepEqual(await webGatewayExchange({ url, method: 'GET' }), [400, [{ error: { description: 'invalid_pin' } }]]);
  mode = 'redirect'; assert.deepEqual(await webGatewayExchange({ url, method: 'GET' }), [302, {}]); assert.equal(redirected, 0);
  mode = 'duplicate'; await assert.rejects(webGatewayExchange({ url, method: 'GET' }), /gateway_response_invalid/);
  mode = 'large'; await assert.rejects(webGatewayExchange({ url, method: 'GET' }), /gateway_response_invalid/);
  mode = 'slow'; await assert.rejects(webGatewayExchange({ url, method: 'GET', timeoutMs: 25 }), /gateway_result_unknown_no_retry/);
  assert.equal(requests, 5);
});
