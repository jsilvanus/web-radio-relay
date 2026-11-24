// Sidecar writers (plan 7.2, P7.4). Pure: no I/O, no clock reads.
//
// Every builder takes the full event list (the shape from events.js) and picks
// the types it needs. Times in the events are epoch milliseconds. The `originMs`
// option turns them into ms from the session start. `endMs` in chaptersVtt and
// buildSidecars is an epoch value on the same clock.

export const DEFAULT_CUE_MS = 4000;

const LANG = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/;

const pad = (n, width = 2) => String(n).padStart(width, '0');
const byStart = (a, b) => a.startedAt - b.startedAt;

/** Events of one type (or all types), copied and sorted by startedAt. */
function sortedOf(events, type) {
  return (events || [])
    .filter((e) => e && (type === undefined || e.type === type))
    .slice()
    .sort(byStart);
}

/** `HH:MM:SS.mmm`; negative input is clamped to 0. */
export function vttTimestamp(ms) {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(total % 1000, 3)}`;
}

/** Escape cue payload text (&, <, >; ">" also stops "-->"), and drop blank lines. */
function cueText(text) {
  return String(text ?? '')
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .join('\n');
}

/**
 * Caption and translation cues of one language on the absolute clock, sorted,
 * never overlapping. A cue ends at endedAt, else at the next cue's start, else
 * after defaultDurationMs; it is cut where the next cue starts. Cues with no
 * text, and cues that end where they start (two cues at the same instant), are
 * dropped.
 */
function captionCues(events, lang, defaultDurationMs = DEFAULT_CUE_MS) {
  const list = sortedOf(events).filter(
    (e) => (e.type === 'caption' || e.type === 'translation') && e.lang === lang && cueText(e.payload?.text) !== '',
  );
  const cues = [];
  list.forEach((e, i) => {
    const next = list[i + 1];
    const start = e.startedAt;
    let end = e.endedAt ?? (next ? next.startedAt : start + defaultDurationMs);
    if (next && end > next.startedAt) end = next.startedAt;
    if (end > start) cues.push({ start, end, text: cueText(e.payload.text) });
  });
  return cues;
}

/** Header, then each cue as `n / time / text`; every cue is preceded by a blank line. */
function renderVtt(header, cues) {
  return (
    header +
    cues
      .map((c, i) => `\n${i + 1}\n${vttTimestamp(c.start)} --> ${vttTimestamp(c.end)}\n${c.text}\n`)
      .join('')
  );
}

/**
 * Full-session WebVTT captions for one language, times relative to originMs.
 * @returns {string}
 */
export function captionsVtt(events, { lang, originMs = 0, defaultDurationMs = DEFAULT_CUE_MS }) {
  const cues = [];
  for (const c of captionCues(events, lang, defaultDurationMs)) {
    const start = Math.max(0, c.start - originMs);
    const end = Math.max(0, c.end - originMs);
    if (end > start) cues.push({ start, end, text: c.text });
  }
  return renderVtt('WEBVTT\n', cues);
}

/** Sections with their end on the absolute clock: endedAt, else the next section's start, never past the next start. */
function sectionSpans(events) {
  const list = sortedOf(events, 'section');
  return list.map((e, i) => {
    const next = list[i + 1];
    let end = e.endedAt ?? (next ? next.startedAt : e.startedAt);
    if (next && end > next.startedAt) end = next.startedAt;
    return { event: e, start: e.startedAt, end };
  });
}

/**
 * WebVTT chapters: each section lasts until the next section starts, the last
 * one until endMs (absolute epoch ms). Sections that would last nothing (no
 * endMs, or the same start as the next one) are left out.
 * @returns {string}
 */
export function chaptersVtt(events, { originMs = 0, endMs } = {}) {
  const list = sortedOf(events, 'section');
  const cues = [];
  list.forEach((e, i) => {
    const next = list[i + 1];
    const endAbs = next ? next.startedAt : (endMs ?? e.startedAt);
    const start = Math.max(0, e.startedAt - originMs);
    const end = Math.max(0, endAbs - originMs);
    const text = cueText(e.payload.title);
    if (end > start && text) cues.push({ start, end, text });
  });
  return renderVtt('WEBVTT\n', cues);
}

/**
 * Sections as JSON rows, times relative to originMs. endMs is the section's
 * endedAt when it has one (clipped to the next section's start), otherwise the
 * next section's start; an open last section has endMs equal to startMs.
 * @returns {{ title: string, kind: string|null, index: number|null, startMs: number, endMs: number }[]}
 */
export function sectionsJson(events, { originMs = 0 } = {}) {
  return sectionSpans(events).map(({ event: e, start, end }) => ({
    title: e.payload.title,
    kind: e.payload.kind ?? null,
    index: e.payload.index ?? null,
    startMs: Math.max(0, start - originMs),
    endMs: Math.max(0, end - originMs),
  }));
}

/**
 * Hymn-verse graphics grouped by hymn number (or by title when there is no
 * number). Groups are in first-appearance order, verses in time order.
 * @returns {{ hymnNumber: string|null, title: string|null, verses: { verse: number|null, lines: string[], text: string|null, startMs: number }[] }[]}
 */
export function hymnsJson(events, { originMs = 0 } = {}) {
  const groups = new Map();
  for (const e of sortedOf(events, 'graphic')) {
    const p = e.payload;
    if (p.kind !== 'hymn-verse') continue;
    const key = p.hymnNumber != null ? `n:${p.hymnNumber}` : `t:${p.title ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { hymnNumber: p.hymnNumber ?? null, title: null, verses: [] };
      groups.set(key, group);
    }
    if (group.title == null && p.title) group.title = p.title;
    group.verses.push({
      verse: p.verse ?? null,
      lines: p.lines ?? [],
      text: p.text ?? null,
      startMs: Math.max(0, e.startedAt - originMs),
    });
  }
  return [...groups.values()];
}

