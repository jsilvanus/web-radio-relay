import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearerToken, tokensEqual, requireBearer } from '../lib/auth.js';
import { buildDelayedPlaylist, parseMediaPlaylist, parseProgramDateTime } from '../lib/hls-delay.js';
import { CaptionBuffer, validateCaptionBody } from '../lib/captions.js';

const T0 = Date.parse('2026-10-25T08:00:00.000Z');

function livePlaylist(count, startMs = T0, seconds = 4) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${seconds}`, '#EXT-X-MEDIA-SEQUENCE:100'];
  for (let i = 0; i < count; i++) {
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(startMs + i * seconds * 1000).toISOString()}`);
    lines.push(`#EXTINF:${seconds.toFixed(3)},`);
    lines.push(`seg${String(100 + i).padStart(5, '0')}.ts`);
  }
  return lines.join('\n') + '\n';
}

test('bearerToken reads only Bearer credentials', () => {
  assert.equal(bearerToken('Bearer abc'), 'abc');
  assert.equal(bearerToken('bearer abc'), 'abc');
  assert.equal(bearerToken('Basic abc'), null);
  assert.equal(bearerToken(undefined), null);
});

test('tokensEqual compares exact values', () => {
  assert.equal(tokensEqual('secret', 'secret'), true);
  assert.equal(tokensEqual('secret', 'secreT'), false);
  assert.equal(tokensEqual('secret', 'secret2'), false);
});

test('requireBearer fails closed without a configured token', () => {
  const mw = requireBearer('');
  const res = fakeRes();
  let called = false;
  mw({ headers: { authorization: 'Bearer x' } }, res, () => { called = true; });
  assert.equal(res.statusCode, 503);
  assert.equal(called, false);
});

