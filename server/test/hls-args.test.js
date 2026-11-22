import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hlsArgs, listSizeFor } from '../lib/hls-args.js';

function assertCopyOnly(args) {
  for (const a of args) {
    assert.doesNotMatch(a, /^-c:v$/);
    assert.doesNotMatch(a, /libx264|-vf|-filter/);
  }
  const i = args.indexOf('-c');
  assert.equal(args[i + 1], 'copy');
}

test('hls args package the relay as a copy-only MPEG-TS playlist', () => {
  const args = hlsArgs({ stream: 'main', hlsDir: '/hls' });
  assert.deepEqual(args, [
    '-hide_banner', '-loglevel', 'warning', '-nostdin', '-rtsp_transport', 'tcp',
    '-rw_timeout', '10000000', '-i', 'rtsp://mediamtx:8554/live/main',
    '-map', '0', '-c', 'copy', '-f', 'hls',
    '-hls_time', '4', '-hls_list_size', '30',
    '-hls_flags', 'program_date_time+delete_segments+independent_segments+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', '/hls/main/video/%d.ts',
    '/hls/main/video/stream.m3u8',
  ]);
  assertCopyOnly(args);
});

test('segment time, list size, rtspBase and a trailing slash on hlsDir', () => {
  const args = hlsArgs({
    stream: 'radio-1', hlsDir: '/data/hls/', hlsTime: 2, listSize: 12,
    rtspBase: 'rtsp://relay.example.com:8554',
  });
  assert.equal(args[args.indexOf('-hls_time') + 1], '2');
  assert.equal(args[args.indexOf('-hls_list_size') + 1], '12');
  assert.equal(args[args.indexOf('-i') + 1], 'rtsp://relay.example.com:8554/live/radio-1');
  assert.equal(args.at(-1), '/data/hls/radio-1/video/stream.m3u8');
  assertCopyOnly(args);
});

test('invalid inputs throw', () => {
  assert.throws(() => hlsArgs({ stream: '', hlsDir: '/hls' }), /stream name/);
  assert.throws(() => hlsArgs({ stream: 'Main', hlsDir: '/hls' }), /stream name/);
  assert.throws(() => hlsArgs({ stream: 'main', hlsDir: '' }), /hlsDir/);
  assert.throws(() => hlsArgs({ stream: 'main', hlsDir: '/hls', hlsTime: 0 }), /hlsTime/);
  assert.throws(() => hlsArgs({ stream: 'main', hlsDir: '/hls', listSize: -1 }), /listSize/);
});

test('inputArgs override replaces the RTSP input and its flags', () => {
  const args = hlsArgs({ stream: 'main', hlsDir: '/hls', inputArgs: { input: '/media/x.mp4' } });
  assert.deepEqual(args.slice(0, 6), ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-i', '/media/x.mp4']);
  assert.ok(!args.includes('-rtsp_transport'));
  assertCopyOnly(args);
});

test('listSizeFor covers the delay with a floor of 10 segments', () => {
  assert.equal(listSizeFor(0, 4), 10);
  assert.equal(listSizeFor(1, 4), 11);
  assert.equal(listSizeFor(10, 4), 13);
  assert.equal(listSizeFor(60, 4), 25);
  assert.equal(listSizeFor(61, 4), 26);
  assert.equal(listSizeFor(120, 2), 70);
});

test('listSizeFor rejects bad values', () => {
  assert.throws(() => listSizeFor(-1, 4), /delayMaxSeconds/);
  assert.throws(() => listSizeFor(NaN, 4), /delayMaxSeconds/);
  assert.throws(() => listSizeFor(Infinity, 4), /delayMaxSeconds/);
  assert.throws(() => listSizeFor(60, 0), /hlsTime/);
});
