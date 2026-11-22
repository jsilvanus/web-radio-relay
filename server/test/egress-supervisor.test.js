import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { EgressSupervisor } from '../lib/egress-supervisor.js';

const KEY = 'SUPER-SECRET-KEY-42';
const URL_ = 'rtmp://ingest.example.com/live2';
const DEST_YT = { id: 'dst_000000000001', kind: 'youtube', url: URL_, key: KEY, variant: 'raw' };
const DEST_B = { id: 'dst_000000000002', kind: 'rtmp', url: 'rtmp://other.example.com/app', key: 'OTHER-KEY-7', variant: 'cc' };

/** Fake timers on a fake clock: nothing waits for real time. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn, id, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => [...timers.values()].map((t) => t.ms),
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const t of timers.values()) {
          if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
      }
      now = target;
    },
  };
}

/** Fake ffmpeg child: records its arguments, lets the test write stderr and crash it. */
function fakeSpawn({ throwOnSpawn = false } = {}) {
  const children = [];
  const spawnProcess = (cmd, args) => {
    if (throwOnSpawn) throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const child = new EventEmitter();
    child.pid = 5000 + children.length;
    child.exitCode = null;
    child.signalCode = null;
    child.cmd = cmd;
    child.args = args;
    child.signals = [];
    child.stderr = new PassThrough();
    child.kill = (signal = 'SIGTERM') => {
      child.signals.push(signal);
      return true;
    };
    child.crash = (code = 1, signal = null) => {
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('close', code, signal);
    };
    children.push(child);
    return child;
  };
  return { children, spawnProcess };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(options = {}) {
  const clock = fakeClock();
  const fake = fakeSpawn(options);
  const supervisor = new EgressSupervisor({
    spawnProcess: fake.spawnProcess,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    backoffMs: 2000,
    maxBackoffMs: 60000,
    liveAfterMs: 5000,
    stopGraceMs: 5000,
    rtspBase: 'rtsp://mediamtx.example.com:8554',
    ...options.extra,
  });
  return { clock, children: fake.children, supervisor };
}

test('start builds copy-only arguments for the destination (no re-encoding)', () => {
  const { children, supervisor } = setup();
  supervisor.start('chapel', DEST_YT);
  const args = children[0].args;
  assert.equal(children[0].cmd, 'ffmpeg');
  assert.ok(args.includes('rtsp://mediamtx.example.com:8554/live/chapel'));
  assert.equal(args[args.indexOf('-c') + 1], 'copy');
  assert.equal(args.includes('-c:v'), false);
  assert.equal(args.at(-1), `${URL_}/${KEY}`);
});

test('start is idempotent while running; invalid destinations are 400 and spawn nothing', () => {
  const { children, supervisor } = setup();
  assert.equal(supervisor.start('chapel', DEST_YT).state, 'starting');
  supervisor.start('chapel', DEST_YT);
  assert.equal(children.length, 1);
  assert.throws(
    () => supervisor.start('chapel', { id: 'dst_000000000009', url: 'http://example.com/x', key: 'k' }),
    (err) => err.statusCode === 400 && /invalid url/.test(err.message),
  );
  assert.throws(() => supervisor.start('Bad Name', DEST_B), (err) => err.statusCode === 400);
  assert.equal(children.length, 1);
});

test('a child that runs for 5 s without exit is live; before that it is starting', () => {
  const { clock, children, supervisor } = setup();
  supervisor.start('chapel', DEST_YT);
  clock.advance(4999);
  assert.equal(supervisor.state('chapel', DEST_YT.id).state, 'starting');
  clock.advance(1);
  assert.equal(supervisor.state('chapel', DEST_YT.id).state, 'live');
  assert.equal(children.length, 1);
});

test('crash and restart with backoff: 2 s, then 4 s, then 2 s again after a live period', () => {
  const { clock, children, supervisor } = setup();
  supervisor.start('chapel', DEST_YT);

  children[0].crash(1);
  let s = supervisor.state('chapel', DEST_YT.id);
  assert.equal(s.state, 'retrying');
  assert.equal(s.restartCount, 1);
  assert.match(s.lastError, /ffmpeg exited \(code 1, signal none\)/);
  clock.advance(1999);
  assert.equal(children.length, 1, 'no restart before 2 s');
  clock.advance(1);
  assert.equal(children.length, 2, 'restarted at 2 s');
  assert.equal(supervisor.state('chapel', DEST_YT.id).state, 'starting');

  children[1].crash(1);
  clock.advance(3999);
  assert.equal(children.length, 2, 'second backoff is 4 s');
  clock.advance(1);
  assert.equal(children.length, 3);

  clock.advance(5000);
  assert.equal(supervisor.state('chapel', DEST_YT.id).state, 'live');
  children[2].crash(255, 'SIGKILL');
  assert.match(supervisor.state('chapel', DEST_YT.id).lastError, /code 255, signal SIGKILL/);
  clock.advance(1999);
  assert.equal(children.length, 3);
  clock.advance(1);
  assert.equal(children.length, 4, 'backoff restarted at 2 s after a live period');
});

test('backoff is capped at 60 s', () => {
  const { clock, children, supervisor } = setup();
  supervisor.start('chapel', DEST_YT);
  // 2, 4, 8, 16, 32, then 60 (capped, not 64)
  const expected = [2000, 4000, 8000, 16000, 32000, 60000, 60000];
  for (let i = 0; i < expected.length; i++) {
    children[i].crash(1);
    clock.advance(expected[i] - 1);
    assert.equal(children.length, i + 1, `no restart before ${expected[i]} ms (attempt ${i + 1})`);
    clock.advance(1);
    assert.equal(children.length, i + 2);
  }
});

test('stop cancels a pending retry and sends SIGTERM to a running child', () => {
  const { clock, children, supervisor } = setup();
  supervisor.start('chapel', DEST_YT);
  children[0].crash(1);
  assert.equal(supervisor.state('chapel', DEST_YT.id).state, 'retrying');
  assert.equal(supervisor.stop('chapel', DEST_YT.id).state, 'off');
  clock.advance(120000);
  assert.equal(children.length, 1, 'the retry was cancelled');
  assert.equal(supervisor.state('chapel', DEST_YT.id).state, 'off');

  supervisor.start('chapel', DEST_YT);
  supervisor.stop('chapel', DEST_YT.id);
  assert.deepEqual(children[1].signals, ['SIGTERM']);
  children[1].crash(0);
  clock.advance(120000);
  assert.equal(children.length, 2, 'a stopped child does not come back');
});

test('stop escalates to SIGKILL after the grace period when the child ignores SIGTERM', () => {
  const { clock, children, supervisor } = setup();
  supervisor.start('chapel', DEST_YT);
  supervisor.stop('chapel', DEST_YT.id);
  clock.advance(4999);
  assert.deepEqual(children[0].signals, ['SIGTERM']);
  clock.advance(1);
  assert.deepEqual(children[0].signals, ['SIGTERM', 'SIGKILL']);
});

test('a spawn error marks the destination failed with no automatic retry; start tries again', () => {
  const { clock, supervisor, children } = setup({ throwOnSpawn: true });
  supervisor.start('chapel', DEST_YT);
  const s = supervisor.state('chapel', DEST_YT.id);
  assert.equal(s.state, 'failed');
  assert.equal(s.lastError, 'ffmpeg could not be started');
  clock.advance(120000);
  assert.equal(children.length, 0, 'no retry is scheduled after a failed spawn');
});

test('key never appears in the state or in the stderr tail, and stderr is redacted', async () => {
  const { clock, children, supervisor } = setup();
  supervisor.start('chapel', DEST_YT);
  const child = children[0];
  // a line split over two chunks, plus a line that prints the url with the key
  child.stderr.write(`Output #0, flv, to '${URL_}/`);
  child.stderr.write(`${KEY}':\n`);
  child.stderr.write(`Opening '${URL_}/${KEY}' for writing\n`);
  child.stderr.write('frame=  100 fps=25 q=-1.0 size=1024kB time=00:00:04.00\n');
  await flush();
  const tail = supervisor.state('chapel', DEST_YT.id).stderrTail;
  assert.ok(tail.length >= 3, `tail has ${tail.length} lines`);
  assert.equal(JSON.stringify(tail).includes(KEY), false);
  assert.ok(tail.some((line) => line.includes('[REDACTED]')));

  clock.advance(5000);
  child.crash(1);
  const after = supervisor.state('chapel', DEST_YT.id);
  assert.equal(JSON.stringify(after).includes(KEY), false);
  assert.equal(JSON.stringify(supervisor.state()).includes(KEY), false);
  assert.equal(JSON.stringify(supervisor.state('chapel')).includes(KEY), false);
});

test('the stderr tail keeps the last 20 lines only', async () => {
  const { children, supervisor } = setup();
  supervisor.start('chapel', DEST_B);
  for (let i = 1; i <= 25; i++) children[0].stderr.write(`line ${i}\n`);
  await flush();
  const tail = supervisor.state('chapel', DEST_B.id).stderrTail;
  assert.equal(tail.length, 20);
  assert.equal(tail[0], 'line 6');
  assert.equal(tail.at(-1), 'line 25');
});

test('two destinations of one stream are independent', () => {
  const { clock, children, supervisor } = setup();
  supervisor.start('chapel', DEST_YT);
  supervisor.start('chapel', DEST_B);
  assert.equal(children.length, 2);
  assert.notEqual(children[0].args.at(-1), children[1].args.at(-1));

  children[0].crash(1);
  assert.equal(supervisor.state('chapel', DEST_YT.id).state, 'retrying');
  assert.equal(supervisor.state('chapel', DEST_B.id).state, 'starting');

  clock.advance(5000);
  assert.equal(supervisor.state('chapel', DEST_B.id).state, 'live');

  supervisor.stop('chapel', DEST_B.id);
  assert.equal(supervisor.state('chapel', DEST_B.id).state, 'off');
  // the first destination restarted at 2 s and goes live at 7 s; now it is at 6.999 s
  clock.advance(1999);
  assert.equal(supervisor.state('chapel', DEST_YT.id).state, 'starting', 'the other destination restarted');
  assert.equal(children.length, 3);
  assert.equal(children[1].signals.length, 1, 'only the stopped one was signalled');
});

test('state(): all, per stream, per destination; a never-started destination is off', () => {
  const { supervisor } = setup();
  supervisor.start('chapel', DEST_YT);
  supervisor.start('hall', DEST_B);
  assert.equal(supervisor.state().length, 2);
  assert.deepEqual(supervisor.state('chapel').map((s) => s.id), [DEST_YT.id]);
  assert.equal(supervisor.state('chapel', 'dst_0000000000ff').state, 'off');
  assert.equal(supervisor.stopStream('chapel').length, 1);
  assert.equal(supervisor.state('chapel', DEST_YT.id).state, 'off');
  assert.equal(supervisor.state('hall', DEST_B.id).state, 'starting');
});

test('close stops every child and refuses new starts', async () => {
  const { children, supervisor } = setup();
  supervisor.start('chapel', DEST_YT);
  supervisor.start('hall', DEST_B);
  await supervisor.close();
  assert.deepEqual(children.map((c) => c.signals[0]), ['SIGTERM', 'SIGTERM']);
  assert.throws(() => supervisor.start('chapel', DEST_YT), (err) => err.statusCode === 503);
});
