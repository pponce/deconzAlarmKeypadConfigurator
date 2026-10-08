// Preferences shared by the original web pages, independent of server setup.
import { WebAdminFiles, webDigest } from './web-admin-files.js';
import { requireWeb, exact, integer } from './web-admin-common.js';

const defaults = () => ({ discovery_seconds: 60, display_seconds: 5, home_screen_name: 'Keypad Cntrl' });
function validate(value) {
  requireWeb(exact(value, Object.keys(defaults())) && integer(value.discovery_seconds, 10, 3600) && integer(value.display_seconds, 2, 300), 'application_settings_invalid');
  const name = value.home_screen_name;
  requireWeb(typeof name === 'string' && [...name].length >= 1 && [...name].length <= 32 && name === name.trim() &&
    !/[\p{C}\p{Zl}\p{Zp}]/u.test(name) && !/[^\S ]/u.test(name), 'home_screen_name_invalid');
  return value;
}
export class WebAdminApplication {
  constructor(storagePath) { this.files = new WebAdminFiles(storagePath); this.values = defaults(); this.pending = Promise.resolve(); }
  async load() { this.values = await this.files.read('web-application.json', validate) ?? defaults(); }
  public() { return { application: structuredClone(this.values), application_revision: webDigest(this.values) }; }
  save(body) {
    const copy = structuredClone(body);
    const result = this.pending.then(async () => {
      requireWeb(exact(copy, ['revision', 'settings']) && copy.revision === webDigest(this.values), 'settings_changed_refresh');
      requireWeb(exact(copy.settings, Object.keys(defaults())) || exact(copy.settings, ['discovery_seconds', 'display_seconds']), 'application_settings_invalid');
      const next = validate({ ...this.values, ...copy.settings });
      await this.files.write('web-application.json', next, validate); this.values = next; return this.public();
    }); this.pending = result.catch(() => {}); return result;
  }
}
