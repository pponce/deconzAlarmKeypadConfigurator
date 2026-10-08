import test from 'node:test';
import assert from 'node:assert/strict';
import { webAdminNetwork } from '../src/web-admin-network.js';

test('LAN discovery omits loopback, tunnels, container bridges, duplicates and unusable addresses', () => {
  const row = (address, internal = false) => ({ address, internal });
  const result = webAdminNetwork({ lo: [row('127.0.0.1', true)], docker0: [row('172.17.0.1')],
    'br-abcd': [row('172.18.0.1')], tun0: [row('10.9.0.1')], eth0: [row('192.168.1.8'), row('fe80::1'), row('169.254.1.1')],
    wlan0: [row('192.168.1.8'), row('10.0.0.8'), row('224.0.0.1'), row('0.0.0.0')], wan: [row('203.0.113.10')] });
  assert.deepEqual(result, { addresses: ['10.0.0.8', '192.168.1.8', '203.0.113.10'], suggestedAddress: '10.0.0.8' });
  assert.deepEqual(webAdminNetwork({}), { addresses: [], suggestedAddress: null });
});
