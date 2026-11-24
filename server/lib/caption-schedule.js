/**
 * Caption scheduler for the live CEA-608 captioner (P9.5). Pure: timed caption
 * events in, per-frame field-1 pairs out. No clock, no I/O.
 *
 * Each event is `{ startFrame, endFrame, text }` on the output frame clock (the
 * caller turns the caption's startedAt into a frame index). For each event:
 *   - the text is loaded (pop-on: RCL, ENM, PAC, characters) into non-displayed
 *     memory in free slots after the previous caption's End Of Caption, and must
 *     finish before the start frame;
 *   - End Of Caption (EOC, sent twice) goes on the start frame, which flips the
 *     memories and shows the text;
 *   - Erase Displayed Memory (EDM, sent twice) goes on the end frame, unless the
 *     next caption's EOC comes first (the flip replaces the text anyway).
 * An event whose text cannot load in time, or whose EOC slot is taken, is
 * counted in `late` and not shown: a late caption is worse than a missing one
 * only in the counter, never on screen.
 *
 * The slot rule matches the E1 test-file maker (server/scripts/e1-make-test.mjs):
 * `slotsForFrame` gives 30 pairs per second on any frame rate, and a doubled
 * control code always sits in two consecutive slots.
 */
import { encodePopOn, eocPair, edmPair, PADDING } from './cea608.js';

const PAIRS_PER_SECOND = 30;

/** Field-1 pair slots for frame f (pairsPerFrame 'auto' keeps 30 pairs per second). */
export function slotsForFrame(f, fps, pairsPerFrame = 'auto') {
  if (pairsPerFrame !== 'auto') return pairsPerFrame;
  return Math.floor(((f + 1) * PAIRS_PER_SECOND) / fps) - Math.floor((f * PAIRS_PER_SECOND) / fps);
}

/** Group pairs into units: a doubled control code (two equal control pairs) is one unit. */
export function units(pairs) {
  const out = [];
  for (let i = 0; i < pairs.length; i += 1) {
    const p = pairs[i];
    const q = pairs[i + 1];
    const control = ((p[0] & 0x7f) & 0x70) === 0x10;
    if (control && q && q[0] === p[0] && q[1] === p[1]) {
      out.push([p, q]);
      i += 1;
    } else out.push([p]);
  }
  return out;
}

/**
 * @param {Array<{ startFrame: number, endFrame: number, text: string }>} events
 * @param {{ fps: number, totalFrames: number, pairsPerFrame?: 'auto'|number,
 *   channel?: 1|3, align?: 'left'|'center' }} options
 * @returns {{ pairsFor: (f: number) => number[][], maxSlots: number,
 *   placed: Array<{ text: string, startFrame: number, endFrame: number, loadFrom: number,
 *   loadTo: number, erased: boolean }>, late: number, invalid: number }}
 */
