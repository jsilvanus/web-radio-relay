/**
 * Per-stream state for the relay: one caption buffer and one listener delay
 * per stream. Streams are named by the RTMP stream key (nginx passes it to
 * on-publish.sh), so the name is restricted to a safe path segment.
 */

import { CaptionBuffer } from './captions.js';

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidStreamName(name) {
  return typeof name === 'string' && NAME.test(name);
}

export class StreamRegistry {
  /**
   * @param {{ defaultDelaySeconds: number, maxDelaySeconds: number, maxStreams?: number }} options
   */
  constructor({ defaultDelaySeconds, maxDelaySeconds, maxStreams = 50 }) {
    this.defaultDelaySeconds = defaultDelaySeconds;
    this.maxDelaySeconds = maxDelaySeconds;
    this.maxStreams = maxStreams;
    /** @type {Map<string, { delaySeconds: number, captions: CaptionBuffer }>} */
    this.entries = new Map();
  }

  /** Existing state for a stream, or null. Public reads never create entries. */
  peek(name) {
    return this.entries.get(name) || null;
  }

  /**
   * State for a stream, created on first write. Null when the stream limit is reached.
   * @param {string} name
   */
  ensure(name) {
    let entry = this.entries.get(name);
    if (!entry) {
      if (this.entries.size >= this.maxStreams) return null;
      entry = { delaySeconds: this.defaultDelaySeconds, captions: new CaptionBuffer() };
      this.entries.set(name, entry);
    }
    return entry;
  }

  /** Delay in seconds for a stream (the default when it has no state yet). */
  delayOf(name) {
    const entry = this.entries.get(name);
    return entry ? entry.delaySeconds : this.defaultDelaySeconds;
  }
}
