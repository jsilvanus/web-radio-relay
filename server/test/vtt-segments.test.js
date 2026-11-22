import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUE_LOOKBACK_MS,
  isSubtitleLang,
  masterPlaylist,
  mpegtsForSegment,
  renditionEvents,
  segmentSeq,
  subsPlaylist,
  vttForSegment,
} from '../lib/vtt-segments.js';
import { parseMediaPlaylist } from '../lib/hls-delay.js';

const T = 1_800_000_000_000; // a fixed epoch in ms (segment clock)
const SEG = 4000;

const cap = (lang, startedAt, text, endedAt = null) => ({
  type: 'caption', lang, startedAt, endedAt, sourceKey: null, payload: { text, final: true },
});
const tr = (lang, startedAt, text, endedAt = null) => ({
  type: 'translation', lang, startedAt, endedAt, sourceKey: null, payload: { text, final: true },
});

const headerOnly = (mpegts) => `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${mpegts},LOCAL:00:00:00.000\n`;

test('an empty segment is a valid WebVTT file with the timestamp map header', () => {
  const text = vttForSegment({ segStartMs: T, segEndMs: T + SEG, events: [], lang: 'fi' });
  assert.equal(text, headerOnly(900000));
  assert.match(text, /^WEBVTT\n/);
});

test('a cue inside one segment is written relative to the segment start', () => {
  const events = [cap('fi', T + 1000, 'Hyvää huomenta', T + 3000)];
  const text = vttForSegment({ segStartMs: T, segEndMs: T + SEG, events, lang: 'original' });
  assert.equal(
    text,
    `${headerOnly(900000)}\n1\n00:00:01.000 --> 00:00:03.000\nHyvää huomenta\n`,
  );
});

test('a cue that starts or ends exactly on a segment border is in one segment only', () => {
  const ends = [cap('fi', T - 3000, 'Edellinen', T)];
  const starts = [cap('fi', T + SEG, 'Seuraava', T + SEG + 1000)];
  const before = vttForSegment({ segStartMs: T, segEndMs: T + SEG, events: [...ends, ...starts], lang: 'original' });
  assert.equal(before.includes('Edellinen'), false);
  assert.equal(before.includes('Seuraava'), false);
});

test('a cue spanning two segments appears in both, clipped to each', () => {
  const events = [tr('sv', T + 3500, 'Över gränsen', T + SEG + 1000)];
  const first = vttForSegment({ segStartMs: T, segEndMs: T + SEG, events, lang: 'sv' });
  const second = vttForSegment({
    segStartMs: T + SEG, segEndMs: T + 2 * SEG, events, lang: 'sv', originMs: T,
  });
  assert.equal(first, `${headerOnly(900000)}\n1\n00:00:03.500 --> 00:00:04.000\nÖver gränsen\n`);
  // the second segment starts 4 s later on the 90 kHz clock: 360000 ticks
  assert.equal(second, `${headerOnly(900000 + 360000)}\n1\n00:00:00.000 --> 00:00:01.000\nÖver gränsen\n`);
});

test('Finnish characters ä, ö and å survive unchanged in UTF-8', () => {
  const events = [cap('fi', T, 'Äiti ja isä öljyssä åkrin laidalla', T + 2000)];
  const text = vttForSegment({ segStartMs: T, segEndMs: T + SEG, events, lang: 'original' });
  assert.ok(text.includes('Äiti ja isä öljyssä åkrin laidalla'));
  assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text);
});

test('original is the caption events in any language; other languages only their translations', () => {
  const events = [
    cap('fi', T, 'Suomi'),
    tr('sv', T, 'Svenska'),
    tr('fi', T, 'Käännös fi'),
  ];
  const original = vttForSegment({ segStartMs: T, segEndMs: T + SEG, events, lang: 'original' });
  assert.ok(original.includes('Suomi'));
  assert.equal(original.includes('Svenska'), false);
  assert.equal(original.includes('Käännös fi'), false);

  const sv = vttForSegment({ segStartMs: T, segEndMs: T + SEG, events, lang: 'sv' });
  assert.ok(sv.includes('Svenska'));
  assert.equal(sv.includes('Suomi'), false);
});

test('renditionEvents keeps caption events for original and translations per language', () => {
  const events = [cap('fi', 1, 'a'), tr('sv', 2, 'b'), tr('fi', 3, 'c')];
  assert.deepEqual(renditionEvents(events, 'original').map((e) => e.lang), ['original']);
  assert.deepEqual(renditionEvents(events, 'fi').map((e) => e.payload.text), ['c']);
  assert.deepEqual(renditionEvents(events, 'en'), []);
});