test('requireBearer rejects wrong and missing tokens and accepts the right one', () => {
  const mw = requireBearer('good');
  for (const header of [undefined, 'Bearer bad', 'Token good']) {
    const res = fakeRes();
    let called = false;
    mw({ headers: { authorization: header } }, res, () => { called = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(called, false);
  }
  let called = false;
  mw({ headers: { authorization: 'Bearer good' } }, fakeRes(), () => { called = true; });
  assert.equal(called, true);
});

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json() { return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
}

test('parseProgramDateTime accepts ffmpeg offsets', () => {
  assert.equal(parseProgramDateTime('2026-10-25T08:00:00.000+0000'), T0);
  assert.equal(parseProgramDateTime('2026-10-25T08:00:00.000Z'), T0);
  assert.equal(parseProgramDateTime('garbage'), null);
});

test('parseMediaPlaylist reads header, PDT and durations', () => {
  const { header, segments } = parseMediaPlaylist(livePlaylist(3));
  assert.equal(header.mediaSequence, 100);
  assert.equal(segments.length, 3);
  assert.equal(segments[1].startMs, T0 + 4000);
  assert.equal(segments[1].duration, 4);
});

test('delayed playlist lists only segments that ended before now - delay', () => {
  const src = livePlaylist(10); // segments end at T0+4, +8, ... +40
  // now = T0+40s, delay 12s -> cutoff T0+28s: segments ending <= 28s are 0..6 (ends 4..28)
  const out = buildDelayedPlaylist(src, { delaySeconds: 12, nowMs: T0 + 40_000 });
  const { header, segments } = parseMediaPlaylist(out);
  assert.equal(segments.length, 6);
  assert.equal(segments[5].uri, '/hls/seg00106.ts');
  assert.equal(header.mediaSequence, 101); // 100 + (7 released - 6 window)
  assert.equal(segments[5].startMs, T0 + 24_000);
});

test('zero delay exposes everything completed', () => {
  const out = buildDelayedPlaylist(livePlaylist(10), { delaySeconds: 0, nowMs: T0 + 40_000 });
  const { segments } = parseMediaPlaylist(out);
  assert.equal(segments.length, 6);
  assert.equal(segments[5].uri.endsWith('seg00109.ts'), true);
});

test('delayed playlist is empty before the delay has passed, and null without timing', () => {
  const early = buildDelayedPlaylist(livePlaylist(2), { delaySeconds: 60, nowMs: T0 + 8_000 });
  assert.equal(parseMediaPlaylist(early).segments.length, 0);
  const untimed = '#EXTM3U\n#EXTINF:4.0,\nseg1.ts\n';
  assert.equal(buildDelayedPlaylist(untimed, { delaySeconds: 0, nowMs: T0 }), null);
});

test('segment names with path or query tricks are dropped', () => {
  const bad = livePlaylist(1).replace('seg00100.ts', '../../etc/passwd');
  const out = buildDelayedPlaylist(bad, { delaySeconds: 0, nowMs: T0 + 10_000 });
  assert.equal(out.includes('/hls/passwd'), true); // only the basename survives
  assert.equal(out.includes('..'), false);
});

test('CaptionBuffer releases captions only after the delay', () => {
  const buf = new CaptionBuffer();
  buf.add([
    { lang: 'fi', text: 'Hyvää huomenta', startedAt: T0, endedAt: null },
    { lang: 'fi', text: 'Myöhemmin', startedAt: T0 + 10_000, endedAt: null },
    { lang: 'sv', text: 'God morgon', startedAt: T0, endedAt: null },
  ]);
  const early = buf.released({ nowMs: T0 + 5_000, delayMs: 8_000, from: T0 });
  assert.equal(early.captions.length, 0);
  const due = buf.released({ nowMs: T0 + 9_000, delayMs: 8_000, from: T0 });
  assert.deepEqual(due.captions.map((c) => c.text), ['Hyvää huomenta', 'God morgon']);
  const fi = buf.released({ nowMs: T0 + 9_000, delayMs: 8_000, from: T0, lang: 'fi' });
  assert.equal(fi.captions.length, 1);
  const next = buf.released({ nowMs: T0 + 30_000, delayMs: 8_000, from: due.next, lang: 'fi' });
  assert.deepEqual(next.captions.map((c) => c.text), ['Myöhemmin']);
});

test('CaptionBuffer caps its size and prunes old entries', () => {
  const buf = new CaptionBuffer({ maxEntries: 3 });
  buf.add([1, 2, 3, 4].map((i) => ({ lang: 'fi', text: `t${i}`, startedAt: T0 + i, endedAt: null })));
  assert.deepEqual(buf.items.map((c) => c.text), ['t2', 't3', 't4']);
  buf.prune(T0 + 3);
  assert.deepEqual(buf.items.map((c) => c.text), ['t3', 't4']);
});

test('validateCaptionBody accepts good input and names the bad field', () => {
  const good = validateCaptionBody({ segments: [{ lang: 'FI', text: ' Hei ', startedAt: T0 }] }, T0);
  assert.equal(good.ok, true);
  assert.equal(good.segments[0].lang, 'fi');
  assert.equal(good.segments[0].text, 'Hei');

  assert.equal(validateCaptionBody({ segments: [] }, T0).ok, false);
  assert.match(validateCaptionBody({ segments: [{ lang: 'x-!', text: 'a', startedAt: T0 }] }, T0).error, /lang/);
  assert.match(validateCaptionBody({ segments: [{ lang: 'fi', text: '', startedAt: T0 }] }, T0).error, /text/);
  assert.match(validateCaptionBody({ segments: [{ lang: 'fi', text: 'a', startedAt: 1.5 }] }, T0).error, /startedAt/);
  assert.match(validateCaptionBody({ segments: [{ lang: 'fi', text: 'a', startedAt: T0 + 3_600_000 }] }, T0).error, /window/);
  assert.match(validateCaptionBody({ segments: [{ lang: 'fi', text: 'a', startedAt: T0, endedAt: T0 - 1 }] }, T0).error, /endedAt/);
});
