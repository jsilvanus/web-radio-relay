/**
 * Live caption scheduler for the CEA-608 embedder (P9.5).
 *
 * Turns caption events (text, startedAt, endedAt in wall-clock ms) into the 608
 * byte pairs for each video frame. Pop-on: the text is loaded into the
 * non-displayed memory in the free slots of the frames before `startedAt`, End Of
 * Caption (EOC) goes into the first slot of the first frame whose wall time is
 * >= `startedAt`, and Erase Displayed Memory (EDM) at `endedAt`. Loading of the
 * next caption starts only after the EOC of the previous one, because EOC flips
 * the two memories.
 *
 * The caller (the captioner service) takes frames out of the hold buffer and asks
 * `pairsForFrame(frameIndex, wallMs)` for each. Frame indexes count from the first
 * video frame (frame index = round((pts - firstPts) * fps / 1000)), so the order
 * of the calls may follow decode order (B-frames): the pairs are generated in
 * frame order and kept until asked for, and each frame gets the pairs of its own
 * presentation position.
 *
 * Pure: no clock reads, no I/O. Timing is entirely the `wallMs` that is passed.
 */

import { encodePopOn, splitCaption, eocPair, edmPair, PADDING } from './cea608.js';

/** 608 field-1 data rate: two bytes per frame at (about) 30 fps. */
export const PAIRS_PER_SECOND = 30;

/** Field-1 pair slots for frame f at `fps` (25 fps: 1,1,1,1,2 so the byte rate stays at 30 pairs/s). */
export function slotsForFrame(f, fps) {
  return Math.floor(((f + 1) * PAIRS_PER_SECOND) / fps) - Math.floor((f * PAIRS_PER_SECOND) / fps);
}

/** The largest slot count of any frame: the constant `cc_count` to use for the stream. */
export function maxSlotsFor(fps) {
  let max = 1;
  for (let f = 0; f < fps; f += 1) max = Math.max(max, slotsForFrame(f, fps));
  return max;
}

/**
 * Group pairs into units: a doubled control code (two equal pairs whose first
 * byte is a control byte) must stay in two consecutive slots, or a decoder
 * would not recognise the second copy as redundant.
 */
