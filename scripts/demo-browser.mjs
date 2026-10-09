// Exercise the actual published directory under a GitHub project-site prefix.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
const root = new URL('../demo/', import.meta.url);
const prefix = '/deconzAlarmKeypadConfigurator/';
const allowed = new Set(['index.html', 'style.css', 'public-demo.css', 'keypad.js', 'demo.js', 'app.js', 'app-icon.svg']);
const requests = [];
const server = http.createServer(async (req, res) => {
  requests.push({method:req.method, path:req.url});
  const name = req.url.startsWith(prefix) ? req.url.slice(prefix.length) || 'index.html' : '';
  if(req.method !== 'GET' || !allowed.has(name)) { res.writeHead(404); res.end(); return; }
  const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
  res.setHeader('Content-Type', type); res.end(await readFile(new URL(name, root)));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const output = process.env.PREVIEW_OUTPUT || '/tmp/configurator-demo-screenshots';
await mkdir(output, {recursive:true});
const playwright = await import(pathToFileURL(join(process.env.PLAYWRIGHT_MODULE, 'index.mjs')).href);
let browser;
try {
  for(const kind of ['chromium', 'webkit']) {
    browser = await playwright[kind].launch({headless:true});
    const phone = kind === 'webkit';
    const context = await browser.newContext(phone ? playwright.devices['iPhone 13'] : {viewport:{width:1360,height:980}});
    const page = await context.newPage(), errors = [], unexpected = [];
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => {void dialog.accept();});
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if(url.origin !== origin || request.method() !== 'GET' || !url.pathname.startsWith(prefix) || !allowed.has(url.pathname.slice(prefix.length) || 'index.html')) {
        unexpected.push(request.method() + ' ' + url.pathname); return route.abort();
      }
      return route.continue();
    });
    const ready = () => page.waitForFunction(() => !document.querySelector('#demo-reset').disabled);
    async function navigate(id) {
      if(phone)await page.locator('#mobile-menu').click();
      await page.locator('[data-page="' + id + '"]').click();
      await page.locator('#' + id).waitFor({state:'visible'}); await ready();
    }
    await page.goto(origin + prefix);
    await page.locator('#user-list [data-id]').first().waitFor(); await ready();
    assert.equal(await page.locator('#login').isVisible(), false);
    assert.equal(await page.locator('#demo-mode').isVisible(), false);
    assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /connect-src 'none'/);
    await page.screenshot({path:join(output, kind + '-users.png'), fullPage:true});
    await page.locator('#user-list [data-id]').first().click(); await ready();
    await page.locator('#name').fill('Demo owner edited');
    await page.locator('#editor button.primary').click();
    await page.getByText('Saved in demo data only.', {exact:true}).waitFor(); await ready();
    await page.reload(); await page.locator('#user-list [data-id]').first().waitFor({state:'attached'}); await ready();
    if(!await page.locator('#name').isVisible())await page.locator('#user-list [data-id]').first().click();
    assert.equal(await page.locator('#name').inputValue(), 'Demo owner edited');
    await page.locator('#pin').fill('85927461'); await page.locator('#pin-repeat').fill('85927461');
    await page.locator('#editor button.primary').click();
    await page.getByText('Demo PIN change simulated. No PIN was saved or sent.', {exact:true}).waitFor(); await ready();
    assert.equal(await page.locator('#pin').inputValue(), '');
    assert.equal(await page.evaluate(() => JSON.stringify({...localStorage, ...sessionStorage}).includes('85927461')), false);
    await navigate('gateway'); assert.equal(await page.locator('[data-inventory-gateway]').count() > 0 || (await page.locator('#gateway-inventory').textContent()).includes('Demo · Office'), true);
    await navigate('access'); await page.locator('#grant-preview').waitFor();
    await navigate('protection');
    await page.locator('#lockout-enabled').waitFor();
    await page.locator('#lockout-enabled').check(); await page.locator('#lockout-threshold').fill('8');
    await page.locator('#lockout-form button.primary').click();
    await page.getByText('Keypad protection saved. No services restarted.', {exact:true}).waitFor(); await ready();
    assert.equal(await page.locator('#lockout-threshold').inputValue(), '8');
    await navigate('alarm');
    await page.locator('[data-alarm-timer="armed_stay_entry_delay"]').fill('12');
    await page.locator('#alarm-save').click(); await ready();
    assert.equal(await page.locator('[data-alarm-timer="armed_stay_entry_delay"]').inputValue(), '12');
    await navigate('keypad');
    for(const digit of '2323')await page.locator('[data-keypad-digit="' + digit + '"]').click();
    await page.waitForFunction(() => /accepted/i.test(document.querySelector('#keypad-results').textContent));
    await page.screenshot({path:join(output, kind + '-keypad.png'), fullPage:true});
    await navigate('history'); assert.match(await page.locator('#activity').textContent(), /demo|no activity|no matching/i);
    await navigate('users');
    await page.locator('#gateway-select').selectOption('demo-office'); await ready();
    assert.match(await page.locator('#configuration-context').textContent(), /Office/);
    if(phone)await page.locator('#mobile-menu').click();
    await page.locator('#demo-reset').click(); await ready();
    if(phone)await page.locator('#mobile-menu-close').click();
    await page.locator('#gateway-select').selectOption('demo-home'); await ready();
    await page.locator('#user-list [data-id]').first().click(); await ready();
    assert.equal(await page.locator('#name').inputValue(), 'Owner');
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, 'Unexpected horizontal overflow');
    await context.close(); await browser.close(); browser = undefined;
    console.log(kind + ': demo navigation, edits, persistence, PIN privacy, reset and network isolation passed');
  }
  assert.ok(requests.every(r => r.method === 'GET' && r.path.startsWith(prefix)));
  if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT, 'result=Chromium desktop and WebKit mobile passed; no API or external requests\n');
} catch(error) {
  if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT, 'result=' + String(error.message).replace(/[\r\n]/g, ' ').slice(0, 700) + '\n');
  throw error;
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
