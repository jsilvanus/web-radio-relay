import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recorderArgs, closedSegments } from '../lib/recorder-args.js';

function assertCopyOnly(args) {
  for (const a of args) {
    assert.doesNotMatch(a, /^-c:v$/);
    assert.doesNotMatch(a, /libx264|-vf|-filter/);
  }
  const i = args.indexOf('-c');
  assert.equal(args[i + 1], 'copy');
}

test('recorder args read the relay and write 60 s fragmented MP4 segments', () => {
  const args = recorderArgs({ stream: 'main', spoolDir: '/spool', sessionId: 's-1' });
  assert.deepEqual(args, [
    '-hide_banner', '-loglevel', 'warning', '-nostdin', '-rtsp_transport', 'tcp',
    '-rw_timeout', '10000000', '-i', 'rtsp://mediamtx:8554/live/main',
    '-map', '0', '-c', 'copy', '-f', 'segment', '-segment_time', '60',
    '-segment_format', 'mp4',
    '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof',
    '-reset_timestamps', '1', '/spool/s-1/%06d.mp4',
  ]);
  assertCopyOnly(args);
});

test('segment length, rtspBase and a trailing slash on spoolDir', () => {
  const args = recorderArgs({
    stream: 'radio_2', spoolDir: '/spool/', sessionId: 'abc', segmentSeconds: 30,
    rtspBase: 'rtsp://relay.example.com:8554/',
  });
  assert.equal(args[args.indexOf('-segment_time') + 1], '30');
  assert.equal(args[args.indexOf('-i') + 1], 'rtsp://relay.example.com:8554/live/radio_2');
  assert.equal(args.at(-1), '/spool/abc/%06d.mp4');
  assertCopyOnly(args);
});

test('invalid inputs throw', () => {
  assert.throws(() => recorderArgs({ stream: 'Main', spoolDir: '/s', sessionId: 'a' }), /stream name/);
  assert.throws(() => recorderArgs({ stream: 'main', spoolDir: '', sessionId: 'a' }), /spoolDir/);
  assert.throws(() => recorderArgs({ stream: 'main', spoolDir: '/s', sessionId: '../x' }), /sessionId/);
  assert.throws(() => recorderArgs({ stream: 'main', spoolDir: '/s', sessionId: 'a', segmentSeconds: 0 }), /segmentSeconds/);
  assert.throws(() => recorderArgs({ stream: 'main', spoolDir: '/s', sessionId: 'a', segmentSeconds: 1.5 }), /segmentSeconds/);
});

test('inputArgs override replaces the RTSP input and its flags', () => {
  const args = recorderArgs({ stream: 'main', spoolDir: '/s', sessionId: 'a', inputArgs: { input: '/media/x.mp4' } });
  assert.deepEqual(args.slice(0, 5), ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-i']);
  assert.equal(args[4 + 1], '/media/x.mp4');
  assert.ok(!args.includes('-rtsp_transport'));
  assertCopyOnly(args);
});

test('closedSegments keeps every segment except the newest, in order', () => {
  assert.deepEqual(closedSegments(['000002.mp4', '000000.mp4', '000001.mp4']), ['000000.mp4', '000001.mp4']);
});

test('closedSegments ignores other names', () => {
  assert.deepEqual(
    closedSegments(['000000.mp4', '000001.mp4', 'junk.txt', '000002.mp4.part', '00003.mp4', '1234567.mp4', 'stream.m3u8', 'x000004.mp4']),
    ['000000.mp4'],
  );
});

test('closedSegments is empty for zero or one segment', () => {
  assert.deepEqual(closedSegments([]), []);
  assert.deepEqual(closedSegments(['000000.mp4']), []);
  assert.deepEqual(closedSegments(['junk.txt']), []);
  assert.deepEqual(closedSegments(undefined), []);
});
