import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WebAdminCollector } from '../src/web-admin-collector.js';
const reference = JSON.parse(await readFile(new URL('./fixtures/web-admin-read-parity.json', import.meta.url)));

function fixture() {
  const data = structuredClone(reference), calls = [], events = [], sockets = [];
  const registration = { id: 'test', name: 'Synthetic gateway', identity: '0011223344556677', endpoint: 'http://127.0.0.1:8080/', key: 'synthetic' };
  const client = { verify: async alarm => { calls.push(['verify', alarm]); return alarm ? data.capabilities[alarm] : { bridgeid: registration.identity, websocketport: 44391 }; },
    request: async (path, method = 'GET') => { assert.equal(method, 'GET'); calls.push(['GET', path]); assert.ok(Object.hasOwn(data.responses, path)); return structuredClone(data.responses[path]); } };
  const backend = { registrations: new Map([['test', registration]]), catalog: new Map(), connected: new Map(), debugCaptures: new Map(),
    history: { dueLockouts: async () => [], add: async (...args) => events.push(args), lockoutEvent: async (...args) => events.push(args) } };
  const collector = new WebAdminCollector({ backend, gatewayFactory: () => client, socketFactory: url => { const socket = { url, close() { this.closed = true; } }; sockets.push(socket); return socket; } });
  return { data, calls, events, sockets, client, backend, collector, start: () => { collector.start(); const state = collector.states.get('test'); clearTimeout(state.timer); return state; } };
}
test('collection starts explicitly; only a live socket marks connected, and shutdown records the gap without replay', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); assert.equal(f.sockets.length, 0);
  const state = f.start();
  try {
    await f.collector.refresh(state); assert.ok(f.backend.catalog.has('test')); assert.notEqual(f.backend.connected.get('test'), true);
    const socket = f.sockets[0]; assert.equal(socket.url, 'ws://127.0.0.1:44391/'); socket.onopen(); await state.pending;
    assert.equal(f.backend.connected.get('test'), true); assert.ok(f.events.some(row => row[4] === 'Connected'));
    socket.onmessage({ data: JSON.stringify({ t: 'event', r: 'alarmsystems', e: 'access', id: 1, sensor_id: '3', event_id: 'a'.repeat(32), timestamp: new Date().toISOString(), user_id: 'unknown', action: 'disarmed', uses_consumed: 0, remaining_uses: null, code0: '1234' }) });
    await state.pending; assert.ok(f.events.some(row => row[2] === 'Deleted or unknown user')); assert.equal(JSON.stringify(f.events).includes('1234'), false);
    await f.collector.close(); assert.equal(socket.closed, true); assert.equal(f.backend.connected.get('test'), false); assert.ok(f.events.some(row => row[4] === 'Disconnected'));
  } finally { await f.collector.close(); }
});
test('closing waits for in-flight discovery and cannot open a late socket or restart its timer', async () => {
  const f = fixture(), original = f.client.verify; let release, entered;
  const blocked = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  f.client.verify = async alarm => { entered(); await blocked; return original(alarm); };
  const state = f.start(), refresh = f.collector.refresh(state); await started;
  let closed = false; const shutdown = f.collector.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); await Promise.all([shutdown, refresh]); assert.equal(f.sockets.length, 0); assert.equal(f.collector.states.size, 0);
  f.collector.requestDiscovery('test'); assert.equal(f.sockets.length, 0);
});
test('an event endpoint change disconnects and a throwing socket close cannot prevent shutdown', async () => {
  const f = fixture(), state = f.start();
  try {
    await f.collector.refresh(state); f.sockets[0].onopen(); await state.pending;
    const original = f.client.verify; f.client.verify = async alarm => alarm ? original(alarm) : { websocketport: 44392 };
    await f.collector.refresh(state); assert.equal(f.backend.connected.get('test'), false); assert.equal(f.sockets[0].closed, true); assert.equal(f.sockets.length, 1);
    await f.collector.refresh(state); f.sockets[1].close = () => { throw Error('closed'); };
    await f.collector.close(); assert.equal(f.collector.states.size, 0);
  } finally { await f.collector.close(); }
});
