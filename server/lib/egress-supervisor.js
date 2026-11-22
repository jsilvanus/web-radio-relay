/**
 * Egress supervisor (P4.3): one ffmpeg child per (stream, destination).
 *
 * States: off | starting | live | retrying | failed.
 *  - starting: a child is running and has not yet been up for `liveAfterMs`.
 *  - live: the child has run for `liveAfterMs` without exiting.
 *  - retrying: the child exited; the next attempt is scheduled with backoff
 *    (`backoffMs`, doubled per failure, capped at `maxBackoffMs`).
 *  - failed: ffmpeg could not be started at all (spawn error). No retry is
 *    scheduled; a new start() tries again.
 *  - off: not wanted running (never started, stopped, or stopped while retrying).
 *
 * The key and the url are kept in a private field used only for redaction and
 * for the arguments; state() never returns them. stderr lines are redacted
 * before they enter the 20-line tail.
 *
 * Timers, clock and spawn are injected so tests run without real time or ffmpeg.
 * Not wired into the MediaMTX ready hook here: only the start/stop routes call it.
 */

import { spawn } from 'node:child_process';
import { egressArgs } from './egress-args.js';
import { DEFAULT_RTSP_BASE } from './ffmpeg-input.js';
import { redact } from './redact.js';

export const EGRESS_STATES = ['off', 'starting', 'live', 'retrying', 'failed'];
const TAIL_LINES = 20;

