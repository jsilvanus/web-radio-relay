/**
 * Server-side delay for the live HLS audio stream.
 *
 * ffmpeg writes a rolling media playlist with #EXT-X-PROGRAM-DATE-TIME for
 * every segment (the `program_date_time` hls flag). The relay serves a second,
 * delayed playlist that lists only segments which ended at least `delaySeconds`
 * ago. Captions are released on the same clock (see captions.js), so listeners
 * hear and read the same moment together.
 *
 * Pure functions: no I/O, no clock reads (the caller passes `nowMs`).
 */

/** Segments in the delayed playlist (about 24 s at HLS_TIME=4). */
export const DELAYED_WINDOW_SEGMENTS = 6;

/**
 * Parse an ISO 8601 date-time as written by ffmpeg. Accepts "+0000" offsets.
 * @param {string} value
 * @returns {number | null} epoch milliseconds
 */
export function parseProgramDateTime(value) {
  const normalised = String(value).trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(normalised);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Parse a media playlist into its header values and segment list.
 * @param {string} text
 * @returns {{ version: number, targetDuration: number, mediaSequence: number,
 *   segments: { uri: string, duration: number | null, startMs: number | null }[] }}
 */
export function parseMediaPlaylist(text) {
  const header = { version: 3, targetDuration: 0, mediaSequence: 0 };
  const segments = [];
  let pending = { duration: null, startMs: null };

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const value = line.slice(line.indexOf(':') + 1);

    if (line.startsWith('#EXT-X-VERSION:')) header.version = Number(value);
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) header.targetDuration = Number(value);
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) header.mediaSequence = Number(value);
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pending.startMs = parseProgramDateTime(value);
    else if (line.startsWith('#EXTINF:')) pending.duration = parseFloat(value);
    else if (line.startsWith('#')) continue;
    else {
      segments.push({ uri: line, duration: pending.duration, startMs: pending.startMs });
      pending = { duration: null, startMs: null };
    }
  }
  return { header, segments };
}

/** Keep only a safe file name for a segment URI (no paths, no query strings). */
function segmentName(uri) {
  const base = uri.split(/[\\/]/).pop().split('?')[0];
  return /^[A-Za-z0-9._-]+$/.test(base) ? base : null;
}

/**
 * Build the delayed media playlist.
 *
 * Lists the last DELAYED_WINDOW_SEGMENTS segments that ended at or before
 * `nowMs - delaySeconds * 1000`. Returns null when the source playlist has
 * no timed segments (the stream is not live, or ffmpeg lacks program_date_time).
 *
 * @param {string} sourceText contents of the live stream.m3u8
 * @param {{ delaySeconds: number, nowMs: number, segmentPrefix?: string }} options
 * @returns {string | null}
 */
export function buildDelayedPlaylist(sourceText, { delaySeconds, nowMs, segmentPrefix = '/hls/' }) {
  const { header, segments } = parseMediaPlaylist(sourceText);
  const cutoffMs = nowMs - delaySeconds * 1000;

  // Segments are in order; the released ones form a prefix of the list.
  let released = 0;
  for (const segment of segments) {
    if (segment.startMs == null || segment.duration == null) break;
    if (segment.startMs + segment.duration * 1000 > cutoffMs) break;
    released += 1;
  }
  if (released === 0) {
    const anyTimed = segments.some((s) => s.startMs != null);
    return anyTimed || segments.length === 0 ? playlist([], header, 0, segmentPrefix) : null;
  }

  const first = Math.max(0, released - DELAYED_WINDOW_SEGMENTS);
  const picked = segments.slice(first, released);
  if (picked.some((s) => s.startMs == null || s.duration == null)) return null;
  return playlist(picked, header, header.mediaSequence + first, segmentPrefix);
}

function playlist(segments, header, mediaSequence, segmentPrefix) {
  const target = Math.max(
    1,
    Math.ceil(Math.max(header.targetDuration || 0, ...segments.map((s) => s.duration || 0))),
  );
  const out = [
    '#EXTM3U',
    `#EXT-X-VERSION:${header.version || 3}`,
    `#EXT-X-TARGETDURATION:${target}`,
    `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
  ];
  for (const segment of segments) {
    const name = segmentName(segment.uri);
    if (!name) continue;
    out.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(segment.startMs).toISOString()}`);
    out.push(`#EXTINF:${segment.duration.toFixed(3)},`);
    out.push(`${segmentPrefix}${name}`);
  }
  return out.join('\n') + '\n';
}
