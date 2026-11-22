import { test } from 'node:test';
import assert from 'node:assert/strict';
import { egressArgs } from '../lib/egress-args.js';

const INPUT_RAW = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-rtsp_transport', 'tcp',
  '-rw_timeout', '10000000', '-i', 'rtsp://mediamtx:8554/live/main'];

function assertCopyOnly(args) {
  for (const a of args) {
    assert.doesNotMatch(a, /^-c:v$/);
    assert.doesNotMatch(a, /libx264|-vf|-filter/);
  }
  const i = args.indexOf('-c');
  assert.equal(args[i + 1], 'copy');
}

test('raw variant builds the copy-only FLV push', () => {
  const args = egressArgs({ stream: 'main', url: 'rtmps://a.example.com/live2', key: 'KEY' });
  assert.deepEqual(args, [...INPUT_RAW, '-map', '0', '-c', 'copy', '-f', 'flv',
    'rtmps://a.example.com/live2/KEY']);
  assertCopyOnly(args);
});

test('cc variant reads the -cc stream', () => {
  const args = egressArgs({ stream: 'main', variant: 'cc', url: 'rtmp://b.example.com/app', key: 'k' });
  assert.equal(args[args.indexOf('-i') + 1], 'rtsp://mediamtx:8554/live/main-cc');
  assert.equal(args.at(-1), 'rtmp://b.example.com/app/k');
  assertCopyOnly(args);
});

test('a trailing slash on the url is not doubled', () => {
  const args = egressArgs({ stream: 'main', url: 'rtmp://b.example.com/app///', key: 'k' });
  assert.equal(args.at(-1), 'rtmp://b.example.com/app/k');
});

test('an empty or missing key uses the url alone', () => {
  assert.equal(egressArgs({ stream: 'main', url: 'rtmp://b.example.com/app/', key: '' }).at(-1),
    'rtmp://b.example.com/app');
  assert.equal(egressArgs({ stream: 'main', url: 'rtmp://b.example.com/app' }).at(-1),
    'rtmp://b.example.com/app');
});

test('a key with special characters is passed through unchanged', () => {
  const key = 'ab/cd?x=1&y=%2F+z';
  const args = egressArgs({ stream: 'main', url: 'rtmps://a.example.com/live', key });
  assert.equal(args.at(-1), `rtmps://a.example.com/live/${key}`);
});

test('a custom rtspBase is used for the input', () => {
  const args = egressArgs({ stream: 'radio_1', rtspBase: 'rtsp://relay.example.com:8554', url: 'rtmp://x.example.com/a', key: 'k' });
  assert.equal(args[args.indexOf('-i') + 1], 'rtsp://relay.example.com:8554/live/radio_1');
});

test('invalid stream names throw', () => {
  for (const stream of ['', 'Main', 'a b', 'x'.repeat(33), undefined, 'a/b']) {
    assert.throws(() => egressArgs({ stream, url: 'rtmp://x.example.com/a' }), /stream name/);
  }
});

test('invalid variants throw', () => {
  for (const variant of ['hd', 'CC', '', null]) {
    assert.throws(() => egressArgs({ stream: 'main', variant, url: 'rtmp://x.example.com/a' }), /variant/);
  }
});

test('urls other than rtmp:// and rtmps:// throw', () => {
  for (const url of ['http://x.example.com/a', 'rtsp://x.example.com/a', 'rtmp://', '', undefined, 'x.example.com/a']) {
    assert.throws(() => egressArgs({ stream: 'main', url }), /url/);
  }
});