const entryKey = (stream, id) => `${stream}\n${id}`;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export class EgressSupervisor {
  constructor({
    rtspBase = DEFAULT_RTSP_BASE,
    backoffMs = 2000,
    maxBackoffMs = 60000,
    liveAfterMs = 5000,
    stopGraceMs = 5000,
    spawnProcess = spawn,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = () => Date.now(),
  } = {}) {
    this.rtspBase = rtspBase;
    this.backoffMs = backoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.liveAfterMs = liveAfterMs;
    this.stopGraceMs = stopGraceMs;
    this.spawnProcess = spawnProcess;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    /** @type {Map<string, object>} */
    this.entries = new Map();
    this.closing = false;
  }

  /**
   * Starts one destination. `dest` = { id, url, key?, variant? } (key already
   * decrypted). Idempotent while running. Throws 400 for arguments egressArgs
   * refuses and 503 while closing. Returns the state.
   */
  start(stream, dest) {
    if (this.closing) throw httpError(503, 'egress is shutting down');
    const id = dest?.id;
    try {
      // Validation only: the arguments are built again for each launch.
      egressArgs({ stream, variant: dest.variant ?? 'raw', url: dest.url, key: dest.key, rtspBase: this.rtspBase });
    } catch (err) {
      throw httpError(400, err.message);
    }

    const k = entryKey(stream, id);
    let e = this.entries.get(k);
    if (e && e.desiredState === 'running') return this.state(stream, id);
    if (!e) {
      e = {
        stream, id, desiredState: 'stopped', state: 'off', child: null, pid: null,
        generation: 0, startedAt: null, lastTransitionAt: null, restartCount: 0, failures: 0,
        lastError: null, stderrTail: [], stderrPartial: '', liveTimer: null, retryTimer: null,
        target: null, secrets: [],
      };
      this.entries.set(k, e);
    }
    e.target = { url: dest.url, key: dest.key, variant: dest.variant ?? 'raw' };
    e.secrets = [dest.key, dest.url].filter((s) => typeof s === 'string' && s.length > 0);
    e.desiredState = 'running';
    e.lastError = null;
    e.failures = 0;
    e.generation++;
    this.#clearTimers(e);
    this.#launch(e);
    return this.state(stream, id);
  }

  /** Stops one destination: cancels a pending retry and sends SIGTERM (SIGKILL after stopGraceMs). Returns the state. */
  stop(stream, id) {
    const e = this.entries.get(entryKey(stream, id));
    if (!e) return this.state(stream, id);
    e.desiredState = 'stopped';
    e.generation++;
    this.#clearTimers(e);
    const child = e.child;
    e.child = null;
    e.pid = null;
    e.lastError = null;
    e.state = 'off';
    e.lastTransitionAt = this.#iso();
    if (child) this.#terminate(child);
    return this.state(stream, id);
  }

  /** Stops every destination of a stream. Returns the states of that stream. */
  stopStream(stream) {
    for (const e of [...this.entries.values()]) {
      if (e.stream === stream) this.stop(stream, e.id);
    }
    return this.state(stream);
  }

  /**
   * state() → every destination; state(stream) → that stream's destinations;
   * state(stream, id) → one destination (off when it was never started).
   */
  state(stream, id) {
    if (stream === undefined) {
      return [...this.entries.values()].map((e) => this.#view(e));
    }
    if (id === undefined) {
      return [...this.entries.values()].filter((e) => e.stream === stream).map((e) => this.#view(e));
    }
    const e = this.entries.get(entryKey(stream, id));
    if (e) return this.#view(e);
    return { stream, id, state: 'off', pid: null, startedAt: null, lastTransitionAt: null, restartCount: 0, lastError: null, stderrTail: [] };
  }

  /** Stops everything and refuses new starts. */
  async close() {
    this.closing = true;
    for (const e of [...this.entries.values()]) {
      if (e.desiredState === 'running' || e.child || e.retryTimer) this.stop(e.stream, e.id);
    }
  }

  #iso() {
    return new Date(this.now()).toISOString();
  }

  #view(e) {
    return {
      stream: e.stream,
      id: e.id,
      state: e.state,
      pid: e.pid,
      startedAt: e.startedAt,
      lastTransitionAt: e.lastTransitionAt,
      restartCount: e.restartCount,
      lastError: e.lastError,
      stderrTail: [...e.stderrTail],
    };
  }

  #clearTimers(e) {
    if (e.liveTimer !== null) this.clearTimer(e.liveTimer);
    if (e.retryTimer !== null) this.clearTimer(e.retryTimer);
    e.liveTimer = null;
    e.retryTimer = null;
  }

  #terminate(child) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const grace = this.setTimer(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, this.stopGraceMs);
    grace?.unref?.();
    child.once?.('close', () => this.clearTimer(grace));
  }

  #launch(e) {
    const gen = e.generation;
    const { url, key, variant } = e.target;
    let child;
    let args;
    try {
      args = egressArgs({ stream: e.stream, variant, url, key, rtspBase: this.rtspBase });
      child = this.spawnProcess('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      this.#failed(e, gen, 'ffmpeg could not be started');
      return;
    }

    e.child = child;
    e.pid = child.pid ?? null;
    e.state = 'starting';
    e.startedAt = this.#iso();
    e.lastTransitionAt = e.startedAt;
    e.stderrPartial = '';

    child.stderr?.on('data', (chunk) => this.#onStderr(e, gen, chunk));

    e.liveTimer = this.setTimer(() => {
      e.liveTimer = null;
      if (e.generation === gen && e.child === child) {
        e.state = 'live';
        e.lastTransitionAt = this.#iso();
        e.failures = 0;
      }
    }, this.liveAfterMs);

    let gone = false;
    child.once('error', () => {
      if (gone) return;
      gone = true;
      this.#childGone(e, gen, child, { spawnError: true });
    });
    child.once('close', (code, signal) => {
      if (gone) return;
      gone = true;
      this.#childGone(e, gen, child, { code, signal });
    });
  }

  #childGone(e, gen, child, { code = null, signal = null, spawnError = false }) {
    if (e.liveTimer !== null) this.clearTimer(e.liveTimer);
    e.liveTimer = null;
    if (e.generation !== gen || e.child !== child) return; // stopped or replaced: ignore
    this.#flushStderr(e, gen);
    e.child = null;
    e.pid = null;
    if (spawnError) {
      this.#failed(e, gen, 'ffmpeg could not be started');
      return;
    }
    e.lastError = `ffmpeg exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`;
    e.failures++;
    e.restartCount++;
    e.state = 'retrying';
    e.lastTransitionAt = this.#iso();
    const delay = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** (e.failures - 1));
    e.retryTimer = this.setTimer(() => {
      e.retryTimer = null;
      if (e.generation === gen && e.desiredState === 'running' && !this.closing) this.#launch(e);
    }, delay);
    e.retryTimer?.unref?.();
  }

  #failed(e, gen, message) {
    if (e.generation !== gen) return;
    this.#clearTimers(e);
    e.child = null;
    e.pid = null;
    e.desiredState = 'stopped';
    e.state = 'failed';
    e.lastError = message;
    e.lastTransitionAt = this.#iso();
  }

  #onStderr(e, gen, chunk) {
    if (e.generation !== gen) return;
    const lines = (e.stderrPartial + String(chunk)).split(/\r?\n/);
    e.stderrPartial = lines.pop();
    for (const line of lines) this.#pushLine(e, line);
  }

  #flushStderr(e, gen) {
    if (e.generation !== gen || !e.stderrPartial) return;
    this.#pushLine(e, e.stderrPartial);
    e.stderrPartial = '';
  }

  #pushLine(e, line) {
    if (!line.trim()) return;
    e.stderrTail.push(redact(line, e.secrets));
    if (e.stderrTail.length > TAIL_LINES) e.stderrTail.splice(0, e.stderrTail.length - TAIL_LINES);
  }
}
