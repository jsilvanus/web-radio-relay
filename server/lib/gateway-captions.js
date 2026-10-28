/**
 * Pulls captions from pigateway's SSE bus (`GET {gateway}/api/v1/events?types=transcript`,
 * see pitube/CONTRACT.md sections 1 and 2) and adds them to the caption buffer of one stream.
 *
 * - Reconnects with exponential backoff (250 ms to 5 s) plus jitter; 45 s without any
 *   bytes counts as a dead connection (the gateway sends a keep-alive every 15 s).
 * - Sends `Last-Event-ID` after the first event; de-duplicates by (epoch, seq) so a
 *   replay does not add a caption twice. A new epoch (gateway restart) resets the dedupe state.
 * - Every transcript goes through validateCaptionBody; bad events are counted and skipped.
 */

import { validateCaptionBody } from './captions.js';

export const EVENTS_PATH = '/api/v1/events?types=transcript';
const DEDUPE_WINDOW = 2000;

/**
 * Incremental text/event-stream parser. Handles LF, CRLF and CR line ends, comments,
 * multi-line data and input split at any byte (feed it decoded text).
 */
export class SseParser {
  /** @param {(event: { event: string, data: string, id: string | null }) => void} onEvent */
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = '';
    this.started = false;
    this.resetEvent();
    this.lastId = null;
  }

  resetEvent() {
    this.event = '';
    this.dataLines = [];
    this.hasData = false;
    this.id = null;
  }

  /** @param {string} text */
  feed(text) {
    this.buffer += text;
    if (!this.started && this.buffer.length > 0) {
      this.started = true;
      if (this.buffer.charCodeAt(0) === 0xfeff) this.buffer = this.buffer.slice(1);
    }
    let pos = 0;
    for (;;) {
      let end = -1;
      for (let i = pos; i < this.buffer.length; i++) {
        const c = this.buffer[i];
        if (c === '\n' || c === '\r') { end = i; break; }
      }
      if (end === -1) break;
      let next = end + 1;
      if (this.buffer[end] === '\r') {
        // A CR at the very end may be the first half of CRLF: wait for the next chunk.
        if (next >= this.buffer.length) break;
        if (this.buffer[next] === '\n') next++;
      }
      this.line(this.buffer.slice(pos, end));
      pos = next;
    }
    this.buffer = this.buffer.slice(pos);
  }

  line(line) {
    if (line === '') {
      if (this.hasData) {
        const id = this.id !== null ? this.id : this.lastId;
        this.onEvent({ event: this.event || 'message', data: this.dataLines.join('\n'), id });
      }
      this.resetEvent();
      return;
    }
    if (line[0] === ':') return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') { this.dataLines.push(value); this.hasData = true; }
    else if (field === 'id' && !value.includes('\0')) { this.id = value; this.lastId = value; }
  }
}

export class GatewayCaptions {
  /**
   * @param {{
   *   baseUrl: string, token?: string, stream: string,
   *   streams: import('./streams.js').StreamRegistry,
   *   retentionSeconds?: number, idleMs?: number,
   *   backoffMinMs?: number, backoffMaxMs?: number,
   *   fetchImpl?: typeof fetch, now?: () => number, random?: () => number,
   *   log?: (msg: string) => void
   * }} options
   */
  constructor({
    baseUrl, token = '', stream, streams, retentionSeconds = 3600, idleMs = 45_000,
    backoffMinMs = 250, backoffMaxMs = 5000, fetchImpl = fetch, now = Date.now,
    random = Math.random, log = () => {},
  }) {
    this.baseUrl = baseUrl ? String(baseUrl).replace(/\/+$/, '') : '';
    this.token = token;
    this.stream = stream;
    this.streams = streams;
    this.retentionSeconds = retentionSeconds;
    this.idleMs = idleMs;
    this.backoffMinMs = backoffMinMs;
    this.backoffMaxMs = backoffMaxMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.random = random;
    this.log = log;

    this.running = false;
    this.connected = false;
    this.lastEventAt = null;
    this.received = 0;
    this.rejected = 0;
    this.deduped = 0;
    this.reconnects = 0;
    this.lastError = null;

    this.attempt = 0;
    this.lastEventId = null;
    this.epoch = null;
    this.seen = new Set();
    this.controller = null;
    this.loop = null;
    this.wake = null;
  }

