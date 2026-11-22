import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { parseHookPath, createReadyHandler } from '../lib/ready-hooks.js';
import { StreamSupervisor } from '../lib/stream-supervisor.js';

/** Fake supervisor that records calls. */
function fakeSupervisor({ startError = null, stopError = null } = {}) {
  const calls = [];
  return {
    calls,
    async start(name) { calls.push(['start', name]); if (startError) throw startError; return {}; },
    async stop(name) { calls.push(['stop', name]); if (stopError) throw stopError; return {}; },
  };
}

/** Fake probe that records calls. */
function fakeProbe(impl = async () => null) {
  const calls = [];
  return {
    calls,
    probe(name) { calls.push(['probe', name]); return impl(name); },
    clear(name) { calls.push(['clear', name]); },
  };
}

// --- parseHookPath ----------------------------------------------------------

test('parseHookPath: live/<name> is a stream, live/<name>-cc is the captioner', () => {
  assert.deepEqual(parseHookPath('live/keskus'), { stream: 'keskus', captioner: false });
  assert.deepEqual(parseHookPath('live/keskus-cc'), { stream: 'keskus', captioner: true });
  assert.deepEqual(parseHookPath('live/a_b-1'), { stream: 'a_b-1', captioner: false });
  assert.deepEqual(parseHookPath('live/' + 'a'.repeat(32)), { stream: 'a'.repeat(32), captioner: false });
});

test('parseHookPath: anything else is null', () => {
  assert.equal(parseHookPath('live/'), null);
  assert.equal(parseHookPath('live/UPPER'), null);
  assert.equal(parseHookPath('live/' + 'a'.repeat(33)), null);
  assert.equal(parseHookPath('live/keskus/extra'), null);
  assert.equal(parseHookPath('other/keskus'), null);
  assert.equal(parseHookPath('/live/keskus'), null);
  assert.equal(parseHookPath(''), null);
  assert.equal(parseHookPath(undefined), null);
  assert.equal(parseHookPath(['live/keskus', 'live/other']), null);
});

// --- createReadyHandler with fakes ------------------------------------------

test('ready starts the radio pull with the stream name and probes the input', async () => {
  const supervisor = fakeSupervisor();
  const probe = fakeProbe();
  const handler = createReadyHandler({ supervisor, probe });
  assert.deepEqual(await handler.ready('live/keskus'), { action: 'start', stream: 'keskus' });
  assert.deepEqual(supervisor.calls, [['start', 'keskus']]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(probe.calls, [['probe', 'keskus']]);
});

test('a second ready passes the same name again (supervisor.start is idempotent)', async () => {
  const supervisor = fakeSupervisor();
  const handler = createReadyHandler({ supervisor, probe: fakeProbe() });
  await handler.ready('live/keskus');
  assert.deepEqual(await handler.ready('live/keskus'), { action: 'start', stream: 'keskus' });
  assert.deepEqual(supervisor.calls, [['start', 'keskus'], ['start', 'keskus']]);
});

test('notready stops the radio pull and clears the probe', async () => {
  const supervisor = fakeSupervisor();
  const probe = fakeProbe();
  const handler = createReadyHandler({ supervisor, probe });
  assert.deepEqual(await handler.notready('live/keskus'), { action: 'stop', stream: 'keskus' });
  assert.deepEqual(supervisor.calls, [['stop', 'keskus']]);
  assert.deepEqual(probe.calls, [['clear', 'keskus']]);
});

test('unknown and invalid paths are ignored and touch nothing', async () => {
  const supervisor = fakeSupervisor();
  const probe = fakeProbe();
  const handler = createReadyHandler({ supervisor, probe });
  for (const p of ['other/keskus', 'live/', 'live/UPPER', undefined]) {
    assert.deepEqual(await handler.ready(p), { action: 'ignored' });
    assert.deepEqual(await handler.notready(p), { action: 'ignored' });
  }
  assert.deepEqual(supervisor.calls, []);
  assert.deepEqual(probe.calls, []);
});

test('the captioner path (-cc) is ignored by both hooks', async () => {
  const supervisor = fakeSupervisor();
  const probe = fakeProbe();
  const handler = createReadyHandler({ supervisor, probe });
  assert.deepEqual(await handler.ready('live/keskus-cc'), { action: 'ignored' });
  assert.deepEqual(await handler.notready('live/keskus-cc'), { action: 'ignored' });
  assert.deepEqual(supervisor.calls, []);
  assert.deepEqual(probe.calls, []);
});

test('radio off: ready does not start the pull but still probes the input', async () => {
  const supervisor = fakeSupervisor();
  const probe = fakeProbe();
  const handler = createReadyHandler({ supervisor, probe, radioOnReady: false });
  assert.deepEqual(await handler.ready('live/keskus'), { action: 'ignored', stream: 'keskus' });
  assert.deepEqual(supervisor.calls, []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(probe.calls, [['probe', 'keskus']]);
});

test('a failing start is logged (redacted) and still answered', async () => {
  const logged = [];
  const supervisor = fakeSupervisor({ startError: new Error('RADIO_SOURCE_URL_TEMPLATE is not configured rtsp://user:pw@example.com/live/keskus?token=abc123') });
  const handler = createReadyHandler({ supervisor, probe: fakeProbe(), log: (m) => logged.push(m) });
  assert.deepEqual(await handler.ready('live/keskus'), { action: 'error', stream: 'keskus' });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /radio start failed/);
  assert.doesNotMatch(logged[0], /pw|abc123/);
});

test('a failing stop is logged and answered', async () => {
  const logged = [];
  const handler = createReadyHandler({
    supervisor: fakeSupervisor({ stopError: new Error('stop failed') }),
    probe: fakeProbe(),
    log: (m) => logged.push(m),
  });
  assert.deepEqual(await handler.notready('live/keskus'), { action: 'error', stream: 'keskus' });
  assert.match(logged[0], /radio stop failed: stop failed/);
});

test('ready does not wait for the probe, and a rejecting probe changes nothing', async () => {
  const handler = createReadyHandler({
    supervisor: fakeSupervisor(),
    probe: fakeProbe(() => new Promise(() => {})),
  });
  assert.deepEqual(await handler.ready('live/keskus'), { action: 'start', stream: 'keskus' });

  const rejecting = createReadyHandler({
    supervisor: fakeSupervisor(),
    probe: fakeProbe(() => Promise.reject(new Error('probe broke'))),
  });
  assert.deepEqual(await rejecting.ready('live/keskus'), { action: 'start', stream: 'keskus' });
});

// --- with the real StreamSupervisor and a fake ffmpeg -----------------------

test('with the real supervisor, two ready hooks start ffmpeg once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-hooks-'));
  const spawned = [];
  const supervisor = new StreamSupervisor({
    hlsDir: path.join(root, 'hls'), archiveDir: path.join(root, 'archive'),
    logDir: path.join(root, 'logs'), sourceTemplate: 'rtsp://mediamtx:8554/live/{name}',
    retryMs: 60000,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.pid = 4321; child.exitCode = null; child.signalCode = null;
      child.stderr = new PassThrough();
      child.kill = (signal) => { child.signalCode = signal; queueMicrotask(() => child.emit('close', null, signal)); return true; };
      spawned.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  try {
    const handler = createReadyHandler({ supervisor, probe: fakeProbe() });
    await handler.ready('live/keskus');
    await handler.ready('live/keskus');
    assert.equal(spawned.length, 1);
    assert.equal(supervisor.state('keskus').desiredState, 'running');
    await handler.notready('live/keskus');
    assert.equal(supervisor.state('keskus').desiredState, 'stopped');
  } finally {
    await supervisor.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
