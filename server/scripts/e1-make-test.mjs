#!/usr/bin/env node
/**
 * Experiment E1: make an FLV test file with CEA-608 captions inserted as A/53 SEI
 * NAL units into an existing H.264 stream, without re-encoding the video.
 *
 *   node server/scripts/e1-make-test.mjs --fps 25 --seconds 120 --out e1-25.flv
 *
 * Steps: ffmpeg makes a source (testsrc2 with a burned clock, sine tone, libx264
 * without B-frames, AAC, FLV); the file is parsed with server/lib/flv.js and one
 * SEI with cc_data is put into every video frame (after AUD/SPS/PPS/SEI, before
 * the first slice); the FLV is written back. Caption N ("E1 testi 25 fps nro N:
 * äöå ÄÖÅ") pops on exactly at N x interval seconds and is erased `show` seconds
 * later. See docs/e1-youtube-608.md.
 *
 * Options:
 *   --fps <n>               frame rate (default 25)
 *   --seconds <n>           length (default 120)
 *   --out <file>            output FLV (required)
 *   --interval <s>          seconds between captions (default 6)
 *   --show <s>              seconds a caption stays on screen (default 4)
 *   --pairs-per-frame <n>   field-1 pairs per frame: "auto" (default) keeps the
 *                           608 rate of 30 pairs/s (25 fps: 1,1,1,1,2), or 1 or 2
 *   --align left|center     caption position (default left)
 *   --ffmpeg <path>         ffmpeg binary (default ffmpeg on PATH)
 *   --schedule <file>       also write the caption schedule as JSON
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFlvParser, parseVideoTag, buildVideoTag, writeFlvHeader, writeTag, TAG_VIDEO, AVC_CODEC_ID, AVC_NALU } from '../lib/flv.js';
import { encodePopOn, eocPair, edmPair, PADDING } from '../lib/cea608.js';
import { a53SeiNal } from '../lib/cc-data.js';

/** 608 field-1 data rate: two bytes per frame at (about) 30 fps. */
const PAIRS_PER_SECOND = 30;

/** Default caption text for caption number n. */
export function captionText(n, fps) {
  return `E1 testi ${fps} fps nro ${n}: äöå ÄÖÅ`;
}

/**
 * Field-1 pair slots for frame f.
 * @param {number} f
 * @param {number} fps
 * @param {'auto'|number} pairsPerFrame
 */
export function slotsForFrame(f, fps, pairsPerFrame = 'auto') {
  if (pairsPerFrame !== 'auto') return pairsPerFrame;
  return Math.floor(((f + 1) * PAIRS_PER_SECOND) / fps) - Math.floor((f * PAIRS_PER_SECOND) / fps);
}

/**
 * Group load pairs into units: a doubled control code (two equal pairs whose
 * first byte is 0x10-0x1F) must go into two consecutive slots, or a decoder
 * would not recognise the second copy as redundant.
 */
function units(pairs) {
  const out = [];
  for (let i = 0; i < pairs.length; i += 1) {
    const p = pairs[i];
    const q = pairs[i + 1];
    const control = ((p[0] & 0x7f) & 0x70) === 0x10;
    if (control && q && q[0] === p[0] && q[1] === p[1]) {
      out.push([p, q]);
      i += 1;
    } else out.push([p]);
  }
  return out;
}

/**
 * Caption schedule: which field-1 pairs go into which frame.
 *
 * Caption n pops on at frame round(n * interval * fps): its EOC pair is the first
 * pair of that frame (sent twice). EDM follows `show` seconds later. The text of
 * caption n is loaded (pop-on, into non-displayed memory) in the free slots after
 * the EOC of caption n-1, so it may load while n-1 is on screen.
 *
 * @returns {{ frames: Map<number, number[][]>, captions: Array<{ n: number, text: string,
 *   showFrame: number, clearFrame: number, loadFrom: number, loadTo: number }>, maxSlots: number }}
 */
