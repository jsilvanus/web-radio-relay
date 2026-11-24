// Ready and notready wiring (P3.3 + P4.3 + P6.1 + P5.3): destinations, video HLS and recording,
// with fakes for every action. The destination filter and loadEgressTarget run against a real
// in-memory database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/store.js';
import { createReadyHandler } from '../lib/ready-hooks.js';
import { createDestination, loadEgressTarget, startableDestinationIds } from '../lib/destinations.js';

const fakeSupervisor = () => {
  const calls = [];
  return {
    calls,
    async start(name) { calls.push(['start', name]); return {}; },
    async stop(name) { calls.push(['stop', name]); return {}; },
  };
};

const fakeProbe = () => ({ probe: async () => null, clear() {} });

/** Egress fake: `failStart` holds destination ids whose start throws. */
function fakeEgress({ failStart = new Set() } = {}) {
  const calls = [];
  const running = new Map();
  return {
    calls,
    start(stream, dest) {
      calls.push(['start', stream, dest.id]);
      if (failStart.has(dest.id)) throw Object.assign(new Error('ffmpeg could not be started'), { statusCode: 400 });
      running.set(`${stream}\n${dest.id}`, dest);
      return { state: 'starting' };
    },
    stop(stream, id) { calls.push(['stop', stream, id]); running.delete(`${stream}\n${id}`); return { state: 'off' }; },
    stopStream(stream) {
      calls.push(['stopStream', stream]);
      for (const k of [...running.keys()]) if (k.startsWith(`${stream}\n`)) running.delete(k);
      return [];
    },
    state(stream) {
      return [...running.keys()].filter((k) => k.startsWith(`${stream}\n`)).map(() => ({ state: 'live' }));
    },
  };
}

/** Video HLS fake: `failStart` makes start throw. */
function fakeHls({ failStart = false } = {}) {
  const calls = [];
  const running = new Set();
  return {
    calls,
    start(stream) {
      calls.push(['start', stream]);
      if (failStart) throw new Error('hls directory not writable');
      running.add(stream);
      return { state: 'starting' };
    },
    stop(stream) { calls.push(['stop', stream]); running.delete(stream); return { state: 'off' }; },
    state(stream) { return { state: running.has(stream) ? 'live' : 'off' }; },
  };
}

/** Recording fake: `stopError` makes stop reject. `current` is the state it reports. */
function fakeRecordings({ startError = null, stopError = null, current = null } = {}) {
  const calls = [];
  let cur = current;
  return {
    calls,
    start(stream) {
      calls.push(['start', stream]);
      if (startError) throw startError;
      cur = { stream, state: 'recording' };
      return cur;
    },
    async stop(stream) {
      calls.push(['stop', stream]);
      if (stopError) throw stopError;
      cur = { stream, state: 'stopped' };
      return cur;
    },
    state() { return cur; },
  };
}

function build(over = {}) {
  const logs = [];
  const deps = {
    supervisor: fakeSupervisor(),
    probe: fakeProbe(),
    log: (m) => logs.push(m),
    egress: fakeEgress(),
    listStartable: () => [],
    loadTarget: (stream, id) => ({ id, url: 'rtmp://example.com/live', key: undefined, variant: 'raw', enabled: true, startWith: 'stream' }),
    hls: fakeHls(),
    recordings: fakeRecordings(),
    s3Configured: true,
    getConfig: () => ({ videoHls: true, recordOnLive: true }),
    ...over,
  };
  return { handler: createReadyHandler(deps), deps, logs };
}

/** Stream with three destinations: startable, disabled, manual. Returns the db and the ids. */
function dbWithDestinations() {
  const db = openStore(':memory:').db;
  const make = (name, extra) => createDestination(db, 'keskus', {
    name, kind: 'rtmp', url: 'rtmp://example.com/live', ...extra,
  }, { nowMs: 1_700_000_000_000 });
  const a = make('dst-a', { enabled: true, startWith: 'stream' });
  const b = make('dst-b', { enabled: false, startWith: 'stream' });
  const c = make('dst-c', { enabled: true, startWith: 'manual' });
  return { db, ids: { a: a.id, b: b.id, c: c.id } };
}

// --- destinations ----------------------------------------------------------

test('ready starts startable destinations only (enabled and startWith stream), read from the database', async () => {
  const { db, ids } = dbWithDestinations();
  assert.deepEqual(startableDestinationIds(db, 'keskus'), [ids.a]);
  const { handler, deps } = build({
    listStartable: (stream) => startableDestinationIds(db, stream),
    loadTarget: (stream, id) => loadEgressTarget(db, stream, id, { secretKey: '' }),
  });
  const result = await handler.ready('live/keskus');
  assert.deepEqual(deps.egress.calls, [['start', 'keskus', ids.a]]);
  assert.equal(result.destinations, 1);
  assert.equal(result.action, 'start');
  assert.deepEqual(result.failed, []);
});

