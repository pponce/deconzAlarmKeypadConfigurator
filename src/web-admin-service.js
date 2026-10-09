// Standalone composition root. No Homebridge runtime or movement controller.
import { WebAdminAuth } from './web-admin-auth.js';
import { WebAdminBackend } from './web-admin-backend.js';
import { WebAdminApplication } from './web-admin-application.js';
import { WebAdminTransactions, WebAdminTransactionStore } from './web-admin-transactions.js';
import { WebAdminHistory } from './web-admin-history.js';
import { WebAdminPolicyBackup } from './web-admin-backup.js';
import { WebAdminCollector } from './web-admin-collector.js';
import { createWebAdminServer } from './web-admin-server.js';
import { loadWebAdminAssets } from './web-admin-assets.js';
import { WebHomebridgeMaintenance, WebHomebridgeMaintenanceStore } from './web-admin-homebridge-maintenance.js';
import { WebHomebridgeApiHost as WebHomebridgeHost } from './web-admin-homebridge-api.js';
import { StandaloneConfig, configFingerprint, verifyRegistration } from './standalone-config.js';
import { requireWeb, exact } from './web-admin-common.js';

export async function createWebAdminService({ storagePath, row, accounts, tls, homebridgeHost,
  // Trusted programmatic extension seam. No browser-supplied modules, URLs or
  // commands. Required participants are recorded in the recovery journal.
  extensions = { participants: new Map(), keypadBegin: async () => null } }) {
  const registrations = row.gateways, settings = row.server, config = new StandaloneConfig(storagePath);
  const fingerprint = configFingerprint(row);
  const assertCurrent = async () => requireWeb(configFingerprint(await config.read()) === fingerprint, 'standalone_restart_required');
  requireWeb(extensions.participants instanceof Map && !extensions.participants.has('homebridge') && typeof extensions.keypadBegin === 'function', 'extension_contract_invalid');
  const application = new WebAdminApplication(storagePath); await application.load();
  const auth = new WebAdminAuth({ store: accounts }); await auth.refresh();
  const history = new WebAdminHistory(storagePath, new Map(registrations.map(value => [value.id, value])));
  const backup = new WebAdminPolicyBackup(storagePath);
  const disabledHost = {
    readiness: async () => ({ configured: false, error: 'homebridge_not_configured' }),
    available: async () => false, clearAuthentication: async () => {},
  };
  const host = homebridgeHost ?? (row.homebridge ? new WebHomebridgeHost({ storagePath, registrations,
    homebridgeStoragePath: row.homebridge.storagePath, configPath: row.homebridge.configPath, pluginRoot: () => row.homebridge.pluginPath }) : disabledHost);
  // Keep this participant even when disabled: existing bindings must continue
  // to protect their users, and unresolved maintenance must never be skipped.
  const integration = new WebHomebridgeMaintenance({ store: new WebHomebridgeMaintenanceStore(storagePath), registrations, host });
  const transactions = new WebAdminTransactions({ store: new WebAdminTransactionStore(storagePath),
    participants: new Map([...extensions.participants, ['homebridge', integration]]), enrollmentGuard: assertCurrent });
  let collector, accepting = true;
  const setup = {
    public: async () => {
      const saved = await config.read();
      return { deployment: { label: 'Standalone Node.js admin' }, onboarding_required: false,
        revision: String(saved.revision), restart_required: configFingerprint(saved) !== fingerprint,
        gateways: saved.gateways.map(({ key, ...value }) => value), ...application.public(),
        connection_activation: 'standalone_restart', integration_registration: 'protected_local_configuration',
        key_enrollments: [], backup: backup.status(registrations), homebridge: await integration.status() };
    },
    application: async body => { await application.save(body); for (const value of registrations) collector.requestDiscovery(value.id); return setup.public(); },
    gateway: async body => {
      requireWeb(exact(body, ['revision', 'gateway']), 'invalid_request');
      const saved = await config.read(); requireWeb(body.revision === String(saved.revision), 'standalone_config_changed');
      requireWeb(exact(body.gateway, ['id', 'name', 'identity', 'endpoint', 'key']), 'gateway_registry_invalid');
      const before = saved.gateways.find(gateway => gateway.id === body.gateway.id);
      requireWeb(before && before.identity === body.gateway.identity, 'gateway_identity_changed');
      for (const gateway of registrations) await transactions.guard(gateway.id);
      await integration.guard();
      const gateway = await verifyRegistration({ ...body.gateway, key: body.gateway.key || before.key });
      await config.save(saved.revision, { ...saved, gateways: saved.gateways.map(item => item.id === gateway.id ? gateway : item) });
      return setup.public();
    },
  };
  const backend = new WebAdminBackend({ registrations, accessMode: settings.accessMode, setup, history, transactions, backup, assertCurrent, integration,
    hiddenUsers: gateway => integration.hiddenUsers(gateway),
    keypadHook: (registration, alarm, started) => extensions.keypadBegin({ gateway: registration.id, identity: registration.identity, alarm, started }),
    requestDiscovery: gateway => collector.requestDiscovery(gateway) });
  collector = new WebAdminCollector({ backend, interval: () => application.values.discovery_seconds });
  const server = createWebAdminServer({ tls, origin: settings.origin, auth, backend,
    assets: await loadWebAdminAssets(), available: () => accepting,
    web: { public_url: settings.publicUrl, bind: settings.bind, port: settings.port } });
  return {
    server, backend, start: () => collector.start(),
    async close() {
      accepting = false;
      const closed = new Promise(resolve => server.close(() => resolve())); server.closeAllConnections();
      await collector.close(); await auth.close(); await backend.pending; await host.clearAuthentication();
      await history.pending; await application.pending; await config.pending; await closed;
    },
  };
}
