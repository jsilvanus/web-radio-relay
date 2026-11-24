import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHoldBuffer, JUMP_MS } from '../lib/hold-buffer.js';

/** Fake clock: the test moves `clock.t` and the buffer reads it through now(). */
function fakeClock(start = 0) {
  const clock = { t: start };
  clock.now = () => clock.t;
  return clock;
}

/** Deterministic PRNG (mulberry32) for the random-jitter case. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('holds each item for exactly holdMs', () => {
  const clock = fakeClock(1000);
  const hb = createHoldBuffer({ holdMs: 500, now: clock.now });
  hb.push('a', 0); // arrival 1000, so wall time 1000

  assert.deepEqual(hb.due(1000 + 499), []);
  assert.equal(hb.nextDueAt(), 1500);
  const out = hb.due(1000 + 500);
  assert.equal(out.length, 1);
  assert.equal(out[0].item, 'a');
  assert.equal(out[0].wallTimeMs, 1000);
  assert.equal(out[0].mediaTsMs, 0);
  assert.equal(hb.size(), 0);
});

test('releases in push order and never lets a later item overtake an earlier one', () => {
  const clock = fakeClock(0);
  const hb = createHoldBuffer({ holdMs: 100, now: clock.now, smoothing: 1 });
  // smoothing 1 makes the offset the latest raw sample, so b's wall time (40 + 460 = 500)
  // is earlier than a's (1000). b is due at 600 but a (due at 1100) is first.
  clock.t = 1000;
  hb.push('a', 0);
  clock.t = 500;
  hb.push('b', 40);
  assert.deepEqual(hb.due(600), [], 'b is due but a is first');
  const out = hb.due(1100);
  assert.deepEqual(out.map((e) => e.item), ['a', 'b']);
});

test('keeps order for ordinary steady arrivals', () => {
  const clock = fakeClock(0);
  const hb = createHoldBuffer({ holdMs: 2000, now: clock.now });
  for (let i = 0; i < 50; i += 1) {
    clock.t = i * 40;
    hb.push(i, i * 40);
  }
  clock.t = 2000 + 49 * 40;
  const out = hb.due(clock.t);
  assert.deepEqual(out.map((e) => e.item), Array.from({ length: 50 }, (_, i) => i));
  assert.equal(hb.size(), 0);
});

test('smoothing absorbs alternating +/-200 ms arrival jitter', () => {
  // Zero-mean, bounded pattern: the smoothed offset settles near the true offset.
  const base = 100000;
  const clock = fakeClock(0);
  const hb = createHoldBuffer({ holdMs: 0, now: clock.now });
  let worst = 0;
  for (let i = 0; i < 400; i += 1) {
    const mediaTs = i * 40;
    clock.t = base + mediaTs + (i % 2 === 0 ? 200 : -200);
    hb.push(i, mediaTs);
    const [released] = hb.due(Infinity); // holdMs 0: the item just pushed
    if (i >= 100) worst = Math.max(worst, Math.abs(released.wallTimeMs - (base + mediaTs)));
  }
  assert.ok(worst <= 20, `worst deviation ${worst.toFixed(1)} ms after warm-up`);
});

test('smoothing damps random +/-200 ms jitter (documented bound, not 20 ms)', () => {
  // EMA with alpha 0.1 on uniform +/-200 ms noise has an rms error of about 26 ms,
  // so the 20 ms peak bound does not hold for random jitter. This test pins the
  // measured behaviour: released in order, and rms error after warm-up below 40 ms.
  const base = 100000;
  const random = rng(7);
  const clock = fakeClock(0);
  const hb = createHoldBuffer({ holdMs: 0, now: clock.now });
  let sumSq = 0;
  let n = 0;
  let lastItem = -1;
  for (let i = 0; i < 1000; i += 1) {
    const mediaTs = i * 40;
    clock.t = base + mediaTs + (random() * 400 - 200);
    hb.push(i, mediaTs);
    const [released] = hb.due(Infinity);
    assert.equal(released.item, i, 'in order');
    assert.ok(released.item > lastItem);
    lastItem = released.item;
    if (i >= 100) {
      sumSq += (released.wallTimeMs - (base + mediaTs)) ** 2;
      n += 1;
    }
  }
  const rms = Math.sqrt(sumSq / n);
  assert.ok(rms < 40, `rms ${rms.toFixed(1)} ms`);
});

test('a media timestamp jump resets the offset to the raw sample', () => {
  const clock = fakeClock(0);
  const hb = createHoldBuffer({ holdMs: 0, now: clock.now });
  for (let i = 0; i < 20; i += 1) {
    clock.t = 1000 + i * 40 + 150; // steady offset of 1150
    hb.push(i, i * 40);
  }
  // Forward jump of more than JUMP_MS: the offset is the raw sample now, unsmoothed.
  clock.t = 90000 + 333;
  hb.push('after-jump', 90000);
  const out = hb.due(Infinity);
  const last = out[out.length - 1];
  assert.equal(last.item, 'after-jump');
  assert.equal(last.wallTimeMs, clock.t, 'wall time equals arrival exactly after a reset');
});

test('a backwards media timestamp also resets the offset', () => {
  const clock = fakeClock(0);
  const hb = createHoldBuffer({ holdMs: 0, now: clock.now });
  clock.t = 5000;
  hb.push('a', 4000); // offset 1000
  clock.t = 9000;
  hb.push('b', 8000); // offset 1000 (smoothed, unchanged)
  clock.t = 12345;
  hb.push('c', 1000); // backwards: raw sample 11345
  const out = hb.due(Infinity);
  assert.equal(out[2].item, 'c');
  assert.equal(out[2].wallTimeMs, 12345);
});

test('a jump within JUMP_MS is smoothed, not reset', () => {
  assert.equal(JUMP_MS, 5000);
  const clock = fakeClock(0);
  const hb = createHoldBuffer({ holdMs: 0, now: clock.now });
  clock.t = 1000;
  hb.push('a', 0); // offset 1000
  clock.t = 7000;
  hb.push('b', 5000); // a 5000 ms step is not a jump (JUMP_MS is exclusive); sample 2000
  const out = hb.due(Infinity);
  // smoothed: 1000 + 0.1 * (2000 - 1000) = 1100
  assert.equal(out[1].wallTimeMs, 5000 + 1100);
});

test('empty buffer', () => {
  const hb = createHoldBuffer({ holdMs: 300, now: () => 0 });
  assert.equal(hb.size(), 0);
  assert.equal(hb.nextDueAt(), null);
  assert.deepEqual(hb.due(1e9), []);
  hb.clear();
  assert.equal(hb.size(), 0);
});

test('nextDueAt, size and clear', () => {
  const clock = fakeClock(0);
  const hb = createHoldBuffer({ holdMs: 250, now: clock.now });
  clock.t = 100;
  hb.push('x', 0);
  clock.t = 140;
  hb.push('y', 40);
  assert.equal(hb.size(), 2);
  assert.equal(hb.nextDueAt(), 350);
  hb.due(350);
  assert.equal(hb.size(), 1);
  assert.equal(hb.nextDueAt(), 390);

  hb.clear();
  assert.equal(hb.size(), 0);
  assert.equal(hb.nextDueAt(), null);
  // After clear the offset is re-estimated from scratch.
  clock.t = 9000;
  hb.push('z', 100);
  assert.equal(hb.due(9000 + 250)[0].wallTimeMs, 9000);
});

test('large volume: order kept across buffer compaction', () => {
  const clock = fakeClock(0);
  const hb = createHoldBuffer({ holdMs: 1000, now: clock.now });
  let next = 0;
  let released = 0;
  for (let step = 0; step < 200; step += 1) {
    for (let k = 0; k < 20; k += 1) {
      clock.t = next * 10;
      hb.push(next, next * 10);
      next += 1;
    }
    clock.t = step * 200 + 1000;
    for (const e of hb.due(clock.t)) {
      assert.equal(e.item, released, 'items leave in push order');
      released += 1;
    }
  }
  clock.t = 1e9;
  for (const e of hb.due(clock.t)) {
    assert.equal(e.item, released);
    released += 1;
  }
  assert.equal(released, next);
  assert.equal(hb.size(), 0);
});

test('argument checks', () => {
  const now = () => 0;
  assert.throws(() => createHoldBuffer({ holdMs: -1, now }), RangeError);
  assert.throws(() => createHoldBuffer({ holdMs: 10 }), TypeError);
  assert.throws(() => createHoldBuffer({ holdMs: 10, now, smoothing: 0 }), RangeError);
  assert.throws(() => createHoldBuffer({ holdMs: 10, now, smoothing: 1.5 }), RangeError);
  const hb = createHoldBuffer({ holdMs: 10, now });
  assert.throws(() => hb.push('a', Number.NaN), TypeError);
});
