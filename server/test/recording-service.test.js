import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openStore } from '../lib/store.js';
import { addEvents } from '../lib/event-store.js';
import { createToken } from '../lib/tokens.js';
import { createRecordingService } from '../lib/recording-service.js';
import { createRecordingRouter } from '../lib/recording-routes.js';
import { recorderArgs } from '../lib/recorder-args.js';

test('recorderArgs: segmentStartNumber adds a flag only when given', () => {
  const base = { stream: 'main', spoolDir: '/spool', sessionId: 's-1' };
  const plain = recorderArgs(base);
  assert.equal(plain.includes('-segment_start_number'), false);
  const resumed = recorderArgs({ ...base, segmentStartNumber: 7 });
  const i = resumed.indexOf('-segment_start_number');
  assert.equal(resumed[i + 1], '7');
  assert.equal(resumed[resumed.length - 1], '/spool/s-1/%06d.mp4');
  assert.deepEqual(resumed.filter((a) => a !== '-segment_start_number' && a !== '7'), plain);
  assert.throws(() => recorderArgs({ ...base, segmentStartNumber: -1 }), /segmentStartNumber/);
});

const T0 = 1_700_000_000_000;
const RTSP = 'rtsp://relay.example.com:8554';

/** In-memory S3 bucket: keys in a Map, every successful PUT recorded in order. */
function fakeS3() {
  const objects = new Map();
  const puts = [];
  const etagOf = (buf) => `"${createHash('md5').update(buf).digest('hex')}"`;
  const s3 = {
    objects,
    puts,
    failPuts: 0,
    failAll: false,
    async putObject(key, body) {
      if (s3.failAll || s3.failPuts > 0) {
        if (s3.failPuts > 0) s3.failPuts--;
        throw Object.assign(new Error('S3 PutObject failed: HTTP 500 InternalError'), { status: 500, code: 'InternalError' });
      }
      const buf = Buffer.from(body);
      objects.set(key, buf);
      puts.push(key);
      return { etag: etagOf(buf) };
    },
    async headObject(key) {
      const buf = objects.get(key);
      return buf ? { size: buf.length, etag: etagOf(buf) } : null;
    },
    async deleteObject(key) {
      objects.delete(key);
    },
  };
  return s3;
}

/** Fake ffmpeg children: a SIGTERM closes the child on the next tick, like a real exit. */
function fakeSpawn({ throwOnSpawn = false } = {}) {
  const children = [];
  const spawnProcess = (cmd, args) => {
    if (throwOnSpawn) throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    const child = new EventEmitter();
    child.pid = 9000 + children.length;
    child.exitCode = null;
    child.signalCode = null;
    child.cmd = cmd;
    child.args = args;
    child.signals = [];
    child.stderr = new PassThrough();
    child.kill = (signal = 'SIGTERM') => {
      child.signals.push(signal);
      setImmediate(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.signalCode = signal;
          child.emit('close', null, signal);
        }
      });
      return true;
    };
    child.crash = (code = 1) => {
      child.exitCode = code;
      child.emit('close', code, null);
    };
    children.push(child);
    return child;
  };
  return { children, spawnProcess };
}

/** Timers that never run by themselves: a test fires the one it needs. */
function fakeTimers() {
  let seq = 0;
  const timers = new Map();
  return {
    timers,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    /** Runs the oldest pending timer with this delay. Returns false when there is none. */
    fire(ms) {
      for (const [id, t] of timers) {
        if (t.ms === ms) {
          timers.delete(id);
          t.fn();
          return true;
        }
      }
      return false;
    },
  };
}

