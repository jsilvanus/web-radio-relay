/**
 * Bearer-token auth for the control API.
 *
 * Fail closed: when no token is configured the control routes answer 503
 * instead of accepting anonymous writes. Tokens are compared through SHA-256
 * digests with timingSafeEqual so the comparison time does not leak the token.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { findTokenByValue, isUsable, scopeAllows } from './tokens.js';

/**
 * Extract the token from an Authorization header value ("Bearer <token>").
 * Returns null when the header is missing or not a Bearer credential.
 * @param {string | undefined} header
 * @returns {string | null}
 */
export function bearerToken(header) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header || '');
  return match ? match[1] : null;
}

/**
 * Constant-time equality of two strings.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function tokensEqual(a, b) {
  const digestA = createHash('sha256').update(String(a)).digest();
  const digestB = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Express middleware that requires `Authorization: Bearer <token>`.
 * @param {string} token configured RELAY_API_TOKEN ('' = not configured)
 */
export function requireBearer(token) {
  return function (req, res, next) {
    if (!token) {
      res.status(503).json({ error: 'Control API is not configured: set RELAY_API_TOKEN' });
      return;
    }
    const given = bearerToken(req.headers.authorization);
    if (!given || !tokensEqual(given, token)) {
      res.set('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}

/**
 * Express middleware factory for scoped tokens.
 *
 * `neededFn(req)` returns the scope the route needs, for example
 * `req => 'stream:' + req.params.name + ':data'`. A request is let through when
 * it carries the env admin token (RELAY_API_TOKEN, constant-time compare) or a
 * stored token that is usable and allows the scope (`admin` allows all).
 *
 * Answers: 503 when RELAY_API_TOKEN is unset and the store holds no tokens
 * (fail closed, as requireBearer); 401 when the token is missing, unknown,
 * revoked or expired; 403 when the scope is not allowed.
 *
 * @param {(req: object) => string} neededFn
 * @param {{ adminToken?: string, db?: object, nowMs?: () => number }} deps
 *   adminToken: configured RELAY_API_TOKEN ('' = not configured)
 *   db: open store database (store.js); without it only adminToken counts
 */
export function requireScope(neededFn, { adminToken = '', db = null, nowMs = () => Date.now() } = {}) {
  return function (req, res, next) {
    const storedCount = db ? db.prepare('SELECT COUNT(*) AS n FROM tokens').get().n : 0;
    if (!adminToken && storedCount === 0) {
      res.status(503).json({ error: 'Control API is not configured: set RELAY_API_TOKEN or create a token' });
      return;
    }

    const given = bearerToken(req.headers.authorization);
    if (!given) {
      res.set('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (adminToken && tokensEqual(given, adminToken)) {
      req.auth = { kind: 'env', scopes: ['admin'] };
      next();
      return;
    }

    const row = db ? findTokenByValue(db, given) : null;
    if (!isUsable(row, nowMs())) {
      res.set('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const needed = neededFn(req);
    if (!scopeAllows(row.scopes, needed)) {
      res.status(403).json({ error: `Forbidden: token lacks scope ${needed}` });
      return;
    }

    req.auth = { kind: 'token', id: row.id, scopes: row.scopes };
    next();
  };
}
