/**
 * Video HLS packager (P6.1): one copy-only ffmpeg child per stream that writes
 * <HLS_DIR>/<stream>/video/stream.m3u8 and its segments (hls-args.js).
 *
 * Same child and backoff pattern as egress-supervisor.js, with one role per
 * stream (no destinations). States: off | starting | live | retrying | failed.
 * The ready hook starts it when config.videoHls is on; the notready hook stops it.
 *
 * Timers, clock, spawn and the directory creation are injected so tests run without
 * real time or ffmpeg. stderr lines are redacted before they enter the tail.
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { hlsArgs } from './hls-args.js';
import { DEFAULT_RTSP_BASE, assertStreamName } from './ffmpeg-input.js';
import { redact } from './redact.js';

export const HLS_STATES = ['off', 'starting', 'live', 'retrying', 'failed'];
const TAIL_LINES = 20;

export class HlsPackager {
  constructor({
    hlsDir,
    hlsTime = 4,
    listSize = 30,
    rtspBase = DEFAULT_RTSP_BASE,
    backoffMs = 2000,
    maxBackoffMs = 60000,
    liveAfterMs = 5000,
    stopGraceMs = 5000,
    spawnProcess = spawn,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = () => Date.now(),
    makeDir = (dir) => mkdirSync(dir, { recursive: true }),
  } = {}) {
    if (typeof hlsDir !== 'string' || hlsDir.replace(/\/+$/, '') === '') {
      throw new Error('invalid hlsDir: expected a non-empty path');
    }
    this.hlsDir = hlsDir.replace(/\/+$/, '');
    this.hlsTime = hlsTime;
    this.listSize = listSize;
    this.rtspBase = rtspBase;
    this.backoffMs = backoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.liveAfterMs = liveAfterMs;
    this.stopGraceMs = stopGraceMs;
    this.spawnProcess = spawnProcess;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.makeDir = makeDir;
    /** @type {Map<string, object>} one entry per stream */
    this.entries = new Map();
    this.closing = false;
  }

  /** Starts the packager of `stream`. Idempotent while running. Returns the state. Throws when the directory or the arguments are refused. */
  start(stream) {
    if (this.closing) throw Object.assign(new Error('video HLS is shutting down'), { statusCode: 503 });
    assertStreamName(stream);
    this.makeDir(path.join(this.hlsDir, stream, 'video'));

    let e = this.entries.get(stream);
    if (e && e.desired === 'running') return this.state(stream);
    if (!e) {
      e = {
        stream, desired: 'stopped', state: 'off', child: null, pid: null, generation: 0,
        startedAt: null, lastTransitionAt: null, restartCount: 0, failures: 0, lastError: null,
        stderrTail: [], stderrPartial: '', liveTimer: null, retryTimer: null,
      };
      this.entries.set(stream, e);
    }
    e.desired = 'running';
    e.lastError = null;
    e.failures = 0;
    e.generation++;
    this.#clearTimers(e);
    this.#launch(e);
    return this.state(stream);
  }

  /** Stops the packager: cancels a pending retry and sends SIGTERM (SIGKILL after stopGraceMs). Returns the state. */
  stop(stream) {
    const e = this.entries.get(stream);
    if (!e) return this.state(stream);
    e.desired = 'stopped';
    e.generation++;
    this.#clearTimers(e);
    const child = e.child;
    e.child = null;
    e.pid = null;
    e.lastError = null;
    e.state = 'off';
    e.lastTransitionAt = this.#iso();
    if (child) this.#terminate(child);
    return this.state(stream);
  }

  /** The view of one stream (state 'off' when never started). */
  state(stream) {
    const e = this.entries.get(stream);
    if (!e) return { stream, state: 'off', pid: null, startedAt: null, lastTransitionAt: null, restartCount: 0, lastError: null, stderrTail: [] };
    return {
      stream,
      state: e.state,
      pid: e.pid,
      startedAt: e.startedAt,
      lastTransitionAt: e.lastTransitionAt,
      restartCount: e.restartCount,
      lastError: e.lastError,
      stderrTail: [...e.stderrTail],
    };
  }

  /** Stops every packager and refuses new starts. */
  async close() {
    this.closing = true;
    for (const e of [...this.entries.values()]) {
      if (e.desired === 'running' || e.child || e.retryTimer) this.stop(e.stream);
    }
  }

  #iso() {
    return new Date(this.now()).toISOString();
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
    let child;
    try {
      const args = hlsArgs({
        stream: e.stream, hlsDir: this.hlsDir, hlsTime: this.hlsTime, listSize: this.listSize, rtspBase: this.rtspBase,
      });
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
    if (e.generation !== gen || e.child !== child) return; // stopped or replaced
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
      if (e.generation === gen && e.desired === 'running' && !this.closing) this.#launch(e);
    }, delay);
    e.retryTimer?.unref?.();
  }

  #failed(e, gen, message) {
    if (e.generation !== gen) return;
    this.#clearTimers(e);
    e.child = null;
    e.pid = null;
    e.desired = 'stopped';
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
    e.stderrTail.push(redact(line));
    if (e.stderrTail.length > TAIL_LINES) e.stderrTail.splice(0, e.stderrTail.length - TAIL_LINES);
  }
}