export function buildSchedule({ fps, totalFrames, interval = 6, show = 4, pairsPerFrame = 'auto', text = captionText, align = 'left' }) {
  const cap = (f) => slotsForFrame(f, fps, pairsPerFrame);
  const slots = new Map(); // frame -> array of pairs or null, length cap(f)
  const row = (f) => {
    if (!slots.has(f)) slots.set(f, new Array(cap(f)).fill(null));
    return slots.get(f);
  };
  /** Slot after [f, k], skipping frames without slots. */
  const after = ([f, k]) => {
    k += 1;
    while (k >= cap(f)) {
      f += 1;
      k = 0;
    }
    return [f, k];
  };
  const firstOf = (f) => after([f, -1]);
  const isFree = ([f, k]) => row(f)[k] === null;
  /** Place a unit at the first run of free consecutive slots from `from`; returns [start, end]. */
  const placeUnit = (from, unit) => {
    for (let s = from; ; s = after(s)) {
      const run = [s];
      while (run.length < unit.length) run.push(after(run[run.length - 1]));
      if (run.every(isFree)) {
        run.forEach(([f, k], i) => { row(f)[k] = unit[i]; });
        return [run[0], run[run.length - 1]];
      }
    }
  };

  let maxSlots = 1;
  for (let f = 0; f < Math.min(totalFrames, fps * 2); f += 1) maxSlots = Math.max(maxSlots, cap(f));

  const captions = [];
  let cursor = firstOf(0); // first slot the next load may use
  for (let n = 1; ; n += 1) {
    const showFrame = Math.round(n * interval * fps);
    const clearFrame = Math.round((n * interval + show) * fps);
    if (clearFrame + 2 >= totalFrames) break;
    const label = text(n, fps);
    const showSlot = firstOf(showFrame);
    if (showSlot[0] !== showFrame || !isFree(showSlot)) throw new Error(`frame ${showFrame} has no free first slot for EOC`);
    const [, eocEnd] = placeUnit(showSlot, [eocPair(), eocPair()]);
    let loadFrom = null;
    let loadTo = null;
    for (const unit of units(encodePopOn(label, { align }))) {
      const [a, b] = placeUnit(cursor, unit);
      if (b[0] >= showFrame) throw new Error(`caption ${n} does not fit before ${showFrame / fps} s; lengthen the interval`);
      loadFrom ??= a[0];
      loadTo = b[0];
      cursor = after(b);
    }
    const clearSlot = firstOf(clearFrame);
    if (!isFree(clearSlot)) throw new Error(`frame ${clearFrame} has no free first slot for EDM`);
    placeUnit(clearSlot, [edmPair(), edmPair()]);
    cursor = after(eocEnd);
    captions.push({ n, text: label, showFrame, clearFrame, loadFrom, loadTo });
  }
  const frames = new Map();
  for (const [f, list] of slots) {
    // Keep slot positions: an empty slot before a used one becomes padding.
    if (list.some(Boolean)) frames.set(f, list.map((p) => p ?? [...PADDING]));
  }
  return { frames, captions, maxSlots };
}

/** NAL types that are slices (VCL); the SEI goes before the first one. */
function isSlice(nalu) {
  const type = nalu[0] & 0x1f;
  return type >= 1 && type <= 5;
}

/**
 * Insert one SEI per AVC frame. `pairsFor(frameIndex)` returns the field-1 pairs
 * for that frame; the frame index is taken from the presentation time.
 * @param {Buffer} flv
 * @param {{ fps: number, pairsFor: (f: number) => number[][], count: number }} options
 * @returns {{ flv: Buffer, frames: number, inserted: number, originMs: number | null }}
 */
export function insertCaptions(flv, { fps, pairsFor, count }) {
  const parser = createFlvParser();
  const items = parser.push(flv);
  if (parser.pendingBytes() !== 0) throw new Error('FLV: trailing bytes');
  const out = [];
  let frames = 0;
  let inserted = 0;
  let originMs = null;
  for (const item of items) {
    if (item.kind === 'header') {
      out.push(writeFlvHeader({ audio: item.audio, video: item.video, version: item.version }));
      continue;
    }
    if (item.type !== TAG_VIDEO) {
      out.push(writeTag(item));
      continue;
    }
    const video = parseVideoTag(item.data);
    if (video.codecId !== AVC_CODEC_ID || video.avcPacketType !== AVC_NALU) {
      out.push(writeTag(item));
      continue;
    }
    frames += 1;
    const pts = item.timestamp + video.compositionTime;
    // Frame index counted from the first video frame (the FLV muxer may start video
    // a few ms late to make room for AAC priming), so index n is drawtext's %{n}.
    if (originMs === null) originMs = pts;
    const f = Math.round(((pts - originMs) * fps) / 1000);
    const sei = a53SeiNal(pairsFor(f), { count });
    const at = video.nalus.findIndex(isSlice);
    const nalus = [...video.nalus];
    nalus.splice(at < 0 ? nalus.length : at, 0, sei);
    inserted += 1;
    out.push(writeTag({ ...item, data: buildVideoTag({ ...video, nalus }) }));
  }
  return { flv: Buffer.concat(out), frames, inserted, originMs };
}

function hasFilter(ffmpeg, name) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  return r.status === 0 && new RegExp(`\\s${name}\\s`).test(r.stdout);
}

