// WebVTT caption renditions for the delayed video HLS (plan P6.3). Pure: no I/O,
// no clock reads. The segment writer itself is sidecars.js `vttSegment`; this
// module picks the events of one rendition, and writes the master playlist and
// the subtitle media playlist.
//
// Renditions: `original` = the caption events (whatever their language), any other
// language = the translation events of that language.

import { vttSegment } from './sidecars.js';
import { assertStreamName } from './ffmpeg-input.js';

/** MPEG-TS PTS of the first segment of a playlist (10 s at 90 kHz, as ffmpeg starts). */
export const DEFAULT_MPEGTS_BASE = 900000;
/** How far before a segment a cue may start and still be shown in it (cues are short). */
export const CUE_LOOKBACK_MS = 60_000;

const PTS_WRAP = 2 ** 33;
const SUBTITLE_LANG = /^(?:[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?|original)$/;

/** True for a rendition name: a language tag or `original`. */
export function isSubtitleLang(lang) {
  return typeof lang === 'string' && SUBTITLE_LANG.test(lang);
}

/**
 * MPEG-TS PTS (90 kHz) of a segment's first frame. The origin is the wall-clock
 * start of the playlist's first segment, so every segment of one playlist keeps
 * the same spacing as the video.
 * @returns {number}
 */
export function mpegtsForSegment({ segStartMs, originMs = segStartMs, mpegtsBase = DEFAULT_MPEGTS_BASE }) {
  return (mpegtsBase + Math.round((segStartMs - originMs) * 90)) % PTS_WRAP;
}

/** The cue events of one rendition, in the shape vttSegment reads. */
export function renditionEvents(events, lang) {
  if (lang === 'original') {
    return (events || [])
      .filter((e) => e && e.type === 'caption')
      .map((e) => ({ ...e, lang: 'original' }));
  }
  return (events || []).filter((e) => e && e.type === 'translation' && e.lang === lang);
}

/**
 * WebVTT for one video segment. Cues overlapping [segStartMs, segEndMs) are clipped
 * to it and times are relative to segStartMs. A cue crossing a segment border is in
 * both segments. Always returns a valid file, with the header even when empty.
 * @param {{ segStartMs: number, segEndMs: number, events: object[], lang: string,
 *   mpegtsBase?: number, originMs?: number }} options
 * @returns {string}
 */
export function vttForSegment({
  segStartMs, segEndMs, events, lang, mpegtsBase = DEFAULT_MPEGTS_BASE, originMs = segStartMs,
}) {
  if (!isSubtitleLang(lang)) throw new TypeError(`invalid subtitle language: ${lang}`);
  if (!(segEndMs > segStartMs)) throw new RangeError('segEndMs must be after segStartMs');
  return vttSegment({
    segStartMs,
    segEndMs,
    events: renditionEvents(events, lang),
    lang,
    mpegtsAtSegStart: mpegtsForSegment({ segStartMs, originMs, mpegtsBase }),
  });
}

/**
 * The integer sequence number of a segment, from its file name (`%d.ts`, or
 * `seg00200.ts` in fixtures). Null when the name has none.
 * @returns {number | null}
 */
export function segmentSeq(uri) {
  const base = String(uri).split(/[\\/]/).pop().split('?')[0];
  const match = /(\d+)\.ts$/.exec(base);
  return match ? Number(match[1]) : null;
}

/**
 * Master playlist: one subtitle group with a rendition per language, and the
 * delayed video as the variant that uses that group.
 * @param {{ stream: string, langs?: string[], bandwidth: number, resolution: string }} options
 * @returns {string}
 */
export function masterPlaylist({ stream, langs = [], bandwidth, resolution }) {
  assertStreamName(stream);
  if (!Number.isInteger(bandwidth) || bandwidth <= 0) throw new RangeError('bandwidth must be a positive integer');
  if (!/^\d+x\d+$/.test(resolution)) throw new RangeError('resolution must look like 1280x720');
  for (const lang of langs) {
    if (!isSubtitleLang(lang)) throw new TypeError(`invalid subtitle language: ${lang}`);
  }
  const base = `/api/streams/${stream}/hls`;
  const lines = ['#EXTM3U'];
  for (const lang of langs) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${lang}",NAME="${lang}",` +
        `DEFAULT=NO,AUTOSELECT=YES,URI="${base}/subs/${lang}.m3u8"`,
    );
  }
  const subtitles = langs.length ? ',SUBTITLES="subs"' : '';
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution}${subtitles}`);
  lines.push(`${base}/video/delayed.m3u8`);
  return `${lines.join('\n')}\n`;
}

/**
 * Subtitle media playlist that mirrors the delayed video playlist: the same media
 * sequence, targets and durations, one `.vtt` per video segment.
 * Segments without a sequence number cannot be served and are left out.
 * @param {{ stream: string, lang: string, segments: { uri: string, duration: number | null,
 *   startMs: number | null }[], mediaSequence?: number, targetDuration?: number }} options
 * @returns {string}
 */
export function subsPlaylist({ stream, lang, segments, mediaSequence = 0, targetDuration }) {
  assertStreamName(stream);
  if (!isSubtitleLang(lang)) throw new TypeError(`invalid subtitle language: ${lang}`);
  const usable = segments.filter((s) => segmentSeq(s.uri) !== null && s.duration != null);
  const target = Math.max(
    1,
    Math.ceil(Math.max(targetDuration || 0, ...usable.map((s) => s.duration))),
  );
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${target}`,
    `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
  ];
  for (const segment of usable) {
    if (segment.startMs != null) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(segment.startMs).toISOString()}`);
    }
    lines.push(`#EXTINF:${segment.duration.toFixed(3)},`);
    lines.push(`/api/streams/${stream}/hls/subs/${lang}/${segmentSeq(segment.uri)}.vtt`);
  }
  return `${lines.join('\n')}\n`;
}
