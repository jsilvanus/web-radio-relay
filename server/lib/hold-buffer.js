/**
 * Hold buffer for the caption embedder (P9.4).
 *
 * Every item (an FLV tag) is held for `holdMs` of wall-clock time before it is
 * released, so the captioner knows the captions for those frames in time.
 *
 * Wall time of an item: the arrival time (from the injected `now()`) is compared
 * with the media timestamp. The offset `arrival - mediaTs` is smoothed with an
 * exponential moving average, and wallTime = mediaTs + offset. Arrival jitter
 * therefore moves an item by a fraction of the jitter instead of by all of it,
 * and items are released in push order, never reordered.
 *
 * A media timestamp that jumps forward by more than JUMP_MS, or goes backwards,
 * resets the offset to the raw sample (no smoothing) because the old offset no
 * longer applies. Push items in the order they are written (FLV DTS order).
 *
 * Pure: no clock reads. The caller passes `now` (a function returning ms).
 */

/** A media timestamp step larger than this (or any backward step) resets the offset. */
export const JUMP_MS = 5000;

/**
 * @param {object} options
 * @param {number} options.holdMs wall-clock hold time, >= 0
 * @param {() => number} options.now clock in ms (injected; fake in tests)
 * @param {number} [options.smoothing=0.1] EMA factor for the offset, in (0, 1]
 * @returns {{
 *   push(item: unknown, mediaTsMs: number): void,
 *   due(nowMs: number): Array<{ item: unknown, mediaTsMs: number, wallTimeMs: number }>,
 *   nextDueAt(): number | null,
 *   size(): number,
 *   clear(): void,
 * }}
 */
export function createHoldBuffer({ holdMs, now, smoothing = 0.1 } = {}) {
  if (!Number.isFinite(holdMs) || holdMs < 0) throw new RangeError('holdMs must be a number >= 0');
  if (typeof now !== 'function') throw new TypeError('now must be a function returning ms');
  if (!Number.isFinite(smoothing) || smoothing <= 0 || smoothing > 1) {
    throw new RangeError('smoothing must be in (0, 1]');
  }

  let entries = [];
  let head = 0;
  let offset = null; // wallArrival - mediaTs, smoothed
  let lastMediaTs = null;

  return {
    push(item, mediaTsMs) {
      if (!Number.isFinite(mediaTsMs)) throw new TypeError('mediaTsMs must be a finite number');
      const sample = now() - mediaTsMs;
      const jumped = lastMediaTs !== null
        && (mediaTsMs < lastMediaTs || mediaTsMs - lastMediaTs > JUMP_MS);
      if (offset === null || jumped) {
        offset = sample;
      } else {
        offset += smoothing * (sample - offset);
      }
      lastMediaTs = mediaTsMs;
      entries.push({ item, mediaTsMs, wallTimeMs: mediaTsMs + offset });
    },

    /**
     * Items whose wallTime + holdMs <= nowMs, oldest first. Stops at the first
     * item that is not yet due, so a later item never leaves before an earlier one.
     */
    due(nowMs) {
      const out = [];
      while (head < entries.length && entries[head].wallTimeMs + holdMs <= nowMs) {
        out.push(entries[head]);
        entries[head] = undefined; // let the item be collected
        head += 1;
      }
      if (head > 1024 && head * 2 > entries.length) {
        entries = entries.slice(head);
        head = 0;
      }
      return out;
    },

    /** Wall time at which the oldest held item is released, or null when empty. */
    nextDueAt() {
      return head < entries.length ? entries[head].wallTimeMs + holdMs : null;
    },

    size() {
      return entries.length - head;
    },

    clear() {
      entries = [];
      head = 0;
      offset = null;
      lastMediaTs = null;
    },
  };
}