test('the MPEG-TS base follows the segment offset from the origin, at 90 kHz', () => {
  assert.equal(mpegtsForSegment({ segStartMs: T }), 900000);
  assert.equal(mpegtsForSegment({ segStartMs: T + 4000, originMs: T }), 900000 + 360000);
  const header = vttForSegment({
    segStartMs: T + 4000, segEndMs: T + 8000, events: [], lang: 'fi', originMs: T,
  });
  assert.equal(header, headerOnly(1260000));
});

test('the segment window is validated', () => {
  assert.throws(() => vttForSegment({ segStartMs: T, segEndMs: T, events: [], lang: 'fi' }), /segEndMs/);
  assert.throws(() => vttForSegment({ segStartMs: T, segEndMs: T + SEG, events: [], lang: 'FI' }), /language/);
  assert.throws(() => vttForSegment({ segStartMs: T, segEndMs: T + SEG, events: [], lang: '../x' }), /language/);
});

test('language names: tags and original are accepted, anything else is not', () => {
  for (const ok of ['fi', 'sv', 'en', 'original', 'zh-Hant', 'sgn-fin']) {
    assert.equal(isSubtitleLang(ok), true, ok);
  }
  for (const bad of ['', 'FI', 'f', 'fin-', 'fi_x', 'fi-x-church', 'fi/../x', 'toolongtag', 'Original', null]) {
    assert.equal(isSubtitleLang(bad), false, String(bad));
  }
  assert.ok(CUE_LOOKBACK_MS > 0);
});

test('segmentSeq reads the number from %d.ts and seg00200.ts names', () => {
  assert.equal(segmentSeq('200.ts'), 200);
  assert.equal(segmentSeq('/hls/stream/video/seg00201.ts?x=1'), 201);
  assert.equal(segmentSeq('index.m3u8'), null);
});

test('master playlist text is exact', () => {
  const text = masterPlaylist({
    stream: 'messu', langs: ['fi', 'sv'], bandwidth: 2500000, resolution: '1280x720',
  });
  assert.equal(text, [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="fi",NAME="fi",DEFAULT=NO,AUTOSELECT=YES,URI="/api/streams/messu/hls/subs/fi.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="sv",NAME="sv",DEFAULT=NO,AUTOSELECT=YES,URI="/api/streams/messu/hls/subs/sv.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,SUBTITLES="subs"',
    '/api/streams/messu/hls/video/delayed.m3u8',
    '',
  ].join('\n'));
});

test('master playlist without languages has no subtitle group to point at', () => {
  const text = masterPlaylist({ stream: 'messu', langs: [], bandwidth: 1000, resolution: '640x360' });
  assert.equal(text, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\n/api/streams/messu/hls/video/delayed.m3u8\n');
});

test('master playlist refuses bad input', () => {
  assert.throws(() => masterPlaylist({ stream: 'Bad Name', langs: [], bandwidth: 1, resolution: '1x1' }), /stream name/);
  assert.throws(() => masterPlaylist({ stream: 'a', langs: ['x"y'], bandwidth: 1, resolution: '1x1' }), /language/);
  assert.throws(() => masterPlaylist({ stream: 'a', langs: [], bandwidth: 0, resolution: '1x1' }), /bandwidth/);
  assert.throws(() => masterPlaylist({ stream: 'a', langs: [], bandwidth: 1, resolution: 'hd' }), /resolution/);
});

test('subtitle playlist mirrors the video playlist: media sequence, durations, one VTT each', () => {
  const video = [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:101',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-22T10:00:00.000Z', '#EXTINF:4.000,', '/hls/stream/video/101.ts',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-22T10:00:04.000Z', '#EXTINF:3.500,', '/hls/stream/video/102.ts',
    '',
  ].join('\n');
  const parsed = parseMediaPlaylist(video);
  const text = subsPlaylist({
    stream: 'stream',
    lang: 'sv',
    segments: parsed.segments,
    mediaSequence: parsed.header.mediaSequence,
    targetDuration: parsed.header.targetDuration,
  });
  assert.equal(text, [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:101',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-22T10:00:00.000Z',
    '#EXTINF:4.000,',
    '/api/streams/stream/hls/subs/sv/101.vtt',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-22T10:00:04.000Z',
    '#EXTINF:3.500,',
    '/api/streams/stream/hls/subs/sv/102.vtt',
    '',
  ].join('\n'));
});

test('subtitle playlist leaves out segments it cannot name, and refuses bad languages', () => {
  const text = subsPlaylist({
    stream: 'stream',
    lang: 'fi',
    segments: [{ uri: 'nodigits.mp4', duration: 4, startMs: null }, { uri: '7.ts', duration: 2, startMs: null }],
    mediaSequence: 7,
  });
  assert.equal(text.includes('nodigits'), false);
  assert.ok(text.includes('/api/streams/stream/hls/subs/fi/7.vtt'));
  assert.throws(() => subsPlaylist({ stream: 'stream', lang: 'bad lang', segments: [] }), /language/);
});
