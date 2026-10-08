import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebHomebridgeClient, homebridgeUiOrigin, homebridgeUiExchange } from '../src/web-admin-homebridge-client.js';

const bridge = 'AA:BB:CC:DD:EE:FF', tx = '1'.repeat(32);
function fixture() {
  let time = 0, status = 'ok', manuallyStopped = false, loginAllowed = true, commandReply = true;
  const calls = [], secret = 'fixture-only-access-token', config = { platforms: [{ platform: 'deCONZ', _bridge: { username: bridge } }] };
  const exchange = async input => {
    // Deliberately retain only request classification, not submitted credentials.
    calls.push({ route: input.route, method: input.method });
    if (input.route === '/api/auth/login') return { status: 201, value: { access_token: secret } };
    assert.equal(input.authorization, secret);
    if (input.route === '/api/config-editor') return { status: loginAllowed ? 200 : 403, value: config };
    if (input.route === '/api/status/homebridge/child-bridges') return { status: 200, value: [
      { username: bridge, plugin: 'homebridge-deconz', status, manuallyStopped, pid: 456,
        pin: '111-22-333', setupUri: 'X-HM://private-fixture' },
    ] };
    if (!commandReply) throw Error(secret);
    return { status: 200, value: { ok: true } };
  };
  const client = new WebHomebridgeClient({ origin: 'http://127.0.0.1:8581', bridge, exchange, clock: () => time,
    sleep: async ms => { time += ms; } });
  return { client, calls, config, login: () => client.login({ username: 'Owner', password: 'fixture-password' }),
    setState: (s, stopped = false) => { status = s; manuallyStopped = stopped; }, advance: ms => { time += ms; },
    denyAdmin: () => { loginAllowed = false; }, loseCommand: () => { commandReply = false; } };
}

test('local UI client is inert until explicit authentication and accepts only loopback origins', async () => {
  const f = fixture(); assert.deepEqual(f.calls, []);
  await assert.rejects(f.client.status(), /homebridge_login_required/); assert.deepEqual(f.calls, []);
  for (const value of ['http://garage.example.test:8581', 'http://127.0.0.1:8581/path', 'http://owner:secret@127.0.0.1', 'http://127.0.0.1:8581/?key=x']) {
    assert.throws(() => homebridgeUiOrigin(value), /homebridge_ui_address_invalid/);
  }
  assert.equal(homebridgeUiOrigin('http://[::1]:8581'), 'http://[::1]:8581');
});
test('login checks administrator permission and exact child identity; passwords and pairing codes do not survive', async () => {
  const f = fixture(), credentials = { username: 'Owner', password: 'fixture-password', otp: '123456' };
  const result = await f.client.login(credentials); assert.equal(result.authenticated, true);
  assert.equal(credentials.password, ''); assert.equal(credentials.otp, '');
  const state = await f.client.status();
  assert.deepEqual(Object.keys(state).sort(), ['bridge', 'manuallyStopped', 'pid', 'plugin', 'status']);
  assert.equal(JSON.stringify(f.client).includes('fixture-only-access-token'), false);
  const g = fixture(); g.denyAdmin(); await assert.rejects(g.login(), /homebridge_login_required/);
  await assert.rejects(g.client.status(), /homebridge_login_required/);
  const h = fixture(); h.config.platforms[0]._bridge.username = '00:11:22:33:44:55';
  await assert.rejects(h.login(), /homebridge_configuration_changed/);
  await assert.rejects(h.client.status(), /homebridge_login_required/);
});
test('service commands require confirmation; a lost reply cannot cause a duplicate request', async () => {
  const f = fixture(); await f.login();
  await assert.rejects(f.client.command('stop', tx, false), /homebridge_restart_confirmation_required/);
  assert.equal(f.calls.some(x => x.method === 'PUT'), false);
  f.loseCommand(); await assert.rejects(f.client.command('stop', tx, true), /homebridge_ui_result_unknown/);
  await assert.rejects(f.client.command('stop', tx, true), /homebridge_command_already_requested/);
  assert.equal(f.calls.filter(x => x.method === 'PUT').length, 1);
});
test('acknowledgement is not stop evidence and status waiting never issues a second command', async () => {
  const f = fixture(); await f.login();
  assert.deepEqual(await f.client.command('stop', tx, true), { requested: true, verified: false });
  await assert.rejects(f.client.waitFor(row => row.status === 'down' && row.manuallyStopped, 1000), /homebridge_restart_unverified/);
  f.setState('down', true);
  assert.equal((await f.client.waitFor(row => row.status === 'down' && row.manuallyStopped)).status, 'down');
  assert.equal(f.calls.filter(x => x.method === 'PUT').length, 1);
});
test('short-lived authentication expires without silently logging in or refreshing credentials', async () => {
  const f = fixture(); await f.login(); f.advance(300000);
  await assert.rejects(f.client.status(), /homebridge_login_required/);
  assert.equal(f.calls.filter(x => x.route === '/api/auth/login').length, 1);
  const g = fixture(); await g.login(); g.client.close();
  await assert.rejects(g.client.status(), /homebridge_login_required/);
});
test('real transport refuses redirects, bounds the reply and redacts transport errors', async t => {
  let mode = 'redirect', forwarded = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/elsewhere') { forwarded++; res.end('{}'); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: '/api/elsewhere' }); res.end(); }
    else if (mode === 'large') { res.end(JSON.stringify({ value: 'x'.repeat(4 * 1024 * 1024) })); }
    else { req.socket.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const input = { origin: 'http://127.0.0.1:' + server.address().port, route: '/api/auth/login', method: 'POST', body: { password: 'fixture-secret' } };
  await assert.rejects(homebridgeUiExchange(input), /homebridge_ui_redirect_rejected/); assert.equal(forwarded, 0);
  mode = 'large'; await assert.rejects(homebridgeUiExchange(input), /homebridge_ui_response_invalid/);
  mode = 'lost'; await assert.rejects(homebridgeUiExchange(input), error => error.message === 'homebridge_ui_result_unknown');
});
