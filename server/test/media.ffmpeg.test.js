// Real-ffmpeg tests (P4.4): the copy-only argument builders run against a live
// RTMP source that ffmpeg itself serves (listen mode), so the production arguments
// are exercised end to end. Skips with a message when ffmpeg or ffprobe is not on PATH.
//
// The builders take an RTSP base; the test passes an rtmp:// base instead. Only the
// RTSP-only input options (-rtsp_transport, -rw_timeout) are removed from the egress
// arguments, because egressArgs has no input hook. HLS and recorder use their
// `inputArgs.input` hook, which keeps every other argument as in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { egressArgs } from '../lib/egress-args.js';
import { hlsArgs } from '../lib/hls-args.js';
import { recorderArgs, closedSegments } from '../lib/recorder-args.js';
import { buildDelayedPlaylist, parseMediaPlaylist } from '../lib/hls-delay.js';
import { vttForSegment, mpegtsForSegment } from '../lib/vtt-segments.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const SKIP = hasFfmpeg && hasFfprobe ? false : 'ffmpeg/ffprobe not on PATH';

const LOG = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];
const SOURCE_SECONDS = 8;

/** A free TCP port on 127.0.0.1 (closed again before it is returned). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Spawns ffmpeg; `done` resolves with the exit code and stderr when it ends. */
function spawnFfmpeg(args) {
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const done = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
    child.once('error', (err) => resolve({ code: null, signal: null, stderr: `${stderr}${err.message}` }));
  });
  return { child, done };
}

/** Waits for a child; kills it when it runs longer than timeoutMs (the test then fails on the exit code). */
async function finish(proc, timeoutMs = 45000) {
  const timer = setTimeout(() => proc.child.kill('SIGKILL'), timeoutMs);
  const result = await proc.done;
  clearTimeout(timer);
  return result;
}

