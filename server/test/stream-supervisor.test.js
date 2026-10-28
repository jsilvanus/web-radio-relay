import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { StreamSupervisor } from '../lib/stream-supervisor.js';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-supervisor-'));
  const children = [];
  const supervisor = new StreamSupervisor({
    hlsDir: path.join(root, 'hls'), archiveDir: path.join(root, 'archive'),
    logDir: path.join(root, 'logs'), sourceTemplate: 'rtsp://mediamtx/{name}',
    retryMs: 60000, spawnProcess: (_cmd, _args) => {
      const child = new EventEmitter(); child.pid = 1234; child.exitCode = null; child.signalCode = null;
      child.stderr = new PassThrough(); child.kill = (signal) => { child.signalCode = signal; queueMicrotask(() => child.emit('close', null, signal)); return true; };
      children.push(child); queueMicrotask(() => child.emit('spawn')); return child;
    }
  });
  return { root, children, supervisor };
}

test('rejects invalid stream names and missing source config', async () => {
  const { supervisor, root } = setup();
  await assert.rejects(() => supervisor.start('../oops'), /invalid stream name/);
  await supervisor.close(); fs.rmSync(root, { recursive: true, force: true });
  const noSource = new StreamSupervisor({ hlsDir: '/tmp/hls', archiveDir: '/tmp/archive', logDir: '/tmp/log', sourceTemplate: '' });
  await assert.rejects(() => noSource.start('chapel'), /not configured/);
});

test('start is idempotent and stop finalizes managed process', async () => {
  const { root, children, supervisor } = setup();
  const first = await supervisor.start('chapel');
  assert.equal(first.name, 'chapel');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.state('chapel').state, 'running');
  assert.equal((await supervisor.start('chapel')).pid, 1234);
  assert.equal(children.length, 1);
  const stopped = await supervisor.stop('chapel');
  assert.equal(stopped.state, 'stopped');
  assert.equal(supervisor.state('chapel').desiredState, 'stopped');
  await supervisor.close(); fs.rmSync(root, { recursive: true, force: true });
});
