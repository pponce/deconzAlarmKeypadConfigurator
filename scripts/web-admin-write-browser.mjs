import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { webBrowserFixture } from './web-admin-browser-fixture.mjs';

const playwright = await import(pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, 'index.mjs')).href);
let browser;
try {
  for (const kind of ['chromium', 'webkit']) {
    const f = await webBrowserFixture(), phone = kind === 'webkit';
    try {
      browser = await playwright[kind].launch({ headless: true });
      const context = await browser.newContext({ ignoreHTTPSErrors: true, ...(phone ? playwright.devices['iPhone 13'] : { viewport: { width: 1280, height: 900 } }) });
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => { void dialog.accept(); });
      await f.enable(); assert.deepEqual(f.writes, []);
      await page.goto(f.origin); await page.locator('#username').fill('Owner'); await page.locator('#password').fill(f.password); await page.locator('#login button').click();
      const ready = () => page.waitForFunction(() => !document.querySelector('#settings-gear').disabled);
      await page.locator('#user-list [data-id]').first().waitFor(); await ready();
      await page.locator('#user-list [data-id]').first().click(); await ready();
      assert.equal(await page.locator('#hb-use').isVisible(), true);
      assert.equal(await page.locator('#hb-use').isDisabled(), true);
      await page.getByText('Run homebridge-deconz in its own child bridge.', { exact: true }).waitFor();
      async function navigate(id) { if (phone) await page.locator('#mobile-menu').click(); await page.locator('[data-page="' + id + '"]').click(); await page.locator('#' + id).waitFor({ state: 'visible' }); await ready(); }
      await page.locator('#name').fill('Owner renamed');
      await page.locator('#editor button.primary').click(); await page.getByText('Saved. A private recovery snapshot was created before the change.', { exact: true }).waitFor();
      assert.equal(f.data.responses['/alarmsystems/users']['a'.repeat(32)].name, 'Owner renamed');
      await page.locator('#pin').fill('5678'); await page.locator('#pin-repeat').fill('5678'); await page.locator('#editor button.primary').click();
      await page.getByText('PIN updated and verified.', { exact: true }).waitFor(); assert.equal(await page.locator('#pin').inputValue(), '');
      await navigate('alarm');
      const timer = page.locator('[data-alarm-timer="armed_stay_entry_delay"]'); await timer.fill('17'); await page.locator('#alarm-save').click();
      await page.waitForFunction(() => document.querySelector('#alarm-save') && !document.querySelector('#alarm-save').disabled && document.querySelector('[data-alarm-timer="armed_stay_entry_delay"]').value === '17');
      assert.equal(f.data.responses['/alarmsystems/1'].config.armed_stay_entry_delay, 17);
      f.state.loseNextAlarmReply = true; await timer.fill('19'); await page.locator('#alarm-save').click();
      await page.locator('#recovery-review').waitFor({ state: 'visible' });
      const count = f.writes.length; await page.locator('#recovery-review').click();
      await page.locator('#recovery-completion').waitFor({ state: 'visible' }); await page.locator('#recovery-ack').check(); await page.locator('#recovery-confirm').click();
      await page.getByText('Recovery completed. The gateway write was not repeated.', { exact: true }).waitFor(); assert.equal(f.writes.length, count);
      await page.locator('#settings-gear').click(); await page.locator('#settings-content').waitFor({ state: 'visible' });
      await page.locator('#settings-home-screen-name').fill('My keypad'); await page.locator('#settings-preferences button').click();
      await page.getByText('Display and discovery preferences saved.', { exact: true }).waitFor();
      await page.locator('#tab-connections').click(); assert.equal(await page.locator('[data-gateway-form]').count(), 1);
      assert.match(await page.locator('#settings-gateways').textContent(), /Gateway identity/);
      await page.locator('#tab-security').click(); await page.locator('#settings-add-account').click();
      const account = page.locator('#settings-account-editor'); await account.locator('[name="username"]').fill('Guest');
      await account.locator('[name="password"]').fill('synthetic-guest-password'); await account.locator('[name="repeat_password"]').fill('synthetic-guest-password');
      await account.locator('[name="current_password"]').fill(f.password); await account.getByRole('button', { name: 'Save account', exact: true }).click();
      await page.getByText('Web account created.', { exact: true }).waitFor(); assert.equal(await page.locator('[data-web-account]').count(), 2);
      await page.locator('#settings-close').click(); await navigate('history'); assert.ok(await page.locator('#activity .gp-history-row').count() >= 3);
      if (process.env.PREVIEW_OUTPUT) { await mkdir(process.env.PREVIEW_OUTPUT, { recursive: true }); await page.screenshot({ path: join(process.env.PREVIEW_OUTPUT, kind + '-durable-write-history.png'), fullPage: true }); }
      // Exercise the production PIN transaction and browser confirmation while
      // substituting only the host service port. No service or hardware exists.
      f.state.homebridgeAvailable = true; await navigate('users');
      await page.locator('#user-list [data-id="' + 'a'.repeat(32) + '"]').click();
      await page.locator('#hb-use').check(); await page.locator('[data-hb-alarm="1"]').check();
      await page.locator('#pin').fill('6789'); await page.locator('#pin-repeat').fill('6789'); await page.locator('#editor button.primary').click();
      await page.getByRole('button', { name: 'Continue to preparation', exact: true }).click();
      const restart = page.getByRole('button', { name: 'Save PIN and restart Homebridge deCONZ', exact: true });
      assert.equal(await restart.isEnabled(), false); assert.equal(f.maintenance.includes('stop'), false);
      assert.match(await page.locator('#hb-flow-content').textContent(), /same page/);
      await page.locator('[name="homebridge-username"]').fill('BridgeAdmin');
      await page.locator('[name="homebridge-password"]').fill('synthetic-bridge-password');
      await page.locator('[name="homebridge-restart-confirmed"]').check();
      const pinWritesBefore = f.writes.filter(([, route]) => route === '/alarmsystems/users/' + 'a'.repeat(32)).length;
      await restart.click(); await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByText('Homebridge access updated.', { exact: true }).waitFor();
      assert.equal(f.writes.filter(([, route]) => route === '/alarmsystems/users/' + 'a'.repeat(32)).length, pinWritesBefore + 1);
      assert.equal(f.maintenance.filter(value => value === 'stop').length, 1); assert.equal(f.maintenance.filter(value => value === 'start').length, 1);
      assert.equal(await page.locator('#login').isVisible(), false); assert.equal(await page.locator('#users').isVisible(), true);
      assert.equal(await page.locator('[name="homebridge-password"]').count(), 0);
      await page.locator('#logout').click(); await page.locator('#username').fill('Guest'); await page.locator('#password').fill('synthetic-guest-password'); await page.locator('#login button').click();
      await page.locator('#users').waitFor({ state: 'visible' }); await ready();
      assert.equal(await page.locator('#user-list [data-id="' + 'a'.repeat(32) + '"]').count(), 0);
      assert.deepEqual(errors, []); assert.deepEqual(f.errors, []);
      await context.close(); await browser.close(); browser = null;
      console.log(kind + ': Standalone startup, production TLS, rename, PIN, alarm save, lost-reply recovery without replay, preferences, accounts, activity, confirmed child-bridge PIN restart and Regular protections passed');
    } finally { if (browser) { await browser.close(); browser = null; } await f.close(); }
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'result=Desktop and mobile production setup, durable saves and no-replay recovery passed\n');
} catch (error) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'result=' + String(error.stack || error).replaceAll('\n', ' ').slice(0, 1500) + '\n');
  throw error;
}
