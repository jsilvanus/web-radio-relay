/**
 * Encryption of secrets at rest (destination stream keys).
 *
 * AES-256-GCM with a random 12-byte IV per call. The output is
 * `v1:<iv base64>:<tag base64>:<ciphertext base64>`. The key is 32 bytes,
 * given as 64 hex characters (env RELAY_SECRET_KEY). Pure functions: no I/O.
 *
 * Error messages never contain the key or the plaintext.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Throws unless keyHex is a string of exactly 64 hex characters.
 * @param {unknown} keyHex
 */
export function assertKey(keyHex) {
  if (typeof keyHex !== 'string' || !KEY_PATTERN.test(keyHex)) {
    throw new Error('RELAY_SECRET_KEY must be 64 hex characters');
  }
}

/**
 * Encrypt a string.
 * @param {string} plain
 * @param {string} keyHex 64 hex characters
 * @returns {string} `v1:<iv>:<tag>:<ciphertext>`, all parts base64
 */
export function encrypt(plain, keyHex) {
  assertKey(keyHex);
  if (typeof plain !== 'string') {
    throw new TypeError('secret must be a string');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, Buffer.from(keyHex, 'hex'), iv, {
    authTagLength: TAG_BYTES,
  });
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

/**
 * Decrypt a blob made by encrypt(). Throws Error('cannot decrypt secret') on
 * a wrong key, a tampered blob or a malformed blob.
 * @param {string} blob
 * @param {string} keyHex 64 hex characters
 * @returns {string} the plaintext
 */
export function decrypt(blob, keyHex) {
  assertKey(keyHex);
  const fail = () => new Error('cannot decrypt secret');
  if (typeof blob !== 'string') throw fail();
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw fail();
  const [, ivB64, tagB64, dataB64] = parts;
  if (![ivB64, tagB64, dataB64].every((p) => BASE64_PATTERN.test(p))) throw fail();

  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw fail();

  try {
    const decipher = createDecipheriv(ALGORITHM, Buffer.from(keyHex, 'hex'), iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    throw fail();
  }
}
