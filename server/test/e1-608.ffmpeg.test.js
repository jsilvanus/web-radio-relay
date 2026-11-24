// Experiment E1 test-file maker: the schedule (pure) and a real-ffmpeg self-check.
// The self-check runs server/scripts/e1-make-test.mjs at 25 and 30 fps, decodes the
// inserted CEA-608 with ffmpeg's own decoder (lavfi movie, subcc) and compares the
// text (with ä ö å Ä Ö Å) and the pop-on and erase times (±1 frame) to the schedule.
// Real-ffmpeg parts skip with a message when ffmpeg is not on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchedule, slotsForFrame, insertCaptions, sourceArgs, captionText, captionTextB } from '../scripts/e1-make-test.mjs';
import { createFlvParser, parseVideoTag, buildVideoTag, writeFlvHeader, writeTag, TAG_VIDEO, AVC_NALU } from '../lib/flv.js';
import { parseA53Sei } from '../lib/cc-data.js';
import { eocPair, edmPair, PADDING } from '../lib/cea608.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'e1-make-test.mjs');
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const SKIP = hasFfmpeg ? false : 'ffmpeg not on PATH';

test('slotsForFrame keeps 30 pairs per second', () => {
  const sum = (fps) => Array.from({ length: fps }, (_, f) => slotsForFrame(f, fps)).reduce((a, b) => a + b, 0);
  assert.equal(sum(30), 30);
  assert.equal(sum(25), 30);
  assert.deepEqual(Array.from({ length: 5 }, (_, f) => slotsForFrame(f, 25)), [1, 1, 1, 1, 2]);
  assert.deepEqual(Array.from({ length: 3 }, (_, f) => slotsForFrame(f, 30)), [1, 1, 1]);
  assert.equal(slotsForFrame(7, 25, 2), 2);
});

test('buildSchedule: EOC first in the show frame, EDM at clear, load before show', () => {
  for (const fps of [25, 30]) {
    const { frames, captions, maxSlots } = buildSchedule({ fps, totalFrames: 30 * fps });
    assert.equal(maxSlots, fps === 25 ? 2 : 1);
    assert.deepEqual(captions.map((c) => c.n), [1, 2, 3, 4]); // 5 would clear at 34 s
    for (const c of captions) {
      assert.equal(c.text, captionText(c.n, fps));
      assert.equal(c.showFrame, c.n * 6 * fps);
      assert.equal(c.clearFrame, (c.n * 6 + 4) * fps);
      assert.deepEqual(frames.get(c.showFrame)[0], eocPair());
      assert.deepEqual(frames.get(c.clearFrame)[0], edmPair());
      assert.ok(c.loadTo < c.showFrame);
    }
    // No frame holds more pairs than it has slots.
    for (const [f, pairs] of frames) assert.ok(pairs.length <= slotsForFrame(f, fps), `frame ${f}`);
  }
});

test('buildSchedule: doubled control codes sit in consecutive slots', () => {
  const { frames } = buildSchedule({ fps: 25, totalFrames: 20 * 25, interval: 3, show: 2 });
  const stream = [];
  const last = Math.max(...frames.keys());
  for (let f = 0; f <= last; f += 1) {
    const pairs = frames.get(f) ?? [];
    for (let k = 0; k < slotsForFrame(f, 25); k += 1) stream.push(pairs[k] ?? [0x80, 0x80]);
  }
  // Every control pair (first byte 0x10-0x1F without parity) has an equal neighbour.
  stream.forEach((p, i) => {
    if (((p[0] & 0x7f) & 0x70) !== 0x10) return;
    const same = (q) => q && q[0] === p[0] && q[1] === p[1];
    assert.ok(same(stream[i - 1]) || same(stream[i + 1]), `control pair at ${i} is not doubled`);
  });
});

test('buildSchedule refuses a caption that cannot load in time', () => {
  assert.throws(() => buildSchedule({ fps: 25, totalFrames: 600, interval: 1, show: 0.5 }), /does not fit/);
});

/** Parse ffmpeg's SRT output into { start, end, text } with times in seconds. */
function parseSrt(srt) {
  const time = (t) => {
    const [h, m, rest] = t.split(':');
    const [s, ms] = rest.split(',');
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  };
  return srt.replace(/\r/g, '').trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const lines = block.split('\n');
    const [a, b] = lines[1].split(' --> ');
    const text = lines.slice(2).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
    return { start: time(a), end: time(b), text };
  });
}

