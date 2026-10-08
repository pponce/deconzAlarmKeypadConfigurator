'use strict';
// Real admin UI and adapter, synthetic coordinator transport. The sibling-repo
// Python check separately exercises the actual coordinator implementation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const token = 'synthetic-browser-token-with-no-device-access';
const envelope = { apiVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001' };
const controllers = [{ id: 'example-garage', name: 'Example garage <safe text>', doorBackend: 'tailwind',
  boltBackend: 'deconz', exposeBoltLock: true, feedback: { closing: 'sensor', opening: 'timed', bolt: 'relay' },
  status: { phase: 'not-commissioned', door: 'unknown', bolt: 'unknown', actuationEnabled: false } }];
const routing = { controllerId: 'example-garage', builtins: { homekit: 'primary', virtualKeypad: 'primary' },
  motorPaths: [{ id: 'primary', name: 'Primary opener', type: 'tailwind', interruption: 'disabled' },
    { id: 'wall-relay', name: 'Opener relay <safe>', type: 'pulse-relay', interruption: 'stop-opening-reverse-closing' }],
  inputs: [{ id: 'indoor-button', name: 'Indoor button', enabled: true, source: { type: 'deconz', kind: 'button' },
    trigger: 1002, action: 'toggle', motorPath: 'wall-relay', busyBehavior: 'interrupt', rearmSeconds: 1.5, timing: {} },
    { id: 'other-button', name: 'Another brand of button', enabled: true, source: { type: 'homebridge', kind: 'button' },
      trigger: 0, action: 'toggle', motorPath: 'wall-relay', busyBehavior: 'drop', rearmSeconds: 1.5, timing: {} }], runtimeEnabled: false };
let available = true;
let deviceAvailable = true; let probes = 0;
const api = http.createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401); response.end('{}'); return;
  }
  if (!available) { response.writeHead(503); response.end('{}'); return; }
  if (request.url === '/v1/identity') response.end(JSON.stringify({ ...envelope, pluginVersion: '0.3.0-dev.1',
    mode: 'observation', capabilities: { inventory: true, diagnostics: true, routingInventory: true, settingsWrite: false, motion: false, maintenance: false, keypad: false } }));
  else if (request.url === '/v1/controllers') response.end(JSON.stringify({ ...envelope, controllers }));
  else if (request.url === '/v1/controllers/example-garage/routing') response.end(JSON.stringify({ ...envelope, routing }));
  else if (request.url === '/v1/controllers/example-garage/probe' && request.method === 'POST') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    assert.deepEqual(JSON.parse(raw), { instanceId: envelope.instanceId }); probes++;
    response.end(JSON.stringify({ ...envelope, probe: { controllerId: 'example-garage', checkedAt: new Date().toISOString(),
      door: { state: 'closed', feedback: 'closed-sensor', blocked: false, error: null },
      bolt: deviceAvailable ? { state: 'locked', feedback: 'relay', error: null } :
        { state: 'unknown', feedback: 'unavailable', error: 'bolt_unreachable' },
      limitations: [], compatible: deviceAvailable, actuationEnabled: false } }));
  }
  else { response.writeHead(404); response.end('{}'); }
});

function fixture(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Admin fixture startup timed out')), 10000);
    child.once('exit', () => { clearTimeout(timeout); reject(Error('Admin fixture exited during startup')); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    let output = '';
    child.stdout.on('data', data => {
      output += data;
      if (output.includes('\n')) {
        clearTimeout(timeout);
        try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
      }
    });
  });
}

(async () => {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const child = spawn('python3', ['-B', path.join(__dirname, '../configurator/tests/parity_fixture.py')], {
    env: { ...process.env, COORDINATOR_FIXTURE_URL: `http://127.0.0.1:${api.address().port}`, COORDINATOR_TEST_TOKEN: token },
  });
  child.stderr.on('data', () => {});
  let browser;
  try {
    const site = await fixture(child);
    browser = await chromium.launch({ headless: true });
    for (const mobile of [false, true]) {
      available = true; deviceAvailable = true; probes = 0;
      const page = await browser.newPage({ ignoreHTTPSErrors: true,
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(site.origin);
      await page.fill('#password', site.password); await page.click('#login button');
      if (mobile) await page.click('#mobile-menu');
      await page.click('[data-extension="homebridge-coordinator"]');
      const frame = page.frameLocator('iframe[data-extension-id="homebridge-coordinator"]');
      await frame.locator('#controllers article').waitFor();
      assert.match(await frame.locator('#connection').textContent(), /Connected/);
      assert.match(await frame.locator('#readiness').textContent(), /observation only/);
      assert.equal(await frame.locator('h3').first().textContent(), controllers[0].name);
      assert.equal(await frame.locator('safe').count(), 0);
      const routes = frame.locator('.input-routing tbody tr');
      assert.equal(await routes.count(), 4);
      assert.match(await routes.nth(0).textContent(), /HomeKit garage tile.*Tailwind API/);
      assert.match(await routes.nth(1).textContent(), /Virtual keypad.*Tailwind API/);
      assert.match(await routes.nth(2).textContent(), /Indoor button.*Opener relay <safe>/);
      assert.match(await routes.nth(3).textContent(), /Another brand of button.*Opener relay <safe>/);
      assert.equal(probes, 0); // Opening the page is not a hardware read.
      await frame.locator('.probe-button').click();
      await frame.locator('.probe-summary').filter({ hasText: 'Connections verified' }).waitFor();
      assert.equal(probes, 1);
      assert.match(await frame.locator('.probe-result').textContent(), /physical bolt position is not sensed/);
      deviceAvailable = false;
      await frame.locator('.probe-button').click();
      await frame.locator('.probe-summary').filter({ hasText: 'needs attention' }).waitFor();
      assert.equal(probes, 2);
      assert.match(await frame.locator('.probe-result').textContent(), /relay is unreachable/);
      assert.doesNotMatch(await frame.locator('.probe-result').textContent(), /Relay indicates locked/);
      assert.equal(await frame.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth + 1), true);
      await page.reload();
      await frame.locator('#controllers article').waitFor();
      available = false;
      await frame.locator('#refresh').click();
      await frame.locator('#connection').filter({ hasText: /unavailable/ }).waitFor();
      assert.equal(await frame.locator('#controllers article').count(), 0);
      assert.equal((await page.content()).includes(token), false);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('Coordinator page passed on desktop/mobile: login, input/motor routing, explicit read-only probes, evidence labels, escaping, refresh restoration and outage clearing.');
  } finally {
    if (browser) await browser.close();
    child.kill('SIGTERM');
    api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
  }
})().catch(error => {
  console.error(error);
  if (process.env.GITHUB_OUTPUT) require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT,
    'result=Coordinator UI: ' + String(error).replaceAll('\n', ' ').slice(0,1500) + '\n');
  process.exitCode = 1;
});
