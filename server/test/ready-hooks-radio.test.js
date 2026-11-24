import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadyHandler } from '../lib/ready-hooks.js';

/** Fake supervisor that records calls. */
function fakeSupervisor() {
  const calls = [];
  return {
    calls,
    async start(name) { calls.push(['start', name]); return {}; },
    async stop(name) { calls.push(['stop', name]); return {}; },
  };
}

const fakeProbe = () => ({ probe: async () => null, clear() {} });

test('radioOnReady as a function is asked per stream (per-stream config, P8)', async () => {
  const supervisor = fakeSupervisor();
  const asked = [];
  const handler = createReadyHandler({
    supervisor,
    probe: fakeProbe(),
    radioOnReady: (name) => { asked.push(name); return name === 'on'; },
  });
  assert.deepEqual(await handler.ready('live/off'), { action: 'ignored', stream: 'off' });
  assert.deepEqual(await handler.ready('live/on'), { action: 'start', stream: 'on' });
  assert.deepEqual(asked, ['off', 'on']);
  assert.deepEqual(supervisor.calls, [['start', 'on']]);
});

test('a radioOnReady function that throws is answered as an error, not a hang', async () => {
  const supervisor = fakeSupervisor();
  const logs = [];
  const handler = createReadyHandler({
    supervisor,
    probe: fakeProbe(),
    radioOnReady: () => { throw new Error('db gone'); },
    log: (m) => logs.push(m),
  });
  assert.deepEqual(await handler.ready('live/church'), { action: 'error', stream: 'church' });
  assert.deepEqual(supervisor.calls, []);
  assert.match(logs[0], /radio setting unreadable: db gone/);
});