/** Kills whatever is still running (test cleanup). */
function killAll(procs) {
  for (const p of procs) {
    if (p && p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGKILL');
  }
}

/** Drops `-rtsp_transport <v>` and `-rw_timeout <v>` from the input part; nothing else changes. */
function withoutRtspInput(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-rtsp_transport' || args[i] === '-rw_timeout') {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/** The live test source: testsrc + sine, H.264 GOP 50, served as RTMP (ffmpeg listens). */
function sourceArgs(port, stream) {
  return [
    ...LOG,
    '-re',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-c:v', 'libx264', '-g', '50', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-t', String(SOURCE_SECONDS),
    '-f', 'flv', '-listen', '1',
    `rtmp://127.0.0.1:${port}/live/${stream}`,
  ];
}

/** Starts the source and gives it time to bind its port (a probe connection would use up `listen 1`). */
async function startSource(stream) {
  const port = await freePort();
  const source = spawnFfmpeg(sourceArgs(port, stream));
  await sleep(1500);
  return { port, source };
}

/** ffprobe of one stream: codec, size and the number of frames actually read from the file. */
function probeStream(file, selector) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', selector,
    '-show_entries', 'stream=codec_name,codec_type,width,height,nb_read_frames',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [stream] = JSON.parse(r.stdout).streams ?? [];
  return stream ?? null;
}

test('egress: a live RTMP source is copied to an RTMP sink without re-encoding', { skip: SKIP, timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-egress-ff-'));
  const procs = [];
  try {
    const sinkPort = await freePort();
    const sinkFile = join(dir, 'sink.flv');
    // Sink: ffmpeg listens for the egress push and writes the copied streams to a file.
    const sink = spawnFfmpeg([
      ...LOG, '-listen', '1',
      '-i', `rtmp://127.0.0.1:${sinkPort}/live/x`,
      '-c', 'copy', '-f', 'flv', sinkFile,
    ]);
    procs.push(sink);
    await sleep(1000);

    const { port: srcPort, source } = await startSource('s');
    procs.push(source);

    // The production egress arguments; only the RTSP-only input options are dropped.
    const built = egressArgs({
      stream: 's',
      url: `rtmp://127.0.0.1:${sinkPort}/live`,
      key: 'x',
      rtspBase: `rtmp://127.0.0.1:${srcPort}`,
    });
    assert.ok(built.includes('-rtsp_transport'), 'egress args carry the RTSP input options');
    assert.ok(built.includes(`rtmp://127.0.0.1:${srcPort}/live/s`), 'input is the RTMP source');
    const egress = spawnFfmpeg(withoutRtspInput(built));
    procs.push(egress);

    const egressResult = await finish(egress);
    assert.equal(egressResult.code, 0, egressResult.stderr);
    // Copy mode opens no encoder, so no encoder line can appear in the log.
    assert.doesNotMatch(egressResult.stderr, /libx264|encoder/i);

    await finish(source);
    const sinkResult = await finish(sink);
    assert.ok(existsSync(sinkFile), `sink wrote a file (${sinkResult.stderr.slice(-300)})`);

    const video = probeStream(sinkFile, 'v:0');
    const audio = probeStream(sinkFile, 'a:0');
    assert.equal(video.codec_name, 'h264', 'video codec is h264 (copied)');
    assert.equal(video.width, 320);
    assert.equal(video.height, 240);
    assert.ok(Number(video.nb_read_frames) > 0, `sink received video frames (${video.nb_read_frames})`);
    assert.equal(audio.codec_name, 'aac');
    assert.ok(Number(audio.nb_read_frames) > 0, `sink received audio frames (${audio.nb_read_frames})`);
  } finally {
    killAll(procs);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('video HLS: the live source is packaged, delayed and captioned per segment', { skip: SKIP, timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-hls-ff-'));
  const procs = [];
  try {
    const hlsDir = join(dir, 'hls');
    const videoDir = join(hlsDir, 's', 'video');
    mkdirSync(videoDir, { recursive: true });

    const { port, source } = await startSource('s');
    procs.push(source);
    const packager = spawnFfmpeg(hlsArgs({
      stream: 's', hlsDir, inputArgs: { input: `rtmp://127.0.0.1:${port}/live/s` },
    }));
    procs.push(packager);

    const result = await finish(packager);
    assert.equal(result.code, 0, result.stderr);
    await finish(source);

    const live = readFileSync(join(videoDir, 'stream.m3u8'), 'utf8');
    assert.match(live, /#EXT-X-PROGRAM-DATE-TIME:/, 'playlist has program date times');
    const tsFiles = readdirSync(videoDir).filter((n) => n.endsWith('.ts'));
    assert.ok(tsFiles.length >= 1, `at least one .ts segment (${tsFiles.length})`);

    // Delayed playlist with no delay: every segment that has ended by now is listed.
    const delayed = buildDelayedPlaylist(live, { delaySeconds: 0, nowMs: Date.now(), segmentPrefix: '/hls/s/video/' });
    assert.ok(delayed, 'the delayed playlist is built from the live playlist');
    const listed = parseMediaPlaylist(delayed).segments;
    assert.ok(listed.length >= 1, 'the delayed playlist lists segments');
    for (const seg of listed) {
      assert.ok(tsFiles.includes(seg.uri.split('/').pop()), `${seg.uri} is a segment on disk`);
    }

    // Captions: one inside the first segment, one inside the second. The first segment must not show the second's cue.
    const [first, second] = listed;
    assert.ok(first.startMs != null && first.duration != null, 'first segment is timed');
    const events = [
      { type: 'caption', lang: 'fi', startedAt: first.startMs + 500, endedAt: first.startMs + 1500, sourceKey: null, payload: { text: 'Hei', final: true } },
    ];
    if (second) {
      events.push({ type: 'caption', lang: 'fi', startedAt: second.startMs + 200, endedAt: second.startMs + 900, sourceKey: null, payload: { text: 'Toinen', final: true } });
    }
    const vtt = vttForSegment({
      segStartMs: first.startMs,
      segEndMs: first.startMs + first.duration * 1000,
      events,
      lang: 'original',
      originMs: first.startMs,
    });
    assert.match(vtt, /^WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00\.000\n/);
    assert.match(vtt, /00:00:00\.500 --> 00:00:01\.500\nHei\n/);
    assert.doesNotMatch(vtt, /Toinen/, 'a cue of the next segment is not in this one');

    if (second) {
      const pts = mpegtsForSegment({ segStartMs: second.startMs, originMs: first.startMs });
      const vtt2 = vttForSegment({
        segStartMs: second.startMs,
        segEndMs: second.startMs + second.duration * 1000,
        events,
        lang: 'original',
        originMs: first.startMs,
      });
      assert.ok(vtt2.includes(`X-TIMESTAMP-MAP=MPEGTS:${pts},LOCAL:00:00:00.000`), 'second segment PTS follows the first');
      assert.match(vtt2, /00:00:00\.200 --> 00:00:00\.900\nToinen\n/);
    }
  } finally {
    killAll(procs);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recorder: the live source is recorded as closed fragmented MP4 segments', { skip: SKIP, timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-rec-ff-'));
  const procs = [];
  try {
    const spoolDir = join(dir, 'spool');
    const sessionId = 'sess-ff-1';
    mkdirSync(join(spoolDir, sessionId), { recursive: true });

    const { port, source } = await startSource('s');
    procs.push(source);
    // segmentSeconds is overridden to 2 (the production default is 60 s) so that a closed segment exists within the 8 s source.
    const recorder = spawnFfmpeg(recorderArgs({
      stream: 's', spoolDir, sessionId, segmentSeconds: 2,
      inputArgs: { input: `rtmp://127.0.0.1:${port}/live/s` },
    }));
    procs.push(recorder);

    const result = await finish(recorder);
    assert.equal(result.code, 0, result.stderr);
    await finish(source);

    const names = readdirSync(join(spoolDir, sessionId));
    const closed = closedSegments(names);
    assert.ok(closed.length >= 1, `at least one closed segment (${names.join(',')})`);

    const file = join(spoolDir, sessionId, closed[0]);
    assert.ok(readFileSync(file).includes(Buffer.from('moof')), 'segment is fragmented (moof boxes)');
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name',
      '-of', 'json', file,
    ], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const info = JSON.parse(probe.stdout);
    assert.ok(info.format.format_name.includes('mp4'), `ffprobe reads it as MP4 (${info.format.format_name})`);
    assert.ok(Number(info.format.duration) > 0, 'segment has a duration');
    assert.deepEqual(info.streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
  } finally {
    killAll(procs);
    rmSync(dir, { recursive: true, force: true });
  }
});