/** ffmpeg arguments for the source file. */
export function sourceArgs({ fps, seconds, out, interval = 6, drawtext = true }) {
  const clock = `drawtext=text='t %{pts\\:hms}   frame %{n}   expected nro %{eif\\:trunc(t/${interval})\\:d}'`
    + ':fontsize=40:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=8:x=(w-text_w)/2:y=40';
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${fps}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(seconds),
    ...(drawtext ? ['-vf', clock] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-bf', '0', '-g', String(2 * fps),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'flv', out,
  ];
}

function parseArgs(argv) {
  const opts = { fps: 25, seconds: 120, interval: 6, show: 4, pairsPerFrame: 'auto', align: 'left', ffmpeg: 'ffmpeg' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    const need = () => {
      if (value === undefined) throw new Error(`${key} needs a value`);
      i += 1;
      return value;
    };
    switch (key) {
      case '--fps': opts.fps = Number(need()); break;
      case '--seconds': opts.seconds = Number(need()); break;
      case '--out': opts.out = need(); break;
      case '--interval': opts.interval = Number(need()); break;
      case '--show': opts.show = Number(need()); break;
      case '--pairs-per-frame': { const v = need(); opts.pairsPerFrame = v === 'auto' ? 'auto' : Number(v); break; }
      case '--align': opts.align = need(); break;
      case '--ffmpeg': opts.ffmpeg = need(); break;
      case '--schedule': opts.schedule = need(); break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown option ${key}`);
    }
  }
  if (opts.help) return opts;
  if (!opts.out) throw new Error('--out is required');
  if (!Number.isInteger(opts.fps) || opts.fps < 1 || opts.fps > 60) throw new Error('--fps must be an integer 1-60');
  if (!(opts.seconds > 0)) throw new Error('--seconds must be > 0');
  if (!(opts.interval > 0) || !(opts.show > 0) || opts.show >= opts.interval) throw new Error('--show must be > 0 and below --interval');
  if (opts.pairsPerFrame !== 'auto' && ![1, 2].includes(opts.pairsPerFrame)) throw new Error('--pairs-per-frame must be auto, 1 or 2');
  if (!['left', 'center'].includes(opts.align)) throw new Error('--align must be left or center');
  return opts;
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write('usage: e1-make-test.mjs --fps 25 --seconds 120 --out e1-25.flv [--interval 6] [--show 4] [--pairs-per-frame auto|1|2] [--align left|center] [--schedule file.json]\n');
    return 0;
  }
  const dir = mkdtempSync(join(tmpdir(), 'e1-'));
  try {
    const source = join(dir, 'source.flv');
    const drawtext = hasFilter(opts.ffmpeg, 'drawtext');
    if (!drawtext) process.stderr.write('warning: ffmpeg has no drawtext filter; the video has no burned clock\n');
    let r = spawnSync(opts.ffmpeg, sourceArgs({ ...opts, out: source, drawtext }), { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' });
    if (r.status !== 0 && drawtext) {
      process.stderr.write(`warning: drawtext failed (${(r.stderr || '').trim().split('\n').pop()}); retrying without the burned clock\n`);
      r = spawnSync(opts.ffmpeg, sourceArgs({ ...opts, out: source, drawtext: false }), { stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' });
    }
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || '').trim()}`);

    const totalFrames = Math.round(opts.seconds * opts.fps);
    const schedule = buildSchedule({ ...opts, totalFrames });
    const pairsFor = (f) => {
      const pairs = [...(schedule.frames.get(f) ?? [])];
      while (pairs.length < slotsForFrame(f, opts.fps, opts.pairsPerFrame)) pairs.push([...PADDING]);
      return pairs;
    };
    const result = insertCaptions(readFileSync(source), { fps: opts.fps, pairsFor, count: schedule.maxSlots });
    writeFileSync(opts.out, result.flv);
    const origin = (result.originMs ?? 0) / 1000;
    const summary = schedule.captions.map((c) => ({
      n: c.n,
      text: c.text,
      showSeconds: c.showFrame / opts.fps,
      clearSeconds: c.clearFrame / opts.fps,
      fileShowSeconds: origin + c.showFrame / opts.fps,
      fileClearSeconds: origin + c.clearFrame / opts.fps,
      showFrame: c.showFrame,
      clearFrame: c.clearFrame,
    }));
    if (opts.schedule) {
      writeFileSync(opts.schedule, `${JSON.stringify({ fps: opts.fps, videoStartSeconds: origin, captions: summary }, null, 2)}\n`);
    }
    process.stderr.write(`${opts.out}: ${result.frames} video frames, ${result.inserted} SEI inserted, ${summary.length} captions `
      + `(${opts.interval} s apart, ${opts.show} s on screen), cc_count ${schedule.maxSlots}\n`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`e1-make-test: ${err.message}\n`);
    process.exitCode = 1;
  }
}
