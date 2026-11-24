// Viewer payloads for the LCYT-compatible viewer SSE (plan P7.5, plan 7.1). Pure: no I/O, no clock reads.
//
// The shapes are the LCYT contract (`GET /api/v1/viewer/:key` in live-captions-yt, read by its viewer pages
// and the Android TV app): caption `{ text, composedText, translations, codes, sequence, timestamp }`, where
// `timestamp` is ISO 8601 in local-clock form without a trailing `Z`.

/**
 * LCYT timestamp: ISO 8601 with milliseconds and no trailing `Z`, e.g. "2026-03-10T12:00:00.000".
 * @param {number} ms epoch milliseconds
 */
export function viewerTimestamp(ms) {
  return new Date(ms).toISOString().replace(/Z$/, '');
}

/** Translations as a { lang: text } map. Accepts [{ lang, text }] or an existing map; empty texts are dropped. */
function translationMap(translations) {
  const map = {};
  if (Array.isArray(translations)) {
    for (const t of translations) {
      if (t && typeof t.lang === 'string' && typeof t.text === 'string' && t.text) map[t.lang] = t.text;
    }
  } else if (translations && typeof translations === 'object') {
    for (const [lang, text] of Object.entries(translations)) {
      if (typeof text === 'string' && text) map[lang] = text;
    }
  }
  return map;
}

/**
 * One LCYT caption payload.
 * @param {object} args
 * @param {{ startedAt: number, payload: { text: string } }} args.caption stored caption event
 * @param {Array<{ lang: string, text: string }> | Record<string, string>} [args.translations]
 * @param {string} [args.section] title of the section in effect (codes.section)
 * @param {number} args.sequence caption sequence (the stored caption's id)
 * @param {string} [args.firstLang] language shown under the original in composedText
 */
export function toViewerCaption({ caption, translations, section, sequence, firstLang }) {
  const text = caption.payload.text;
  const map = translationMap(translations);
  const translated = firstLang ? map[firstLang] : undefined;
  return {
    text,
    composedText: translated ? `${text}<br>${translated}` : text,
    translations: map,
    codes: section ? { section } : {},
    sequence,
    timestamp: viewerTimestamp(caption.startedAt),
  };
}

const GRAPHIC_FIELDS = ['title', 'text', 'assetId', 'hymnNumber', 'verse', 'lines'];

/**
 * A stored graphic event for the viewer: its kind and payload fields, with id and timestamp.
 * @param {{ id: number, startedAt: number, payload: object }} event
 */
export function toViewerGraphic(event) {
  const out = { id: event.id, timestamp: viewerTimestamp(event.startedAt), kind: event.payload.kind };
  for (const field of GRAPHIC_FIELDS) {
    if (event.payload[field] !== undefined) out[field] = event.payload[field];
  }
  return out;
}

/**
 * A stored section event for the viewer.
 * @param {{ id: number, startedAt: number, payload: object }} event
 */
export function toViewerSection(event) {
  const out = { id: event.id, timestamp: viewerTimestamp(event.startedAt), title: event.payload.title };
  if (event.payload.kind !== undefined) out.kind = event.payload.kind;
  if (event.payload.index !== undefined) out.index = event.payload.index;
  return out;
}
