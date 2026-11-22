/**
 * Recording to S3 (P5.3). One recorder child per stream (copy-only ffmpeg,
 * see recorder-args.js) writes 60 s fMP4 segments into a spool directory; an
 * uploader moves every closed segment to S3 and deletes the local copy only
 * after a verified upload. At stop the remaining segments are uploaded, then
 * the sidecars and `session.json` are written once.
 *
 * Layout in the bucket (keys are relative to S3_PREFIX):
 *   recordings/<stream>/<sessionId>/<NNNNNN>.mp4
 *   recordings/<stream>/<sessionId>/sidecars/<name>
 *   recordings/<stream>/<sessionId>/session.json
 *   recordings/<stream>/<sessionId>/handoff.json   (Saarnavideo manifest with presigned URLs, when the S3 client can presign)
 *
 * States: recording | degraded | failed | stopping | stopped | interrupted.
 *  - degraded: the spool of all sessions is over spoolMaxBytes. Recording goes on;
 *    nothing that is not uploaded yet is deleted.
 *  - failed: the recorder could not be started (no retry; stop still uploads what exists).
 *  - stopping: the recorder is gone, uploads of the rest are still being retried.
 *  - interrupted: close() stopped the recorder at shutdown. The spool is kept.
 *
 * Never logs keys or secrets: messages carry the stream, the session id and
 * segment file names only. S3 errors carry the HTTP status and the S3 code.
 * Clock, timers, spawn and S3 are injected.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { recorderArgs, closedSegments } from './recorder-args.js';
import { DEFAULT_RTSP_BASE, assertDirectory, assertStreamName } from './ffmpeg-input.js';
import { rangeEvents } from './event-store.js';
import { buildSidecars } from './sidecars.js';
import { buildHandoffManifest } from './handoff-manifest.js';
import { redact } from './redact.js';

export const RECORDING_STATES = ['recording', 'degraded', 'failed', 'stopping', 'stopped', 'interrupted'];
const ACTIVE = new Set(['recording', 'degraded', 'failed']);
const SEGMENT_FILE = /^\d{6}\.mp4$/;
const LANG = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/;
const TAIL_LINES = 10;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/** Sortable id: UTC timestamp to the millisecond plus 8 random hex characters, e.g. 20261122101010123-3f9a0c2b. */
export function newSessionId(nowMs, hex = randomBytes(4).toString('hex')) {
  const stamp = new Date(nowMs).toISOString().replace(/\D/g, '').slice(0, 17);
  return `${stamp}-${hex}`;
}

/** Object key of one segment, relative to the bucket prefix. `name` is the file name NNNNNN.mp4. */
export function segmentKey(stream, sessionId, name) {
  return `recordings/${stream}/${sessionId}/${name}`;
}

/** Segment file names of a spool directory, sorted; anything else is ignored. */
function listSegments(dir) {
  try {
    return readdirSync(dir).filter((n) => SEGMENT_FILE.test(n)).sort();
  } catch {
    return [];
  }
}

function spoolBytesOf(dir) {
  let total = 0;
  for (const name of listSegments(dir)) {
    try {
      total += statSync(path.join(dir, name)).size;
    } catch {
      // removed meanwhile
    }
  }
  return total;
}

/**
 * @param {object} options
 * @param {object} options.db              open store database (store.js)
 * @param {object|null} options.s3         S3 client (s3.js); null = recording off (start answers 503)
 * @param {string} options.spoolDir        RECORDING_SPOOL_DIR
 * @param {Function} [options.spawnProcess]
 * @param {string} [options.rtspBase]
 * @param {number} [options.spoolMaxBytes] RECORDING_SPOOL_MAX_BYTES (default 2 GiB)
 * @param {number} [options.uploadIntervalMs] uploader period (default 5 s)
 */
