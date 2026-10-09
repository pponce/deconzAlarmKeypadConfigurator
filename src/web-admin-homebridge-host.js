// Narrow port of the owner's existing offline alarm-PIN configuration flow.
// Only the reviewed deCONZ child bridge cache is eligible. No plugin source,
// Homebridge configuration, service installation or pairing identity is edited.
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { WebAdminError } from './web-admin-auth.js';
import { WebAdminFiles, webDigest } from './web-admin-files.js';
import { WebAdminGateway, webGatewayExchange } from './web-admin-gateway.js';
import { WebHomebridgeClient } from './web-admin-homebridge-client.js';
import { homebridgeEligibleUser, validateAlarmBinding } from './web-admin-homebridge-maintenance.js';
import { requireWeb, object, integer, parseWebJson } from './web-admin-common.js';
import reviewed from './web-admin-homebridge-sources.json' with { type: 'json' };

const SECURITY = '0000007E-0000-1000-8000-0026BB765291';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = raw => parseWebJson(new TextDecoder('utf-8', { fatal: true }).decode(raw));
const pin = value => typeof value === 'string' && /^[0-9]{4,16}$/.test(value);
const MAX_CACHE = 16 * 1024 * 1024;
const require = createRequire(import.meta.url);

export async function readHomebridgeFile(file, limit = MAX_CACHE, { allowServiceGroupWrite = false } = {}) {
  let handle, reason = 'read_failed';
  try {
    reason = 'linked_path';
    requireWeb(path.isAbsolute(file) && await realpath(file) === file, 'homebridge_file_path_invalid');
    reason = 'read_failed';
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    reason = 'not_regular'; requireWeb(info.isFile(), 'homebridge_file_permissions_invalid');
    reason = 'hard_link'; requireWeb(info.nlink === 1, 'homebridge_file_permissions_invalid');
    reason = 'writable_by_others';
    const trustedGroupWrite = allowServiceGroupWrite && process.getgid && info.gid === process.getgid();
    requireWeb(!(info.mode & 0o002) && (!(info.mode & 0o020) || trustedGroupWrite), 'homebridge_file_permissions_invalid');
    reason = 'unexpected_owner'; requireWeb(!process.getuid || [0, process.getuid()].includes(info.uid), 'homebridge_file_permissions_invalid');
    reason = 'too_large'; requireWeb(info.size <= limit, 'homebridge_file_permissions_invalid');
    reason = 'read_failed';
    const raw = await handle.readFile(); requireWeb(raw.length <= limit, 'homebridge_file_too_large'); return raw;
  } catch (cause) {
    const error = new WebAdminError('homebridge_file_unavailable');
    error.fileReason = cause.code === 'ENOENT' ? 'missing' : ['EACCES', 'EPERM'].includes(cause.code) ? 'unreadable' : reason;
    throw error;
  }
  finally { await handle?.close(); }
}
// Fixed package-relative labels only: never expose host paths or file contents.
async function readPrerequisite(file, limit, scope, label, resolve = false) {
  try {
    return await readHomebridgeFile(resolve ? await realpath(file) : file, limit,
      { allowServiceGroupWrite: scope === 'plugin' || scope === 'library' });
  }
  catch (cause) {
    if (cause.code === 'ENOENT' || cause.code === 'EACCES' || cause.code === 'EPERM') {
      const error = new WebAdminError('homebridge_file_unavailable');
      error.fileReason = cause.code === 'ENOENT' ? 'missing' : 'unreadable'; cause = error;
    }
    if (cause.message === 'homebridge_file_unavailable') cause.fileCheck = { scope, file: label, reason: cause.fileReason };
    throw cause;
  }
}
function publicFileCheck(value) {
  const files = value?.scope === 'configuration' ? ['config.json'] : ['package.json', ...Object.keys(reviewed[value?.scope]?.source_sha256 ?? {})];
  const reasons = ['missing', 'unreadable', 'linked_path', 'not_regular', 'hard_link', 'writable_by_others', 'unexpected_owner', 'too_large', 'read_failed'];
  if (!['configuration', 'plugin', 'library'].includes(value?.scope) || !files.includes(value?.file) || !reasons.includes(value?.reason)) return null;
  return { scope: value.scope, file: value.file, reason: value.reason };
}
export function homebridgeAlarmContext(rows, identity, accessory) {
  requireWeb(Array.isArray(rows), 'homebridge_cache_schema_unsupported');
  const matches = rows.filter(row => row?.platform === 'deCONZ' && row.context?.id === accessory && row.context?.context?.gid === identity);
  requireWeb(matches.length === 1, 'homebridge_accessory_identity_changed');
  const row = matches[0], services = row.services?.filter(service => service?.UUID === SECURITY);
  requireWeb(Array.isArray(services) && services.length === 1, 'one_homebridge_alarm_service_required');
  const subtype = services[0].subtype;
  requireWeb(subtype == null || typeof subtype === 'string', 'homebridge_cache_schema_unsupported');
  const key = SECURITY + (subtype == null ? '' : '.' + subtype), value = row.context[key];
  requireWeb(object(value) && pin(value.pin), 'homebridge_cache_schema_unsupported'); return value;
}
export function editedHomebridgeCache(raw, binding, mapping, newPin) {
  validateAlarmBinding(binding); requireWeb(pin(newPin), 'invalid_pin');
  requireWeb(object(mapping) && same(Object.keys(mapping).map(Number).sort((a, b) => a - b), binding.alarms), 'homebridge_alarm_mapping_changed');
  const rows = json(raw);
  for (const accessory of Object.values(mapping)) homebridgeAlarmContext(rows, binding.identity, accessory).pin = newPin;
  return Buffer.from(JSON.stringify(rows) + '\n');
}
export async function replaceHomebridgeCache(file, before, after, assertStopped) {
  let handle, directory, temporary;
  try {
    requireWeb(Buffer.isBuffer(before) && Buffer.isBuffer(after) && after.length <= MAX_CACHE, 'homebridge_cache_schema_unsupported');
    await assertStopped();
    requireWeb((await readHomebridgeFile(file)).equals(before), 'homebridge_cache_changed');
    const original = await lstat(file);
    requireWeb(!process.getuid || original.uid === process.getuid(), 'homebridge_cache_owner_unavailable');
    const folder = path.dirname(file), info = await lstat(folder);
    requireWeb(info.isDirectory() && !(info.mode & 0o022) && await realpath(folder) === folder, 'homebridge_file_permissions_invalid');
    temporary = path.join(folder, '.deconz-admin-pin-' + randomBytes(16).toString('hex'));
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(after); await handle.chmod(0o600); await handle.sync(); await handle.close(); handle = null;
    await assertStopped();
    requireWeb((await readHomebridgeFile(file)).equals(before), 'homebridge_cache_changed');
    await rename(temporary, file); temporary = null;
    directory = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); await directory.sync();
    requireWeb((await readHomebridgeFile(file)).equals(after), 'homebridge_cache_write_unverified');
  } finally { await handle?.close(); await directory?.close(); if (temporary) await unlink(temporary).catch(() => {}); }
}
async function processStamp(pid) {
  requireWeb(integer(pid, 1, Number.MAX_SAFE_INTEGER), 'homebridge_process_unverified');
  try {
    const value = await readFile('/proc/' + pid + '/stat', 'utf8'), suffix = value.slice(value.lastIndexOf(')') + 2).split(' ');
    requireWeb(/^[0-9]+$/.test(suffix[19] ?? ''), 'homebridge_process_unverified'); return suffix[19];
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw new WebAdminError('homebridge_process_unverified'); }
}
function validateBackup(value) {
  requireWeb(object(value) && value.schema === 1 && /^[0-9a-f]{32}$/.test(value.id) && /^[0-9a-f]{64}$/.test(value.binding_digest) &&
    typeof value.before === 'string' && typeof value.after === 'string' &&
    [value.before, value.after].every(raw => /^[A-Za-z0-9+/]*={0,2}$/.test(raw) && Buffer.from(raw, 'base64').length <= MAX_CACHE), 'homebridge_backup_invalid');
  return value;
}

