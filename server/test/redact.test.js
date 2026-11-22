import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../lib/redact.js';

test('non-string input returns an empty string', () => {
  assert.equal(redact(undefined), '');
  assert.equal(redact(null), '');
  assert.equal(redact(42), '');
  assert.equal(redact({ token: 'x' }), '');
  assert.equal(redact(['token=abc']), '');
});

test('secrets are replaced literally, longest first, empty ones ignored', () => {
  assert.equal(redact('key abc-secret here', ['abc-secret']), 'key [REDACTED] here');
  // A secret that contains another one is removed whole.
  assert.equal(redact('x abcdef y', ['abc', 'abcdef']), 'x [REDACTED] y');
  // Regex metacharacters are plain text.
  assert.equal(redact('a.*+?(b) and axxb', ['a.*+?(b)']), '[REDACTED] and axxb');
  // Empty and non-string secrets are ignored (empty would otherwise match everywhere).
  assert.equal(redact('unchanged', ['', null, 5]), 'unchanged');
  assert.equal(redact('unchanged', undefined), 'unchanged');
});

test('several secrets in one string are all replaced', () => {
  const text = 'first=AAA111 second=BBB222 third=CCC333';
  assert.equal(
    redact(text, ['AAA111', 'BBB222', 'CCC333']),
    'first=[REDACTED] second=[REDACTED] third=[REDACTED]',
  );
});

test('query values of sensitive parameters are redacted, other params kept', () => {
  assert.equal(redact('https://h.example.com/a?token=abc&x=1'), 'https://h.example.com/a?token=[REDACTED]&x=1');
  assert.equal(redact('/p?x=1&key=abc'), '/p?x=1&key=[REDACTED]');
  assert.equal(redact('?cid=123&streamid=xyz'), '?cid=[REDACTED]&streamid=[REDACTED]');
  assert.equal(redact('?secret=s1&password=p1'), '?secret=[REDACTED]&password=[REDACTED]');
});

test('parameter names are case-insensitive', () => {
  assert.equal(redact('?TOKEN=abc&Key=def'), '?TOKEN=[REDACTED]&Key=[REDACTED]');
});

test('query values stop at &, whitespace, fragment and quotes', () => {
  assert.equal(redact('?token=abc#frag'), '?token=[REDACTED]#frag');
  assert.equal(redact('"?token=abc" next'), '"?token=[REDACTED]" next');
  assert.equal(redact("'?token=abc' next"), "'?token=[REDACTED]' next");
});

test('parameter names only match as whole names', () => {
  assert.equal(redact('?monkey=banana&xtoken=1'), '?monkey=banana&xtoken=1');
  assert.equal(redact('?keyword=val'), '?keyword=val');
});

test('user:pass in any scheme becomes [REDACTED]@', () => {
  assert.equal(redact('https://user:pass@example.com/x'), 'https://[REDACTED]@example.com/x');
  assert.equal(redact('srt://me:pw@example.com:9000?mode=caller'), 'srt://[REDACTED]@example.com:9000?mode=caller');
  assert.equal(redact('ftp://onlyuser@example.com/'), 'ftp://[REDACTED]@example.com/');
});

test('rtmp and rtmps: the last path segment (stream key) is redacted', () => {
  assert.equal(
    redact('rtmp://a.rtmp.youtube.com/live2/abcd-1234'),
    'rtmp://a.rtmp.youtube.com/live2/[REDACTED]',
  );
  assert.equal(redact('rtmps://ingest.example.com/app/live/key1'), 'rtmps://ingest.example.com/app/live/[REDACTED]');
  assert.equal(redact('rtmp://ingest.example.com/app/key1/'), 'rtmp://ingest.example.com/app/[REDACTED]/');
  assert.equal(redact('RTMP://ingest.example.com/app/key1'), 'RTMP://ingest.example.com/app/[REDACTED]');
});

test('rtmp URL with only one path segment is left alone', () => {
  assert.equal(redact('rtmp://host/app'), 'rtmp://host/app');
  assert.equal(redact('rtmp://host/app/'), 'rtmp://host/app/');
  assert.equal(redact('rtmp://host'), 'rtmp://host');
});

test('rtmp with user:pass keeps the userinfo redacted and the key redacted', () => {
  assert.equal(
    redact('rtmp://user:pw@ingest.example.com/app/key1'),
    'rtmp://[REDACTED]@ingest.example.com/app/[REDACTED]',
  );
});

test('a URL that must stay unchanged', () => {
  const url = 'https://example.com/listen/main.m3u8?quality=high&lang=fi#top';
  assert.equal(redact(url), url);
  const plain = 'rtsp://mediamtx:8554/keskus';
  assert.equal(redact(plain), plain);
});

test('multi-line ffmpeg stderr with several URLs and secrets', () => {
  const stderr = [
    'Input #0, flv, from \'rtmp://ingest.example.com/app/stream-in\':',
    '  Metadata:',
    '    encoder         : Lavf',
    'Opening \'rtmp://a.rtmp.youtube.com/live2/abcd-1234\' for writing',
    'Error opening output https://graph.example.com/v1/x?token=tok123&x=1',
    'auth https://user:hunter2@cdn.example.com/hls/index.m3u8',
    'Output with secret wXyZ-99 failed',
    '[rtmp @ 0x55] Connection refused',
  ].join('\n');
  const out = redact(stderr, ['wXyZ-99']);
  assert.equal(out, [
    'Input #0, flv, from \'rtmp://ingest.example.com/app/[REDACTED]\':',
    '  Metadata:',
    '    encoder         : Lavf',
    'Opening \'rtmp://a.rtmp.youtube.com/live2/[REDACTED]\' for writing',
    'Error opening output https://graph.example.com/v1/x?token=[REDACTED]&x=1',
    'auth https://[REDACTED]@cdn.example.com/hls/index.m3u8',
    'Output with secret [REDACTED] failed',
    '[rtmp @ 0x55] Connection refused',
  ].join('\n'));
});

test('the empty string and text without anything to redact pass through', () => {
  assert.equal(redact(''), '');
  assert.equal(redact('nothing here to see'), 'nothing here to see');
});
