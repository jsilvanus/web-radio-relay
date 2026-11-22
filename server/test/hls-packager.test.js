import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HlsPackager } from '../lib/hls-packager.js';
import { hlsArgs } from '../lib/hls-args.js';

const HLS_DIR = '/srv/hls';
const RTSP = 'rtsp://relay.example.com:8554';

/** Fake ffmpeg children: kill() ends the child on the next tick; crash() ends it at once. */
function fakeSpawn({ throwOnSpawn = false } = {}) {
  const children = [];
  const spawnProcess = (cmd, args) => {
    if (throwOnSpawn) throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    const child = new EventEmitter();
    child.pid = 7000 + children.length;
    child.exitCode = null;
    child.signalCode = null;
    child.args = args;
    child.cmd = cmd;
    child.signals = [];
    child.stderr = new EventEmitter();
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
  const fake = fakeSpawn(options);
  const timers = fakeTimers();
  const made = [];
  const packager = new HlsPackager({
    hlsDir: HLS_DIR,
    hlsTime: 4,
    listSize: 30,
    rtspBase: RTSP,
    spawnProcess: fake.spawnProcess,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    makeDir: (dir) => made.push(dir),
    now: () => 1_700_000_000_000,
  });
  return { packager, fake, timers, made };
}

test('start creates <HLS_DIR>/<stream>/video and runs the hlsArgs command', () => {
  const { packager, fake, made } = setup();
  const state = packager.start('keskus');
  assert.deepEqual(made, [`${HLS_DIR}/keskus/video`]);
  assert.equal(fake.children.length, 1);
  assert.equal(fake.children[0].cmd, 'ffmpeg');
  assert.deepEqual(fake.children[0].args, hlsArgs({ stream: 'keskus', hlsDir: HLS_DIR, hlsTime: 4, listSize: 30, rtspBase: RTSP }));
  assert.equal(state.state, 'starting');
  assert.equal(state.pid, 7000);
});

test('start twice runs one child', () => {
  const { packager, fake } = setup();
  packager.start('keskus');
  packager.start('keskus');
  assert.equal(fake.children.length, 1);
});

test('a crash restarts with backoff (2 s, then 4 s) and counts the restarts', () => {
  const { packager, fake, timers } = setup();
  packager.start('keskus');
  fake.children[0].crash(1);
  assert.equal(packager.state('keskus').state, 'retrying');
  assert.equal(packager.state('keskus').restartCount, 1);
  assert.deepEqual([...timers.timers.values()].map((t) => t.ms), [2000]);
  assert.equal(timers.fire(2000), true);
  assert.equal(fake.children.length, 2);
  fake.children[1].crash(1);
  assert.deepEqual([...timers.timers.values()].map((t) => t.ms), [4000]);
});

test('a child that runs for liveAfterMs is live', () => {
  const { packager, timers } = setup();
  packager.start('keskus');
  assert.equal(timers.fire(5000), true);
  assert.equal(packager.state('keskus').state, 'live');
});

test('stop cancels a pending retry and sends SIGTERM', async () => {
  const { packager, fake, timers } = setup();
  packager.start('keskus');
  fake.children[0].crash(1);
  const state = packager.stop('keskus');
  assert.equal(state.state, 'off');
  assert.equal(timers.fire(2000), false, 'the retry is gone');
  assert.equal(fake.children.length, 1);

  packager.start('keskus');
  packager.stop('keskus');
  assert.deepEqual(fake.children[1].signals, ['SIGTERM']);
  await new Promise((resolve) => setImmediate(resolve));
});

test('stderr lines are redacted before they enter the tail', () => {
  const { packager, fake } = setup();
  packager.start('keskus');
  fake.children[0].stderr.emit('data', Buffer.from('Input from rtsp://relay.example.com/live/keskus?token=abc123\nlast line\n'));
  const { stderrTail } = packager.state('keskus');
  assert.equal(stderrTail.length, 2);
  assert.doesNotMatch(stderrTail[0], /abc123/);
  assert.match(stderrTail[0], /token=\[REDACTED\]/);
  assert.equal(stderrTail[1], 'last line');
});

test('a spawn error ends in failed with no retry', () => {
  const { packager, timers } = setup({ throwOnSpawn: true });
  const state = packager.start('keskus');
  assert.equal(state.state, 'failed');
  assert.equal(state.lastError, 'ffmpeg could not be started');
  assert.equal(timers.timers.size, 0);
});

test('an invalid stream name is refused and nothing is spawned', () => {
  const { packager, fake, made } = setup();
  assert.throws(() => packager.start('Bad Name'));
  assert.equal(fake.children.length, 0);
  assert.deepEqual(made, []);
});

test('state of a stream never started is off', () => {
  const { packager } = setup();
  assert.equal(packager.state('keskus').state, 'off');
});

test('close stops every packager and refuses new starts', async () => {
  const { packager, fake } = setup();
  packager.start('a-one');
  packager.start('b-two');
  await packager.close();
  assert.equal(packager.state('a-one').state, 'off');
  assert.equal(packager.state('b-two').state, 'off');
  assert.throws(() => packager.start('c-three'), /shutting down/);
});

test('the constructor refuses an empty hlsDir', () => {
  assert.throws(() => new HlsPackager({ hlsDir: '' }), /hlsDir/);
});
