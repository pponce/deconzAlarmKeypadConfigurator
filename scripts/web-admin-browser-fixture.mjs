// Synthetic loopback gateway for browser acceptance. No device addresses,
// installed service, live secrets or command delivery can enter this fixture.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStorage, initializeStandalone, defaultServer } from '../src/standalone-config.js';
import { startStandalone } from '../src/standalone.js';

export async function webBrowserFixture() {
  const storagePath = await mkdtemp(join(tmpdir(), 'web-admin-acceptance-'));
  await prepareStorage(storagePath);
  const data = JSON.parse(await readFile(new URL('../test/fixtures/web-admin-read-parity.json', import.meta.url)));
  const writes = [], errors = [], maintenance = [], state = { loseNextAlarmReply: false, homebridgeAvailable: false, bridgeStopped: false };
  const gateway = http.createServer(async (request, response) => {
    try {
      assert.ok(request.url.startsWith('/api/synthetic_key/'));
      const route = request.url.slice('/api/synthetic_key'.length);
      const send = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
      if (request.method === 'GET') {
        if (route === '/config') return send({ bridgeid: '0011223344556677' });
        const caps = /^\/alarmsystems\/(\d+)\/users\/capabilities$/.exec(route);
        if (caps) return send(data.capabilities[caps[1]]);
        assert.ok(Object.hasOwn(data.responses, route), route); return send(data.responses[route]);
      }
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); writes.push([request.method, route]);
      if (request.method === 'PUT' && route === '/alarmsystems/1/disarm') { assert.match(body.code0, /^[0-9]{1,16}$/); return send([{ success: { '/alarmsystems/1/config/armmode': 'disarmed' } }]); }
      if (request.method === 'PUT' && route === '/alarmsystems/1/config') {
        Object.assign(data.responses['/alarmsystems/1'].config, body);
        if (state.loseNextAlarmReply) { state.loseNextAlarmReply = false; response.destroy(); return; }
        return send(Object.entries(body).map(([key, value]) => ({ success: { [route + '/' + key]: value } })));
      }
      const grants = /^\/alarmsystems\/(\d+)\/users(?:\/([a-f0-9]{32}))?$/.exec(route);
      if (grants) {
        const prefix = '/alarmsystems/' + grants[1] + '/users', rows = data.responses[prefix], identities = data.responses['/alarmsystems/users'];
        const id = grants[2] ?? 'cccccccccccccccccccccccccccccccc';
        if (request.method === 'DELETE') { assert.ok(rows[id]); delete rows[id]; return send({ deleted: id }); }
        assert.ok(['PUT', 'POST'].includes(request.method));
        const current = identities[id], changed = !current || current.name !== body.name || current.enabled !== body.enabled;
        const userRevision = (current?.user_revision ?? 0) + Number(changed);
        const { pin, ...publicBody } = body;
        identities[id] = { id, name: body.name, enabled: body.enabled, revision: userRevision, user_revision: userRevision };
        for (const aid of Object.keys(data.responses['/alarmsystems'])) {
          const other = data.responses['/alarmsystems/' + aid + '/users'][id];
          if (other) Object.assign(other, { name: body.name, enabled: body.enabled, user_revision: userRevision });
        }
        rows[id] = { ...publicBody, id, revision: body.revision + 1, user_revision: userRevision, schedule: body.schedule ?? null }; return send(rows[id]);
      }
      const identity = /^\/alarmsystems\/users\/([a-f0-9]{32})$/.exec(route);
      if (identity && request.method === 'PUT') {
        const row = data.responses['/alarmsystems/users'][identity[1]]; assert.ok(row); assert.match(body.pin, /^[0-9]{4,16}$/);
        row.revision++; row.user_revision++; delete row.pin;
        for (const aid of Object.keys(data.responses['/alarmsystems'])) {
          const grant = data.responses['/alarmsystems/' + aid + '/users'][row.id]; if (grant) grant.user_revision = row.user_revision;
        }
        return send(row);
      }
      if (route === '/alarmsystems/1/users/lockout') {
        const row = data.responses[route];
        if (request.method === 'PUT') row.policy = { ...body, revision: row.policy.revision + 1 };
        else { assert.equal(request.method, 'DELETE'); for (const pad of row.keypads) Object.assign(pad, { level: 0, remaining_seconds: 0, locked_until: 0 }); }
        return send(row);
      }
      throw Error('Unsupported synthetic write');
    } catch (error) { errors.push(error.message); response.statusCode = 400; response.end('{}'); }
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const homebridgeHost = {
    async readiness() { return { configured: state.homebridgeAvailable, error: state.homebridgeAvailable ? null : 'homebridge_child_identity_invalid' }; },
    async available() { return state.homebridgeAvailable; },
    async authenticate(credentials) { assert.equal(credentials.username, 'BridgeAdmin'); assert.equal(credentials.password, 'synthetic-bridge-password'); maintenance.push('authenticated'); },
    async clearAuthentication() { maintenance.push('cleared'); },
    async prepare(binding) { assert.deepEqual(binding.alarms, [1]); return { bridge: 'AA:BB:CC:DD:EE:FF', pid: 1234 }; },
    async stop() { state.bridgeStopped = true; maintenance.push('stop'); },
    async assertStopped() { assert.equal(state.bridgeStopped, true); },
    async snapshotStopped(lease, pin) { assert.match(pin, /^[0-9]{4,16}$/); maintenance.push('backup'); },
    async verifyGateway() {}, async verifySnapshot() {},
    async commitStopped(lease, { applied }) { assert.equal(state.bridgeStopped, true); assert.equal(applied, true); maintenance.push('pin saved'); },
    async start() { state.bridgeStopped = false; maintenance.push('start'); },
    async verifyRunning() { assert.equal(state.bridgeStopped, false); maintenance.push('verified'); },
  };
  let service;
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = 'https://127.0.0.1:' + port, password = 'synthetic-browser-password';
  const settings = { ...defaultServer(), port, origin, publicUrl: origin };
  return { storagePath, get service() { return service; }, settings, origin, password, data, writes, errors, state, maintenance,
    async enable({ homebridge = true } = {}) { await initializeStandalone({ storagePath, server: settings, username: 'Owner', password, gateways: [{ id: 'deconz', name: 'Synthetic gateway', endpoint: 'http://127.0.0.1:' + gateway.address().port, identity: '0011223344556677', key: 'synthetic_key' }] }); service = await startStandalone({ storagePath, homebridgeHost: homebridge ? homebridgeHost : undefined }); },
    async restart() { await service.close(); service = await startStandalone({ storagePath }); },
    async close() { await service?.close(); await new Promise(resolve => { gateway.close(resolve); gateway.closeAllConnections(); }); await rm(storagePath, { recursive: true, force: true }); },
  };
}
