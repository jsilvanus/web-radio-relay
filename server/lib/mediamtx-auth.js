// Publish and read decisions for MediaMTX (authMethod: http) and nginx-rtmp
// on_publish. Pure: no I/O, no clock reads (nowMs is passed in), the token
// lookup is injected. Reason strings never contain a token.

import { tokensEqual } from './auth.js';
import { isUsable, scopeAllows } from './tokens.js';

// The name group is lazy so that "-cc" is captured as the suffix instead of
// being swallowed into the name. Same language as ^live/([a-z0-9_-]{1,32})(-cc)?$.
const PATH_RE = /^live\/([a-z0-9_-]{1,32}?)(-cc)?$/;

/** Parses "a.b.c.d/n" into { base, mask } as unsigned 32-bit numbers, or null. */
export function parseCidr(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (octets.some((o) => o > 255) || bits > 32) return null;
  const addr = octets.reduce((acc, o) => ((acc << 8) | o) >>> 0, 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (addr & mask) >>> 0, mask };
}

/**
 * True when the IPv4 address `ip` is inside `cidr`. IPv4-mapped IPv6 addresses
 * (`::ffff:10.1.2.3`) count as their IPv4 form. Anything else (a real IPv6
 * address, a malformed address or CIDR) is false.
 */
export function ipInCidr(ip, cidr) {
  const net = parseCidr(cidr);
  if (!net || typeof ip !== 'string') return false;
  const v4 = ip.trim().replace(/^::ffff:/i, '');
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!m) return false;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const addr = octets.reduce((acc, o) => ((acc << 8) | o) >>> 0, 0);
  return ((addr & net.mask) >>> 0) === net.base;
}

/** The token from the query string (`token=`), else the password field. */
function presentedToken(query, password) {
  const fromQuery = new URLSearchParams(query || '').get('token');
  if (fromQuery) return fromQuery;
  return typeof password === 'string' && password.length > 0 ? password : '';
}

/**
 * Decides one MediaMTX (or nginx-rtmp) request.
 *
 * @param {{ action: string, path: string, query?: string, user?: string,
 *           password?: string, ip?: string, protocol?: string }} req
 * @param {{ lookupToken: (token: string) => object | null,
 *           internalSecret?: string, internalCidrs?: string[], nowMs: number }} deps
 * @returns {{ allow: boolean, reason: string }}
 */
export function decide(req, { lookupToken, internalSecret = '', internalCidrs = [], nowMs }) {
  const { action, path, query = '', password, ip } = req || {};
  const match = PATH_RE.exec(typeof path === 'string' ? path : '');
  if (!match) return { allow: false, reason: 'path is not live/<name>' };
  const name = match[1];
  const captioner = match[2] === '-cc';

  if (action === 'publish') {
    if (captioner) {
      const given = new URLSearchParams(query || '').get('secret') || '';
      if (!internalSecret) return { allow: false, reason: 'captioner path: internal secret not configured' };
      if (!given || !tokensEqual(given, internalSecret)) {
        return { allow: false, reason: 'captioner path needs the internal secret' };
      }
      return { allow: true, reason: 'captioner publish' };
    }
    const token = presentedToken(query, password);
    if (!token) return { allow: false, reason: 'publish needs a token' };
    const row = lookupToken(token);
    if (!row) return { allow: false, reason: 'unknown token' };
    if (!isUsable(row, nowMs)) return { allow: false, reason: 'token is revoked or expired' };
    if (!scopeAllows(row.scopes, `stream:${name}:publish`)) {
      return { allow: false, reason: `token lacks stream:${name}:publish` };
    }
    return { allow: true, reason: 'publish allowed' };
  }

  if (action === 'read' || action === 'playback') {
    if (typeof ip === 'string' && internalCidrs.some((cidr) => ipInCidr(ip, cidr))) {
      return { allow: true, reason: 'read from internal network' };
    }
    const token = presentedToken(query, password);
    if (!token) return { allow: false, reason: 'read needs an internal address or a view token' };
    const row = lookupToken(token);
    if (!row) return { allow: false, reason: 'unknown token' };
    if (!isUsable(row, nowMs)) return { allow: false, reason: 'token is revoked or expired' };
    if (!scopeAllows(row.scopes, `stream:${name}:view`)) {
      return { allow: false, reason: `token lacks stream:${name}:view` };
    }
    return { allow: true, reason: 'read with view token' };
  }

  return { allow: false, reason: `action ${String(action)} is not allowed` };
}
