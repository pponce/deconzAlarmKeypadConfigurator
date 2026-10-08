// Development-only UI contract check. Uses the actual HTTPS/auth/backend and
// original browser assets, with synthetic gateway/setup/transaction ports.
// This is not an installation, a write-parity test, or a hardware test.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { WebAdminAuth, initialWebAccounts } from '../src/web-admin-auth.js';
import { WebAdminBackend } from '../src/web-admin-backend.js';
import { createWebAdminServer } from '../src/web-admin-server.js';
import { loadWebAdminAssets } from '../src/web-admin-assets.js';

const temp = await mkdtemp(join(tmpdir(), 'web-admin-browser-'));
const output = process.env.PREVIEW_OUTPUT || join(temp, 'screenshots');
const reference = JSON.parse(await readFile(new URL('../test/fixtures/web-admin-read-parity.json', import.meta.url)));
const registration = { id: 'test', name: 'Synthetic gateway', identity: '0011223344556677', endpoint: 'http://127.0.0.1:1', key: 'synthetic-never-display-key' };
const password = 'synthetic-browser-password';
const record = await initialWebAccounts('Owner', password), guest = await initialWebAccounts('Guest', password);
record.accounts.push({ ...guest.accounts[0], role: 'regular' });
const auth = new WebAdminAuth({ store: { read: async () => structuredClone(record), write: async () => { throw Error('No account writes in this read-only browser check'); } } });
const calls = [];
const backend = new WebAdminBackend({ registrations: [registration],
  connected: new Map([['test', true]]),
  history: { scopes: async () => [{ gateway: 'test', alarm: 1 }], days: async () => 90,
    rows: async () => [{ seq: 1, time: '2026-01-01T12:00:00Z', user: 'Administrator', source: 'Configuration', action: 'Synthetic change', result: 'Verified fixture' }] },
  transactions: { status: async () => ({ stage: 'none' }) },
  setup: { public: async () => ({ deployment: { label: 'Synthetic Homebridge fixture' }, onboarding_required: false, revision: 'synthetic', restart_required: false,
    gateways: [{ id: registration.id, name: registration.name, identity: registration.identity, endpoint: registration.endpoint }],
    application: { discovery_seconds: 60, display_seconds: 5, home_screen_name: 'Keypad Cntrl' }, application_revision: 'synthetic',
    connection_activation: 'homebridge_restart', integration_registration: 'protected_local_configuration', key_enrollments: [], backup: [] }) },
  gatewayFactory: () => ({
    verify: async alarm => { calls.push(['verify', alarm]); return alarm ? reference.capabilities[alarm] : { bridgeid: registration.identity }; },
    request: async (path, method = 'GET') => { assert.equal(method, 'GET'); assert.ok(Object.hasOwn(reference.responses, path), path); calls.push([method, path]); return structuredClone(reference.responses[path]); },
  }),
});
const port = 44389, origin = 'https://127.0.0.1:' + port;
let server, browser;
try {
  // Ephemeral loopback test certificate only. Production TLS has no insecure fallback.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(temp, 'key.pem'), '-out', join(temp, 'cert.pem')], { stdio: 'ignore' });
  server = createWebAdminServer({ origin, auth, backend, assets: await loadWebAdminAssets(), web: { port, bind: '127.0.0.1' },
    tls: { key: await readFile(join(temp, 'key.pem')), cert: await readFile(join(temp, 'cert.pem')) } });
  assert.equal(calls.length, 0); server.listen(port, '127.0.0.1'); await once(server, 'listening');
  const playwright = await import(pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, 'index.mjs')).href);
  await mkdir(output, { recursive: true });
  for (const kind of ['chromium', 'webkit']) {
    browser = await playwright[kind].launch({ headless: true });
    const phone = kind === 'webkit';
    for (const username of ['Owner', 'Guest']) {
      const regular = username === 'Guest';
      const context = await browser.newContext({ ignoreHTTPSErrors: true, ...(phone ? playwright.devices['iPhone 13'] : { viewport: { width: 1280, height: 900 } }) });
      const page = await context.newPage(), errors = [], rejected = [];
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => { errors.push(error.message); });
      page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400 && !response.url().endsWith('/api/session')) rejected.push(response.status() + ' ' + new URL(response.url()).pathname); });
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== origin) { errors.push('Unexpected external request'); return route.abort(); }
        return route.continue();
      });
      async function ready() {
        await page.waitForFunction(() => !document.querySelector('#settings-gear').disabled);
        assert.equal(await page.locator('#message.gp-error').count(), 0, await page.locator('#message').textContent());
      }
      async function navigate(id) {
        if (phone) await page.locator('#mobile-menu').click();
        await page.locator('[data-page="' + id + '"]').click();
        await page.locator('#' + id).waitFor({ state: 'visible' });
        await ready();
      }
      await page.goto(origin);
      await page.locator('#username').fill(username); await page.locator('#password').fill(password);
      await page.locator('#login button').click();
      await page.locator('#user-list [data-id]').first().waitFor({ state: 'visible' }); await ready();
      assert.match(await page.locator('#user-list').textContent(), /Owner/);
      assert.equal(await page.locator('#password').inputValue(), '');
      assert.equal(await page.locator('[data-extension]').count(), 0);
      const loginCookies = await context.cookies();
      assert.ok(loginCookies.some(row => row.name === '__Host-configurator' && row.httpOnly && row.secure && row.sameSite === 'Strict'));
      await page.screenshot({ path: join(output, kind + '-' + username + '-users.png'), fullPage: true });
      await navigate('access');
      assert.equal(await page.locator('#grant-preview .gp-grant-row').count(), 2);
      assert.match(await page.locator('#grant-preview').textContent(), /Previously allowed keypad/);
      await navigate('protection');
      assert.equal(await page.locator('[data-protection-alarm]').count(), 2);
      if (regular) assert.equal(await page.locator('#lockout-form input').count(), 0);
      else assert.equal(await page.locator('#lockout-threshold').inputValue(), String(reference.expected.lockout.policy.threshold));
      await page.screenshot({ path: join(output, kind + '-' + username + '-protection.png'), fullPage: true });
      if (!regular) {
        await navigate('gateway');
        assert.equal(await page.locator('#gateway-inventory .gp-alarm-card').count(), 2);
        await navigate('alarm');
        assert.equal(await page.locator('[data-alarm-timer]').count(), 9);
        assert.match(await page.locator('#alarm-state').textContent(), /Disarmed/);
        await navigate('history');
        assert.equal(await page.locator('#activity .gp-history-row').count(), 1);
        assert.match(await page.locator('#activity').textContent(), /Verified fixture/);
      }
      await page.locator('#settings-gear').click();
      await page.locator('#settings-content').waitFor({ state: 'visible' });
      if (regular) {
        assert.equal(await page.locator('#tab-general').isVisible(), false);
        assert.equal(await page.locator('#settings-add-account').count(), 0);
        assert.match(await page.locator('#settings-account-name').textContent(), /Guest/);
      } else {
        assert.equal(await page.locator('#settings-discovery').inputValue(), '60');
        await page.locator('#tab-security').click();
        assert.equal(await page.locator('[data-web-account]').count(), 2);
      }
      assert.equal((await page.locator('body').textContent()).includes(registration.key), false);
      await page.screenshot({ path: join(output, kind + '-' + username + '-settings.png'), fullPage: true });
      await page.locator('#settings-close').click(); await page.locator('#logout').click();
      await page.locator('#login').waitFor({ state: 'visible' });
      assert.equal((await context.cookies()).some(row => row.name === '__Host-configurator'), false);
      assert.deepEqual(errors, []); assert.deepEqual(rejected, []);
      console.log(kind + ' ' + username + ': original read pages, scope, permissions, settings and secure sign-in passed');
      await context.close();
    }
    await browser.close(); browser = null;
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'result=Desktop Chromium and mobile WebKit; Admin and Regular read flows passed\n');
} catch (error) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'result=' + String(error.stack || error).replaceAll('\n', ' ').slice(0, 1500) + '\n');
  throw error;
} finally {
  if (browser) await browser.close();
  if (server?.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  await auth.close(); await rm(temp, { recursive: true, force: true });
}
