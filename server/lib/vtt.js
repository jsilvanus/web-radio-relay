/**
 * WebVTT writer for captions (plain text cues). Pure: cues in, string out.
 *
 * The timestamp format and cue layout are the ones used by LCYT's caption files
 * (packages/lcyt-backend/src/caption-files.js), so a VTT from either side reads the
 * same. Times are milliseconds on the media timeline; an empty text is skipped.
 */

/**
 * WebVTT timestamp, HH:MM:SS.mmm.
 * @param {number} ms non-negative milliseconds
 * @returns {string}
 */
export function formatVttTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError('time must be a non-negative number of milliseconds');
  const total = Math.round(ms);
  const hh = String(Math.floor(total / 3600000)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600000) / 60000)).padStart(2, '0');
  const ss = String(Math.floor((total % 60000) / 1000)).padStart(2, '0');
  const frac = String(total % 1000).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${frac}`;
}

/**
 * A whole WebVTT file.
 * @param {Array<{ startMs: number, endMs: number, text: string }>} cues in time order
 * @returns {string}
 */
export function buildVtt(cues) {
  let out = 'WEBVTT\n\n';
  let seq = 0;
  for (const cue of cues) {
    if (!cue.text || !cue.text.trim()) continue;
    if (cue.endMs <= cue.startMs) throw new RangeError('cue must end after it starts');
    seq += 1;
    out += `${seq}\n${formatVttTime(cue.startMs)} --> ${formatVttTime(cue.endMs)}\n${cue.text}\n\n`;
  }
  return out;
}
