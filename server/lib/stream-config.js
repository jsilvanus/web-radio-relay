// Per-stream configuration (P8). Stored as JSON in `streams.config_json` (migration 1), so no
// schema change. Only the fields a client actually sent are stored; defaults fill the rest.
//
// validateConfigPatch is pure. getConfig, putConfig and resolveViewerStream take an open
// node:sqlite handle (the same convention as event-store.js). putConfig reads the clock only
// through its nowMs argument, which defaults to Date.now() for the route.

import { LANG } from './events.js';
import { isValidStreamName } from './streams.js';

const DEFAULT_CAPTION_HOLD_SECONDS = (() => {
  const value = Number(process.env.CAPTION_HOLD_SECONDS);
  return Number.isFinite(value) && value >= 1 && value <= 60 ? value : 16;
})();
const DEFAULT_CAPTION_SYNC_OFFSET_MS = (() => {
  const value = Number(process.env.CAPTION_SYNC_OFFSET_MS);
  return Number.isInteger(value) && value >= -10000 && value <= 10000 ? value : 1500;
})();

export const DEFAULT_CONFIG = Object.freeze({
  // '*' = every language that arrives (visitors pick their own on /view).
  visibleLanguages: Object.freeze(['*']),
  radio: true,
  videoHls: false,
  recordOnLive: false,
  publicGraphics: true,
  viewerKey: null,
  captioner: Object.freeze({ enabled: false, lang: 'fi', holdSeconds: DEFAULT_CAPTION_HOLD_SECONDS, syncOffsetMs: DEFAULT_CAPTION_SYNC_OFFSET_MS }),
});

const KEYS = Object.keys(DEFAULT_CONFIG);
const BOOLEAN_KEYS = ['radio', 'videoHls', 'recordOnLive', 'publicGraphics'];
const MAX_LANGUAGES = 10;
const CAPTIONER_KEYS = ['enabled', 'lang', 'holdSeconds', 'syncOffsetMs'];
/** A viewer key is an operator-chosen path segment: 8 to 64 characters. */
export const VIEWER_KEY = /^[a-z0-9_-]{8,64}$/;

/** A configuration problem with an HTTP status: 400 for bad input, 409 for a taken viewer key. */
export class StreamConfigError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'StreamConfigError';
    this.status = status;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkCaptioner(value) {
  if (!isPlainObject(value)) return { ok: false, error: 'captioner must be an object' };
  const out = {};
  for (const key of Object.keys(value)) {
    if (!CAPTIONER_KEYS.includes(key)) return { ok: false, error: 'unknown captioner field: ' + key.slice(0, 64) };
    const v = value[key];
    if (key === 'enabled') {
      if (typeof v !== 'boolean') return { ok: false, error: 'captioner.enabled must be true or false' };
      out.enabled = v;
    } else if (key === 'lang') {
      if (typeof v !== 'string' || !LANG.test(v.trim().toLowerCase())) return { ok: false, error: 'captioner.lang must be a language tag' };
      out.lang = v.trim().toLowerCase();
    } else if (key === 'holdSeconds') {
      if (!Number.isFinite(v) || v < 1 || v > 60) return { ok: false, error: 'captioner.holdSeconds must be a number 1-60' };
      out.holdSeconds = v;
    } else if (key === 'syncOffsetMs') {
      if (!Number.isInteger(v) || v < -10000 || v > 10000) return { ok: false, error: 'captioner.syncOffsetMs must be an integer -10000..10000' };
      out.syncOffsetMs = v;
    }
  }
  return { ok: true, value: out };
}

function checkLanguages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LANGUAGES) {
    return { ok: false, error: `visibleLanguages must be an array of 1 to ${MAX_LANGUAGES} language tags` };
  }
  const out = [];
  for (const item of value) {
    const tag = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (tag === '*') {
      if (value.length !== 1) return { ok: false, error: 'visibleLanguages: "*" (all languages) must be the only entry' };
      out.push(tag);
      continue;
    }
    if (!LANG.test(tag)) {
      return { ok: false, error: 'visibleLanguages must contain language tags such as "fi" or "sv", or only "*"' };
    }
    if (out.includes(tag)) return { ok: false, error: 'visibleLanguages must not repeat a language' };
    out.push(tag);
  }
  return { ok: true, value: out };
}

