// Reuse the reviewed original interface. Only this finite asset map is served;
// account files, gateway keys, installers and arbitrary filesystem paths cannot
// become static routes. Unimplemented domain endpoints remain unavailable.
import { readFile } from 'node:fs/promises';
const assets = [
  ['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'],
  ['/style.css', 'style.css', 'text/css'], ['/settings.js', 'settings.js', 'text/javascript'],
  ['/keypad.js', 'keypad.js', 'text/javascript'], ['/homebridge-flow.js', 'homebridge-flow.js', 'text/javascript'],
  ['/demo.js', 'demo.js', 'text/javascript'], ['/app-icon.svg', 'app-icon.svg', 'image/svg+xml'],
  ['/app-icon-192.png', 'app-icon-192.png', 'image/png'], ['/app-icon-512.png', 'app-icon-512.png', 'image/png'],
  ['/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png'],
  ['/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json'],
  ['/installation-help.html', 'installation-help.html', 'text/html'],
];
export async function loadWebAdminAssets() {
  return new Map(await Promise.all(assets.map(async ([route, name, type]) =>
    [route, { type, content: await readFile(new URL('../web-admin/public/' + name, import.meta.url)) }])));
}
