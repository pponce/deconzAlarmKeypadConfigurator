// Shared policy projections from configurator/domain.py; no gateway I/O.
import { requireWeb, object, exact, integer } from './web-admin-common.js';
import { webSchedulePolicy } from './web-admin-schedule.js';

export const userFields = ['id', 'name', 'enabled', 'user_revision', 'remaining_uses', 'revision', 'api_arm_disarm', 'grant_enabled', 'owner', 'arm', 'disarm', 'all_keypads', 'keypads'];
export const identityFields = ['id', 'name', 'enabled', 'revision', 'user_revision'];
export const grantFields = [...userFields, 'schedule'];
export const alarmModes = ['disarmed', 'armed_stay', 'armed_night', 'armed_away'];
export const alarmStates = [...alarmModes, 'exit_delay', 'entry_delay', 'not_ready', 'in_alarm', 'arming_stay', 'arming_night', 'arming_away'];
export const alarmTimingFields = alarmModes.slice(1).flatMap(mode => ['entry_delay', 'exit_delay', 'trigger_duration'].map(field => mode + '_' + field));
export const unrestricted = row => ['enabled', 'grant_enabled', 'owner', 'arm', 'disarm', 'api_arm_disarm'].every(key => row[key] === true) && row.remaining_uses === null && row.schedule == null;
export function webUserPayload(body, deleting = false) {
  requireWeb(object(body), 'invalid_user');
  const allowed = deleting ? ['id', 'alarm', 'revision', 'user_revision'] : ['id', 'alarm', 'revision', 'user_revision', 'name', 'pin', 'enabled', 'remaining_uses', 'api_arm_disarm', 'enable_management', 'schedule', 'grant_enabled', 'owner', 'arm', 'disarm', 'all_keypads', 'keypads'];
  requireWeb(Object.keys(body).every(key => allowed.includes(key)), 'unknown_field');
  const uid = body.id ?? null, alarm = body.alarm;
  requireWeb(uid === null && !deleting || typeof uid === 'string' && /^[0-9a-f]{32}$/.test(uid), 'invalid_user');
  requireWeb(integer(alarm, 1, 255), 'invalid_alarm');
  requireWeb(['revision', 'user_revision'].every(key => integer(body[key], 0, Number.MAX_SAFE_INTEGER)), 'revision_required');
  const payload = Object.fromEntries(Object.entries(body).filter(([key]) => !['id', 'alarm', 'enable_management'].includes(key)).map(([key, value]) => [key, structuredClone(value)]));
  if (!deleting) {
    requireWeb(typeof body.name === 'string' && body.name.isWellFormed() && Buffer.byteLength(body.name.trim()) > 0 && Buffer.byteLength(body.name.trim()) <= 64 && !/[\x00-\x1f\x7f]/.test(body.name), 'invalid_name');
    requireWeb(['enabled', 'api_arm_disarm', 'grant_enabled', 'owner', 'arm', 'disarm', 'all_keypads'].every(key => typeof body[key] === 'boolean'), 'invalid_user');
    requireWeb(Object.hasOwn(body, 'remaining_uses') && (body.remaining_uses === null || integer(body.remaining_uses, 0, 1000000)), 'invalid_remaining_uses');
    if (Object.hasOwn(body, 'pin')) requireWeb(typeof body.pin === 'string' && /^[0-9]{4,16}$/.test(body.pin), 'invalid_pin');
    requireWeb(Array.isArray(body.keypads) && body.keypads.length <= 256 && !(body.all_keypads && body.keypads.length), 'invalid_keypads');
    for (const pad of body.keypads) requireWeb(exact(pad, ['source', 'endpoint']) && typeof pad.source === 'string' && /^[0-9a-f]{1,16}$/.test(pad.source) && integer(pad.endpoint, 1, 240), 'invalid_keypads');
  }
  if (Object.hasOwn(payload, 'schedule')) payload.schedule = webSchedulePolicy(payload.schedule);
  return { uid, alarm, payload };
}
export function alarmTimings(value) {
  requireWeb(exact(value, alarmTimingFields) && Object.values(value).every(v => integer(v, 0, 255)), 'invalid_alarm_timings');
  return { ...value };
}
export function lockoutPolicy(value) {
  requireWeb(exact(value, ['enabled', 'threshold', 'window_seconds', 'durations_seconds', 'reset_seconds', 'revision']) && typeof value.enabled === 'boolean', 'invalid_lockout_policy');
  for (const [key, low, high] of [['threshold', 1, 100], ['window_seconds', 1, 3600], ['reset_seconds', 3600, 604800], ['revision', 0, Number.MAX_SAFE_INTEGER]]) requireWeb(integer(value[key], low, high), 'invalid_lockout_policy');
  requireWeb(Array.isArray(value.durations_seconds) && value.durations_seconds.length === 3 && value.durations_seconds.every((duration, i, rows) => integer(duration, 1, 3600) && (i === 0 || duration >= rows[i - 1])), 'invalid_lockout_policy');
  return structuredClone(value);
}
