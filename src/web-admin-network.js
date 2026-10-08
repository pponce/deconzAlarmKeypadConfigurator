// Local interface discovery only: no requests, hardware probes or saved changes.
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

export function webAdminNetwork(interfaces) {
  if (interfaces === undefined) { try { interfaces = networkInterfaces(); } catch { interfaces = {}; } }
  const addresses = [];
  for (const [name, rows] of Object.entries(interfaces)) {
    // Container bridges and tunnels are not useful default browser destinations.
    if (/^(?:docker|br-|veth|virbr|tun|tap|utun|tailscale|wg|zt)/i.test(name)) continue;
    for (const row of rows ?? []) {
      const address = row.address;
      if (row.internal || isIP(address) !== 4 || /^(?:0\.|127\.|169\.254\.)/.test(address) || Number(address.split('.')[0]) >= 224) continue;
      if (!addresses.includes(address)) addresses.push(address);
    }
  }
  const privateAddress = value => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(value);
  addresses.sort((a, b) => Number(privateAddress(b)) - Number(privateAddress(a)) || a.localeCompare(b, undefined, { numeric: true }));
  return { addresses, suggestedAddress: addresses[0] ?? null };
}
