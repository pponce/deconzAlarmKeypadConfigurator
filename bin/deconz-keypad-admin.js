#!/usr/bin/env node
import path from 'node:path';
import { homedir } from 'node:os';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { acquireOwnership } from '../src/ownership.js';
import { startStandalone } from '../src/standalone.js';
import { prepareStorage, StandaloneConfig, defaultServer, initializeStandalone, verifyRegistration, assertNoMaintenance } from '../src/standalone-config.js';
import { requireWeb } from '../src/web-admin-common.js';

const args = process.argv.slice(2), command = args.shift() || 'serve';
let storagePath = path.join(homedir(), '.local/share/deconz-keypad-configurator');
if (args[0] === '--data-dir' && args[1]) { storagePath = path.resolve(args[1]); args.splice(0, 2); }
const help = 'Usage: deconz-keypad-admin [init|serve|gateway|homebridge|network|help] [--data-dir PATH]\nSetup commands run locally while the server is stopped. Secrets are entered at hidden prompts, never as command arguments.';
async function configure() {
  requireWeb(process.stdin.isTTY && process.stdout.isTTY, 'interactive_terminal_required');
  await prepareStorage(storagePath); const release = await acquireOwnership(storagePath);
  let muted = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  rl.on('SIGINT', () => { rl.close(); });
  async function ask(label, fallback = '', secret = false) {
    process.stdout.write(label + (fallback ? ' [' + fallback + ']' : '') + ': ');
    muted = secret;
    try { const value = await rl.question(''); return value || fallback; }
    finally { muted = false; if (secret) process.stdout.write('\n'); }
  }
  async function gateway(before) {
    const id = before?.id || await ask('Gateway ID', 'deconz');
    const name = await ask('Gateway display name', before?.name || 'deCONZ');
    const endpoint = await ask('deCONZ URL (including its HTTP port)', before?.endpoint || 'http://127.0.0.1:80');
    const key = await ask(before ? 'Replacement API key (blank keeps existing key)' : 'deCONZ API key', '', true) || before?.key;
    return verifyRegistration({ id, name, endpoint, key, identity: before?.identity || '' });
  }
  async function server(before = defaultServer()) {
    const origin = await ask('Admin HTTPS address', before.origin);
    const bind = await ask('Listen address (use 0.0.0.0 for LAN access)', before.bind);
    const port = Number(new URL(origin).port || 443);
    const accessMode = await ask('Access mode: manage or observe', before.accessMode);
    return { origin, publicUrl: origin, bind, port, accessMode };
  }
  try {
    const store = new StandaloneConfig(storagePath), current = await store.read();
    if (command === 'init') {
      requireWeb(!current, 'standalone_already_configured');
      const settings = await server(), registration = await gateway();
      const username = await ask('First web administrator username', 'Owner');
      let password = await ask('Web administrator password (at least 8 characters)', '', true);
      requireWeb(password === await ask('Repeat password', '', true), 'passwords_do_not_match');
      try { await initializeStandalone({ storagePath, username, password, server: settings, gateways: [registration] }); }
      finally { password = ''; }
    } else {
      requireWeb(current, 'standalone_setup_required'); await assertNoMaintenance(storagePath, current);
      if (command === 'gateway') {
        const id = await ask('Gateway ID to add or update', current.gateways[0].id);
        const before = current.gateways.find(row => row.id === id);
        const registration = await gateway(before || { id, name: 'deCONZ' });
        const gateways = before ? current.gateways.map(row => row.id === id ? registration : row) : [...current.gateways, registration];
        await store.save(current.revision, { ...current, gateways });
      } else if (command === 'network') {
        await store.save(current.revision, { ...current, server: await server(current.server) });
      } else {
        const homebridge = {
          storagePath: await ask('Homebridge storage directory', current.homebridge?.storagePath || ''),
          configPath: await ask('Homebridge config.json absolute path', current.homebridge?.configPath || ''),
          pluginPath: await ask('Installed homebridge-deconz package directory', current.homebridge?.pluginPath || ''),
        };
        await store.save(current.revision, { ...current, homebridge });
      }
    }
    process.stdout.write('Saved. Start the standalone admin with npm start (and the same --data-dir, if set).\n');
  } finally { rl.close(); await release(); }
}
try {
  requireWeb(args.length === 0 && ['init', 'serve', 'gateway', 'homebridge', 'network', 'help', '--help'].includes(command), 'arguments_invalid');
  if (['help', '--help'].includes(command)) console.log(help);
  else if (command !== 'serve') await configure();
  else {
    const service = await startStandalone({ storagePath }); console.log('deCONZ web admin: ' + service.url);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await service.close(); };
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  }
} catch (error) {
  // Only fixed codes may reach the terminal. Never print paths, gateway URLs,
  // API bodies, credentials or arbitrary errors from external integrations.
  const code = /^[a-z][a-z0-9_]{1,100}$/.test(error.message || '') ? error.message : 'standalone_operation_failed';
  console.error(code + '\n' + help); process.exitCode = 1;
}