export function scheduleCaptions(events, { fps, totalFrames, pairsPerFrame = 'auto', channel = 1, align = 'left' } = {}) {
  if (!Number.isInteger(fps) || fps < 1) throw new RangeError('fps must be a positive integer');
  if (!Number.isInteger(totalFrames) || totalFrames < 1) throw new RangeError('totalFrames must be a positive integer');
  const cap = (f) => slotsForFrame(f, fps, pairsPerFrame);
  const slots = new Map(); // frame -> array of pairs | null, length cap(f)
  const at = (f, k) => (slots.get(f) ?? [])[k] ?? null;
  const put = (f, k, pair) => {
    if (!slots.has(f)) slots.set(f, new Array(cap(f)).fill(null));
    slots.get(f)[k] = pair;
  };
  /** Slot after [f, k], skipping frames without slots. */
  const after = ([f, k]) => {
    let nf = f;
    let nk = k + 1;
    while (nk >= cap(nf)) {
      nf += 1;
      nk = 0;
    }
    return [nf, nk];
  };
  const firstOf = (f) => [f, 0];
  const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

  /**
   * First run of `len` consecutive free slots at or after `from`, ending before
   * `limit` (a [frame, slot] pair), not using slots in `taken`. Returns the
   * list of [frame, slot] or null.
   */
  const findRun = (from, len, limit, taken) => {
    const free = ([f, k]) => at(f, k) === null && !taken.has(`${f}:${k}`);
    for (let s = from; before(s, limit); s = after(s)) {
      const run = [s];
      while (run.length < len) run.push(after(run[run.length - 1]));
      if (!before(run[run.length - 1], limit)) return null;
      if (run.every(free)) return run;
    }
    return null;
  };

  const sorted = [...events].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
  const placed = [];
  let late = 0;
  let invalid = 0;
  let cursor = firstOf(0); // first slot a load may use
  let lastShow = -1;

  sorted.forEach((ev, i) => {
    const { startFrame: show, endFrame: clear, text } = ev;
    if (!Number.isInteger(show) || !Number.isInteger(clear) || show < 0 || clear <= show
      || show >= totalFrames || typeof text !== 'string' || !text.trim()) {
      invalid += 1;
      return;
    }
    if (show <= lastShow || at(show, 0) !== null) {
      late += 1; // an earlier caption already flips on that frame, or its first slot is taken
      return;
    }
    const taken = new Set();
    const mark = (run) => run.forEach(([f, k]) => taken.add(`${f}:${k}`));
    // EOC on the start frame: two consecutive slots from its first slot.
    // The first copy must sit on the start frame; the second may fall on the next frame.
    const eocRun = findRun(firstOf(show), 2, firstOf(show + 2), taken);
    if (!eocRun || eocRun[0][0] !== show) {
      late += 1;
      return;
    }
    mark(eocRun);
    const eocEnd = eocRun[eocRun.length - 1];
    // Loads: in free slots after the previous EOC, all before the start frame.
    const loadRuns = [];
    let from = cursor;
    let ok = true;
    for (const unit of units(encodePopOn(text, { align, channel }))) {
      const run = findRun(from, unit.length, firstOf(show), taken);
      if (!run) {
        ok = false;
        break;
      }
      mark(run);
      loadRuns.push(run.map(([f, k], j) => [[f, k], unit[j]]));
      from = after(run[run.length - 1]);
    }
    if (!ok) {
      late += 1;
      return;
    }
    // Commit the loads and the EOC.
    for (const run of loadRuns) for (const [[f, k], p] of run) put(f, k, p);
    eocRun.forEach(([f, k], j) => put(f, k, eocPair(channel)));
    // EDM on the end frame, unless the next caption's EOC comes first.
    const next = sorted[i + 1];
    const nextShowsFirst = next && Number.isInteger(next.startFrame) && next.startFrame <= clear;
    let erased = false;
    if (!nextShowsFirst && clear < totalFrames) {
      const edmRun = findRun(firstOf(clear), 2, firstOf(clear + 2), new Set());
      if (edmRun && edmRun[0][0] === clear) {
        edmRun.forEach(([f, k]) => put(f, k, edmPair(channel)));
        erased = true;
      }
    }
    const firstLoad = loadRuns.length ? loadRuns[0][0][0][0] : show;
    const lastLoad = loadRuns.length ? loadRuns[loadRuns.length - 1].slice(-1)[0][0][0] : show;
    placed.push({ text, startFrame: show, endFrame: clear, loadFrom: firstLoad, loadTo: lastLoad, erased });
    cursor = after(eocEnd);
    lastShow = show;
  });

  let maxSlots = 1;
  for (let f = 0; f < totalFrames; f += 1) maxSlots = Math.max(maxSlots, cap(f));

  const pairsFor = (f) => {
    const list = slots.get(f) ?? [];
    const out = [];
    for (let k = 0; k < cap(f); k += 1) out.push(list[k] ?? [...PADDING]);
    return out;
  };
  return { pairsFor, maxSlots, placed, late, invalid };
}
