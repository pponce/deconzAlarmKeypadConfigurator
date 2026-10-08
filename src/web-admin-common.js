import { WebAdminError } from './web-admin-auth.js';

export const requireWeb = (condition, code = 'request_rejected') => {
  if (!condition) throw new WebAdminError(code);
};
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const exact = (value, fields) => object(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
export const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

// Match the reference's duplicate-field rejection before native JSON parsing.
// Depth is bounded so malformed gateway responses cannot exhaust the call stack.
export function parseWebJson(raw) {
  requireWeb(typeof raw === 'string', 'invalid_json');
  let at = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(raw[at] ?? '\0')) at++; };
  const string = () => {
    const start = at++;
    while (at < raw.length) {
      const char = raw[at++];
      if (char === '\\') { at++; continue; }
      if (char === '"') {
        try { return JSON.parse(raw.slice(start, at)); } catch { break; }
      }
    }
    throw new WebAdminError('invalid_json');
  };
  const value = depth => {
    requireWeb(depth <= 64, 'json_too_deep'); whitespace();
    const char = raw[at];
    if (char === '"') { string(); return; }
    if (char === '{' || char === '[') {
      at++; whitespace(); const end = char === '{' ? '}' : ']'; const keys = new Set();
      if (raw[at] === end) { at++; return; }
      while (true) {
        if (char === '{') {
          requireWeb(raw[at] === '"', 'invalid_json'); const key = string();
          requireWeb(!keys.has(key), 'duplicate_fields'); keys.add(key); whitespace();
          requireWeb(raw[at++] === ':', 'invalid_json');
        }
        value(depth + 1); whitespace();
        if (raw[at] === end) { at++; return; }
        requireWeb(raw[at++] === ',', 'invalid_json'); whitespace();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(at))?.[0];
    requireWeb(!!token, 'invalid_json');
    if (/^-?[0-9]/.test(token)) requireWeb(Number.isFinite(Number(token)), 'invalid_number');
    at += token.length;
  };
  value(0); whitespace(); requireWeb(at === raw.length, 'invalid_json');
  try { return JSON.parse(raw); } catch { throw new WebAdminError('invalid_json'); }
}