test('a destination the handler sees as disabled or manual is not started', async () => {
  const { handler, deps } = build({
    listStartable: () => ['dst_1', 'dst_2'],
    loadTarget: (stream, id) => ({ id, url: 'rtmp://example.com/live', variant: 'raw', enabled: id === 'dst_1', startWith: 'stream' }),
  });
  const result = await handler.ready('live/keskus');
  assert.deepEqual(deps.egress.calls, [['start', 'keskus', 'dst_1']]);
  assert.equal(result.destinations, 1);
});

test('a destination that fails to load is logged redacted and skipped, the others still start', async () => {
  const leaked = 'rtmp://user:pw@example.com/live/SECRETKEY123';
  const { handler, deps, logs } = build({
    listStartable: () => ['dst_bad', 'dst_good'],
    loadTarget: (stream, id) => {
      if (id === 'dst_bad') throw new Error(`cannot read ${leaked}`);
      return { id, url: 'rtmp://example.com/live', variant: 'raw', enabled: true, startWith: 'stream' };
    },
  });
  const result = await handler.ready('live/keskus');
  assert.deepEqual(deps.egress.calls, [['start', 'keskus', 'dst_good']]);
  assert.deepEqual(result.failed, ['destination:dst_bad']);
  assert.equal(result.action, 'error');
  const text = logs.join('\n');
  assert.doesNotMatch(text, /SECRETKEY123/);
  assert.doesNotMatch(text, /pw@/);
  assert.match(text, /destination dst_bad not started/);
});

// --- video HLS -----------------------------------------------------------------

test('video HLS starts only when config.videoHls is on', async () => {
  const off = build({ getConfig: () => ({ videoHls: false, recordOnLive: false }) });
  const offResult = await off.handler.ready('live/keskus');
  assert.deepEqual(off.deps.hls.calls, []);
  assert.equal(offResult.hls, 'ignored');

  const on = build({ getConfig: () => ({ videoHls: true, recordOnLive: false }) });
  const onResult = await on.handler.ready('live/keskus');
  assert.deepEqual(on.deps.hls.calls, [['start', 'keskus']]);
  assert.equal(onResult.hls, 'start');
});

// --- recording -------------------------------------------------------------------

test('recording starts only when recordOnLive is on and S3 is configured', async () => {
  const cases = [
    { recordOnLive: true, s3Configured: true, expect: 1 },
    { recordOnLive: true, s3Configured: false, expect: 0 },
    { recordOnLive: false, s3Configured: true, expect: 0 },
    { recordOnLive: false, s3Configured: false, expect: 0 },
  ];
  for (const c of cases) {
    const { handler, deps } = build({
      getConfig: () => ({ videoHls: false, recordOnLive: c.recordOnLive }),
      s3Configured: c.s3Configured,
    });
    const result = await handler.ready('live/keskus');
    assert.equal(deps.recordings.calls.length, c.expect, JSON.stringify(c));
    assert.equal(result.recording, c.expect ? 'start' : 'ignored', JSON.stringify(c));
  }
});

// --- independence ---------------------------------------------------------------

test('one failing action does not stop the others on ready', async () => {
  const { handler, deps } = build({
    listStartable: () => ['dst_x', 'dst_y'],
    loadTarget: (stream, id) => ({ id, url: 'rtmp://example.com/live', variant: 'raw', enabled: true, startWith: 'stream' }),
    egress: fakeEgress({ failStart: new Set(['dst_x']) }),
    hls: fakeHls({ failStart: true }),
    recordings: fakeRecordings({ startError: Object.assign(new Error('409'), { statusCode: 409 }) }),
  });
  const result = await handler.ready('live/keskus');
  assert.deepEqual(deps.supervisor.calls, [['start', 'keskus']], 'radio still starts');
  assert.deepEqual(deps.egress.calls.map((c) => c[2]), ['dst_x', 'dst_y'], 'the second destination still starts');
  assert.equal(deps.hls.calls.length, 1);
  assert.equal(deps.recordings.calls.length, 1);
  assert.equal(result.destinations, 1);
  assert.equal(result.radio, 'start');
  assert.equal(result.action, 'error');
  assert.deepEqual(result.failed.sort(), ['destination:dst_x', 'hls', 'recording']);
});

test('a radio failure does not stop destinations, HLS or recording', async () => {
  const supervisor = fakeSupervisor();
  supervisor.start = async () => { throw new Error('radio down'); };
  const { handler, deps } = build({ supervisor, listStartable: () => ['dst_1'], loadTarget: (s, id) => ({ id, url: 'rtmp://example.com/live', variant: 'raw', enabled: true, startWith: 'stream' }) });
  const result = await handler.ready('live/keskus');
  assert.equal(result.radio, 'error');
  assert.equal(result.destinations, 1);
  assert.equal(deps.hls.calls.length, 1);
  assert.equal(deps.recordings.calls.length, 1);
  assert.deepEqual(result.failed, ['radio']);
});

