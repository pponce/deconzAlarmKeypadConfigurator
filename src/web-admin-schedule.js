// Same editor policy as the standalone administrator. Temporal handles real
// timezone transitions; nonexistent/ambiguous wall times require user correction.
import { Temporal } from '@js-temporal/polyfill';
import { WebAdminError } from './web-admin-auth.js';
import { requireWeb, exact, integer } from './web-admin-common.js';

const aliases = new Set('CET CST6CDT Cuba EET EST EST5EDT Egypt Eire Factory GB GB-Eire GMT GMT+0 GMT-0 GMT0 Greenwich HST Hongkong Iceland Iran Israel Jamaica Japan Kwajalein Libya MET MST MST7MDT NZ NZ-CHAT Navajo PRC PST8PDT Poland Portugal ROC ROK Singapore Turkey UCT UTC Universal W-SU WET Zulu'.split(' '));
export function webSchedulePolicy(value) {
  if (value === null) return null;
  requireWeb(exact(value, ['timezone', 'weekly', 'expires_local', 'not_before']) && ['timezone', 'weekly', 'expires_local'].every(key => typeof value[key] === 'string') &&
    value.timezone.length <= 128 && value.weekly.length <= 4096, 'invalid_schedule');
  const zone = value.timezone;
  requireWeb(/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(zone) && (zone.includes('/') || aliases.has(zone)), 'invalid_timezone');
  try { Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone); } catch { throw new WebAdminError('invalid_timezone'); }
  const windows = [];
  for (const raw of value.weekly.split(/[\n\r\v\f\x85\u2028\u2029]/)) {
    const line = raw.trim(); if (!line) continue;
    const match = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([0-2][0-9]):([0-5][0-9])-([0-2][0-9]):([0-5][0-9])$/.exec(line);
    requireWeb(!!match, 'invalid_weekly_window');
    const start = Number(match[2]) * 60 + Number(match[3]), end = Number(match[4]) * 60 + Number(match[5]);
    requireWeb(start >= 0 && start < end && end <= 1440 && start <= 1439, 'invalid_weekly_window');
    windows.push({ day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(match[1]) + 1, start, end });
  }
  requireWeb(windows.length <= 28, 'too_many_weekly_windows');
  let expires = null;
  if (value.expires_local) {
    requireWeb(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value.expires_local), 'invalid_expiry');
    let local; try { local = Temporal.PlainDateTime.from(value.expires_local, { overflow: 'reject' }); } catch { throw new WebAdminError('invalid_expiry'); }
    const candidates = new Set();
    for (const disambiguation of ['earlier', 'later']) {
      const zoned = local.toZonedDateTime(zone, { disambiguation });
      if (zoned.toPlainDateTime().equals(local)) candidates.add(zoned.epochMilliseconds);
    }
    requireWeb(candidates.size > 0, 'nonexistent_expiry'); requireWeb(candidates.size === 1, 'ambiguous_expiry_choose_utc'); expires = [...candidates][0];
  }
  const start = value.not_before;
  requireWeb(start === null || integer(start, 1577836800000, 4102444800000), 'invalid_not_before');
  requireWeb(expires === null || integer(expires, 1577836800000, 4102444800000), 'invalid_expiry');
  requireWeb(start === null || expires === null || start < expires, 'invalid_expiry');
  return { timezone: zone, not_before: start, expires_at: expires, windows };
}
