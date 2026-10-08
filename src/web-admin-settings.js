// Strict HTTPS origin validation shared by standalone setup and TLS.
import { isIP } from 'node:net';
import { requireWeb } from './web-admin-common.js';
import { WebAdminError } from './web-admin-auth.js';

export function webOrigin(value) {
  let url; try { url = new URL(value); } catch { throw new WebAdminError('web_origin_invalid'); }
  requireWeb(typeof value === 'string' && value.length <= 512 && url.protocol === 'https:' && url.origin === value && !url.username && !url.password &&
    (isIP(url.hostname.replace(/^\[|\]$/g, '')) || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname)), 'web_origin_invalid');
  return url;
}
