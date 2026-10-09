// Non-controller administration dispatch. Explicit ports are required for
// durable setup/history/transactions; absent operations never report success.
import { WebAdminError } from './web-admin-auth.js';
import { WebAdminGateway, validateWebGateways } from './web-admin-gateway.js';
import { WebAdminView } from './web-admin-view.js';
import { WebAdminActivity } from './web-admin-activity.js';
import { WebAdminEditor, webWriteOperations, webRecoveryOperations } from './web-admin-editor.js';
import { WebAdminKeypad } from './web-admin-keypad.js';
import { WebAdminDebugCapture } from './web-admin-events.js';
import { requireWeb, object, exact, integer } from './web-admin-common.js';

const regularReads = new Set(['inventory', 'administration', 'lockout', 'transaction_status']);
const regularWrites = new Set(['save_user', 'delete_user', 'rotate_pin', 'reset_lockout']);
const readonly = new Set(['inventory', 'discover', 'overview', 'alarm', 'lockout', 'administration', 'editor']);
const privateAttention = /homebridge|extension|maintenance|recovery|participant|host_helper/;
function limitedTransaction(value) {
  const pending = !['none', 'complete'].includes(value.stage);
  return { stage: pending ? 'held' : 'none', pending, administrator_required: pending };
}

export class WebAdminBackend {
  constructor({ registrations = [], accessMode = 'observe', setup, transactions, history, backup, integration, keypadHook, assertCurrent = async () => {}, requestDiscovery = () => {}, connected = new Map(), hiddenUsers = async () => [], gatewayFactory = (row, options) => new WebAdminGateway(row, options) }) {
    this.registrations = new Map(validateWebGateways(registrations).map(row => [row.id, row]));
    requireWeb(['observe', 'manage'].includes(accessMode), 'candidate_read_only_required');
    Object.assign(this, { accessMode, setup, transactions, history, backup, integration, keypadHook, assertCurrent, requestDiscovery, hiddenUsers, gatewayFactory });
    // Only the activity collector may set connection state. A successful REST
    // read does not establish that the live event stream is connected.
    this.connected = connected; this.catalog = new Map(); this.pending = Promise.resolve();
    this.activity = new WebAdminActivity({ registrations: this.registrations, catalog: this.catalog, connected, history });
    this.debugCaptures = new Map();
  }
  dispatch(session, operation, body) {
    const principal = structuredClone(session), payload = structuredClone(body);
    const result = this.pending.then(async () => {
      if (!['setup', 'installation_settings', 'setup_gateway', 'setup_application'].includes(operation)) await this.assertCurrent();
      return this.execute(principal, operation, payload);
    });
    this.pending = result.catch(() => {}); return result;
  }
  unavailable() { throw new WebAdminError('operation_not_implemented'); }
  async execute(session, operation, body) {
    requireWeb(session && ['admin', 'regular'].includes(session.role), 'forbidden');
    requireWeb(typeof operation === 'string' && object(body), 'invalid_request');
    const regular = session.role === 'regular';
    if (operation === 'gateways') {
      requireWeb(exact(body, []), 'invalid_request');
      return { gateways: [...this.registrations].map(([id, row]) => ({ id, name: row.name, connected: this.connected.get(id) === true })) };
    }
    if (operation === 'setup') {
      requireWeb(exact(body, []), 'invalid_request');
      if (regular) return { access_mode: this.accessMode, extensions: [], onboarding_required: false };
      if (!this.setup?.public) return this.unavailable();
      return { ...await this.setup.public(), access_mode: this.accessMode, extensions: [], gateway_count: this.registrations.size };
    }
    if (operation === 'installation_settings') {
      requireWeb(!regular, 'forbidden'); requireWeb(exact(body, []), 'invalid_request');
      const result = await this.execute(session, 'setup', {});
      return { ...result, homebridge_details: null };
    }
    if (operation === 'setup_gateway') {
      requireWeb(!regular && this.accessMode === 'manage', 'forbidden');
      if (!this.setup?.gateway) return this.unavailable();
      return this.setup.gateway(body);
    }
    if (operation === 'setup_application') {
      requireWeb(!regular, 'forbidden'); requireWeb(this.accessMode === 'manage', 'candidate_read_only_required');
      if (!this.setup?.application) return this.unavailable();
      return this.setup.application(body);
    }
    if (operation === 'activity_options') {
      requireWeb(exact(body, []), 'invalid_request');
      // The shared header polls this endpoint for both roles. Regular accounts
      // receive only their already-visible gateway status, not history metadata.
      if (regular) return this.execute(session, 'gateways', {});
      return this.activity.options();
    }
    if (operation === 'history_query') { requireWeb(!regular, 'forbidden'); return this.activity.query(body); }
    if (operation === 'history_clear' || operation === 'history_retention') {
      requireWeb(!regular, 'forbidden'); requireWeb(this.accessMode === 'manage', 'candidate_read_only_required');
      return operation === 'history_clear' ? this.activity.clear(body) : this.activity.retention(body);
    }
    if (operation !== 'gateway_request') { requireWeb(!regular, 'forbidden'); return this.unavailable(); }
    requireWeb(exact(body, ['gateway', 'alarm', 'operation', 'body']) && object(body.body), 'invalid_request');
    const { gateway, alarm, operation: action, body: payload } = body;
    requireWeb(typeof gateway === 'string' && this.registrations.has(gateway), 'gateway_not_registered');
    requireWeb(alarm === null || integer(alarm, 1, 255), 'invalid_alarm');
    requireWeb(typeof action === 'string' && (!regular || regularReads.has(action) || regularWrites.has(action)), 'forbidden');
    try {
      if (action === 'homebridge_authorize_recovery') {
        requireWeb(!regular && this.accessMode === 'manage', 'forbidden');
        requireWeb(exact(payload, ['transaction_id', 'credentials']) && integer(alarm, 1, 255), 'invalid_request');
        requireWeb(typeof this.integration?.authorizeRecovery === 'function', 'homebridge_not_configured');
        const tx = await this.transactions.load(gateway);
        requireWeb(tx && tx.id === payload.transaction_id && tx.alarm === alarm && tx.participants.homebridge === 1 && tx.stage !== 'complete', 'no_matching_transaction');
        return this.integration.authorizeRecovery(tx, payload.credentials);
      }
      if (action === 'debug_status' || action === 'debug_control') {
        requireWeb(!regular, 'forbidden'); requireWeb(integer(alarm, 1, 255), 'explicit_alarm_required');
        const key = gateway + ':' + alarm;
        if (!this.debugCaptures.has(key)) this.debugCaptures.set(key, new WebAdminDebugCapture());
        const capture = this.debugCaptures.get(key);
        if (action === 'debug_control') return capture.command(payload);
        requireWeb(exact(payload, []), 'invalid_request'); return capture.status();
      }
      if (action === 'transaction_status' || action === 'history') {
        requireWeb(integer(alarm, 1, 255), 'explicit_alarm_required'); requireWeb(exact(payload, []), 'invalid_request');
        if (action === 'transaction_status') {
          if (!this.transactions?.status) return this.unavailable();
          const value = await this.transactions.status(gateway);
          if (!regular && value.homebridge && this.integration?.logStatus) value.homebridge_logs = await this.integration.logStatus(value.id);
          if (!regular && value.homebridge && this.integration?.method) value.homebridge_method = await this.integration.method(value.id);
          return regular ? limitedTransaction(value) : value;
        }
        if (!this.history?.rows) return this.unavailable();
        return { rows: await this.history.rows(gateway, alarm, 200), connected: this.connected.get(gateway) === true };
      }
      if (action === 'keypad_status' || action === 'keypad_send') {
        requireWeb(integer(alarm, 1, 255), 'explicit_alarm_required');
        if (typeof this.keypadHook !== 'function' || typeof this.transactions?.execute !== 'function' || typeof this.history?.reserveRequest !== 'function') return this.unavailable();
        const registration = this.registrations.get(gateway), client = this.gatewayFactory(registration, { writable: action === 'keypad_send' });
        const keypad = new WebAdminKeypad({ gateway, identity: registration.identity, alarm, client, accessMode: this.accessMode,
          transactions: this.transactions, history: this.history, begin: started => this.keypadHook(registration, alarm, started) });
        return action === 'keypad_status' ? keypad.status(payload) : keypad.send(payload);
      }
      const edit = webWriteOperations.has(action), recovery = webRecoveryOperations.has(action);
      if (!readonly.has(action) && !edit && !recovery) return this.unavailable();
      if (edit || recovery) {
        if (typeof this.transactions?.execute !== 'function' || edit && (!this.backup || typeof this.history?.add !== 'function')) return this.unavailable();
        requireWeb(this.accessMode === 'manage', 'candidate_read_only_required');
      } else requireWeb(exact(payload, []), 'invalid_request');
      if (!['inventory', 'discover'].includes(action)) requireWeb(integer(alarm, 1, 255), 'explicit_alarm_required');
      const registration = this.registrations.get(gateway), client = this.gatewayFactory(registration, { writable: edit });
      await client.verify(alarm);
      const view = new WebAdminView({ gatewayId: gateway, name: registration.name, alarm, client,
        onInventory: result => { this.catalog.set(gateway, result); },
        homebridgeStatus: this.integration?.viewStatus ? () => this.integration.viewStatus() : undefined,
        transactionStatus: this.transactions?.status ? id => this.transactions.status(id) : undefined });
      if (edit || recovery) {
        const authorize = regular ? async (operation, body, snapshot) => {
          requireWeb(regularWrites.has(operation), 'forbidden'); if (operation === 'reset_lockout') return;
          requireWeb(!Object.hasOwn(body, 'homebridge_selection') && !body.enable_management && !body.owner, 'forbidden');
          const uid = body.id ?? null; requireWeb(uid === null || typeof uid === 'string', 'invalid_user');
          const hidden = new Set(await this.hiddenUsers(gateway));
          const owners = new Set(Object.values(snapshot.grants).flatMap(grants => Object.values(grants).filter(row => row.owner).map(row => row.id)));
          requireWeb(!hidden.has(uid) && !owners.has(uid), 'protected_identity');
        } : undefined;
        const editor = new WebAdminEditor({ view, identity: registration.identity, transactions: this.transactions, backup: this.backup, history: this.history,
          authorize, integration: this.integration, requestDiscovery: this.requestDiscovery, actor: session.username ? 'Web account · ' + session.username : 'Administrator' });
        let result;
        const homebridgePin = action === 'rotate_pin' && this.integration?.applies && await this.integration.applies({ operation: action, gateway, identity_id: payload.id, homebridge_selection: payload.homebridge_selection });
        if (homebridgePin) {
          requireWeb(!regular && typeof this.integration.withRequest === 'function', 'forbidden');
          const { homebridge_confirmed, homebridge_login, homebridge_clear_logs = false, ...request } = payload;
          result = await this.integration.withRequest({ pin: payload.new_pin, confirmed: homebridge_confirmed, credentials: homebridge_login, clearLogs: homebridge_clear_logs }, () => editor.dispatch(action, request));
        } else {
          try {
            result = await editor.dispatch(action, payload);
            if (action === 'recover_transaction') {
              const tx = await this.transactions.load(gateway);
              await this.integration?.afterTransaction?.({ ...result, saved: tx.write_attempted && !tx.definite_rejection });
            }
          }
          finally { if (action === 'recover_transaction') await this.integration?.host?.clearAuthentication?.(); }
        }
        return regular ? { saved: result.saved === true } : result;
      }
      if (action === 'inventory' || action === 'discover') return view.inventory();
      if (action === 'editor') return view.snapshot();
      if (action === 'overview') return { alarm: await view.alarm(), users: await view.users(), capabilities: { managed: (await client.verify(alarm)).managed === true } };
      const value = await view[action]();
      if (regular && action === 'administration') {
        const hidden = new Set(await this.hiddenUsers(gateway));
        const protectedIds = new Set(value.alarms.flatMap(alarm => alarm.users.filter(row => row.owner).map(row => row.id)));
        const users = rows => rows.filter(row => !hidden.has(row.id)).map(row => ({ ...row, read_only: protectedIds.has(row.id) }));
        return { identities: users(value.identities), users: users(value.users), keypads: value.keypads,
          alarms: value.alarms.map(alarm => ({ ...alarm, users: users(alarm.users) })), managed: value.managed,
          schedules: value.schedules, transaction: limitedTransaction(value.transaction), pin_rotation_available: this.accessMode === 'manage' && !!this.backup && typeof this.transactions?.execute === 'function' && typeof this.history?.add === 'function' };
      }
      return value;
    } catch (error) {
      if (regular && error instanceof WebAdminError && privateAttention.test(error.message)) throw new WebAdminError('administrator_attention_required');
      throw error;
    }
  }
}
