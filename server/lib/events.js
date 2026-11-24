// Timeline event model (plan 7, P7.1). Pure: no I/O, no clock reads.
//
// An event is { type, lang?, startedAt, endedAt?, sourceKey?, payload }.
// startedAt is epoch milliseconds on the NTP-synced clock. validateEvent
// strips unknown top-level and payload fields, so what is stored is exactly
// what the model describes.

export const EVENT_TYPES = ['caption', 'translation', 'section', 'graphic', 'marker', 'data'];
export const GRAPHIC_KINDS = ['hymn-verse', 'slide', 'image', 'text', 'clear'];
export const MAX_EVENTS_PER_REQUEST = 100;
export const MAX_DATA_VALUE_BYTES = 4096;

const MAX_TEXT = 500;
const MAX_TITLE = 200;
const MAX_SOURCE_KEY = 128;
const MAX_LINES = 20;
const MAX_LINE = 200;
export const LANG = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/;
const ASSET_ID = /^[a-f0-9]{64}\.(png|jpg|webp)$/;

class Invalid extends Error {}

function fail(message) {
  throw new Invalid(message);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (v) => v !== undefined && v !== null;

/** Drop keys whose value is undefined, so optional fields are absent, not undefined. */
function compact(obj) {
  for (const key of Object.keys(obj)) if (obj[key] === undefined) delete obj[key];
  return obj;
}

function requiredText(value, field, max) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s || s.length > max) fail(`${field} must be 1-${max} characters`);
  return s;
}

function optionalText(value, field, max) {
  if (!has(value)) return undefined;
  if (typeof value !== 'string') fail(`${field} must be a string`);
  const s = value.trim();
  if (!s) return undefined;
  if (s.length > max) fail(`${field} must be at most ${max} characters`);
  return s;
}

function langTag(value, field) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!LANG.test(s)) fail(`${field} must be a language tag such as "fi" or "sv"`);
  return s;
}

function sourceKeyOf(value, field) {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  const s = value.trim();
  if (!s || s.length > MAX_SOURCE_KEY) fail(`${field} must be 1-${MAX_SOURCE_KEY} characters`);
  return s;
}

function optionalInt(value, field, min) {
  if (!has(value)) return undefined;
  if (!Number.isInteger(value) || value < min) fail(`${field} must be an integer >= ${min}`);
  return value;
}

function linesOf(value) {
  if (!has(value)) return undefined;
  if (!Array.isArray(value) || value.length > MAX_LINES) {
    fail(`payload.lines must be an array of at most ${MAX_LINES} strings`);
  }
  return value.map((line, i) => {
    if (typeof line !== 'string' || line.length > MAX_LINE) {
      fail(`payload.lines[${i}] must be a string of at most ${MAX_LINE} characters`);
    }
    return line;
  });
}

function assetIdOf(value) {
  if (!has(value)) return undefined;
  if (typeof value !== 'string' || !ASSET_ID.test(value)) {
    fail('payload.assetId must be a 64-character hex hash ending in .png, .jpg or .webp');
  }
  return value;
}

