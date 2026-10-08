// Standalone browser administration API.
import { requireWeb } from './web-admin-common.js';
const routes = new Map([
  ['POST /api/setup/finish', 'setup_finish'], ['GET /api/debug', 'debug_status'], ['POST /api/debug/control', 'debug_control'],
  ['GET /api/administration', 'administration'], ['GET /api/activity-options', 'activity_options'],
  ['POST /api/history/query', 'history_query'], ['POST /api/history/clear', 'history_clear'], ['POST /api/history/retention', 'history_retention'],
  ['POST /api/setup/probe', 'setup_probe'], ['POST /api/setup/connect', 'setup_connect'], ['GET /api/setup/local-gateways', 'setup_local_gateways'],
  ['POST /api/recovery/credential', 'verify_credential'], ['POST /api/setup/gateway', 'setup_gateway'], ['POST /api/setup/application', 'setup_application'],
  ['GET /api/editor', 'editor'], ['POST /api/discover', 'discover'], ['GET /api/setup', 'setup'], ['GET /api/gateways', 'gateways'],
  ['GET /api/inventory', 'inventory'], ['GET /api/overview', 'overview'], ['GET /api/alarm', 'alarm'], ['GET /api/lockout', 'lockout'], ['GET /api/history', 'history'],
  ['POST /api/users/save', 'save_user'], ['POST /api/users/delete', 'delete_user'], ['POST /api/users/rotate-pin', 'rotate_pin'],
  ['POST /api/alarm/save', 'save_alarm'], ['POST /api/lockout/save', 'save_lockout'], ['POST /api/lockout/reset', 'reset_lockout'],
  ['GET /api/keypad', 'keypad_status'], ['POST /api/keypad/send', 'keypad_send'], ['GET /api/transaction', 'transaction_status'],
  ['POST /api/recovery/review', 'review_recovery'], ['POST /api/recovery/confirm', 'recover_transaction'], ['GET /api/settings', 'installation_settings'],
  ['POST /api/homebridge/authorize-recovery', 'homebridge_authorize_recovery'],
]);
const global = new Set(['gateways', 'setup', 'setup_gateway', 'setup_application', 'setup_local_gateways', 'setup_probe', 'setup_connect', 'activity_options', 'history_query', 'history_clear', 'history_retention', 'installation_settings']);
export function webAdminRoute(request, body) {
  let operation = routes.get(request.method + ' ' + request.url);
  requireWeb(!!operation, 'route_not_found');
  const gateway = request.headers['x-configurator-gateway'], alarm = request.headers['x-configurator-alarm'];
  for (const name of ['x-configurator-gateway', 'x-configurator-alarm']) requireWeb(request.rawHeaders.filter((key, i) => i % 2 === 0 && key.toLowerCase() === name).length <= 1, 'invalid_gateway_request');
  requireWeb(alarm === undefined || gateway !== undefined, 'invalid_gateway_request');
  if (gateway !== undefined && !global.has(operation)) {
    requireWeb(typeof gateway === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(gateway), 'invalid_gateway_request');
    requireWeb(alarm === undefined || typeof alarm === 'string' && /^[0-9]{1,3}$/.test(alarm), 'invalid_alarm');
    body = { gateway, alarm: alarm === undefined ? null : Number(alarm), operation, body }; operation = 'gateway_request';
  }
  return { operation, body };
}
