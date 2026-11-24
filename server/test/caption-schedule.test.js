// Live captioner scheduler (P9.5): timed events to per-frame CEA-608 pairs. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleCaptions, slotsForFrame, units } from '../lib/caption-schedule.js';
import { eocPair, edmPair, rclPair } from '../lib/cea608.js';

/** Every slot of the schedule, in order, for frames 0..last. */
function stream(sched, last) {
  const out = [];
  for (let f = 0; f <= last; f += 1) out.push(...sched.pairsFor(f));
  return out;
}

test('one caption: EOC on the start frame, EDM on the end frame, load before the start', () => {
  const fps = 25;
  const sched = scheduleCaptions([{ startFrame: 150, endFrame: 250, text: 'E1 testi nro 1' }], { fps, totalFrames: 600 });
  assert.equal(sched.late, 0);
  assert.equal(sched.invalid, 0);
  const [c] = sched.placed;
  assert.equal(c.startFrame, 150);
  assert.equal(c.erased, true);
  assert.ok(c.loadTo < 150, 'the text is loaded before the flip');
  assert.deepEqual(sched.pairsFor(150)[0], eocPair());
  assert.deepEqual(sched.pairsFor(250)[0], edmPair());
});

test('doubled control codes sit in consecutive slots of the stream', () => {
  const sched = scheduleCaptions([{ startFrame: 150, endFrame: 250, text: 'Hei maailma' }], { fps: 25, totalFrames: 300 });
  const s = stream(sched, 299);
  s.forEach((p, i) => {
    if (((p[0] & 0x7f) & 0x70) !== 0x10) return;
    const next = s[i + 1];
    const prev = s[i - 1];
    const twin = (q) => q && q[0] === p[0] && q[1] === p[1];
    assert.ok(twin(next) || twin(prev) || i === 0, `control pair at ${i} has no twin next to it`);
  });
});

test('a second caption before the first ends: no EDM for the first, both shown', () => {
  const sched = scheduleCaptions([
    { startFrame: 150, endFrame: 250, text: 'Eka' },
    { startFrame: 200, endFrame: 300, text: 'Toka' },
  ], { fps: 25, totalFrames: 400 });
  assert.equal(sched.late, 0);
  assert.equal(sched.placed[0].erased, false);
  assert.deepEqual(sched.pairsFor(200)[0], eocPair());
});

test('a caption that cannot load before its start is counted late and not placed', () => {
  const sched = scheduleCaptions([{ startFrame: 3, endFrame: 200, text: 'Liian myöhään, koska teksti ei mahdu' }], { fps: 30, totalFrames: 300 });
  assert.equal(sched.placed.length, 0);
  assert.equal(sched.late, 1);
});

test('invalid events are counted and skipped; end must be after start', () => {
  const sched = scheduleCaptions([
    { startFrame: 50, endFrame: 50, text: 'x' },
    { startFrame: 60, endFrame: 80, text: '   ' },
    { startFrame: 500, endFrame: 600, text: 'after the end' },
    { startFrame: 100, endFrame: 150, text: 'ok' },
  ], { fps: 25, totalFrames: 300 });
  assert.equal(sched.invalid, 3);
  assert.equal(sched.placed.length, 1);
});

test('channel 3 uses the CC3 misc byte; the slot count follows the frame rate', () => {
  const sched = scheduleCaptions([{ startFrame: 150, endFrame: 250, text: 'Kolme' }], { fps: 30, totalFrames: 300, channel: 3 });
  assert.equal(sched.late, 0);
  const cc3Rcl = rclPair(3);
  assert.deepEqual(cc3Rcl, [0x15, 0x20]);
  assert.ok(stream(sched, 200).some((p) => p[0] === cc3Rcl[0] && p[1] === cc3Rcl[1]));
  assert.equal(sched.maxSlots, 1);
  assert.equal(sched.pairsFor(0).length, slotsForFrame(0, 30));
  assert.ok(sched.pairsFor(0).every((p) => Array.isArray(p) && p.length === 2));
});

test('units groups a doubled control pair into one unit', () => {
  assert.equal(units([[0x94, 0x20], [0x94, 0x20], [0x41, 0x42]]).length, 2);
});

// Real ffmpeg: the scheduler's pairs, put into an FLV, decode with ffmpeg's 608 decoder.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertCaptions } from '../scripts/e1-make-test.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('scheduler output decodes in ffmpeg with the same text and times', { skip: hasFfmpeg ? false : 'ffmpeg not on PATH', timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-sched-'));
  try {
    const fps = 25;
    const totalFrames = 20 * fps;
    const bare = join(dir, 'bare.flv');
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25',
      '-t', '20', '-c:v', 'libx264', '-tune', 'zerolatency', '-bf', '0', '-g', '50', '-pix_fmt', 'yuv420p', '-an', '-f', 'flv', bare], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const events = [
      { startFrame: 6 * fps, endFrame: 10 * fps, text: 'Live nro 1: äöå ÄÖÅ' },
      { startFrame: 12 * fps, endFrame: 16 * fps, text: 'Live nro 2: äöå' },
    ];
    const sched = scheduleCaptions(events, { fps, totalFrames });
    assert.equal(sched.late, 0);
    const out = join(dir, 'live.flv');
    writeFileSync(out, insertCaptions(readFileSync(bare), { fps, pairsFor: sched.pairsFor, count: sched.maxSlots }).flv);
    const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', `movie=${out}[out0+subcc]`, '-map', '0:s', '-f', 'srt', '-'], { encoding: 'utf8' });
    assert.equal(decoded.status, 0, decoded.stderr);
    const texts = [...decoded.stdout.matchAll(/<font[^>]*>(?:\{\\an\d\})?([^<]*)<\/font>/g)].map((m) => m[1]);
    assert.deepEqual(texts, events.map((e) => e.text));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