const PAYLOAD = {
  caption(p) {
    if (has(p.final) && typeof p.final !== 'boolean') fail('payload.final must be true or false');
    return {
      text: requiredText(p.text, 'payload.text', MAX_TEXT),
      final: has(p.final) ? p.final : true,
    };
  },

  translation(p) {
    return compact({
      text: requiredText(p.text, 'payload.text', MAX_TEXT),
      sourceKey: sourceKeyOf(p.sourceKey, 'payload.sourceKey'),
      model: optionalText(p.model, 'payload.model', 64),
    });
  },

  section(p) {
    return compact({
      title: requiredText(p.title, 'payload.title', MAX_TITLE),
      kind: optionalText(p.kind, 'payload.kind', 32),
      index: optionalInt(p.index, 'payload.index', 0),
    });
  },

  graphic(p) {
    if (!GRAPHIC_KINDS.includes(p.kind)) fail(`payload.kind must be one of ${GRAPHIC_KINDS.join(', ')}`);
    const out = compact({
      kind: p.kind,
      title: optionalText(p.title, 'payload.title', MAX_TITLE),
      text: optionalText(p.text, 'payload.text', MAX_TEXT),
      assetId: assetIdOf(p.assetId),
      hymnNumber: optionalText(p.hymnNumber, 'payload.hymnNumber', 16),
      verse: optionalInt(p.verse, 'payload.verse', 1),
      lines: linesOf(p.lines),
    });
    if (out.kind === 'hymn-verse' && !(out.lines && out.lines.length) && !out.text) {
      fail('hymn-verse needs payload.lines or payload.text');
    }
    if ((out.kind === 'image' || out.kind === 'slide') && !out.assetId) {
      fail(`${out.kind} needs payload.assetId`);
    }
    return out;
  },

  marker(p) {
    return { label: requiredText(p.label, 'payload.label', MAX_TITLE) };
  },

  data(p) {
    const name = requiredText(p.name, 'payload.name', 64);
    if (p.value === undefined) fail('payload.value is required');
    let json;
    try {
      json = JSON.stringify(p.value);
    } catch {
      fail('payload.value must be JSON');
    }
    if (json === undefined) fail('payload.value must be JSON');
    if (new TextEncoder().encode(json).length > MAX_DATA_VALUE_BYTES) {
      fail(`payload.value must be at most ${MAX_DATA_VALUE_BYTES} bytes when stringified`);
    }
    return { name, value: p.value };
  },
};

function parseEvent(e) {
  if (!isObject(e)) fail('event must be an object');
  if (!EVENT_TYPES.includes(e.type)) fail(`type must be one of ${EVENT_TYPES.join(', ')}`);

  if (!Number.isInteger(e.startedAt) || e.startedAt <= 0) {
    fail('startedAt must be an integer (epoch milliseconds) greater than 0');
  }
  let endedAt = null;
  if (has(e.endedAt)) {
    if (!Number.isInteger(e.endedAt) || e.endedAt < e.startedAt) {
      fail('endedAt must be an integer not before startedAt');
    }
    endedAt = e.endedAt;
  }

  const needsLang = e.type === 'caption' || e.type === 'translation';
  let lang = null;
  if (has(e.lang)) lang = langTag(e.lang, 'lang');
  else if (needsLang) fail(`lang is required for ${e.type}`);

  const sourceKey = has(e.sourceKey) ? sourceKeyOf(e.sourceKey, 'sourceKey') : null;

  if (!isObject(e.payload)) fail('payload must be an object');
  const payload = PAYLOAD[e.type](e.payload);

  return { type: e.type, lang, startedAt: e.startedAt, endedAt, sourceKey, payload };
}

/**
 * Validate one timeline event. Rejects with a message naming the field.
 * @param {unknown} e
 * @returns {{ ok: true, event: object } | { ok: false, error: string }}
 */
export function validateEvent(e) {
  try {
    return { ok: true, event: parseEvent(e) };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Validate a POST body `{ "events": [...] }` (1..100 events). A bare array is
 * accepted too, as for captions. One bad event rejects the whole batch, and the
 * error names its index.
 * @param {unknown} body
 * @returns {{ ok: true, events: object[] } | { ok: false, error: string }}
 */
export function validateEventBatch(body) {
  const list = Array.isArray(body) ? body : isObject(body) ? body.events : undefined;
  if (!Array.isArray(list)) return { ok: false, error: 'body must be { "events": [...] }' };
  if (list.length === 0) return { ok: false, error: 'events must not be empty' };
  if (list.length > MAX_EVENTS_PER_REQUEST) {
    return { ok: false, error: `at most ${MAX_EVENTS_PER_REQUEST} events per request` };
  }

  const events = [];
  for (let i = 0; i < list.length; i++) {
    const result = validateEvent(list[i]);
    if (!result.ok) return { ok: false, error: `events[${i}]: ${result.error}` };
    events.push(result.event);
  }
  return { ok: true, events };
}