/**
 * Every graphic event in time order, plus the unique asset ids they reference
 * (first-appearance order), so the assets can be copied next to the recording.
 * @returns {{ graphics: object[], assetIds: string[] }}
 */
export function graphicsJson(events, { originMs = 0 } = {}) {
  const graphics = [];
  const assetIds = new Set();
  for (const e of sortedOf(events, 'graphic')) {
    const p = e.payload;
    graphics.push({
      kind: p.kind,
      title: p.title ?? null,
      text: p.text ?? null,
      assetId: p.assetId ?? null,
      startMs: Math.max(0, e.startedAt - originMs),
    });
    if (p.assetId) assetIds.add(p.assetId);
  }
  return { graphics, assetIds: [...assetIds] };
}

/** One JSON object per line, newline-terminated, in time order, with the original absolute times. */
export function eventsJsonl(events) {
  return sortedOf(events)
    .map((e) => `${JSON.stringify(e)}\n`)
    .join('');
}

/**
 * WebVTT segment for HLS. Cues overlapping [segStartMs, segEndMs) are clipped to
 * the segment; times are relative to segStartMs, which the X-TIMESTAMP-MAP header
 * maps to LOCAL 00:00:00.000. A cue spanning two segments appears in both.
 * @returns {string}
 */
export function vttSegment({ segStartMs, segEndMs, events, lang, mpegtsAtSegStart = 0 }) {
  const cues = [];
  for (const c of captionCues(events, lang)) {
    if (!(c.start < segEndMs && c.end > segStartMs)) continue;
    cues.push({
      start: Math.max(c.start, segStartMs) - segStartMs,
      end: Math.min(c.end, segEndMs) - segStartMs,
      text: c.text,
    });
  }
  return renderVtt(`WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${mpegtsAtSegStart},LOCAL:00:00:00.000\n`, cues);
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * All sidecar files of a session, as file name -> text.
 * @param {object[]} events
 * @param {{ originMs?: number, endMs?: number, langs?: string[] }} options
 * @returns {Record<string, string>}
 */
export function buildSidecars(events, { originMs = 0, endMs, langs = [] } = {}) {
  const files = {};
  for (const lang of new Set(langs)) {
    if (!LANG.test(lang)) throw new TypeError(`invalid language tag: ${lang}`);
    files[`captions.${lang}.vtt`] = captionsVtt(events, { lang, originMs });
  }
  files['chapters.vtt'] = chaptersVtt(events, { originMs, endMs });
  files['sections.json'] = json(sectionsJson(events, { originMs }));
  files['hymns.json'] = json(hymnsJson(events, { originMs }));
  files['graphics.json'] = json(graphicsJson(events, { originMs }));
  files['events.jsonl'] = eventsJsonl(events);
  return files;
}
