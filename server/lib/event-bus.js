// In-process fan-out of stored timeline events (plan P7.5). One relay process, so a plain emitter is enough.
//
// publish(stream, rows) hands stored event rows (with their ids) to every listener of that stream.
// storeAndPublish() is the only place that stores and publishes together: it calls addEvents unchanged, then
// publishes the rows that call actually wrote (duplicates ignored). addEvents keeps its signature.

import { addEvents, eventsAfterId, maxEventId } from './event-store.js';

/**
 * @returns {{
 *   subscribe(stream: string, listener: (rows: object[]) => void): () => void,
 *   publish(stream: string, rows: object[]): void,
 *   subscriberCount(stream: string): number,
 * }}
 */
export function createEventBus() {
  /** @type {Map<string, Set<(rows: object[]) => void>>} */
  const listeners = new Map();

  return {
    subscribe(stream, listener) {
      let set = listeners.get(stream);
      if (!set) {
        set = new Set();
        listeners.set(stream, set);
      }
      set.add(listener);
      return () => {
        const current = listeners.get(stream);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) listeners.delete(stream);
      };
    },

    publish(stream, rows) {
      const set = listeners.get(stream);
      if (!set || rows.length === 0) return;
      // A listener that throws must not stop the others or the ingest that called us.
      for (const listener of [...set]) {
        try {
          listener(rows);
        } catch {
          /* ignored: the viewer's own error handling owns its connection */
        }
      }
    },

    subscriberCount(stream) {
      return listeners.get(stream)?.size ?? 0;
    },
  };
}

/**
 * addEvents, then publish the rows it added. Throws (and publishes nothing) when storing fails.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof createEventBus>} bus
 * @param {string} stream
 * @param {object[]} events validated events (validateEvent / validateEventBatch)
 * @param {number} nowMs
 * @returns {{ added: number, deduped: number }}
 */
export function storeAndPublish(db, bus, stream, events, nowMs) {
  const before = maxEventId(db);
  const result = addEvents(db, stream, events, nowMs);
  if (result.added > 0) bus.publish(stream, eventsAfterId(db, stream, before));
  return result;
}