/**
 * Check a partial configuration. Only the fields present come back in `value`.
 * Unknown fields are refused, so a typo is reported instead of silently ignored.
 * @param {unknown} patch
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateConfigPatch(patch) {
  if (!isPlainObject(patch)) return { ok: false, error: 'body must be a JSON object with configuration fields' };
  const value = {};
  for (const key of Object.keys(patch)) {
    if (!KEYS.includes(key)) return { ok: false, error: `unknown config field: ${key.slice(0, 64)}` };
    const v = patch[key];
    if (key === 'captioner') {
      const checked = checkCaptioner(v);
      if (!checked.ok) return checked;
      value[key] = { ...DEFAULT_CONFIG.captioner, ...checked.value };
    } else if (key === 'visibleLanguages') {
      const checked = checkLanguages(v);
      if (!checked.ok) return checked;
      value[key] = checked.value;
    } else if (BOOLEAN_KEYS.includes(key)) {
      if (typeof v !== 'boolean') return { ok: false, error: `${key} must be true or false` };
      value[key] = v;
    } else if (key === 'viewerKey') {
      if (v !== null && !(typeof v === 'string' && VIEWER_KEY.test(v))) {
        return { ok: false, error: 'viewerKey must be null or 8-64 characters: a-z, 0-9, _ or -' };
      }
      value[key] = v;
    }
  }
  return { ok: true, value };
}

/** The stored config fields of a stream (known keys only; never throws). */
function storedFields(db, stream) {
  const row = db.prepare('SELECT config_json FROM streams WHERE name = ?').get(stream);
  if (!row || !row.config_json) return {};
  let parsed;
  try {
    parsed = JSON.parse(row.config_json);
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) return {};
  const known = {};
  for (const key of KEYS) if (key in parsed) known[key] = parsed[key];
  return known;
}

/**
 * The full configuration of a stream: stored fields over the defaults. A stream without a row
 * gets the defaults. Arrays are copies, so callers may change the result.
 */
export function getConfig(db, stream) {
  const checked = validateConfigPatch(storedFields(db, stream));
  const merged = { ...DEFAULT_CONFIG, ...(checked.ok ? checked.value : {}) };
  merged.visibleLanguages = [...merged.visibleLanguages];
  merged.captioner = { ...DEFAULT_CONFIG.captioner, ...(merged.captioner || {}) };
  return merged;
}

/**
 * Store a partial configuration (creates the stream row when needed) and return the full
 * configuration after the write. Throws StreamConfigError: 400 for an invalid name or patch,
 * 409 when the viewer key belongs to another stream.
 */
export function putConfig(db, stream, patch, nowMs = Date.now()) {
  if (!isValidStreamName(stream)) throw new StreamConfigError('invalid stream name', 400);
  const checked = validateConfigPatch(patch);
  if (!checked.ok) throw new StreamConfigError(checked.error, 400);

  const key = checked.value.viewerKey;
  if (typeof key === 'string') {
    const owner = db
      .prepare("SELECT name FROM streams WHERE json_extract(config_json, '$.viewerKey') = ? AND name <> ?")
      .get(key, stream);
    if (owner) throw new StreamConfigError('viewerKey is already used by another stream', 409);
  }

  const next = { ...storedFields(db, stream), ...checked.value };
  db.prepare(
    `INSERT INTO streams (name, config_json, created_at) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET config_json = excluded.config_json`,
  ).run(stream, JSON.stringify(next), nowMs);
  return getConfig(db, stream);
}

/**
 * The stream a viewer key opens, or null. A key equal to some stream's viewerKey opens that stream.
 * Otherwise a valid stream name opens the stream, but only while that stream has no viewerKey:
 * once it has one, the name alone no longer opens it.
 */
export function resolveViewerStream(db, key) {
  if (typeof key !== 'string') return null;
  const owner = db.prepare("SELECT name FROM streams WHERE json_extract(config_json, '$.viewerKey') = ?").get(key);
  if (owner) return owner.name;
  if (!isValidStreamName(key)) return null;
  if (typeof storedFields(db, key).viewerKey === 'string') return null;
  return key;
}

/** True when a translation in `lang` is shown under this config ('*' shows all). */
export function isLanguageVisible(config, lang) {
  return config.visibleLanguages.includes('*') || config.visibleLanguages.includes(lang);
}
