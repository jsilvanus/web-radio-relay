// Late translations (P8). Pure logic: the caller passes the delay and the receive time.
//
// A translation is late when it arrived after its own release time on a delayed viewer:
// startedAt + delayMs < receivedAt. Late translations are stored with payload.late = true.
// createLateCounter keeps the per-stream count shown in /metrics (in memory, since process start).

/**
 * Mark late translations in place (payload.late = true). Other events are not touched.
 * @param {object[]} events validated events
 * @param {{ delayMs: number, nowMs: number }} opts nowMs is the receive time
 * @returns {number} how many were marked
 */
export function markLateTranslations(events, { delayMs, nowMs }) {
  let late = 0;
  for (const e of events) {
    if (e.type !== 'translation') continue;
    if (e.startedAt + delayMs < nowMs) {
      e.payload = { ...e.payload, late: true };
      late++;
    }
  }
  return late;
}

/** Per-stream counter of late translations. */
export function createLateCounter() {
  const counts = new Map();
  return {
    add(stream, n) {
      if (n > 0) counts.set(stream, (counts.get(stream) ?? 0) + n);
    },
    get(stream) {
      return counts.get(stream) ?? 0;
    },
    /** [stream, count] pairs, sorted by stream name. */
    entries() {
      return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    },
  };
}
