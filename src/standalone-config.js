import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { WebAdminFiles, webDigest, webPrivateDirectory } from './web-admin-files.js';
import { WebAdminGateway, validateWebGateways } from './web-admin-gateway.js';
import { WebAdminAccountStore } from './web-admin-store.js';
import { WebAdminTransactionStore } from './web-admin-transactions.js';
import { WebHomebridgeMaintenanceStore } from './web-admin-homebridge-maintenance.js';
import { webOrigin } from './web-admin-settings.js';
import { requireWeb, exact, integer } from './web-admin-common.js';

export const defaultServer = () => ({ bind: '127.0.0.1', port: 9443, origin: 'https://localhost:9443', publicUrl: 'https://localhost:9443', accessMode: 'manage' });
export async function prepareStorage(storagePath) {
  await mkdir(storagePath, { recursive: true, mode: 0o700 });
  await webPrivateDirectory(storagePath);
  const directory = path.join(storagePath, 'deconz-keypad-admin');
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await webPrivateDirectory(directory);
}
export function validateStandaloneConfig(row) {
  requireWeb(exact(row, ['schema', 'revision', 'server', 'gateways', 'homebridge']) && row.schema === 1 && integer(row.revision, 1, Number.MAX_SAFE_INTEGER), 'standalone_config_invalid');
  const s = row.server;
  requireWeb(exact(s, ['bind', 'port', 'origin', 'publicUrl', 'accessMode']) && typeof s.bind === 'string' && !!isIP(s.bind) && integer(s.port, 1024, 65535) && ['manage', 'observe'].includes(s.accessMode), 'standalone_server_invalid');
  requireWeb(Number(webOrigin(s.origin).port || 443) === s.port, 'web_backend_port_mismatch'); webOrigin(s.publicUrl);
  validateWebGateways(row.gateways); requireWeb(row.gateways.length > 0, 'gateway_required');
  if (row.homebridge !== null) {
    requireWeb(exact(row.homebridge, ['storagePath', 'configPath', 'pluginPath']) && Object.values(row.homebridge).every(value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value)), 'homebridge_paths_invalid');
  }
  return row;
}
export class StandaloneConfig {
  constructor(storagePath) { this.files = new WebAdminFiles(storagePath); this.pending = Promise.resolve(); }
  read() { return this.files.read('web-standalone.json', validateStandaloneConfig); }
  save(expectedRevision, value) {
    const next = structuredClone(value);
    const result = this.pending.then(async () => {
      const current = await this.read();
      requireWeb((current?.revision ?? 0) === expectedRevision, 'standalone_config_changed');
      const row = validateStandaloneConfig({ ...next, schema: 1, revision: expectedRevision + 1 });
      await this.files.write('web-standalone.json', row, validateStandaloneConfig); return row;
    });
    this.pending = result.catch(() => {}); return result;
  }
}
export async function verifyRegistration(value, { gatewayFactory = row => new WebAdminGateway(row) } = {}) {
  // Validate the endpoint and key before any network request. Initial setup pins
  // the bridge identity returned by deCONZ; edits must preserve that identity.
  const candidate = validateWebGateways([{ ...value, identity: value.identity || '0000000000000000' }])[0];
  const config = await gatewayFactory(candidate).request('/config');
  const identity = String(config.bridgeid ?? '').replaceAll(':', '').toUpperCase();
  requireWeb(/^[0-9A-F]{16}$/.test(identity) && identity !== '0000000000000000', 'gateway_identity_invalid');
  requireWeb(!value.identity || value.identity === identity, 'gateway_identity_changed');
  return validateWebGateways([{ ...candidate, identity }])[0];
}
export async function assertNoMaintenance(storagePath, row) {
  const store = new WebAdminTransactionStore(storagePath);
  for (const gateway of row.gateways) {
    const tx = await store.read(gateway.id); requireWeb(!tx || tx.stage === 'complete', 'transaction_recovery_required');
  }
  const hb = await new WebHomebridgeMaintenanceStore(storagePath).read();
  requireWeb(!hb.lease || hb.lease.stage === 'complete', 'homebridge_shared_service_recovery_required');
}
export async function initializeStandalone({ storagePath, username, password, server = defaultServer(), gateways, homebridge = null }) {
  const config = new StandaloneConfig(storagePath);
  requireWeb(!await config.read(), 'standalone_already_configured');
  const row = validateStandaloneConfig({ schema: 1, revision: 1, server, gateways, homebridge });
  const accounts = new WebAdminAccountStore(storagePath);
  // An interrupted initialization keeps an existing administrator verifier.
  if (!await accounts.configured()) await accounts.initialize(username, password);
  return config.save(0, row);
}
export const configFingerprint = row => webDigest(row);