export function createRecordingService({
  db,
  s3 = null,
  spoolDir,
  spawnProcess = spawn,
  rtspBase = DEFAULT_RTSP_BASE,
  spoolMaxBytes = 2 * 1024 ** 3,
  uploadIntervalMs = 5000,
  handoffTtlSeconds = 86400,
  relayName = '',
  backoffMs = 2000,
  maxBackoffMs = 60000,
  liveAfterMs = 5000,
  stopGraceMs = 5000,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  newId = newSessionId,
  log = () => {},
} = {}) {
  if (!db) throw new Error('recording service needs db');
  const root = assertDirectory(spoolDir, 'spoolDir');
  /** @type {Map<string, object>} one session per stream (the latest one) */
  const sessions = new Map();
  let closing = false;

  // ---- database -----------------------------------------------------------

  function dbUpdate(s, { state, endedAt = null, manifestJson = null }) {
    db.prepare(
      'UPDATE recordings SET state = ?, ended_at = COALESCE(?, ended_at), manifest_json = COALESCE(?, manifest_json) WHERE id = ?',
    ).run(state, endedAt, manifestJson, s.sessionId);
  }

  function setState(s, state) {
    if (s.state === state) return;
    s.state = state;
    dbUpdate(s, { state });
    log(`[recording] ${s.stream} ${s.sessionId}: ${state}`);
  }

  // ---- view -----------------------------------------------------------------

  function view(s) {
    return {
      stream: s.stream,
      sessionId: s.sessionId,
      state: s.state,
      startedAt: iso(s.startedAt),
      endedAt: iso(s.endedAt),
      spoolBytes: s.spoolBytes,
      segmentsUploaded: s.segments.size,
      recorder: s.recorder,
      restartCount: s.restartCount,
      lastError: s.lastError,
      uploadError: s.uploadError,
      stderrTail: [...s.stderrTail],
    };
  }

  // ---- recorder child (same pattern as egress-supervisor.js) -----------------

  function clearTimers(s) {
    for (const key of ['liveTimer', 'retryTimer', 'tickTimer']) {
      if (s[key] !== null) clearTimer(s[key]);
      s[key] = null;
    }
  }

  function pushStderr(s, line) {
    if (!line.trim()) return;
    s.stderrTail.push(redact(line));
    if (s.stderrTail.length > TAIL_LINES) s.stderrTail.splice(0, s.stderrTail.length - TAIL_LINES);
  }

  function failRecorder(s, gen, message) {
    if (s.generation !== gen) return;
    clearTimers(s);
    s.child = null;
    s.desired = 'stopped';
    s.recorder = 'failed';
    s.lastError = message;
    setState(s, 'failed');
  }

  function launch(s) {
    const gen = s.generation;
    let child;
    try {
      const onDisk = listSegments(s.dir).map((n) => Number(n.slice(0, 6)) + 1);
      // A relaunched recorder continues the numbering: a reused name would overwrite an uploaded object.
      const segmentStartNumber = Math.max(s.nextSegment, 0, ...onDisk);
      const args = recorderArgs({
        stream: s.stream, spoolDir: root, sessionId: s.sessionId, rtspBase, segmentStartNumber,
      });
      child = spawnProcess('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      failRecorder(s, gen, 'recorder could not be started');
      return;
    }

    s.child = child;
    s.recorder = 'running';
    s.stderrPartial = '';
    child.stderr?.on('data', (chunk) => {
      if (s.generation !== gen) return;
      const lines = (s.stderrPartial + String(chunk)).split(/\r?\n/);
      s.stderrPartial = lines.pop();
      for (const line of lines) pushStderr(s, line);
    });

    s.liveTimer = setTimer(() => {
      s.liveTimer = null;
      if (s.generation === gen && s.child === child) s.failures = 0;
    }, liveAfterMs);

    let gone = false;
    child.once('error', () => {
      if (gone) return;
      gone = true;
      childGone(s, gen, child, { spawnError: true });
    });
    child.once('close', (code, signal) => {
      if (gone) return;
      gone = true;
      childGone(s, gen, child, { code, signal });
    });
  }

  function childGone(s, gen, child, { code = null, signal = null, spawnError = false }) {
    if (s.liveTimer !== null) clearTimer(s.liveTimer);
    s.liveTimer = null;
    if (s.generation !== gen || s.child !== child) return; // stopped or replaced
    if (s.stderrPartial) pushStderr(s, s.stderrPartial);
    s.stderrPartial = '';
    s.child = null;
    if (spawnError) {
      failRecorder(s, gen, 'recorder could not be started');
      return;
    }
    s.lastError = `ffmpeg exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`;
    s.failures++;
    s.restartCount++;
    s.recorder = 'retrying';
    const delay = Math.min(maxBackoffMs, backoffMs * 2 ** (s.failures - 1));
    s.retryTimer = setTimer(() => {
      s.retryTimer = null;
      if (s.generation === gen && s.desired === 'running' && !closing) launch(s);
    }, delay);
    s.retryTimer?.unref?.();
  }

  /** Resolves once the child has exited (SIGTERM, SIGKILL after stopGraceMs). */
  function terminate(child) {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      child.once('close', finish);
      child.once('error', finish);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const grace = setTimer(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        const last = setTimer(finish, stopGraceMs);
        last?.unref?.();
      }, stopGraceMs);
      grace?.unref?.();
    });
  }

  // ---- uploader ------------------------------------------------------------

  function scheduleTick(s) {
    if (s.tickTimer !== null) return;
    if (!['recording', 'degraded', 'failed', 'stopping'].includes(s.state)) return;
    s.tickTimer = setTimer(() => {
      s.tickTimer = null;
      void pass(s);
    }, uploadIntervalMs);
    s.tickTimer?.unref?.();
  }

  async function uploadSegment(s, name) {
    const n = Number(name.slice(0, 6));
    const key = segmentKey(s.stream, s.sessionId, name);
    const file = path.join(s.dir, name);
    const body = await readFile(file);
    const put = await s3.putObject(key, body, { contentType: 'video/mp4' });
    const head = await s3.headObject(key);
    if (!head) throw new Error('uploaded segment not found');
    if (head.size !== body.length) throw new Error('uploaded segment size differs');
    if (put?.etag && head.etag && put.etag !== head.etag) throw new Error('uploaded segment ETag differs');
    await unlink(file);
    s.segments.set(n, { n, key, bytes: body.length });
    s.nextSegment = Math.max(s.nextSegment, n + 1);
  }

  /** Handoff manifest with presigned URLs, or null when the recording has no segments. */
  function buildHandoffFor(session, segments, sidecars, events) {
    if (segments.length === 0) return null;
    return buildHandoffManifest({
      session,
      segments,
      sidecars,
      events,
      urlFor: (key) => s3.presignGet(key, handoffTtlSeconds),
      relayName: relayName || undefined,
    });
  }

  async function finalize(s) {
    const events = rangeEvents(db, { stream: s.stream, fromMs: s.startedAt, toMs: s.endedAt + 1 });
    const langs = [...new Set(events
      .filter((e) => (e.type === 'caption' || e.type === 'translation') && e.lang && LANG.test(e.lang))
      .map((e) => e.lang))].sort();
    const files = buildSidecars(events, { originMs: s.startedAt, endMs: s.endedAt, langs });
    const prefix = `recordings/${s.stream}/${s.sessionId}/`;
    for (const [name, text] of Object.entries(files)) {
      const type = name.endsWith('.json')
        ? 'application/json'
        : name.endsWith('.jsonl') ? 'application/x-ndjson' : 'text/plain; charset=utf-8';
      await s3.putObject(`${prefix}sidecars/${name}`, text, { contentType: type });
    }
    const manifest = {
      stream: s.stream,
      sessionId: s.sessionId,
      startedAt: iso(s.startedAt),
      endedAt: iso(s.endedAt),
      segments: [...s.segments.values()].sort((a, b) => a.n - b.n).map(({ n, key, bytes }) => ({ n, key, bytes })),
      sidecars: Object.keys(files),
    };
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    await s3.putObject(`${prefix}session.json`, manifestJson, { contentType: 'application/json' });
    if (typeof s3.presignGet === 'function') {
      const handoff = buildHandoffFor(
        { stream: s.stream, sessionId: s.sessionId, startedAt: s.startedAt, endedAt: s.endedAt },
        manifest.segments, manifest.sidecars, events,
      );
      if (handoff) {
        await s3.putObject(`${prefix}handoff.json`, `${JSON.stringify(handoff, null, 2)}\n`, { contentType: 'application/json' });
      }
    }
    s.finalized = true;
    s.state = 'stopped';
    dbUpdate(s, { state: 'stopped', endedAt: s.endedAt, manifestJson });
    log(`[recording] ${s.stream} ${s.sessionId}: stopped, ${manifest.segments.length} segment(s)`);
  }

  function applyCap() {
    const total = [...sessions.values()].reduce((sum, x) => sum + x.spoolBytes, 0);
    for (const x of sessions.values()) {
      if (x.state !== 'recording' && x.state !== 'degraded') continue;
      setState(x, total > spoolMaxBytes ? 'degraded' : 'recording');
    }
  }

  async function runPass(s) {
    const finalPass = s.state === 'stopping';
    const names = listSegments(s.dir);
    for (const name of names) s.nextSegment = Math.max(s.nextSegment, Number(name.slice(0, 6)) + 1);
    const ready = finalPass ? names : closedSegments(names);
    for (const name of ready) {
      try {
        await uploadSegment(s, name);
        s.uploadError = null;
      } catch (err) {
        s.uploadError = err.message;
        log(`[recording] ${s.stream} ${s.sessionId}: segment ${name} kept, upload failed: ${err.message}`);
        break; // keep the order: later segments wait for this one
      }
    }
    s.spoolBytes = spoolBytesOf(s.dir);
    if (finalPass && !s.finalized && listSegments(s.dir).length === 0) {
      try {
        await finalize(s);
      } catch (err) {
        s.uploadError = err.message;
        log(`[recording] ${s.stream} ${s.sessionId}: session files not written yet: ${err.message}`);
      }
    }
    applyCap();
  }

  /** Single-flight uploader pass; schedules the next tick while the session is not finished. */
  function pass(s) {
    if (!s.inflight) {
      s.inflight = runPass(s).finally(() => {
        s.inflight = null;
        scheduleTick(s);
      });
    }
    return s.inflight;
  }

  // ---- public API -----------------------------------------------------------

  /** Starts a recording of `stream`. A running one is returned as it is. */
  function start(stream) {
    try {
      assertStreamName(stream);
    } catch (err) {
      throw httpError(400, err.message);
    }
    if (closing) throw httpError(503, 'recording is shutting down');
    if (!s3) throw httpError(503, 'recording needs S3: set S3_ENDPOINT and S3_BUCKET');

    const current = sessions.get(stream);
    if (current && ACTIVE.has(current.state)) return view(current);
    if (current && current.state === 'stopping') {
      throw httpError(409, 'the previous recording of this stream is still uploading');
    }

    const startedAt = now();
    const sessionId = newId(startedAt);
    const dir = path.join(root, sessionId);
    mkdirSync(dir, { recursive: true });
    db.prepare('INSERT OR IGNORE INTO streams (name, created_at) VALUES (?, ?)').run(stream, startedAt);
    db.prepare(
      'INSERT INTO recordings (id, stream, started_at, ended_at, state, manifest_json) VALUES (?, ?, ?, NULL, ?, NULL)',
    ).run(sessionId, stream, startedAt, 'recording');

    const s = {
      stream, sessionId, dir, state: 'recording', startedAt, endedAt: null,
      child: null, generation: 0, desired: 'running', failures: 0, restartCount: 0,
      recorder: 'stopped', lastError: null, uploadError: null, stderrTail: [], stderrPartial: '',
      liveTimer: null, retryTimer: null, tickTimer: null,
      segments: new Map(), nextSegment: 0, spoolBytes: 0, inflight: null, finalized: false, stopping: null,
    };
    sessions.set(stream, s);
    log(`[recording] ${stream} ${sessionId}: started`);
    launch(s);
    scheduleTick(s);
    return view(s);
  }

  async function doStop(s) {
    s.desired = 'stopped';
    s.generation++;
    clearTimers(s);
    s.endedAt = now();
    s.state = 'stopping';
    dbUpdate(s, { state: 'stopping', endedAt: s.endedAt });
    const child = s.child;
    s.child = null;
    s.recorder = 'stopped';
    if (child) await terminate(child);
    while (s.inflight) await s.inflight;
    await pass(s);
    return view(s);
  }

  /**
   * Stops the recording: the recorder goes, the rest is uploaded, then the
   * sidecars and session.json are written once. A second call returns the
   * same result and writes nothing again.
   * @returns {Promise<object>} the session view (state `stopping` while uploads are still retried)
   */
  function stop(stream) {
    const s = sessions.get(stream);
    if (!s) return Promise.reject(httpError(404, 'no recording for this stream'));
    if (s.stopping) return s.stopping;
    if (s.state === 'stopped') return Promise.resolve(view(s));
    s.stopping = doStop(s);
    return s.stopping;
  }

  /** The current (or last) session of a stream, or null. */
  function state(stream) {
    const s = sessions.get(stream);
    return s ? view(s) : null;
  }

  /** Recordings of a stream from the database, newest first. */
  function list(stream) {
    return db
      .prepare('SELECT id, started_at, ended_at, state, manifest_json FROM recordings WHERE stream = ? ORDER BY started_at DESC, id DESC')
      .all(stream)
      .map((row) => {
        let manifest = null;
        if (row.manifest_json) {
          try { manifest = JSON.parse(row.manifest_json); } catch { manifest = null; }
        }
        return {
          sessionId: row.id,
          stream,
          startedAt: iso(row.started_at),
          endedAt: iso(row.ended_at),
          state: row.state,
          manifest,
        };
      });
  }

  /**
   * Handoff manifest of a stopped recording with fresh presigned URLs (the
   * stored handoff.json has the URLs of the stop time, which may have expired).
   * Errors carry a statusCode: 404 unknown session, 409 not stopped or no
   * segments, 503 no S3 or an S3 client that cannot presign.
   */
  function handoff(stream, sessionId) {
    const row = db
      .prepare('SELECT id, started_at, ended_at, state, manifest_json FROM recordings WHERE stream = ? AND id = ?')
      .get(stream, sessionId);
    if (!row) throw httpError(404, 'no such recording');
    if (!s3 || typeof s3.presignGet !== 'function') throw httpError(503, 'handoff needs S3 with presigned URLs');
    let saved = null;
    try { saved = row.manifest_json ? JSON.parse(row.manifest_json) : null; } catch { saved = null; }
    if (row.state !== 'stopped' || !saved) throw httpError(409, 'the recording has not been stopped and finalized yet');
    const events = rangeEvents(db, { stream, fromMs: row.started_at, toMs: row.ended_at + 1 });
    const manifest = buildHandoffFor(
      { stream, sessionId, startedAt: row.started_at, endedAt: row.ended_at },
      saved.segments ?? [], saved.sidecars ?? [], events,
    );
    if (!manifest) throw httpError(409, 'the recording has no segments');
    return manifest;
  }

  /** Runs one uploader pass now (the timer does the same every uploadIntervalMs). Resolves when it is done. */
  async function flush(stream) {
    const s = sessions.get(stream);
    if (s) await pass(s);
  }

  /**
   * Shutdown: recorders are stopped and their sessions marked interrupted.
   * The spool is not touched and nothing is uploaded here.
   */
  async function close() {
    closing = true;
    const waits = [];
    for (const s of sessions.values()) {
      if (s.state === 'stopped' || s.state === 'stopping' || s.state === 'interrupted') continue;
      s.desired = 'stopped';
      s.generation++;
      clearTimers(s);
      const child = s.child;
      s.child = null;
      s.recorder = 'stopped';
      s.endedAt = now();
      s.state = 'interrupted';
      dbUpdate(s, { state: 'interrupted', endedAt: s.endedAt });
      if (child) waits.push(terminate(child));
    }
    await Promise.allSettled(waits);
  }

  return { start, stop, state, list, handoff, flush, close, spoolDir: root, spoolMaxBytes };
}
