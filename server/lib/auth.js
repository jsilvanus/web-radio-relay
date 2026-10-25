/**
 * Bearer-token auth for the control API.
 *
 * Fail closed: when no token is configured the control routes answer 503
 * instead of accepting anonymous writes. Tokens are compared through SHA-256
 * digests with timingSafeEqual so the comparison time does not leak the token.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

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
