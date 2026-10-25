/**
 * Timed caption buffer for the relay.
 *
 * Captions arrive from the sender (pivoice, later translations) with
 * `startedAt`: epoch milliseconds of the spoken audio on the sender's clock,
 * which is NTP-synced with the relay. A caption is released to listeners at
 * `startedAt + delaySeconds`, the same moment the delayed audio plays it.
 *
 * Pure except for the buffer itself; the caller passes `nowMs`.
 */

export const MAX_SEGMENTS_PER_REQUEST = 100;
export const MAX_TEXT_LENGTH = 500;
/** Captions further in the past than this are refused (sender clock sanity). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Captions further in the future than this are refused. */
const MAX_FUTURE_MS = 5 * 60 * 1000;
const LANG = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/;

/**
 * Validate a POST body of caption segments. Rejects the whole request on the
 * first invalid segment so senders see exactly what was wrong.
 * @param {unknown} body `{ segments: [...] }` or a bare array
 * @param {number} nowMs
 * @returns {{ ok: true, segments: CaptionInput[] } | { ok: false, error: string }}
 */
export function validateCaptionBody(body, nowMs) {
  const list = Array.isArray(body) ? body : body && body.segments;
  if (!Array.isArray(list)) return { ok: false, error: 'body must be { "segments": [...] }' };
  if (list.length === 0) return { ok: false, error: 'segments must not be empty' };
  if (list.length > MAX_SEGMENTS_PER_REQUEST) {
    return { ok: false, error: `at most ${MAX_SEGMENTS_PER_REQUEST} segments per request` };
  }

  const segments = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {};
    const at = `segments[${i}]`;
    const lang = typeof s.lang === 'string' ? s.lang.trim().toLowerCase() : '';
    if (!LANG.test(lang)) return { ok: false, error: `${at}.lang must be a language tag such as "fi" or "sv"` };
    const text = typeof s.text === 'string' ? s.text.trim() : '';
    if (!text || text.length > MAX_TEXT_LENGTH) {
      return { ok: false, error: `${at}.text must be 1-${MAX_TEXT_LENGTH} characters` };
    }
    if (!Number.isFinite(s.startedAt) || !Number.isInteger(s.startedAt)) {
      return { ok: false, error: `${at}.startedAt must be an integer (epoch milliseconds)` };
    }
    if (s.startedAt < nowMs - MAX_AGE_MS || s.startedAt > nowMs + MAX_FUTURE_MS) {
      return { ok: false, error: `${at}.startedAt is outside the accepted window (check the sender clock)` };
    }
    let endedAt = null;
    if (s.endedAt !== undefined && s.endedAt !== null) {
      if (!Number.isInteger(s.endedAt) || s.endedAt < s.startedAt) {
        return { ok: false, error: `${at}.endedAt must be an integer not before startedAt` };
      }
      endedAt = s.endedAt;
    }
    segments.push({ lang, text, startedAt: s.startedAt, endedAt });
  }
  return { ok: true, segments };
}

/**
 * @typedef {{ lang: string, text: string, startedAt: number, endedAt: number | null }} CaptionInput
 * @typedef {CaptionInput & { id: number }} Caption
 */

export class CaptionBuffer {
  /** @param {{ maxEntries?: number }} [options] */
  constructor({ maxEntries = 20000 } = {}) {
    /** @type {Caption[]} */
    this.items = [];
    this.nextId = 1;
    this.maxEntries = maxEntries;
  }

  /**
   * Store validated captions. Drops the oldest entries past maxEntries.
   * @param {CaptionInput[]} segments
   * @returns {number} how many were stored
   */
  add(segments) {
    for (const segment of segments) {
      this.items.push({ id: this.nextId++, ...segment });
    }
    if (this.items.length > this.maxEntries) {
      this.items.splice(0, this.items.length - this.maxEntries);
    }
    return segments.length;
  }

  /** Drop captions that started before `cutoffMs`. */
  prune(cutoffMs) {
    this.items = this.items.filter((c) => c.startedAt >= cutoffMs);
  }

  /**
   * Captions that are due for listeners now, oldest first.
   * A caption is due when startedAt + delay <= now and startedAt >= from.
   *
   * @param {{ nowMs: number, delayMs: number, from?: number, lang?: string, limit?: number }} query
   * @returns {{ captions: Caption[], next: number }} `next` is the `from` for the next poll
   */
  released({ nowMs, delayMs, from, lang, limit = 200 }) {
    const cutoff = nowMs - delayMs;
    const start = from ?? cutoff - 30_000;
    const due = this.items
      .filter((c) => c.startedAt >= start && c.startedAt <= cutoff && (!lang || c.lang === lang))
      .sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
    const captions = due.slice(0, limit);
    const next = captions.length ? captions[captions.length - 1].startedAt + 1 : start;
    return { captions, next };
  }
}
