// Pure helpers for the relay's viewer pages (/view, /embed/viewer, /watch, /listen panels).
// No DOM, no globals: the same file is imported by the browser pages and by the Node tests.
//
// resolveViewerText and collectLangTexts are ported from LCYT (lcyt-web src/lib/viewerUtils.js);
// the payload they read is the LCYT viewer contract served by GET /api/v1/viewer/{key}.

/**
 * Text to show for one caption event, given the `lang` choice.
 * '' / undefined / null  -> composed text (original + translation)
 * 'original'             -> the original text only
 * 'all'                  -> composed text (the caller lays out one column per language)
 * '<lang>'               -> that translation; falls back to composed, then original
 * @param {{ text?: string, composedText?: string, translations?: Record<string, string> }} data
 * @param {string} [lang]
 * @returns {string}
 */
export function resolveViewerText(data, lang) {
  if (!lang) return data.composedText ?? data.text ?? '';
  if (lang === 'original') return data.text ?? '';
  if (lang === 'all') return data.composedText ?? data.text ?? '';
  const specific = data.translations?.[lang];
  return specific ?? data.composedText ?? data.text ?? '';
}

/**
 * Every language text of one caption event, for `lang=all`. `original` is always present.
 * Empty translations are left out.
 * @param {{ text?: string, translations?: Record<string, string> }} data
 * @returns {Record<string, string>}
 */
export function collectLangTexts(data) {
  const map = { original: data.text || '' };
  if (data.translations && typeof data.translations === 'object') {
    for (const [lang, text] of Object.entries(data.translations)) {
      if (text) map[lang] = text;
    }
  }
  return map;
}

/**
 * Split text on <br> tags (the backend joins original and translation with <br>). The parts are
 * meant for textContent and <br> elements built with the DOM API: never assign the text to innerHTML.
 * @param {unknown} text
 * @returns {string[]} at least one part; [''] for non-string input
 */
export function splitBreaks(text) {
  if (typeof text !== 'string') return [''];
  return text.split(/<br\s*\/?>/i);
}

/**
 * Languages that have a non-empty translation in one caption event, in the event's order.
 * @param {{ translations?: unknown }} data
 * @returns {string[]}
 */
export function languagesOf(data) {
  if (!data || !data.translations || typeof data.translations !== 'object') return [];
  return Object.keys(data.translations).filter((lang) => data.translations[lang]);
}

const ASSET_ID = /^[a-f0-9]{64}\.(png|jpe?g|webp)$/;

/**
 * Public URL of a library image, or null for an id that is not `<64 hex>.png|jpg|jpeg|webp`.
 * @param {unknown} assetId
 * @returns {string|null}
 */
export function assetUrl(assetId) {
  return typeof assetId === 'string' && ASSET_ID.test(assetId) ? `/api/assets/${assetId}` : null;
}

/**
 * Lines of a hymn verse for display: `lines[]` as given, else `verse` or `text` split on newlines.
 * @param {{ lines?: unknown, verse?: unknown, text?: unknown }} graphic
 * @returns {string[]}
 */
export function hymnLines(graphic) {
  if (Array.isArray(graphic.lines)) return graphic.lines.filter((l) => typeof l === 'string');
  const body = typeof graphic.verse === 'string' ? graphic.verse : typeof graphic.text === 'string' ? graphic.text : '';
  return body ? body.split(/\r?\n/) : [];
}

const LANG = /^[A-Za-z0-9-]{1,16}$/;

/**
 * The `lang` value from a URL or storage: 'original', 'all', a short language code, or '' (composed).
 * Anything else is ''.
 * @param {unknown} value
 * @returns {string}
 */
export function parseLang(value) {
  if (value === 'original' || value === 'all') return value;
  return typeof value === 'string' && LANG.test(value) ? value : '';
}

/**
 * Caption size in rem from a `fontsize` parameter, clamped to 0.5..10. Falls back when missing or not a number.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function parseFontSize(value, fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(10, Math.max(0.5, n));
}

/**
 * Theme from a `theme` parameter: 'light' or 'dark' (default dark, as LCYT).
 * @param {unknown} value
 * @returns {'light'|'dark'}
 */
export function parseTheme(value) {
  return value === 'light' ? 'light' : 'dark';
}

const STREAM_NAME = /^[a-z0-9_-]{1,32}$/;

/** A viewer key or stream name: the same rule as the server's stream names. */
export function isViewerKey(value) {
  return typeof value === 'string' && STREAM_NAME.test(value);
}