  /** Start pulling. Does nothing when no gateway URL is configured. */
  start() {
    if (!this.baseUrl || this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Abort the connection and wait for the loop to end. */
  async stop() {
    this.running = false;
    this.connected = false;
    this.controller?.abort();
    this.wake?.();
    if (this.loop) await this.loop;
    this.loop = null;
  }

  status() {
    return {
      configured: Boolean(this.baseUrl),
      connected: this.connected,
      lastEventAt: this.lastEventAt,
      received: this.received,
      rejected: this.rejected,
      deduped: this.deduped,
      reconnects: this.reconnects,
      lastError: this.lastError,
    };
  }

  setError(err) {
    let msg = err && err.message ? err.message : String(err);
    if (this.token) msg = msg.split(this.token).join('[redacted]');
    this.lastError = msg;
  }

  backoffDelay() {
    const base = Math.min(this.backoffMaxMs, this.backoffMinMs * 2 ** this.attempt);
    return Math.min(this.backoffMaxMs, base + this.random() * base * 0.25);
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() { clearTimeout(timer); self.wake = null; resolve(); }
      this.wake = done;
    });
  }

  async run() {
    let first = true;
    while (this.running) {
      if (!first) {
        const delay = this.backoffDelay();
        this.attempt++;
        await this.sleep(delay);
        if (!this.running) break;
        this.reconnects++;
      }
      first = false;
      try {
        await this.connectOnce();
        if (this.running) this.setError(new Error('stream ended'));
      } catch (err) {
        if (this.running) this.setError(err);
      }
      this.connected = false;
    }
  }

  async connectOnce() {
    const controller = new AbortController();
    this.controller = controller;
    let idleTimer = null;
    let idled = false;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idled = true; controller.abort(); }, this.idleMs);
    };
    try {
      const headers = { Accept: 'text/event-stream' };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
      armIdle();
      let res;
      try {
        res = await this.fetchImpl(this.baseUrl + EVENTS_PATH, { headers, signal: controller.signal });
      } catch (err) {
        if (idled) throw new Error(`no data for ${this.idleMs} ms`);
        throw err;
      }
      if (!res.ok) {
        res.body?.cancel?.().catch(() => {});
        throw new Error(`gateway answered HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('gateway response has no body');
      this.connected = true;
      const decoder = new TextDecoder();
      const parser = new SseParser((ev) => this.onEvent(ev));
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        if (idled) throw new Error(`no data for ${this.idleMs} ms`);
        throw err;
      }
    } finally {
      clearTimeout(idleTimer);
      this.connected = false;
      if (this.controller === controller) this.controller = null;
    }
  }

  onEvent({ event, data, id }) {
    if (event === 'ready') { this.attempt = 0; return; }
    if (event !== 'transcript') return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      this.rejected++;
      return;
    }
    try {
      this.onTranscript(payload, id);
    } catch (err) {
      this.rejected++;
      this.setError(err);
    }
  }

  onTranscript(payload, id) {
    if (!payload || typeof payload !== 'object') { this.rejected++; return; }
    const epoch = payload.epoch !== undefined ? String(payload.epoch) : null;
    const seq = payload.seq;
    const nowMs = this.now();
    this.lastEventAt = nowMs;

    if (epoch !== null && Number.isInteger(seq)) {
      if (epoch !== this.epoch) {
        this.epoch = epoch;
        this.seen.clear();
      }
      if (this.seen.has(seq)) { this.deduped++; return; }
      this.seen.add(seq);
      if (this.seen.size > DEDUPE_WINDOW) this.seen.delete(this.seen.values().next().value);
      this.lastEventId = id || `${epoch}:${seq}`;
    }
    this.attempt = 0;

    const checked = validateCaptionBody(
      [{ lang: payload.language, text: payload.text, startedAt: payload.startedAt, endedAt: payload.endedAt }],
      nowMs,
    );
    if (!checked.ok) { this.rejected++; return; }
    const entry = this.streams.ensure(this.stream);
    if (!entry) { this.rejected++; this.setError(new Error('too many streams')); return; }
    this.received += entry.captions.add(checked.segments);
    entry.captions.prune(nowMs - (entry.delaySeconds * 1000 + this.retentionSeconds * 1000));
  }
}
