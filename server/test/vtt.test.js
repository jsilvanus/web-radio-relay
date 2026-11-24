// WebVTT writer (server/lib/vtt.js): time format and cue layout, as LCYT writes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatVttTime, buildVtt } from '../lib/vtt.js';

test('formatVttTime: HH:MM:SS.mmm, rounded to the millisecond', () => {
  assert.equal(formatVttTime(0), '00:00:00.000');
  assert.equal(formatVttTime(6021), '00:00:06.021');
  assert.equal(formatVttTime(3723456), '01:02:03.456');
  assert.equal(formatVttTime(1.4), '00:00:00.001');
  assert.throws(() => formatVttTime(-1), RangeError);
  assert.throws(() => formatVttTime(Number.NaN), RangeError);
});

test('buildVtt: header, numbered cues, blank line between cues', () => {
  const vtt = buildVtt([
    { startMs: 6000, endMs: 10000, text: 'E1 testi nro 1: äöå ÄÖÅ' },
    { startMs: 12000, endMs: 16000, text: 'two\nrows' },
  ]);
  assert.equal(vtt, 'WEBVTT\n\n1\n00:00:06.000 --> 00:00:10.000\nE1 testi nro 1: äöå ÄÖÅ\n\n'
    + '2\n00:00:12.000 --> 00:00:16.000\ntwo\nrows\n\n');
});

test('buildVtt: empty text is skipped and does not take a number; bad cues throw', () => {
  const vtt = buildVtt([
    { startMs: 0, endMs: 1000, text: '   ' },
    { startMs: 1000, endMs: 2000, text: 'kept' },
  ]);
  assert.match(vtt, /^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:02\.000\nkept\n\n$/);
  assert.equal(buildVtt([]), 'WEBVTT\n\n');
  assert.throws(() => buildVtt([{ startMs: 5, endMs: 5, text: 'x' }]), RangeError);
});