for (const fps of [25, 30]) {
  test(`E1 self-check at ${fps} fps: ffmpeg decodes the inserted 608 text and timing`, { skip: SKIP, timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'e1-test-'));
    try {
      const out = join(dir, `e1-${fps}.flv`);
      const schedulePath = join(dir, 'schedule.json');
      const made = spawnSync(process.execPath, [SCRIPT, '--fps', String(fps), '--seconds', '20', '--out', out, '--schedule', schedulePath], { encoding: 'utf8' });
      assert.equal(made.status, 0, made.stderr);
      const schedule = JSON.parse(readFileSync(schedulePath, 'utf8'));
      assert.equal(schedule.captions.length, 2);

      const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
        '-f', 'lavfi', '-i', `movie=${out}[out0+subcc]`, '-map', '0:s', '-f', 'srt', '-'], { encoding: 'utf8' });
      assert.equal(decoded.status, 0, decoded.stderr);
      const cues = parseSrt(decoded.stdout);
      assert.equal(cues.length, schedule.captions.length, decoded.stdout);
      const frame = 1 / fps + 0.0015; // one frame, plus SRT millisecond rounding
      cues.forEach((cue, i) => {
        const want = schedule.captions[i];
        assert.equal(cue.text, `E1 testi ${fps} fps nro ${i + 1}: äöå ÄÖÅ`);
        assert.equal(cue.text, want.text);
        assert.ok(Math.abs(cue.start - want.showSeconds) <= frame, `start ${cue.start} vs ${want.showSeconds}`);
        assert.ok(Math.abs(cue.end - want.clearSeconds) <= frame, `end ${cue.end} vs ${want.clearSeconds}`);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('insertCaptions changes nothing but the added SEI NAL units', { skip: SKIP, timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'e1-strip-'));
  try {
    const source = join(dir, 'source.flv');
    const r = spawnSync('ffmpeg', sourceArgs({ fps: 25, seconds: 3, out: source, drawtext: false }), { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const original = readFileSync(source);
    const { frames } = buildSchedule({ fps: 25, totalFrames: 75, interval: 1.5, show: 1 });
    const { flv, frames: count, inserted } = insertCaptions(original, { fps: 25, pairsFor: (f) => frames.get(f) ?? [], count: 2 });
    assert.equal(count, 75);
    assert.equal(inserted, 75);
    assert.ok(flv.length > original.length);

    // Strip every A/53 SEI again and rebuild: must be the source byte for byte.
    const parts = [];
    let seen = 0;
    for (const item of createFlvParser().push(flv)) {
      if (item.kind === 'header') {
        parts.push(writeFlvHeader(item));
        continue;
      }
      if (item.type === TAG_VIDEO) {
        const video = parseVideoTag(item.data);
        if (video.avcPacketType === AVC_NALU) {
          const firstSlice = video.nalus.findIndex((n) => (n[0] & 0x1f) >= 1 && (n[0] & 0x1f) <= 5);
          const seiAt = video.nalus.findIndex((n) => parseA53Sei(n));
          assert.equal(seiAt, firstSlice - 1, 'SEI sits right before the first slice');
          seen += 1;
          const nalus = video.nalus.filter((n) => !parseA53Sei(n));
          parts.push(writeTag({ ...item, data: buildVideoTag({ ...video, nalus }) }));
          continue;
        }
      }
      parts.push(writeTag(item));
    }
    assert.equal(seen, 75);
    assert.ok(Buffer.concat(parts).equals(original));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CC3 (field 2): ffmpeg decodes captions that are sent as field 2 alone', { skip: SKIP, timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'e1-cc3-'));
  try {
    const bare = join(dir, 'bare.flv');
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30',
      '-t', '20', '-c:v', 'libx264', '-tune', 'zerolatency', '-bf', '0', '-g', '60', '-pix_fmt', 'yuv420p', '-an', '-f', 'flv', bare], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const fps = 30;
    const sch = buildSchedule({ fps, totalFrames: 20 * fps, channel: 3, text: captionTextB, pairsPerFrame: 1 });
    const pairsFor = (f) => {
      const list = [...(sch.frames.get(f) ?? [])];
      if (list.length === 0) list.push([...PADDING]);
      return list.map((p) => Object.assign([...p], { field: 2 }));
    };
    const out = join(dir, 'cc3.flv');
    writeFileSync(out, insertCaptions(readFileSync(bare), { fps, pairsFor, count: 1 }).flv);
    const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', `movie=${out}[out0+subcc]`, '-map', '0:s', '-f', 'srt', '-'], { encoding: 'utf8' });
    assert.equal(decoded.status, 0, decoded.stderr);
    const cues = parseSrt(decoded.stdout);
    assert.deepEqual(cues.map((c) => c.text), sch.captions.map((c) => captionTextB(c.n)));
    cues.forEach((cue, i) => assert.ok(Math.abs(cue.start - sch.captions[i].showFrame / fps) <= 1 / fps + 0.0015));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--tracks 2 writes a VTT per track with the same captions as the 608', { skip: SKIP, timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'e1-vtt-'));
  try {
    const out = join(dir, 'e1-25.flv');
    const made = spawnSync(process.execPath, [SCRIPT, '--fps', '25', '--seconds', '20', '--tracks', '2', '--out', out], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const cc1 = readFileSync(join(dir, 'e1-25.cc1.vtt'), 'utf8');
    const cc3 = readFileSync(join(dir, 'e1-25.cc3.vtt'), 'utf8');
    assert.match(cc1, /^WEBVTT\n\n1\n00:00:06\.0\d\d --> 00:00:10\.0\d\d\n/);
    assert.ok(cc1.includes(`${captionText(1, 25)}\n`) && cc1.includes(`${captionText(2, 25)}\n`));
    assert.ok(cc3.includes(`${captionTextB(1)}\n`) && cc3.includes(`${captionTextB(2)}\n`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('buildSchedule --lead-in: captions start after the lead-in, same spacing', () => {
  const { captions } = buildSchedule({ fps: 30, totalFrames: 90 * 30, leadIn: 30 });
  assert.equal(captions[0].showFrame, (30 + 6) * 30);
  assert.equal(captions[0].clearFrame, (30 + 6 + 4) * 30);
  assert.equal(captions[1].showFrame - captions[0].showFrame, 6 * 30);
});