export class WebHomebridgeHost {
  constructor({ storagePath, homebridgeStoragePath = storagePath, configPath = path.join(homebridgeStoragePath, 'config.json'), registrations,
    clientFactory = options => new WebHomebridgeClient(options), exchange = webGatewayExchange,
    gatewayFactory = row => new WebAdminGateway(row), stamp = processStamp,
    clock = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pluginRoot = () => path.dirname(require.resolve('homebridge-deconz/package.json')) }) {
    Object.assign(this, { storagePath, homebridgeStoragePath, configPath, clientFactory, exchange, gatewayFactory, stamp, pluginRoot, clock, sleep });
    this.registrations = new Map(registrations.map(row => [row.id, row])); this.files = new WebAdminFiles(storagePath); this.client = null;
  }
  async configuration() {
    requireWeb(process.platform === 'linux', 'homebridge_local_linux_required');
    const root = await realpath(this.homebridgeStoragePath), raw = await readPrerequisite(this.configPath, MAX_CACHE, 'configuration', 'config.json', true), config = json(raw);
    const platforms = config.platforms?.filter(row => row?.platform === 'deCONZ'), ui = config.platforms?.filter(row => row?.platform === 'config');
    requireWeb(platforms?.length === 1 && ui?.length === 1, 'one_homebridge_child_bridge_required');
    const bridge = platforms[0]._bridge?.username?.toUpperCase();
    requireWeb(typeof bridge === 'string' && /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(bridge) &&
      bridge !== config.bridge?.username?.toUpperCase(), 'homebridge_child_identity_invalid');
    requireWeb(!config.disabledPlugins?.includes('homebridge-deconz') && (!config.plugins || config.plugins.includes('homebridge-deconz')), 'homebridge_plugin_disabled');
    // The first adapter supports the ordinary local HTTP Homebridge UI. HTTPS
    // must use a separately reviewed certificate-trust configuration, never an
    // automatic rejectUnauthorized:false fallback.
    const ssl = ui[0].ssl;
    requireWeb((ssl == null || ssl === false || object(ssl) && !ssl.key && !ssl.cert && !ssl.pfx && !ssl.selfSigned) &&
      integer(ui[0].port ?? 8581, 1, 65535), 'homebridge_local_http_ui_required');
    const cache = path.join(root, 'accessories', 'cachedAccessories.' + bridge.replaceAll(':', ''));
    return { root, cache, bridge, digest: hash(raw), origin: 'http://127.0.0.1:' + (ui[0].port ?? 8581) };
  }
  async verifySources() {
    const plugin = await realpath(await this.pluginRoot()), localRequire = createRequire(path.join(plugin, 'package.json'));
    const library = path.dirname(await realpath(localRequire.resolve('homebridge-lib')));
    for (const [kind, root] of [['plugin', plugin], ['library', library]]) {
      const expected = reviewed[kind], packageJson = json(await readPrerequisite(path.join(root, 'package.json'), 1048576, kind, 'package.json'));
      requireWeb(packageJson.name === expected.package && packageJson.version === expected.version, 'homebridge_source_changed_review_required');
      for (const [relative, digest] of Object.entries(expected.source_sha256)) {
        requireWeb(hash(await readPrerequisite(path.join(root, relative), 1048576, kind, relative)) === digest, 'homebridge_source_changed_review_required');
      }
    }
  }
  async readiness() {
    let phase = 'configuration';
    try { await this.configuration(); phase = 'sources'; await this.verifySources(); return { configured: true, error: null }; }
    catch (error) {
      const safe = new Set(['homebridge_local_linux_required', 'one_homebridge_child_bridge_required', 'homebridge_child_identity_invalid',
        'homebridge_plugin_disabled', 'homebridge_local_http_ui_required', 'homebridge_source_changed_review_required', 'homebridge_file_unavailable']);
      const fileCheck = error.message === 'homebridge_file_unavailable' ? publicFileCheck(error.fileCheck) : null;
      return { configured: false, error: safe.has(error.message) ? error.message :
        phase === 'sources' ? 'homebridge_sources_unavailable' : 'homebridge_configuration_unavailable',
        ...(fileCheck ? { file_check: fileCheck } : {}) };
    }
  }
  async available() { return (await this.readiness()).configured; }
  async authenticate(credentials) {
    const config = await this.configuration(); await this.verifySources(); this.client?.close();
    this.client = this.clientFactory({ origin: config.origin, bridge: config.bridge });
    await this.client.login(credentials);
  }
  async clearAuthentication() { this.client?.close(); this.client = null; }
  async current(lease) {
    const config = await this.configuration();
    requireWeb(config.digest === lease.host.configuration && config.bridge === lease.host.bridge, 'homebridge_configuration_changed');
    requireWeb(this.client?.bridge === config.bridge, 'homebridge_login_required'); await this.verifySources(); return config;
  }
  gatewayPort(rows, identity) {
    requireWeb(Array.isArray(rows), 'homebridge_cache_schema_unsupported');
    const found = rows.filter(row => row?.platform === 'deCONZ' && row.context?.className === 'Gateway' && row.context?.id === identity);
    requireWeb(found.length === 1 && integer(found[0].context.uiPort, 1024, 65535), 'homebridge_gateway_identity_changed');
    return found[0].context.uiPort;
  }
  async inventory(port, identity, timeoutMs = 8000) {
    let result;
    try { result = await this.exchange({ timeoutMs, url: 'http://127.0.0.1:' + port + '/gateways/' + identity + '/accessories', method: 'GET' }); }
    catch (error) {
      if (error instanceof WebAdminError && error.message === 'gateway_result_unknown_no_retry') throw new WebAdminError('homebridge_alarm_api_unavailable');
      if (error instanceof WebAdminError && error.message === 'gateway_response_invalid') throw new WebAdminError('homebridge_alarm_api_response_invalid');
      throw error;
    }
    const [status, value] = result;
    requireWeb(![502, 503, 504].includes(status), 'homebridge_alarm_api_unavailable');
    requireWeb(status === 200 && object(value), 'homebridge_alarm_inventory_unavailable'); return value;
  }
  // Poll only the restarted child's read-only inventory transport. Identity,
  // mapping, malformed replies and PIN mismatches still fail immediately.
  async runningInventory(config, lease, state) {
    const deadline = this.clock() + 30000;
    while (true) {
      requireWeb(this.clock() < deadline, 'homebridge_alarm_api_not_ready');
      const current = await this.client.status();
      requireWeb(current.status === 'ok' && !current.manuallyStopped && current.pid === state.pid,
        'homebridge_process_changed');
      const rows = json(await readHomebridgeFile(config.cache)), port = this.gatewayPort(rows, lease.binding.identity);
      try {
        const inventory = await this.inventory(port, lease.binding.identity, Math.max(1, Math.min(8000, Math.ceil(deadline - this.clock()))));
        requireWeb(same(this.mapping(lease.binding, rows, inventory), lease.host.mapping), 'homebridge_alarm_mapping_changed');
        return rows;
      } catch (error) {
        if (!(error instanceof WebAdminError) || error.message !== 'homebridge_alarm_api_unavailable') throw error;
        requireWeb(this.clock() < deadline, 'homebridge_alarm_api_not_ready');
        await this.sleep(Math.min(500, deadline - this.clock()));
      }
    }
  }
  mapping(binding, rows, inventory) {
    const mapping = {};
    for (const alarm of binding.alarms) {
      const matches = Object.entries(inventory).filter(([, row]) => row?.type === 'alarmsystems' && same(row.resources, ['/alarmsystems/' + alarm]));
      requireWeb(matches.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(matches[0][0]), 'homebridge_alarm_mapping_changed');
      mapping[alarm] = matches[0][0]; homebridgeAlarmContext(rows, binding.identity, matches[0][0]);
    }
    requireWeb(new Set(Object.values(mapping)).size === binding.alarms.length, 'homebridge_alarm_mapping_changed'); return mapping;
  }
  async prepare(binding) {
    validateAlarmBinding(binding); const config = await this.configuration(); await this.verifySources();
    requireWeb(this.client?.bridge === config.bridge && this.registrations.get(binding.gateway)?.identity === binding.identity, 'homebridge_binding_changed');
    const state = await this.client.status(); requireWeb(state.status === 'ok' && !state.manuallyStopped && state.pid !== process.pid, 'homebridge_child_not_running');
    const stamp = await this.stamp(state.pid); requireWeb(stamp !== null, 'homebridge_process_unverified');
    // Test our own durable storage before stopping another child bridge.
    const probe = { schema: 1, checked: true };
    const validProbe = value => object(value) && value.schema === 1 && value.checked === true;
    await this.files.write('web-homebridge-storage-check.json', probe, validProbe);
    requireWeb(await this.files.read('web-homebridge-storage-check.json', validProbe), 'web_private_storage_invalid');
    const rows = json(await readHomebridgeFile(config.cache)), port = this.gatewayPort(rows, binding.identity), inventory = await this.inventory(port, binding.identity);
    const mapping = this.mapping(binding, rows, inventory);
    requireWeb((await this.client.status()).pid === state.pid && await this.stamp(state.pid) === stamp, 'homebridge_process_changed');
    return { configuration: config.digest, bridge: config.bridge, pid: state.pid, stamp, mapping };
  }
  async stop(lease) { await this.current(lease); await this.client.command('stop', lease.id, true); }
  async assertStopped(lease) {
    await this.current(lease);
    await this.client.waitFor(async row => row.manuallyStopped && row.status === 'down' && await this.stamp(lease.host.pid) !== lease.host.stamp);
  }
  async snapshotStopped(lease, newPin) {
    await this.assertStopped(lease); const config = await this.current(lease), before = await readHomebridgeFile(config.cache);
    const after = editedHomebridgeCache(before, lease.binding, lease.host.mapping, newPin);
    const value = { schema: 1, id: lease.id, binding_digest: webDigest(lease.binding), before: before.toString('base64'), after: after.toString('base64') };
    await this.files.write('web-homebridge-private-backup.json', value, validateBackup, 48 * 1024 * 1024);
  }
  async backup(lease) {
    const value = await this.files.read('web-homebridge-private-backup.json', validateBackup, 48 * 1024 * 1024);
    requireWeb(value?.id === lease.id && value.binding_digest === webDigest(lease.binding), 'homebridge_backup_changed'); return value;
  }
  async verifySnapshot(lease) {
    const config = await this.current(lease), value = await this.backup(lease), raw = await readHomebridgeFile(config.cache);
    requireWeb([value.before, value.after].some(encoded => raw.equals(Buffer.from(encoded, 'base64'))), 'homebridge_cache_changed');
  }
  async commitStopped(lease, { applied }) {
    await this.assertStopped(lease); const config = await this.current(lease), value = await this.backup(lease);
    const before = Buffer.from(value.before, 'base64'), after = Buffer.from(value.after, 'base64'), current = await readHomebridgeFile(config.cache);
    if (!applied) { requireWeb(current.equals(before), 'homebridge_cache_changed'); return; }
    if (!current.equals(after)) await replaceHomebridgeCache(config.cache, before, after, () => this.assertStopped(lease));
    requireWeb((await readHomebridgeFile(config.cache)).equals(after), 'homebridge_cache_write_unverified');
  }
  async verifyGateway(lease, tx) {
    const binding = lease.binding, registration = this.registrations.get(binding.gateway);
    requireWeb(registration?.identity === binding.identity, 'homebridge_gateway_identity_changed');
    const client = this.gatewayFactory(registration); await client.verify();
    const expected = { ...tx.intent.expected };
    if (!tx.write_attempted || tx.definite_rejection) { expected.revision--; expected.user_revision--; }
    const users = await client.request('/alarmsystems/users'), actual = users[binding.user];
    requireWeb(actual && Object.keys(expected).every(key => same(actual[key], expected[key])), 'homebridge_gateway_revision_changed');
    for (const alarm of binding.alarms) {
      await client.verify(alarm); const grants = await client.request('/alarmsystems/' + alarm + '/users');
      requireWeb(homebridgeEligibleUser(grants[binding.user]), 'homebridge_user_must_remain_unrestricted');
    }
  }
  // Only used for an interrupted stop before any gateway write. It does not
  // create a backup, edit a cache, or claim to recover a previously changed PIN.
  async noWriteState(lease, tx) {
    requireWeb(tx.write_attempted === false, 'homebridge_gateway_write_unverified');
    const config = await this.current(lease);
    await this.verifyGateway(lease, tx);
    const rows = json(await readHomebridgeFile(config.cache));
    for (const accessory of Object.values(lease.host.mapping)) homebridgeAlarmContext(rows, lease.binding.identity, accessory);
    const state = await this.client.waitFor(async row => {
      if (row.status === 'ok' && !row.manuallyStopped) return row.pid !== process.pid && await this.stamp(row.pid) !== null;
      return row.status === 'down' && row.manuallyStopped &&
        (row.pid === null || await this.stamp(row.pid) === null) && await this.stamp(lease.host.pid) !== lease.host.stamp;
    });
    return state.status === 'ok' ? 'running' : 'stopped';
  }
  async verifyNoWriteRunning(lease, tx) {
    requireWeb(tx.write_attempted === false, 'homebridge_gateway_write_unverified');
    const config = await this.current(lease);
    const state = await this.client.waitFor(async row => row.status === 'ok' && !row.manuallyStopped &&
      row.pid !== process.pid && await this.stamp(row.pid) !== null);
    const stamp = await this.stamp(state.pid);
    const rows = await this.runningInventory(config, lease, state);
    await this.verifyGateway(lease, tx);
    const after = await this.client.status();
    requireWeb(after.status === 'ok' && !after.manuallyStopped && after.pid === state.pid && await this.stamp(after.pid) === stamp, 'homebridge_process_changed');
  }
  async start(lease) { await this.current(lease); await this.client.command('start', lease.id, true); }
  async verifyRunning(lease, tx) {
    const config = await this.current(lease);
    const state = await this.client.waitFor(async row => row.status === 'ok' && !row.manuallyStopped &&
      row.pid !== lease.host.pid && await this.stamp(row.pid) !== null);
    const rows = await this.runningInventory(config, lease, state);
    const value = await this.backup(lease), expected = json(Buffer.from(tx.write_attempted && !tx.definite_rejection ? value.after : value.before, 'base64'));
    for (const accessory of Object.values(lease.host.mapping)) {
      requireWeb(homebridgeAlarmContext(rows, lease.binding.identity, accessory).pin === homebridgeAlarmContext(expected, lease.binding.identity, accessory).pin, 'homebridge_saved_pin_unverified');
    }
    requireWeb((await this.client.status()).pid === state.pid, 'homebridge_process_changed');
    await this.verifyGateway(lease, tx);
  }
}
