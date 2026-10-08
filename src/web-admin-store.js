// One account store per standalone process, under its ownership lock.
// Initial account setup is a trusted local operation; no public signup route.
import { WebAdminFiles } from './web-admin-files.js';
import { WebAdminError, initialWebAccounts, validateWebAccounts } from './web-admin-auth.js';

export class WebAdminAccountStore {
  constructor(storagePath) {
    const files = new WebAdminFiles(storagePath);
    this.privateStore = { read: () => files.read('web-accounts.json', validateWebAccounts), write: value => files.write('web-accounts.json', value, validateWebAccounts) };
    this.pending = Promise.resolve();
  }
  serial(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  read() {
    return this.serial(async () => {
      const record = await this.privateStore.read();
      if (!record) throw new WebAdminError('web_account_setup_required');
      return record;
    });
  }
  configured() { return this.serial(async () => !!await this.privateStore.read()); }
  initialize(username, password) {
    return this.serial(async () => {
      if (await this.privateStore.read()) throw new WebAdminError('web_account_already_configured');
      const record = await initialWebAccounts(username, password);
      await this.privateStore.write(record);
      return { configured: true };
    });
  }
  write({ expectedRevision, record }) {
    // Snapshot before joining the queue so callers cannot mutate a pending write.
    const next = structuredClone(record);
    validateWebAccounts(next);
    return this.serial(async () => {
      const current = await this.privateStore.read();
      if (!current) throw new WebAdminError('web_account_setup_required');
      if (current.revision !== expectedRevision || next.revision !== expectedRevision + 1) {
        throw new WebAdminError('web_account_changed');
      }
      await this.privateStore.write(next);
    });
  }
}