function units(pairs) {
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
 * @param {object} options
 * @param {number} options.fps integer frame rate of the video, 1-60
 * @param {1|3} [options.channel=1] caption channel (CC1 field 1; CC3 would be field 2 and is not used by the embedder)
 * @param {'left'|'center'} [options.align='left']
 * @param {number} [options.defaultShowMs=4000] on-screen time when a caption has no endedAt
 * @param {number} [options.lateToleranceMs] an EOC later than this after startedAt counts as late (default two frames)
 * @param {number} [options.maxPendingFrames=600] cap of generated-ahead frames kept for reordering
 */
export function createCaptioner({
  fps,
  channel = 1,
  align = 'left',
  defaultShowMs = 4000,
  lateToleranceMs,
  maxPendingFrames = 600,
} = {}) {
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new RangeError('fps must be an integer 1-60');
  const frameMs = 1000 / fps;
  const tolerance = lateToleranceMs ?? 2 * frameMs;

  /** Pieces (one pop-on each) not yet displayed, in order. */
  const queue = [];
  /** Pairs of a unit that did not fit at the end of the previous frame. */
  let carry = [];
  /** The piece currently on screen, with its erase time; null when nothing is shown. */
  let shown = null;
  let nextGen = 0; // next frame index to generate
  const ready = new Map(); // frame index -> pairs, generated but not yet asked for

  const stats = { captions: 0, pieces: 0, late: 0, lateMsMax: 0, replacedChars: 0, dropped: 0, embedded: 0 };

  /** Add a caption. Text is split into pop-ons of two lines; the time is divided between them. */
  function addCaption({ text, startedAtMs, endedAtMs }) {
    if (!Number.isFinite(startedAtMs)) throw new TypeError('startedAtMs must be a finite number');
    const clean = String(text ?? '').trim();
    if (!clean) return 0;
    const parts = splitCaption(clean);
    if (parts.length === 0) return 0;
    const total = Number.isFinite(endedAtMs) && endedAtMs > startedAtMs
      ? endedAtMs - startedAtMs
      : defaultShowMs * parts.length;
    const each = total / parts.length;
    stats.captions += 1;
    parts.forEach((lines, i) => {
      const pairs = encodePopOn(lines.join(' '), { align, channel });
      // encodePopOn wraps again; lines of one piece never exceed two rows because splitCaption already cut them.
      stats.replacedChars += pairs.replaced ?? 0;
      queue.push({
        startedAt: startedAtMs + i * each,
        endedAt: startedAtMs + (i + 1) * each,
        loadUnits: units(pairs),
        loaded: 0,
      });
      stats.pieces += 1;
    });
    return parts.length;
  }

  /** Generate the pairs of the next frame (frame index nextGen) at wall time `wallMs`. */
  function generate(wallMs) {
    const cap = slotsForFrame(nextGen, fps);
    const slots = [];
    const put = (pairs) => {
      for (const p of pairs) slots.push(p);
    };
    while (slots.length < cap) {
      if (carry.length) {
        const n = Math.min(carry.length, cap - slots.length);
        put(carry.splice(0, n));
        continue;
      }
      // A unit is two pairs at most; if only one slot is left, the second half carries to the next frame.
      const emit = (unit) => {
        const room = cap - slots.length;
        put(unit.slice(0, room));
        carry = unit.slice(room);
      };
      const head = queue[0];
      if (shown && wallMs >= shown.endedAt && (!head || wallMs < head.startedAt || head.loaded < head.loadUnits.length)) {
        shown = null;
        emit([edmPair(channel), edmPair(channel)]);
        continue;
      }
      if (head && head.loaded >= head.loadUnits.length && wallMs >= head.startedAt) {
        queue.shift();
        const lateMs = wallMs - head.startedAt;
        if (lateMs > tolerance) {
          stats.late += 1;
          stats.lateMsMax = Math.max(stats.lateMsMax, lateMs);
        }
        shown = head;
        // An EOC that came late must still stay visible for a while: keep at least one frame.
        shown.endedAt = Math.max(shown.endedAt, wallMs + frameMs);
        stats.embedded += 1;
        emit([eocPair(channel), eocPair(channel)]);
        continue;
      }
      if (head && head.loaded < head.loadUnits.length) {
        emit(head.loadUnits[head.loaded]);
        head.loaded += 1;
        continue;
      }
      slots.push([...PADDING]);
    }
    return slots;
  }

  return {
    addCaption,

    /**
     * Pairs for frame `frameIndex`, which has wall time `wallMs`. Frames are
     * generated in index order up to this one; a frame asked for out of order
     * (B-frame decode order) gets the pairs generated for its own index.
     * @returns {number[][]} slotsForFrame(frameIndex, fps) pairs
     */
    pairsForFrame(frameIndex, wallMs) {
      if (!Number.isInteger(frameIndex) || frameIndex < 0) throw new RangeError('frameIndex must be an integer >= 0');
      if (!Number.isFinite(wallMs)) throw new TypeError('wallMs must be a finite number');
      if (frameIndex < nextGen && !ready.has(frameIndex)) {
        // Asked twice or far behind: no captions for this frame, only padding.
        stats.dropped += 1;
        return Array.from({ length: slotsForFrame(frameIndex, fps) }, () => [...PADDING]);
      }
      // A jump forward of more than maxPendingFrames (stream restart or a gap): skip, do not generate thousands of frames.
      if (frameIndex - nextGen > maxPendingFrames) {
        nextGen = frameIndex;
        ready.clear();
        carry = [];
      }
      while (nextGen <= frameIndex) {
        ready.set(nextGen, generate(wallMs + (nextGen - frameIndex) * frameMs));
        nextGen += 1;
      }
      const out = ready.get(frameIndex);
      ready.delete(frameIndex);
      if (ready.size > maxPendingFrames) {
        // Oldest generated-ahead frames that were never asked for.
        const oldest = Math.min(...ready.keys());
        ready.delete(oldest);
      }
      return out;
    },

    /** Forget everything (stream restart): queued captions, the shown one and generated frames. */
    reset() {
      queue.length = 0;
      carry = [];
      shown = null;
      nextGen = 0;
      ready.clear();
    },

    /** Captions waiting or being loaded. */
    pending() {
      return queue.length;
    },

    stats() {
      return { ...stats, pending: queue.length, shown: shown !== null };
    },

    /** Constant cc_count for the SEI of every frame of this stream. */
    ccCount: maxSlotsFor(fps),
    fps,
  };
}
