// Scoped API tokens. Only the SHA-256 hash of a token is stored; the value is
// returned once, when it is created. Pure helpers take nowMs; the DB helpers
// take the open `db` from store.js.
import { createHash, randomBytes } from 'node:crypto';

export const SCOPE_ADMIN = 'admin';
const STREAM_SCOPE = /^stream:([a-z0-9_-]{1,32}):(publish|data|control|view)$/;

/** sha256 hex of a token value. */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** A new random token value: 32 bytes as hex (64 characters). */
export function newToken() {
  return randomBytes(32).toString('hex');
}

/** A new token id, e.g. `tok_3f9a0c2b7d11`. */
export function newTokenId() {
  return `tok_${randomBytes(6).toString('hex')}`;
}

/** True for `admin` and `stream:<name>:(publish|data|control|view)`. */
export function isValidScope(scope) {
  if (typeof scope !== 'string') return false;
  return scope === SCOPE_ADMIN || STREAM_SCOPE.test(scope);
}

/** `admin` allows everything; otherwise the needed scope must be listed exactly. */
export function scopeAllows(scopes, needed) {
  if (!Array.isArray(scopes)) return false;
  if (scopes.includes(SCOPE_ADMIN)) return true;
  return scopes.includes(needed);
}

/**
 * A token row (camelCase, as findTokenByValue returns it) is usable when it is
 * neither revoked nor expired. A null expiresAt never expires.
 */
export function isUsable(row, nowMs) {
  if (!row) return false;
  if (row.revokedAt != null) return false;
  if (row.expiresAt != null && nowMs >= row.expiresAt) return false;
  return true;
}

function toRow(r) {
  return {
    id: r.id,
    label: r.label ?? null,
    scopes: JSON.parse(r.scopes_json),
    createdAt: r.created_at,
    expiresAt: r.expires_at ?? null,
    revokedAt: r.revoked_at ?? null,
  };
}

/**
 * Issues a token. Returns { id, token, scopes, expiresAt, label }; the token
 * value is not stored and cannot be read again.
 * @param {object} db
 * @param {{ scopes: string[], expiresInSeconds?: number, label?: string }} input
 * @param {number} nowMs
 */
export function createToken(db, { scopes, expiresInSeconds, label } = {}, nowMs) {
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error('scopes must be a non-empty array');
  for (const s of scopes) {
    if (!isValidScope(s)) throw new Error(`invalid scope: ${s}`);
  }
  const unique = [...new Set(scopes)];
  const token = newToken();
  const id = newTokenId();
  const expiresAt = expiresInSeconds == null ? null : nowMs + expiresInSeconds * 1000;
  const labelValue = label ?? null;
  db.prepare(
    'INSERT INTO tokens (id, hash, scopes_json, expires_at, created_at, label) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, hashToken(token), JSON.stringify(unique), expiresAt, nowMs, labelValue);
  return { id, token, scopes: unique, expiresAt, label: labelValue };
}

/** The token row for a presented value, or null. Revoked and expired rows are returned too; check isUsable. */
export function findTokenByValue(db, token) {
  const row = db.prepare('SELECT * FROM tokens WHERE hash = ?').get(hashToken(token));
  return row ? toRow(row) : null;
}

/** All tokens, newest first. Never includes the hash or the value. */
export function listTokens(db) {
  return db
    .prepare('SELECT * FROM tokens ORDER BY created_at DESC, id')
    .all()
    .map(toRow);
}

/** Revokes a token. Returns false when no token has that id. Revoking twice keeps the first time. */
export function revokeToken(db, id, nowMs) {
  const res = db
    .prepare('UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
    .run(nowMs, id);
  return res.changes > 0;
}
