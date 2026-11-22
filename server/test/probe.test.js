import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { parseProbe, parseFrameRate } from '../lib/probe.js';
import { createProbeService } from '../lib/probe-service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');

test('parseProbe: H.264 video and AAC audio', () => {
  assert.deepEqual(parseProbe(fixture('ffprobe-h264-aac.json')), {
    video: { codec: 'h264', width: 1280, height: 720, fps: 25 },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
  });
});

test('parseProbe: audio only has video null', () => {
  assert.deepEqual(parseProbe(fixture('ffprobe-audio-only.json')), {
    video: null,
    audio: { codec: 'mp3', sampleRate: 44100, channels: 1 },
  });
});

test('parseProbe: HEVC with a cover-art stream and NTSC frame rate (cover art skipped)', () => {
  assert.deepEqual(parseProbe(fixture('ffprobe-hevc.json')), {
    video: { codec: 'hevc', width: 1920, height: 1080, fps: 29.97 },
    audio: { codec: 'opus', sampleRate: 48000, channels: 2 },
  });
});

test('parseProbe accepts already parsed objects', () => {
  const parsed = JSON.parse(fixture('ffprobe-audio-only.json'));
  assert.equal(parseProbe(parsed).audio.codec, 'mp3');
});

test('parseProbe: input that is not ffprobe output is null', () => {
  assert.equal(parseProbe('not json'), null);
  assert.equal(parseProbe('null'), null);
  assert.equal(parseProbe({}), null);
  assert.equal(parseProbe({ streams: 'x' }), null);
});

test('parseProbe: a file without streams is video null and audio null, not an error', () => {
  assert.deepEqual(parseProbe({ streams: [] }), { video: null, audio: null });
});

test('parseProbe: missing or non-numeric fields become null', () => {
  const out = parseProbe({
    streams: [
      { codec_type: 'video', avg_frame_rate: '0/0' },
      { codec_type: 'audio', sample_rate: 'abc', channels: '' },
    ],
  });
  assert.deepEqual(out, {
    video: { codec: null, width: null, height: null, fps: null },
    audio: { codec: null, sampleRate: null, channels: null },
  });
});

test('parseFrameRate: fractions, 0/0 and junk', () => {
  assert.equal(parseFrameRate('50/1'), 50);
  assert.equal(parseFrameRate('24000/1001'), 23.976);
  assert.equal(parseFrameRate('0/0'), null);
  assert.equal(parseFrameRate('25/0'), null);
  assert.equal(parseFrameRate(undefined), null);
  assert.equal(parseFrameRate('25'), null);
});

// --- probe service with a fake ffprobe -------------------------------------

/** A fake child process: stdout is written by the test, close is emitted by the test. */
function fakeSpawn(record) {
  return (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4242;
    child.killed = [];
    child.kill = (signal) => { child.killed.push(signal); return true; };
    record.push({ cmd, args, opts, child });
    return child;
  };
}

/** Ends the fake's stdout with `output`, lets the data drain, then emits close (as ffprobe would). */
async function finish(child, output, code = 0) {
  child.stdout.end(output);
  await once(child.stdout, 'end');
  child.emit('close', code, null);
}

test('probe service: stores the parsed result and get() returns it', async () => {
  const calls = [];
  const service = createProbeService({
    spawnProcess: fakeSpawn(calls),
    urlFor: (name) => `rtsp://mediamtx:8554/live/${name}`,
  });
  assert.equal(service.get('keskus'), null);
  const pending = service.probe('keskus');
  const { child } = calls[0];
  await finish(child, fixture('ffprobe-h264-aac.json'));
  const result = await pending;
  assert.equal(result.video.codec, 'h264');
  assert.deepEqual(service.get('keskus'), result);
  assert.equal(calls[0].cmd, 'ffprobe');
  assert.deepEqual(calls[0].args.slice(0, 6), ['-v', 'error', '-rtsp_transport', 'tcp', '-show_streams', '-of']);
  assert.equal(calls[0].args.at(-1), 'rtsp://mediamtx:8554/live/keskus');
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'ignore']);
});

test('probe service: a timeout kills ffprobe and stores null', async () => {
  const calls = [];
  const service = createProbeService({
    spawnProcess: fakeSpawn(calls),
    urlFor: (name) => `rtsp://mediamtx:8554/live/${name}`,
    timeoutMs: 20,
  });
  const result = await service.probe('keskus');
  assert.equal(result, null);
  assert.equal(service.get('keskus'), null);
  assert.deepEqual(calls[0].child.killed, ['SIGKILL']);
});

test('probe service: a non-zero exit or bad output stores null and never throws', async () => {
  const calls = [];
  const service = createProbeService({
    spawnProcess: fakeSpawn(calls),
    urlFor: (name) => `rtsp://mediamtx:8554/live/${name}`,
  });
  const failed = service.probe('keskus');
  await finish(calls[0].child, '', 1);
  assert.equal(await failed, null);

  const garbage = service.probe('keskus');
  await finish(calls[1].child, '<html>');
  assert.equal(await garbage, null);
});

test('probe service: a missing ffprobe binary (spawn error) answers null', async () => {
  const service = createProbeService({
    spawnProcess: (...args) => {
      const child = fakeSpawn([])(...args);
      queueMicrotask(() => child.emit('error', new Error('spawn ffprobe ENOENT')));
      return child;
    },
    urlFor: (name) => `rtsp://mediamtx:8554/live/${name}`,
  });
  assert.equal(await service.probe('keskus'), null);
});

test('probe service: a spawn that throws synchronously answers null', async () => {
  const service = createProbeService({
    spawnProcess: () => { throw new Error('boom'); },
    urlFor: (name) => `rtsp://mediamtx:8554/live/${name}`,
  });
  assert.equal(await service.probe('keskus'), null);
});

test('probe service: no source URL means no ffprobe run', async () => {
  const calls = [];
  const service = createProbeService({ spawnProcess: fakeSpawn(calls), urlFor: () => '' });
  assert.equal(await service.probe('keskus'), null);
  assert.equal(calls.length, 0);
});

test('probe service: clear() during a probe stops its late answer from being stored', async () => {
  const calls = [];
  const service = createProbeService({
    spawnProcess: fakeSpawn(calls),
    urlFor: (name) => `rtsp://mediamtx:8554/live/${name}`,
  });
  const pending = service.probe('keskus');
  service.clear('keskus');
  await finish(calls[0].child, fixture('ffprobe-audio-only.json'));
  assert.equal(await pending, null);
  assert.equal(service.get('keskus'), null);
});

test('probe service: clear() forgets a stored result', async () => {
  const calls = [];
  const service = createProbeService({
    spawnProcess: fakeSpawn(calls),
    urlFor: (name) => `rtsp://mediamtx:8554/live/${name}`,
  });
  const pending = service.probe('keskus');
  await finish(calls[0].child, fixture('ffprobe-audio-only.json'));
  await pending;
  assert.ok(service.get('keskus'));
  service.clear('keskus');
  assert.equal(service.get('keskus'), null);
});
