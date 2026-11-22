/**
 * Egress destinations (P4.1): RTMP(S) outputs a relay stream can be pushed to.
 *
 * `validateDestination` is pure. The db helpers take the open `db` from
 * store.js and the secret key (RELAY_SECRET_KEY, 64 hex characters) when a
 * stream key is stored or read. Keys are sealed with secret-box and no function
 * here returns one: public views carry `hasKey` only. Errors thrown by the db
 * helpers carry `statusCode` and never contain a key.
 */

import { randomBytes } from 'node:crypto';
import { encrypt, decrypt } from './secret-box.js';
import { redact } from './redact.js';

export const DESTINATION_KINDS = ['youtube', 'facebook', 'rtmp'];
export const DESTINATION_VARIANTS = ['raw', 'cc'];
export const START_WITH_VALUES = ['stream', 'manual'];
export const DEFAULT_MAX_DESTINATIONS = 6;

const NAME = /^[a-z0-9_-]{1,32}$/;
const RTMP_URL = /^rtmps?:\/\/\S+$/i;
const RTMPS_URL = /^rtmps:\/\/\S+$/i;
const KEY_CHARS = /^[\x21-\x7e]+$/;
const ID = /^dst_[0-9a-f]{12}$/;
const MAX_URL_LENGTH = 2048;
const MAX_KEY_LENGTH = 512;
const FIELDS = ['name', 'kind', 'url', 'key', 'variant', 'enabled', 'startWith'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (input, field) => Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined;

/**
 * Validates a destination body.
 *
 * Create (no `current`): name, kind and url are required; the other fields
 * take their defaults (variant raw, enabled true, startWith stream).
 * Update (`current` = { kind, url, hasKey } of the stored row): only the
 * fields present are checked, and the cross-field rules use the merged values.
 * `key: null` or `''` clears a stored key on update.
 *
 * @param {unknown} input
 * @param {{ current?: { kind: string, url: string, hasKey: boolean } | null }} [options]
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateDestination(input, { current = null } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!isPlainObject(input)) return fail('body must be a JSON object');
  const unknown = Object.keys(input).find((k) => !FIELDS.includes(k));
  if (unknown !== undefined) return fail(`unknown field: ${unknown}`);

  const creating = current === null;
  if (creating) {
    for (const field of ['name', 'kind', 'url']) {
      if (!has(input, field)) return fail(`${field} is required`);
    }
  }

  const value = {};
  if (has(input, 'name')) {
    if (typeof input.name !== 'string' || !NAME.test(input.name)) {
      return fail('name must match [a-z0-9_-]{1,32}');
    }
    value.name = input.name;
  }
  if (has(input, 'kind')) {
    if (!DESTINATION_KINDS.includes(input.kind)) return fail('kind must be youtube, facebook or rtmp');
    value.kind = input.kind;
  }
  if (has(input, 'url')) {
    if (typeof input.url !== 'string' || input.url.length > MAX_URL_LENGTH || !RTMP_URL.test(input.url)) {
      return fail('url must be rtmp:// or rtmps://');
    }
    value.url = input.url;
  }
  if (has(input, 'variant')) {
    if (!DESTINATION_VARIANTS.includes(input.variant)) return fail('variant must be raw or cc');
    value.variant = input.variant;
  }
  if (has(input, 'enabled')) {
    if (typeof input.enabled !== 'boolean') return fail('enabled must be true or false');
    value.enabled = input.enabled;
  }
  if (has(input, 'startWith')) {
    if (!START_WITH_VALUES.includes(input.startWith)) return fail('startWith must be stream or manual');
    value.startWith = input.startWith;
  }
  if (has(input, 'key')) {
    if (input.key === null || input.key === '') {
      value.key = null;
    } else if (
      typeof input.key !== 'string' ||
      input.key.length > MAX_KEY_LENGTH ||
      !KEY_CHARS.test(input.key)
    ) {
      return fail('key must be 1 to 512 printable characters without spaces');
    } else {
      value.key = input.key;
    }
  }

  // Cross-field rules on the merged destination.
  const kind = value.kind ?? current?.kind;
  const url = value.url ?? current?.url;
  const hasKey = value.key !== undefined ? value.key !== null : Boolean(current?.hasKey);
  if (kind === 'facebook' && !RTMPS_URL.test(url)) return fail('facebook url must be rtmps://');
  if ((kind === 'youtube' || kind === 'facebook') && !hasKey) {
    return fail(`${kind} destinations need a stream key`);
  }
  if (typeof value.key === 'string' && url.includes(value.key)) {
    return fail('the stream key must not appear in the url; put it in key');
  }

  if (creating) {
    value.variant ??= 'raw';
    value.enabled ??= true;
    value.startWith ??= 'stream';
  }
  return { ok: true, value };
}

/** A new destination id, e.g. `dst_3f9a0c2b7d11`. */
export function newDestinationId() {
  return `dst_${randomBytes(6).toString('hex')}`;
}

/** Public view of a stored row: no key, the url without credentials. */
export function publicDestination(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: redact(row.url ?? ''),
    variant: row.variant,
    enabled: row.enabled === 1,
    startWith: row.start_with,
    hasKey: typeof row.key_enc === 'string' && row.key_enc.length > 0,
  };
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function sealKey(key, secretKey) {
  if (!secretKey) {
    throw httpError(503, 'RELAY_SECRET_KEY is not set: a destination stream key cannot be stored');
  }
  try {
    return encrypt(key, secretKey);
  } catch {
    throw httpError(503, 'RELAY_SECRET_KEY must be 64 hex characters');
  }
}

function findRow(db, stream, id) {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  return db.prepare('SELECT * FROM destinations WHERE stream = ? AND id = ?').get(stream, id) ?? null;
}

function nameTaken(db, stream, name, exceptId = null) {
  const row = db.prepare('SELECT id FROM destinations WHERE stream = ? AND name = ?').get(stream, name);
  return Boolean(row) && row.id !== exceptId;
}

/** Public views of a stream's destinations, oldest first. */
export function listDestinations(db, stream) {
  return db
    .prepare('SELECT * FROM destinations WHERE stream = ? ORDER BY created_at, id')
    .all(stream)
    .map(publicDestination);
}

/** Ids of the destinations a stream starts when it goes live: enabled and startWith 'stream'. */
export function startableDestinationIds(db, stream) {
  return listDestinations(db, stream).filter((d) => d.enabled && d.startWith === 'stream').map((d) => d.id);
}

/** Public view of one destination, or null. */
export function getDestination(db, stream, id) {
  const row = findRow(db, stream, id);
  return row ? publicDestination(row) : null;
}

/**
 * Creates a destination. Throws 400 (invalid body), 409 (limit reached or name
 * taken) or 503 (no RELAY_SECRET_KEY while a key is given).
 * @returns {object} the public view
 */
export function createDestination(db, stream, input, { secretKey = '', maxPerStream = DEFAULT_MAX_DESTINATIONS, nowMs = Date.now() } = {}) {
  const checked = validateDestination(input);
  if (!checked.ok) throw httpError(400, checked.error);
  const v = checked.value;

  const count = db.prepare('SELECT COUNT(*) AS n FROM destinations WHERE stream = ?').get(stream).n;
  if (count >= maxPerStream) throw httpError(409, `a stream can have at most ${maxPerStream} destinations`);
  if (nameTaken(db, stream, v.name)) throw httpError(409, `a destination named ${v.name} already exists`);

  const keyEnc = v.key ? sealKey(v.key, secretKey) : null;
  const id = newDestinationId();
  // destinations.stream references streams(name); a stream exists once it has a destination.
  db.prepare('INSERT OR IGNORE INTO streams (name, created_at) VALUES (?, ?)').run(stream, nowMs);
  db.prepare(
    `INSERT INTO destinations (id, stream, name, kind, url, key_enc, variant, enabled, start_with, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, stream, v.name, v.kind, v.url, keyEnc, v.variant, v.enabled ? 1 : 0, v.startWith, nowMs);
  return getDestination(db, stream, id);
}

/**
 * Partially updates a destination. Throws 400, 404, 409 or 503 as createDestination.
 * `targetChanged` is true when the kind, url, variant or key changed or the
 * destination was disabled: a running egress must then be stopped by the caller.
 * @returns {{ destination: object, targetChanged: boolean }}
 */
export function updateDestination(db, stream, id, input, { secretKey = '' } = {}) {
  const row = findRow(db, stream, id);
  if (!row) throw httpError(404, 'destination not found');
  const checked = validateDestination(input, { current: { kind: row.kind, url: row.url, hasKey: Boolean(row.key_enc) } });
  if (!checked.ok) throw httpError(400, checked.error);
  const v = checked.value;
  if (v.name !== undefined && nameTaken(db, stream, v.name, id)) {
    throw httpError(409, `a destination named ${v.name} already exists`);
  }

  let keyEnc = row.key_enc;
  if (v.key !== undefined) keyEnc = v.key ? sealKey(v.key, secretKey) : null;

  db.prepare(
    'UPDATE destinations SET name = ?, kind = ?, url = ?, key_enc = ?, variant = ?, enabled = ?, start_with = ? WHERE stream = ? AND id = ?',
  ).run(
    v.name ?? row.name,
    v.kind ?? row.kind,
    v.url ?? row.url,
    keyEnc,
    v.variant ?? row.variant,
    v.enabled === undefined ? row.enabled : (v.enabled ? 1 : 0),
    v.startWith ?? row.start_with,
    stream,
    id,
  );

  const targetChanged =
    (v.kind !== undefined && v.kind !== row.kind) ||
    (v.url !== undefined && v.url !== row.url) ||
    (v.variant !== undefined && v.variant !== row.variant) ||
    v.key !== undefined ||
    v.enabled === false;
  return { destination: getDestination(db, stream, id), targetChanged };
}

/** Deletes a destination. False when there is none with that id. */
export function deleteDestination(db, stream, id) {
  if (typeof id !== 'string' || !ID.test(id)) return false;
  return db.prepare('DELETE FROM destinations WHERE stream = ? AND id = ?').run(stream, id).changes > 0;
}

/**
 * What the egress supervisor needs to run a destination: url, variant and the
 * decrypted key (undefined when none is stored). Throws 404 (unknown), 409 (a
 * YouTube or Facebook destination without a key) or 503 (the stored key cannot
 * be read with the configured RELAY_SECRET_KEY). Never send this to a client.
 * @returns {{ id, name, kind, url, variant, enabled, startWith, key: string | undefined }}
 */
export function loadEgressTarget(db, stream, id, { secretKey = '' } = {}) {
  const row = findRow(db, stream, id);
  if (!row) throw httpError(404, 'destination not found');
  let key;
  if (row.key_enc) {
    if (!secretKey) throw httpError(503, 'RELAY_SECRET_KEY is not set: the stored stream key cannot be read');
    try {
      key = decrypt(row.key_enc, secretKey);
    } catch {
      throw httpError(503, 'the stored stream key cannot be decrypted: check RELAY_SECRET_KEY');
    }
  }
  if ((row.kind === 'youtube' || row.kind === 'facebook') && !key) {
    throw httpError(409, 'destination has no stream key');
  }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    variant: row.variant,
    enabled: row.enabled === 1,
    startWith: row.start_with,
    key,
  };
}

/** True when the destination exists (used by the start and stop routes). */
export function destinationExists(db, stream, id) {
  return findRow(db, stream, id) !== null;
}
