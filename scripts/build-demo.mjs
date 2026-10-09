// Generate a browser-only copy of the current UI. Never publish the server tree.
// Exact-match guards stop the build if upstream wiring changes and needs review.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const read = name => readFile(new URL('web-admin/public/' + name, root), 'utf8');
function once(text, before, after) {
  assert.equal(text.split(before).length, 2, 'Demo adaptation needs review: ' + before.slice(0, 80));
  return text.replace(before, after);
}
function block(text, start, end, replacement) {
  assert.equal(text.split(start).length, 2, 'Missing/ambiguous start: ' + start);
  assert.equal(text.split(end).length, 2, 'Missing/ambiguous end: ' + end);
  const a = text.indexOf(start), b = text.indexOf(end, a);
  assert.ok(b > a, 'Invalid adaptation boundary');
  return text.slice(0, a) + replacement + text.slice(b);
}
let app = await read('app.js');
app = block(app, '  async function openExtension(extension){', '  let demoMode=false,',
  "  async function openExtension(){throw Error('Extensions require an installed server and are unavailable in this demo.');}\n");
app = block(app, '  async function api(path, body,', '  async function continueHomebridge(', `  async function api(path, body, context={gateway:selectedGateway,alarm:selectedAlarm}) {
    if(path==='session')return {role:'admin',username:'Demo visitor',csrf:'public-demo'};
    if(path==='setup')return {extensions:[],onboarding_required:false,access_mode:'manage',homebridge:{profile:'demo'}};
    return window.ConfiguratorDemo.request(path,body,context);
  }
  const homebridgeFlow={clear(){},async open(){throw Error('Service maintenance requires an installed server. Demo PIN changes are simulated.');}};
`);
app = once(app, 'window.ConfiguratorSettings.clear();', '');
app = once(app, "demoMode=!regular&&sessionStorage.getItem('configurator-demo-active')==='true';", 'demoMode=true;');
app = once(app, "if(applicationSettings.onboarding_required){window.location.assign('/welcome.html');return;}", '');
app = block(app, "  $('#settings-gear').onclick=", '  function pendingOperation()',
  "  $('#settings-gear').onclick=()=>tell('Installation settings require your own server.');\n");
app = block(app, "  $('#demo-mode').onchange=", "  $('#demo-reset').onclick=",
  "  $('#demo-mode').onchange=()=>{$('#demo-mode').checked=true;};\n");
app = once(app, "act(async()=>{try{const session=await api('session');csrf=session.csrf;await signedIn();}catch(_){signedOut();tell('Sign in to continue.');}});",
  "act(async()=>{csrf='public-demo';await signedIn();});");
app = app.replaceAll('configurator-demo-navigation', 'configurator-pages-navigation-v1')
  .replaceAll('configurator-debug-visible', 'configurator-pages-debug-v1');
app = once(app, 'Reset all fictional users and grants? Your real setup is unaffected.', 'Reset all fictional users and grants in this browser?');
app = once(app, "tell('PIN updated and verified.');", "tell('Demo PIN change simulated. No PIN was saved or sent.');");
app = once(app, ". PIN changes use coordinated maintenance.'", ". This binding is simulated; no Homebridge service is connected.'");
let html = await read('index.html');
html = once(html, '<title>deCONZ · Administration</title>', '<title>deCONZ · Interactive demo</title>');
html = once(html, '<meta charset="utf-8">', `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'; object-src 'none'"><meta name="referrer" content="no-referrer">`);
html = once(html, '<script src="/settings.js" defer></script>', '');
html = once(html, '<script src="/homebridge-flow.js" defer></script>', '');
html = once(html, '<link rel="manifest" href="/manifest.webmanifest">', '');
html = once(html, '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">', '');
html = once(html, '<link rel="stylesheet" href="/style.css">', '<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/public-demo.css">');
html = once(html, '<span>Local administration</span>', '<a href="https://github.com/pponce/deconzAlarmKeypadConfigurator" target="_blank" rel="noopener noreferrer">Project on GitHub ↗</a>');
html = once(html, '<form id="login">', '<noscript><p class="gp-note">Enable JavaScript to try this interactive demo.</p></noscript><form id="login" hidden>');
html = once(html, 'Turn off demo to return to your unchanged real setup.', 'No installation or sign-in is needed. Try keypad code 2323. Installation settings and service maintenance require your own server.');
html = once(html, '<strong>Try demo data</strong> uses fictional code', 'This demo uses fictional code');
html = block(html, '<dialog id="installation-settings"', '<dialog id="mobile-navigation"', '');
html = html.replaceAll('href="/', 'href="./').replaceAll('src="/', 'src="./');
const files = {
  'index.html': html,
  'app.js': '// Generated by scripts/build-demo.mjs; edit the source or generator.\n' + app,
  'demo.js': once(await read('demo.js'), "const KEY='configurator-demo-v2';", "const KEY='configurator-pages-demo-v1';"),
  'keypad.js': await read('keypad.js'),
  'style.css': await read('style.css'),
  'app-icon.svg': await read('app-icon.svg'),
  'public-demo.css': `/* The published demo never offers a live mode or asks for a web login. */
#login, #logout, #settings-gear, .gp-nav-demo label, [data-page="debug"] { display:none !important; }
.gp-demo a { color:inherit; text-underline-offset:3px; }
`,
};
// A future UI change must not silently add a transport or a root-relative asset.
for(const [name, content] of Object.entries(files)) {
  if(name.endsWith('.js'))assert.doesNotMatch(content, /\bfetch\s*\(|\b(?:XMLHttpRequest|WebSocket|EventSource)\b|\bsendBeacon\s*\(|\/api\//, name + ' contains a network transport');
  if(name.endsWith('.html'))assert.doesNotMatch(content, /(?:href|src)="\//, 'Use relative assets for project Pages');
}
const check = process.argv.includes('--check');
await mkdir(new URL('demo/', root), {recursive:true});
const allowed = new Set([...Object.keys(files), 'README.md']);
for(const entry of await readdir(new URL('demo/', root)))assert.ok(allowed.has(entry), 'Unexpected demo artifact: ' + entry);
for(const [name, content] of Object.entries(files)) {
  const path = new URL('demo/' + name, root);
  if(check)assert.equal(await readFile(path, 'utf8'), content, 'Regenerate demo/' + name);
  else await writeFile(path, content);
}
console.log(check ? 'Static demo matches the current UI.' : 'Generated static demo/ from the current UI.');