test('RADIO_ON_READY=off (radio off) still starts destinations, HLS and recording', async () => {
  const { handler, deps } = build({
    radioOnReady: false,
    listStartable: () => ['dst_1'],
    loadTarget: (s, id) => ({ id, url: 'rtmp://example.com/live', variant: 'raw', enabled: true, startWith: 'stream' }),
  });
  const result = await handler.ready('live/keskus');
  assert.deepEqual(deps.supervisor.calls, []);
  assert.equal(result.radio, 'ignored');
  assert.equal(result.destinations, 1);
  assert.equal(result.action, 'start');
});

test('an unreadable stream config is an error for HLS and recording, destinations still start', async () => {
  const { handler, deps, logs } = build({
    listStartable: () => ['dst_1'],
    loadTarget: (s, id) => ({ id, url: 'rtmp://example.com/live', variant: 'raw', enabled: true, startWith: 'stream' }),
    getConfig: () => { throw new Error('db gone'); },
  });
  const result = await handler.ready('live/keskus');
  assert.equal(result.hls, 'error');
  assert.equal(result.recording, 'error');
  assert.equal(result.destinations, 1);
  assert.deepEqual(deps.hls.calls, []);
  assert.deepEqual(deps.recordings.calls, []);
  assert.match(logs.join('\n'), /stream config unreadable: db gone/);
});

test('captioner and unknown paths start nothing', async () => {
  const { handler, deps } = build({ listStartable: () => ['dst_1'] });
  assert.deepEqual(await handler.ready('live/keskus-cc'), { action: 'ignored' });
  assert.deepEqual(await handler.ready('other/keskus'), { action: 'ignored' });
  assert.deepEqual(await handler.notready('live/keskus-cc'), { action: 'ignored' });
  assert.deepEqual(deps.supervisor.calls, []);
  assert.deepEqual(deps.egress.calls, []);
  assert.deepEqual(deps.hls.calls, []);
  assert.deepEqual(deps.recordings.calls, []);
});

// --- notready ---------------------------------------------------------------------

test('notready stops the destinations, the HLS packager and the recording', async () => {
  const { handler, deps } = build({
    listStartable: () => ['dst_1'],
    loadTarget: (s, id) => ({ id, url: 'rtmp://example.com/live', variant: 'raw', enabled: true, startWith: 'stream' }),
    recordings: fakeRecordings({ current: { stream: 'keskus', state: 'recording' } }),
  });
  await handler.ready('live/keskus');
  const result = await handler.notready('live/keskus');
  assert.deepEqual(deps.egress.calls.filter((c) => c[0] === 'stopStream'), [['stopStream', 'keskus']]);
  assert.deepEqual(deps.hls.calls.filter((c) => c[0] === 'stop'), [['stop', 'keskus']]);
  assert.deepEqual(deps.recordings.calls.filter((c) => c[0] === 'stop'), [['stop', 'keskus']]);
  assert.deepEqual(deps.supervisor.calls.filter((c) => c[0] === 'stop'), [['stop', 'keskus']]);
  assert.equal(result.action, 'stop');
  assert.equal(result.destinations, 1);
  assert.equal(result.hls, 'stop');
  assert.equal(result.recording, 'stop');
});

test('notready leaves a finished recording alone and reports it as ignored', async () => {
  const { handler, deps } = build({ recordings: fakeRecordings({ current: { stream: 'keskus', state: 'stopped' } }) });
  const result = await handler.notready('live/keskus');
  assert.deepEqual(deps.recordings.calls, []);
  assert.equal(result.recording, 'ignored');
});

test('notready: a failing recording stop does not stop the HLS packager or the destinations', async () => {
  const { handler, deps, logs } = build({
    recordings: fakeRecordings({
      stopError: new Error('S3 PutObject failed: HTTP 500 InternalError'),
    }),
  });
  await handler.ready('live/keskus');
  deps.hls.calls.length = 0;
  deps.egress.calls.length = 0;
  const result = await handler.notready('live/keskus');
  assert.deepEqual(deps.hls.calls.filter((c) => c[0] === 'stop'), [['stop', 'keskus']]);
  assert.deepEqual(deps.egress.calls.filter((c) => c[0] === 'stopStream'), [['stopStream', 'keskus']]);
  assert.equal(result.action, 'error');
  assert.deepEqual(result.failed, ['recording']);
  assert.match(logs.join('\n'), /recording stop failed/);
});

test('notready with the legacy handler (no extras) keeps the old answer', async () => {
  const handler = createReadyHandler({ supervisor: fakeSupervisor(), probe: fakeProbe() });
  assert.deepEqual(await handler.notready('live/keskus'), { action: 'stop', stream: 'keskus' });
});
