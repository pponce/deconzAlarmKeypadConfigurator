import { acquireOwnership } from './ownership.js';
import { WebAdminAccountStore } from './web-admin-store.js';
import { WebAdminTls } from './web-admin-tls.js';
import { StandaloneConfig, prepareStorage } from './standalone-config.js';
import { createWebAdminService } from './web-admin-service.js';
import { requireWeb } from './web-admin-common.js';

export async function startStandalone({ storagePath, homebridgeHost, extensions }) {
  await prepareStorage(storagePath);
  const release = await acquireOwnership(storagePath);
  let service, closed = false;
  try {
    const row = await new StandaloneConfig(storagePath).read(); requireWeb(row, 'standalone_setup_required');
    const accounts = new WebAdminAccountStore(storagePath);
    requireWeb(await accounts.configured(), 'web_account_setup_required');
    const tls = await new WebAdminTls(storagePath).load(row.server);
    service = await createWebAdminService({ storagePath, row, accounts, tls, homebridgeHost, extensions });
    await new Promise((resolve, reject) => {
      const error = () => { service.server.off('listening', ready); reject(new Error('standalone_listen_failed')); };
      const ready = () => { service.server.off('error', error); resolve(); };
      service.server.once('error', error); service.server.once('listening', ready);
      service.server.listen(row.server.port, row.server.bind);
    });
    service.start();
    return { ...service, url: row.server.publicUrl, async close() {
      if (closed) return; closed = true;
      try { await service.close(); } finally { await release(); }
    } };
  } catch (error) {
    try { await service?.close(); } finally { await release(); }
    throw error;
  }
}
