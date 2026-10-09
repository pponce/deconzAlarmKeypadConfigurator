// New updates use the maintainer's dynamic Configuration API and `ui discover`.
// The inherited offline adapter exists only to finish already-saved old leases.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { WebHomebridgeHost, readHomebridgeFile } from './web-admin-homebridge-host.js';
import { WebAdminError } from './web-admin-auth.js';
import { webDigest } from './web-admin-files.js';
import { requireWeb, object, integer, parseWebJson } from './web-admin-common.js';
import { validateAlarmBinding } from './web-admin-homebridge-maintenance.js';

const execute = promisify(execFile);
const validPin = value => typeof value === 'string' && /^[0-9]{4,16}$/.test(value);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const secretFile = 'web-homebridge-api-update.json';
function validateSecret(value) {
  requireWeb(object(value) && value.schema === 1 && /^[0-9a-f]{32}$/.test(value.id) &&
    /^[0-9a-f]{64}$/.test(value.binding_digest) && object(value.before) && validPin(value.after) &&
    Object.keys(value.before).length > 0 && Object.keys(value.before).length <= 255 &&
    Object.entries(value.before).every(([id, pin]) => validId(id) && validPin(pin)) &&
    Array.isArray(value.requested) && value.requested.every(id => Object.hasOwn(value.before, id)) &&
    new Set(value.requested).size === value.requested.length, 'homebridge_backup_invalid');
  return value;
}
export class WebHomebridgeApiHost extends WebHomebridgeHost {
  constructor(options) { super(options); this.runDiscovery = options.runDiscovery ?? execute; }
  async cli() {
    try {
      const root = await realpath(await this.pluginRoot());
      const pkg = parseWebJson((await readHomebridgeFile(path.join(root, 'package.json'), 1048576, { allowServiceGroupWrite: true })).toString('utf8'));
      requireWeb(pkg.name === 'homebridge-deconz' && typeof pkg.bin?.ui === 'string' && !path.isAbsolute(pkg.bin.ui), 'homebridge_cli_unavailable');
      const script = await realpath(path.resolve(root, pkg.bin.ui));
      requireWeb(script.startsWith(root + path.sep), 'homebridge_cli_unavailable');
      await readHomebridgeFile(script, 1048576, { allowServiceGroupWrite: true });
      return script;
    } catch { throw new WebAdminError('homebridge_cli_unavailable'); }
  }
  async readiness() {
    try { await this.configuration(); await this.cli(); return { configured: true, error: null }; }
    catch (error) {
      const allowed = new Set(['homebridge_local_linux_required', 'one_homebridge_child_bridge_required', 'homebridge_child_identity_invalid',
        'homebridge_plugin_disabled', 'homebridge_local_http_ui_required', 'homebridge_file_unavailable', 'homebridge_cli_unavailable']);
      return { configured: false, error: allowed.has(error.message) ? error.message : 'homebridge_configuration_unavailable' };
    }
  }
  async authenticate(credentials) {
    const config = await this.configuration(); this.client?.close();
    this.client = this.clientFactory({ origin: config.origin, bridge: config.bridge });
    await this.client.login(credentials);
  }
  async current(lease) {
    if (lease.host.mode !== 'api') return super.current(lease);
    const config = await this.configuration();
    requireWeb(config.digest === lease.host.configuration && config.bridge === lease.host.bridge, 'homebridge_configuration_changed');
    requireWeb(this.client?.bridge === config.bridge, 'homebridge_login_required'); return config;
  }
  async discover(config, identity) {
    let rows;
    try {
      const result = await this.runDiscovery(process.execPath, [await this.cli(), '-U', config.bridge, '-G', identity, 'discover'], {
        env: { ...process.env, HOMEBRIDGE_DIR: config.root }, timeout: 15000, maxBuffer: 1048576, windowsHide: true,
      });
      rows = parseWebJson(result.stdout);
    } catch { throw new WebAdminError('homebridge_cli_discovery_failed'); }
    requireWeb(Array.isArray(rows) && rows.length === 1 && rows[0].username?.toUpperCase() === config.bridge &&
      rows[0].gid === identity && rows[0].childBridge === true && integer(rows[0].uiPort, 1024, 65535), 'homebridge_gateway_identity_changed');
    return rows[0].uiPort;
  }
  async api(port, identity, resource, body) {
    let reply;
    try { reply = await this.exchange({ timeoutMs: 8000, url: 'http://127.0.0.1:' + port + '/gateways/' + identity + resource,
      method: body === undefined ? 'GET' : 'PUT', ...(body === undefined ? {} : { body }) }); }
    catch { throw new WebAdminError('homebridge_alarm_api_unavailable'); }
    requireWeb(![502, 503, 504].includes(reply[0]), 'homebridge_alarm_api_unavailable');
    requireWeb(reply[0] === 200 && object(reply[1]), 'homebridge_alarm_api_response_invalid'); return reply[1];
  }
  apiMapping(binding, inventory) {
    const mapping = {};
    for (const alarm of binding.alarms) {
      const matches = Object.entries(inventory).filter(([, row]) => row?.type === 'alarmsystems' && same(row.resources, ['/alarmsystems/' + alarm]));
      requireWeb(matches.length === 1 && validId(matches[0][0]), 'homebridge_alarm_mapping_changed'); mapping[alarm] = matches[0][0];
    }
    requireWeb(new Set(Object.values(mapping)).size === binding.alarms.length, 'homebridge_alarm_mapping_changed'); return mapping;
  }
  async pins(port, binding, mapping) {
    const inventory = await this.api(port, binding.identity, '/accessories');
    requireWeb(same(this.apiMapping(binding, inventory), mapping), 'homebridge_alarm_mapping_changed');
    const pins = {};
    for (const [alarm, id] of Object.entries(mapping)) {
      const row = await this.api(port, binding.identity, '/accessories/' + id);
      requireWeb(row.id === id && row.type === 'alarmsystems' && same(row.resources, ['/alarmsystems/' + alarm]) && validPin(row.settings?.pin),
        'homebridge_alarm_api_response_invalid'); pins[id] = row.settings.pin;
    }
    return pins;
  }
  async running(lease) {
    const config = await this.current(lease);
    const state = await this.client.waitFor(async row => row.status === 'ok' && !row.manuallyStopped && row.pid !== process.pid &&
      await this.stamp(row.pid) !== null);
    const stamp = await this.stamp(state.pid), port = await this.discover(config, lease.binding.identity);
    return { config, state, stamp, port };
  }
  async unchanged(context) {
    const state = await this.client.status();
    requireWeb(state.status === 'ok' && !state.manuallyStopped && state.pid === context.state.pid &&
      await this.stamp(state.pid) === context.stamp, 'homebridge_process_changed');
  }
  async prepare(binding) {
    validateAlarmBinding(binding); const config = await this.configuration();
    requireWeb(this.client?.bridge === config.bridge && this.registrations.get(binding.gateway)?.identity === binding.identity, 'homebridge_binding_changed');
    const state = await this.client.status();
    requireWeb(state.status === 'ok' && !state.manuallyStopped && state.pid !== process.pid, 'homebridge_child_not_running');
    const stamp = await this.stamp(state.pid); requireWeb(stamp !== null, 'homebridge_process_unverified');
    const port = await this.discover(config, binding.identity);
    const mapping = this.apiMapping(binding, await this.api(port, binding.identity, '/accessories'));
    await this.pins(port, binding, mapping); await this.unchanged({ state, stamp });
    return { mode: 'api', configuration: config.digest, bridge: config.bridge, pid: state.pid, stamp, mapping };
  }
  async snapshotApi(lease, newPin) {
    requireWeb(validPin(newPin), 'invalid_pin');
    const context = await this.running(lease), before = await this.pins(context.port, lease.binding, lease.host.mapping);
    await this.unchanged(context);
    await this.files.write(secretFile, { schema: 1, id: lease.id, binding_digest: webDigest(lease.binding), before, after: newPin, requested: [] }, validateSecret);
  }
  async apiSecret(lease) {
    const value = await this.files.read(secretFile, validateSecret);
    requireWeb(value?.id === lease.id && value.binding_digest === webDigest(lease.binding) &&
      same(Object.keys(value.before).sort(), Object.values(lease.host.mapping).sort()), 'homebridge_backup_changed'); return value;
  }
  async checkApi(lease, { applied, prepared = false }) {
    const context = await this.running(lease);
    const pins = await this.pins(context.port, lease.binding, lease.host.mapping);
    if (applied) {
      const value = await this.apiSecret(lease);
      for (const [id, actual] of Object.entries(pins)) {
        // A readback of the requested value resolves a lost PUT response. Never
        // automatically replay an uncertain PUT just because a request failed.
        const expected = prepared && !value.requested.includes(id) ? value.before[id] : value.after;
        requireWeb(actual === expected || prepared && actual === value.after, 'homebridge_saved_pin_unverified');
      }
    }
    await this.unchanged(context); return context;
  }
  async applyApi(lease) {
    const value = await this.apiSecret(lease), context = await this.running(lease);
    const pins = await this.pins(context.port, lease.binding, lease.host.mapping);
    for (const id of Object.values(lease.host.mapping)) {
      if (pins[id] === value.after) continue;
      requireWeb(!value.requested.includes(id), 'homebridge_pin_write_unverified');
      requireWeb(pins[id] === value.before[id], 'homebridge_saved_pin_unverified');
      await this.unchanged(context);
      value.requested.push(id); await this.files.write(secretFile, value, validateSecret); // Intent before PUT.
      try { await this.api(context.port, lease.binding.identity, '/accessories/' + id + '/settings', { pin: value.after }); }
      catch { /* Resolve through readback, without repeating the PUT. */ }
      const actual = await this.pins(context.port, lease.binding, lease.host.mapping);
      requireWeb(actual[id] === value.after, 'homebridge_pin_write_unverified');
    }
    await this.checkApi(lease, { applied: true });
  }
  async verifyApiRunning(lease, tx) {
    const applied = tx.write_attempted && !tx.definite_rejection;
    const deadline = this.clock() + 30000;
    while (true) {
      try { await this.checkApi(lease, { applied }); break; }
      catch (error) {
        if (!['homebridge_alarm_api_unavailable', 'homebridge_cli_discovery_failed'].includes(error.message)) throw error;
        requireWeb(this.clock() < deadline, 'homebridge_alarm_api_not_ready'); await this.sleep(500);
      }
    }
    await this.verifyGateway(lease, tx);
  }
  async clearLogs() { return this.client.clearLogs(); }
}
