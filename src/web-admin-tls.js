// Private backend certificate. The owner's public nginx key is never imported.
import { generateKeyPair, createPrivateKey, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { WebAdminFiles, webPrivateDirectory } from './web-admin-files.js';
import { webOrigin } from './web-admin-settings.js';
import { requireWeb, exact } from './web-admin-common.js';
import { WebAdminError } from './web-admin-auth.js';

const generate = promisify(generateKeyPair), execute = promisify(execFile);
function valid(record) {
  requireWeb(exact(record, ['schema', 'cert', 'key']) && record.schema === 1 && typeof record.cert === 'string' && typeof record.key === 'string' &&
    record.cert.length <= 32768 && record.key.length <= 16384, 'web_certificate_invalid');
  const cert = new X509Certificate(record.cert); requireWeb(cert.checkPrivateKey(createPrivateKey(record.key)), 'web_certificate_invalid'); return record;
}
const covers = (cert, host) => isIP(host) ? !!cert.checkIP(host) : !!cert.checkHost(host);
export class WebAdminTls {
  constructor(storagePath) { this.files = new WebAdminFiles(storagePath); }
  async load(settings) {
    const hosts = [...new Set([settings.origin, settings.publicUrl].map(value => webOrigin(value).hostname.replace(/^\[|\]$/g, '')))];
    const current = await this.files.read('web-certificate.json', valid, 65536);
    if (current) {
      const cert = new X509Certificate(current.cert);
      if (Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now() + 86400000 && hosts.every(host => covers(cert, host))) return { key: current.key, cert: current.cert };
    }
    let folder, keyFile;
    try {
      const root = await this.files.directory(); folder = await mkdtemp(path.join(root, 'web-cert-')); await webPrivateDirectory(folder);
      keyFile = path.join(folder, 'key.pem');
      const keys = await generate('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      await writeFile(keyFile, keys.privateKey, { mode: 0o600, flag: 'wx' });
      const { stdout } = await execute('openssl', ['req', '-new', '-x509', '-sha256', '-key', keyFile, '-days', '365', '-subj', '/CN=deCONZ keypad administration',
        '-addext', 'subjectAltName=' + hosts.map(host => (isIP(host) ? 'IP:' : 'DNS:') + host).join(',')], { timeout: 10000, maxBuffer: 65536, windowsHide: true });
      const record = valid({ schema: 1, cert: stdout, key: keys.privateKey }); const cert = new X509Certificate(record.cert);
      requireWeb(hosts.every(host => covers(cert, host)), 'web_certificate_invalid');
      await this.files.write('web-certificate.json', record, valid, 65536); return { key: record.key, cert: record.cert };
    } catch { throw new WebAdminError('web_certificate_generation_failed'); }
    finally { if (keyFile) await unlink(keyFile).catch(() => {}); if (folder) await rmdir(folder).catch(() => {}); }
  }
}