function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-recording-'));
  const spoolDir = path.join(dir, 'spool');
  const db = openStore(':memory:').db;
  const s3 = options.noS3 ? null : fakeS3();
  if (s3 && options.presign) {
    s3.presignGet = (key, ttl) => `https://s3.example.com/bucket/${key}?X-Amz-Expires=${ttl}&X-Amz-Signature=sig`;
  }
  const clock = { t: T0 };
  const fake = fakeSpawn({ throwOnSpawn: options.throwOnSpawn });
  const timers = fakeTimers();
  const logs = [];
  const service = createRecordingService({
    db,
    s3,
    spoolDir,
    spawnProcess: fake.spawnProcess,
    rtspBase: RTSP,
    spoolMaxBytes: options.spoolMaxBytes ?? 1024 ** 3,
    uploadIntervalMs: 7000,
    handoffTtlSeconds: 3600,
    relayName: options.relayName ?? '',
    backoffMs: 2000,
    liveAfterMs: 5000,
    stopGraceMs: 3000,
    now: () => clock.t,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    log: (msg) => logs.push(msg),
  });
  return {
    dir, spoolDir, db, s3, clock, fake, timers, service, logs,
    cleanup() {
      service.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Writes a segment file into the session's spool directory (what ffmpeg would have written). */
function writeSegment(env, sessionId, n, bytes = 200) {
  const file = path.join(env.spoolDir, sessionId, `${String(n).padStart(6, '0')}.mp4`);
  fs.writeFileSync(file, Buffer.alloc(bytes, n + 1));
  return file;
}

const segmentsOnDisk = (env, sessionId) => fs.readdirSync(path.join(env.spoolDir, sessionId)).sort();

test('start spawns the recorder, records a row, and a second start returns the same session', () => {
  const env = setup();
  try {
    const first = env.service.start('main');
    assert.equal(first.state, 'recording');
    assert.equal(first.stream, 'main');
    assert.match(first.sessionId, /^\d{17}-[0-9a-f]{8}$/);
    assert.equal(env.fake.children.length, 1);

    const args = env.fake.children[0].args;
    assert.ok(args.includes(`rtsp://relay.example.com:8554/live/main`));
    assert.ok(args.includes(`${env.spoolDir}/${first.sessionId}/%06d.mp4`) || args.includes(path.join(env.spoolDir, first.sessionId, '%06d.mp4')));
    assert.ok(fs.statSync(path.join(env.spoolDir, first.sessionId)).isDirectory());

    const second = env.service.start('main');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(env.fake.children.length, 1, 'no second recorder');

    const row = env.db.prepare('SELECT stream, state, ended_at FROM recordings WHERE id = ?').get(first.sessionId);
    assert.deepEqual({ ...row }, { stream: 'main', state: 'recording', ended_at: null });
  } finally {
    env.cleanup();
  }
});

test('without S3 start answers 503 and starts nothing', () => {
  const env = setup({ noS3: true });
  try {
    assert.throws(() => env.service.start('main'), (err) => {
      assert.equal(err.statusCode, 503);
      assert.match(err.message, /S3_ENDPOINT and S3_BUCKET/);
      return true;
    });
    assert.equal(env.fake.children.length, 0);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM recordings').get().n, 0);
  } finally {
    env.cleanup();
  }
});

test('a bad stream name is a 400', () => {
  const env = setup();
  try {
    assert.throws(() => env.service.start('Not Valid'), (err) => err.statusCode === 400);
  } finally {
    env.cleanup();
  }
});

test('uploads closed segments in order, deletes them, keeps the newest until stop', async () => {
  const env = setup();
  try {
    const { sessionId } = env.service.start('main');
    for (const n of [0, 1, 2]) writeSegment(env, sessionId, n);

    await env.service.flush('main');

    assert.deepEqual(env.s3.puts, [
      `recordings/main/${sessionId}/000000.mp4`,
      `recordings/main/${sessionId}/000001.mp4`,
    ]);
    assert.deepEqual(segmentsOnDisk(env, sessionId), ['000002.mp4'], 'closed ones deleted, newest kept');
    assert.equal(env.s3.objects.get(`recordings/main/${sessionId}/000000.mp4`).length, 200);
    assert.equal(env.service.state('main').segmentsUploaded, 2);
  } finally {
    env.cleanup();
  }
});

test('an uploaded segment has the same bytes in S3 and is removed from the spool', async () => {
  const env = setup();
  try {
    const { sessionId } = env.service.start('main');
    writeSegment(env, sessionId, 0, 321);
    writeSegment(env, sessionId, 1);
    await env.service.flush('main');
    const stored = env.s3.objects.get(`recordings/main/${sessionId}/000000.mp4`);
    assert.equal(stored.length, 321);
    assert.deepEqual(stored, Buffer.alloc(321, 1));
    assert.equal(fs.existsSync(path.join(env.spoolDir, sessionId, '000000.mp4')), false);
  } finally {
    env.cleanup();
  }
});

test('an S3 500 keeps the file and the next pass uploads it', async () => {
  const env = setup();
  try {
    const { sessionId } = env.service.start('main');
    writeSegment(env, sessionId, 0);
    writeSegment(env, sessionId, 1);
    env.s3.failPuts = 1;

    await env.service.flush('main');
    assert.equal(env.s3.objects.size, 0);
    assert.deepEqual(segmentsOnDisk(env, sessionId), ['000000.mp4', '000001.mp4']);
    assert.match(env.service.state('main').uploadError, /HTTP 500 InternalError/);

    await env.service.flush('main');
    assert.equal(env.s3.objects.has(`recordings/main/${sessionId}/000000.mp4`), true);
    assert.deepEqual(segmentsOnDisk(env, sessionId), ['000001.mp4']);
    assert.equal(env.service.state('main').uploadError, null);
  } finally {
    env.cleanup();
  }
});

test('a spool over the cap is degraded, nothing unuploaded is deleted, and it recovers under the cap', async () => {
  const env = setup({ spoolMaxBytes: 300 });
  try {
    const { sessionId } = env.service.start('main');
    writeSegment(env, sessionId, 0, 200);
    writeSegment(env, sessionId, 1, 200);
    env.s3.failAll = true;

    await env.service.flush('main');
    assert.equal(env.service.state('main').state, 'degraded');
    assert.deepEqual(segmentsOnDisk(env, sessionId), ['000000.mp4', '000001.mp4'], 'nothing deleted');
    assert.equal(env.db.prepare('SELECT state FROM recordings WHERE id = ?').get(sessionId).state, 'degraded');

    env.s3.failAll = false;
    await env.service.flush('main');
    assert.deepEqual(segmentsOnDisk(env, sessionId), ['000001.mp4']);
    assert.equal(env.service.state('main').state, 'recording');
  } finally {
    env.cleanup();
  }
});

test('the recorder that exits is relaunched with backoff and keeps the segment numbering', async () => {
  const env = setup();
  try {
    const { sessionId } = env.service.start('main');
    writeSegment(env, sessionId, 0);
    writeSegment(env, sessionId, 1);
    env.fake.children[0].crash(1);

    const view = env.service.state('main');
    assert.equal(view.recorder, 'retrying');
    assert.equal(view.restartCount, 1);
    assert.match(view.lastError, /ffmpeg exited \(code 1/);

    assert.equal(env.timers.fire(2000), true, 'retry scheduled after backoffMs');
    assert.equal(env.fake.children.length, 2);
    const args = env.fake.children[1].args;
    assert.equal(args[args.indexOf('-segment_start_number') + 1], '2', 'no reused file name');
    assert.equal(env.service.state('main').recorder, 'running');
  } finally {
    env.cleanup();
  }
});

test('a recorder that cannot be spawned is state failed; stop still works', async () => {
  const env = setup({ throwOnSpawn: true });
  try {
    const view = env.service.start('main');
    assert.equal(view.state, 'failed');
    assert.equal(view.lastError, 'recorder could not be started');
    assert.equal(env.timers.fire(2000), false, 'no retry');
    const stopped = await env.service.stop('main');
    assert.equal(stopped.state, 'stopped');
  } finally {
    env.cleanup();
  }
});

test('stop uploads the last segment, writes sidecars and session.json once, and updates the row', async () => {
  const env = setup();
  try {
    addEvents(env.db, 'main', [
      { type: 'caption', lang: 'fi', startedAt: T0 + 1000, endedAt: T0 + 3000, payload: { text: 'Hyvää huomenta' } },
      { type: 'caption', lang: 'fi', startedAt: T0 + 4000, endedAt: T0 + 6000, payload: { text: 'Aamen' } },
      { type: 'section', startedAt: T0 + 500, payload: { title: 'Alkusoitto', index: 1 } },
    ], T0);

    const { sessionId } = env.service.start('main');
    writeSegment(env, sessionId, 0);
    writeSegment(env, sessionId, 1);
    env.clock.t = T0 + 10_000;

    const [a, b] = await Promise.all([env.service.stop('main'), env.service.stop('main')]);
    const again = await env.service.stop('main');
    assert.equal(a.state, 'stopped');
    assert.equal(b.sessionId, sessionId);
    assert.equal(again.state, 'stopped');

    const prefix = `recordings/main/${sessionId}/`;
    assert.deepEqual(env.s3.puts.filter((k) => k.endsWith('session.json')), [`${prefix}session.json`], 'written once');
    assert.equal(env.s3.puts.filter((k) => k.endsWith('000001.mp4')).length, 1, 'the newest is uploaded at stop');
    assert.deepEqual(segmentsOnDisk(env, sessionId), [], 'spool emptied');

    const manifest = JSON.parse(env.s3.objects.get(`${prefix}session.json`).toString('utf8'));
    assert.equal(manifest.stream, 'main');
    assert.equal(manifest.sessionId, sessionId);
    assert.equal(manifest.startedAt, new Date(T0).toISOString());
    assert.equal(manifest.endedAt, new Date(T0 + 10_000).toISOString());
    assert.deepEqual(manifest.segments, [
      { n: 0, key: `${prefix}000000.mp4`, bytes: 200 },
      { n: 1, key: `${prefix}000001.mp4`, bytes: 200 },
    ]);
    assert.deepEqual(manifest.sidecars, [
      'captions.fi.vtt', 'chapters.vtt', 'sections.json', 'hymns.json', 'graphics.json', 'events.jsonl',
    ]);
    for (const name of manifest.sidecars) {
      assert.equal(env.s3.objects.has(`${prefix}sidecars/${name}`), true, name);
    }
    const vtt = env.s3.objects.get(`${prefix}sidecars/captions.fi.vtt`).toString('utf8');
    assert.match(vtt, /00:00:01\.000 --> 00:00:03\.000\nHyvää huomenta/);

    const row = env.db.prepare('SELECT state, ended_at, manifest_json FROM recordings WHERE id = ?').get(sessionId);
    assert.equal(row.state, 'stopped');
    assert.equal(row.ended_at, T0 + 10_000);
    assert.equal(JSON.parse(row.manifest_json).segments.length, 2);
    assert.equal(env.service.list('main')[0].state, 'stopped');
    assert.equal(env.fake.children[0].signals[0], 'SIGTERM');
  } finally {
    env.cleanup();
  }
});

test('stop while S3 is down waits in state stopping and writes session.json after recovery', async () => {
  const env = setup();
  try {
    const { sessionId } = env.service.start('main');
    writeSegment(env, sessionId, 0);
    writeSegment(env, sessionId, 1);
    env.s3.failAll = true;

    const during = await env.service.stop('main');
    assert.equal(during.state, 'stopping');
    assert.equal(env.s3.puts.some((k) => k.endsWith('session.json')), false);

    env.s3.failAll = false;
    await env.service.flush('main');
    assert.equal(env.service.state('main').state, 'stopped');
    assert.equal(env.s3.puts.filter((k) => k.endsWith('session.json')).length, 1);
    assert.deepEqual(segmentsOnDisk(env, sessionId), []);
  } finally {
    env.cleanup();
  }
});

test('stop with no recording is a 404', async () => {
  const env = setup();
  try {
    await assert.rejects(env.service.stop('main'), (err) => err.statusCode === 404);
  } finally {
    env.cleanup();
  }
});

test('a new recording starts after the last one stopped, with its own session', async () => {
  const env = setup();
  try {
    const first = env.service.start('main');
    await env.service.stop('main');
    const second = env.service.start('main');
    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(env.fake.children.length, 2);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM recordings').get().n, 2);
  } finally {
    env.cleanup();
  }
});

test('close stops the recorder, keeps the spool and marks the session interrupted', async () => {
  const env = setup();
  try {
    const { sessionId } = env.service.start('main');
    writeSegment(env, sessionId, 0);
    writeSegment(env, sessionId, 1);
    await env.service.close();
    assert.equal(env.fake.children[0].signals[0], 'SIGTERM');
    assert.deepEqual(segmentsOnDisk(env, sessionId), ['000000.mp4', '000001.mp4'], 'spool kept');
    assert.equal(env.s3.puts.length, 0, 'nothing uploaded at shutdown');
    assert.equal(env.db.prepare('SELECT state FROM recordings WHERE id = ?').get(sessionId).state, 'interrupted');
    assert.throws(() => env.service.start('main'), (err) => err.statusCode === 503);
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test('log lines carry no S3 keys', async () => {
  const env = setup();
  try {
    const { sessionId } = env.service.start('main');
    writeSegment(env, sessionId, 0);
    writeSegment(env, sessionId, 1);
    env.s3.failPuts = 1;
    await env.service.flush('main');
    await env.service.stop('main');
    assert.ok(env.logs.length > 0);
    for (const line of env.logs) assert.doesNotMatch(line, /recordings\/|relay\//);
  } finally {
    env.cleanup();
  }
});

// ---- routes ------------------------------------------------------------------

async function withServer(env, fn) {
  const app = express();
  app.use(createRecordingRouter({ service: env.service, adminToken: 'admin-test-token', db: env.db }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });

test('routes: control scope may start, stop and list; view scope is refused with 403', async () => {
  const env = setup();
  try {
    const control = createToken(env.db, { scopes: ['stream:main:control'] }, T0).token;
    const view = createToken(env.db, { scopes: ['stream:main:view'] }, T0).token;

    await withServer(env, async (base) => {
      const denied = await fetch(`${base}/api/v1/streams/main/recordings`, {
        method: 'POST', headers: bearer(view),
      });
      assert.equal(denied.status, 403);

      const anon = await fetch(`${base}/api/v1/streams/main/recordings`, { method: 'POST' });
      assert.equal(anon.status, 401);

      const started = await fetch(`${base}/api/v1/streams/main/recordings`, {
        method: 'POST', headers: bearer(control),
      });
      assert.equal(started.status, 202);
      const { recording } = await started.json();
      assert.equal(recording.state, 'recording');
      assert.equal(recording.stream, 'main');

      const listedDenied = await fetch(`${base}/api/v1/streams/main/recordings`, { headers: bearer(view) });
      assert.equal(listedDenied.status, 403);

      const listed = await fetch(`${base}/api/v1/streams/main/recordings`, { headers: bearer(control) });
      assert.equal(listed.status, 200);
      const body = await listed.json();
      assert.equal(body.recordings[0].sessionId, recording.sessionId);
      assert.equal(body.recordings[0].state, 'recording');

      const stoppedDenied = await fetch(`${base}/api/v1/streams/main/recordings/current`, {
        method: 'DELETE', headers: bearer(view),
      });
      assert.equal(stoppedDenied.status, 403);

      const stopped = await fetch(`${base}/api/v1/streams/main/recordings/current`, {
        method: 'DELETE', headers: bearer(control),
      });
      assert.equal(stopped.status, 200);
      assert.equal((await stopped.json()).recording.state, 'stopped');
    });
  } finally {
    env.cleanup();
  }
});

test('routes: admin token passes; a bad stream name is 400; no S3 is 503', async () => {
  const env = setup();
  try {
    await withServer(env, async (base) => {
      const bad = await fetch(`${base}/api/v1/streams/Bad%20Name/recordings`, {
        method: 'POST', headers: bearer('admin-test-token'),
      });
      assert.equal(bad.status, 400);

      const ok = await fetch(`${base}/api/v1/streams/main/recordings`, {
        method: 'POST', headers: bearer('admin-test-token'),
      });
      assert.equal(ok.status, 202);
    });
  } finally {
    env.cleanup();
  }

  const noS3 = setup({ noS3: true });
  try {
    await withServer(noS3, async (base) => {
      const res = await fetch(`${base}/api/v1/streams/main/recordings`, {
        method: 'POST', headers: bearer('admin-test-token'),
      });
      assert.equal(res.status, 503);
      assert.match((await res.json()).error, /S3_ENDPOINT/);
    });
  } finally {
    noS3.cleanup();
  }
});

test('routes: stop with nothing recording is 404', async () => {
  const env = setup();
  try {
    await withServer(env, async (base) => {
      const res = await fetch(`${base}/api/v1/streams/main/recordings/current`, {
        method: 'DELETE', headers: bearer('admin-test-token'),
      });
      assert.equal(res.status, 404);
    });
  } finally {
    env.cleanup();
  }
});

// ---- handoff (P5.4) -----------------------------------------------------------

test('stop writes handoff.json next to session.json when the S3 client can presign', async () => {
  const env = setup({ presign: true, relayName: 'relay-a' });
  try {
    addEvents(env.db, 'main', [
      { type: 'caption', lang: 'fi', startedAt: T0 + 1000, endedAt: T0 + 3000, payload: { text: 'Hei' } },
      { type: 'section', startedAt: T0 + 2000, payload: { title: 'Alku' } },
    ], T0);
    const { sessionId } = env.service.start('main');
    writeSegment(env, sessionId, 0);
    writeSegment(env, sessionId, 1);
    env.clock.t = T0 + 70_000;
    await env.service.stop('main');

    const prefix = `recordings/main/${sessionId}/`;
    assert.deepEqual(env.s3.puts.filter((k) => k.endsWith('handoff.json')), [`${prefix}handoff.json`]);
    const handoff = JSON.parse(env.s3.objects.get(`${prefix}handoff.json`).toString('utf8'));
    assert.equal(handoff.version, 1);
    assert.equal(handoff.origin.instance, 'relay-a');
    assert.equal(handoff.origin.groupId, `main-${sessionId}`);
    assert.deepEqual(handoff.feeds[0].parts.map((p) => [p.startMs, p.durationMs]), [[0, 60000], [60000, 10000]]);
    assert.equal(handoff.feeds[0].parts[0].ref, `https://s3.example.com/bucket/${prefix}000000.mp4?X-Amz-Expires=3600&X-Amz-Signature=sig`);
    assert.equal(handoff.captions[0].language, 'fi');
    assert.deepEqual(handoff.markers, [{ atMs: 2000, kind: 'cue', label: 'Alku' }]);
  } finally {
    env.cleanup();
  }
});

test('without presign support stop writes no handoff.json and the existing files are unchanged', async () => {
  const env = setup();
  try {
    const { sessionId } = env.service.start('main');
    writeSegment(env, sessionId, 0);
    env.clock.t = T0 + 5000;
    await env.service.stop('main');
    assert.equal(env.s3.puts.some((k) => k.endsWith('handoff.json')), false);
    assert.equal(env.s3.puts.some((k) => k.endsWith('session.json')), true);
  } finally {
    env.cleanup();
  }
});

test('routes: handoff needs control scope, answers 404/409/503 and builds a fresh manifest when stopped', async () => {
  const env = setup({ presign: true });
  const plain = setup();
  try {
    const control = createToken(env.db, { scopes: ['stream:main:control'] }, T0).token;
    const view = createToken(env.db, { scopes: ['stream:main:view'] }, T0).token;
    const { sessionId } = env.service.start('main');
    writeSegment(env, sessionId, 0);
    const url = (base, id = sessionId) => `${base}/api/v1/streams/main/recordings/${id}/handoff`;

    await withServer(env, async (base) => {
      assert.equal((await fetch(url(base))).status, 401);
      assert.equal((await fetch(url(base), { headers: bearer(view) })).status, 403);
      assert.equal((await fetch(url(base, 'nope'), { headers: bearer(control) })).status, 404);
      assert.equal((await fetch(url(base, 'bad.id'), { headers: bearer(control) })).status, 400);
      assert.equal((await fetch(url(base), { headers: bearer(control) })).status, 409, 'still recording');

      env.clock.t = T0 + 5000;
      await env.service.stop('main');
      const ok = await fetch(url(base), { headers: bearer(control) });
      assert.equal(ok.status, 200);
      const manifest = await ok.json();
      assert.equal(manifest.version, 1);
      assert.equal(manifest.feeds[0].parts.length, 1);
      assert.match(manifest.feeds[0].parts[0].ref, /X-Amz-Expires=3600/);
      assert.equal((await fetch(url(base), { headers: bearer('admin-test-token') })).status, 200);
    });

    // A client that cannot presign: 503.
    const row = env.db.prepare('SELECT * FROM recordings WHERE id = ?').get(sessionId);
    plain.db.prepare('INSERT INTO streams (name, created_at) VALUES (?, ?)').run('main', T0);
    plain.db.prepare('INSERT INTO recordings (id, stream, started_at, ended_at, state, manifest_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, 'main', row.started_at, row.ended_at, 'stopped', row.manifest_json);
    assert.throws(() => plain.service.handoff('main', sessionId), (err) => err.statusCode === 503);
  } finally {
    env.cleanup();
    plain.cleanup();
  }
});
