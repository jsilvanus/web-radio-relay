import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCaptioner, slotsForFrame, maxSlotsFor } from '../lib/captioner.js';
import { eocPair, edmPair } from '../lib/cea608.js';

const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];

/** Frames whose first slot starts an EOC (the second copy of a doubled EOC is not counted). */
function eocFrames(frames) {
  return frames.map((p, f) => (same(p[0], eocPair()) && !same(frames[f - 1]?.at(-1), eocPair()) ? f : -1)).filter((f) => f >= 0);
}

/** Run frames 0..n-1 at `fps` with wall time f*1000/fps and collect the pairs per frame. */
function run(c, fps, frames, before = () => {}) {
  const out = [];
  for (let f = 0; f < frames; f += 1) {
    before(f);
    out.push(c.pairsForFrame(f, (f * 1000) / fps));
  }
  return out;
}

test('slots per frame match the 30 pairs per second rate', () => {
  assert.equal(maxSlotsFor(25), 2);
  assert.equal(maxSlotsFor(30), 1);
  assert.equal(maxSlotsFor(50), 1);
  assert.equal(Array.from({ length: 25 }, (_, f) => slotsForFrame(f, 25)).reduce((a, b) => a + b), 30);
});

for (const fps of [25, 30]) {
  test(`${fps} fps: loads before, EOC in the first slot of the start frame, EDM at the end`, () => {
    const c = createCaptioner({ fps });
    c.addCaption({ text: 'Hei maailma äöå', startedAtMs: 6000, endedAtMs: 10000 });
    const frames = run(c, fps, 12 * fps);
    const eoc = frames.findIndex((p) => same(p[0], eocPair()));
    const edm = frames.findIndex((p) => same(p[0], edmPair()));
    assert.equal(eoc, 6 * fps);
    assert.equal(edm, 10 * fps);
    // Something was loaded before the EOC, nothing but padding after the EDM.
    assert.ok(frames.slice(0, eoc).some((p) => p.some((q) => q[0] !== 0x80)));
    for (let f = 0; f < frames.length; f += 1) assert.equal(frames[f].length, slotsForFrame(f, fps));
    assert.ok(frames.slice(edm + 2).every((p) => p.every((q) => q[0] === 0x80 && q[1] === 0x80)));
    assert.equal(c.stats().late, 0);
  });
}

test('a late caption is shown on the next frame and counted as late', () => {
  const fps = 25;
  const c = createCaptioner({ fps });
  const frames = [];
  for (let f = 0; f < 10 * fps; f += 1) {
    if (f === 4 * fps) c.addCaption({ text: 'Myöhässä', startedAtMs: 3000, endedAtMs: 8000 }); // known 1 s after its start
    frames.push(c.pairsForFrame(f, (f * 1000) / fps));
  }
  const eoc = frames.findIndex((p) => same(p[0], eocPair()) || same(p[1], eocPair()));
  assert.ok(eoc >= 4 * fps && eoc < 4 * fps + 30, `EOC at frame ${eoc}`);
  assert.equal(c.stats().late, 1);
  assert.ok(c.stats().lateMsMax >= 1000);
});

test('the next caption loads only after the EOC of the previous one', () => {
  const fps = 30;
  const c = createCaptioner({ fps });
  c.addCaption({ text: 'Yksi', startedAtMs: 3000, endedAtMs: 5000 });
  c.addCaption({ text: 'Kaksi', startedAtMs: 6000, endedAtMs: 8000 });
  const frames = run(c, fps, 10 * fps);
  assert.deepEqual(eocFrames(frames), [3 * fps, 6 * fps]);
  const loads = frames.map((p, f) => (p[0][0] !== 0x80 && !same(p[0], eocPair()) && !same(p[0], edmPair()) ? f : -1)).filter((f) => f >= 0);
  const second = loads.filter((f) => f > 3 * fps);
  assert.ok(second[0] > 3 * fps, 'second caption loads after the first EOC');
  assert.ok(second[second.length - 1] < 6 * fps);
});

test('a long caption is split into pop-ons that share the time', () => {
  const c = createCaptioner({ fps: 30 });
  const n = c.addCaption({
    text: 'Tämä on pitkä teksti joka ei mahdu kahdelle rivillekään yhdellä kertaa koska se on todella pitkä lause jossa on paljon sanoja',
    startedAtMs: 2000, endedAtMs: 11000,
  });
  assert.ok(n >= 2);
  const frames = run(c, 30, 14 * 30);
  const eocs = eocFrames(frames);
  assert.equal(eocs.length, n);
  assert.equal(eocs[0], 60);
});

test('out-of-order frame requests (B-frame decode order) get the pairs of their own index', () => {
  const fps = 30;
  const a = createCaptioner({ fps });
  const b = createCaptioner({ fps });
  for (const c of [a, b]) c.addCaption({ text: 'Testi', startedAtMs: 1000, endedAtMs: 2000 });
  const ordered = run(a, fps, 90);
  // Decode order I P B B ...: 0, 3, 1, 2, 6, 4, 5, ...
  const order = [];
  for (let g = 0; g < 90; g += 3) order.push(g + 2 < 90 && g > 0 ? g : g, ...(g + 2 < 90 ? [g + 2, g + 1] : []));
  const seen = new Map();
  for (const f of [...new Set(order)].filter((x) => x < 90)) seen.set(f, b.pairsForFrame(f, (f * 1000) / fps));
  for (const [f, p] of seen) assert.deepEqual(p, ordered[f], `frame ${f}`);
});

test('a jump far ahead does not generate every frame in between', () => {
  const c = createCaptioner({ fps: 25, maxPendingFrames: 50 });
  c.addCaption({ text: 'x', startedAtMs: 1e6, endedAtMs: 1e6 + 1000 });
  const p = c.pairsForFrame(100000, 4_000_000);
  assert.equal(p.length, slotsForFrame(100000, 25));
});

test('empty text adds nothing; reset forgets the queue', () => {
  const c = createCaptioner({ fps: 30 });
  assert.equal(c.addCaption({ text: '   ', startedAtMs: 0 }), 0);
  c.addCaption({ text: 'a', startedAtMs: 5000 });
  assert.equal(c.pending(), 1);
  c.reset();
  assert.equal(c.pending(), 0);
});

test('characters outside the 608 sets are counted', () => {
  const c = createCaptioner({ fps: 30 });
  c.addCaption({ text: 'a 😀 b', startedAtMs: 0 });
  assert.equal(c.stats().replacedChars, 1);
});

test('rejects a bad fps', () => {
  assert.throws(() => createCaptioner({ fps: 0 }), RangeError);
  assert.throws(() => createCaptioner({ fps: 29.97 }), RangeError);
});
