import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  vttTimestamp,
  captionsVtt,
  chaptersVtt,
  sectionsJson,
  hymnsJson,
  graphicsJson,
  eventsJsonl,
  vttSegment,
  buildSidecars,
} from '../lib/sidecars.js';

const O = 1_000_000; // session origin on the epoch clock
const A = `${'a'.repeat(64)}.png`;
const B = `${'b'.repeat(64)}.jpg`;

const cap = (lang, startedAt, text, extra = {}) => ({
  type: 'caption',
  lang,
  startedAt,
  endedAt: null,
  sourceKey: null,
  payload: { text, final: true },
  ...extra,
});
const translation = (lang, startedAt, text, extra = {}) => ({
  type: 'translation',
  lang,
  startedAt,
  endedAt: null,
  sourceKey: null,
  payload: { text, sourceKey: 'src-1', model: 'm' },
  ...extra,
});
const section = (startedAt, title, payload = {}, extra = {}) => ({
  type: 'section',
  lang: null,
  startedAt,
  endedAt: null,
  sourceKey: null,
  payload: { title, ...payload },
  ...extra,
});
const graphic = (startedAt, payload) => ({
  type: 'graphic',
  lang: null,
  startedAt,
  endedAt: null,
  sourceKey: null,
  payload,
});

/** Lines of a VTT text (no trailing newline) joined to a file body. */
const vtt = (...lines) => `${lines.join('\n')}\n`;

test('vttTimestamp formats HH:MM:SS.mmm and clamps negatives', () => {
  assert.equal(vttTimestamp(0), '00:00:00.000');
  assert.equal(vttTimestamp(3723004), '01:02:03.004');
  assert.equal(vttTimestamp(36000000), '10:00:00.000');
  assert.equal(vttTimestamp(-5), '00:00:00.000');
});

test('captionsVtt: exact text, sorted input, sv excluded, overlap cut, default length, escaping, Finnish', () => {
  const events = [
    cap('fi', O + 6000, 'Hyvää'), // no endedAt: last cue, 4000 ms
    cap('fi', O + 0, 'Hei', { endedAt: O + 2000 }),
    cap('sv', O + 3500, 'Hej'), // other language
    cap('fi', O + 5000, 'Ääkkönen ö å', { endedAt: O + 7000 }), // cut at 6000
    cap('fi', O + 3000, 'Maailma & <b>'), // no endedAt: cut at 5000
  ];
  const out = captionsVtt(events, { lang: 'fi', originMs: O });
  assert.equal(
    out,
    vtt(
      'WEBVTT',
      '',
      '1',
      '00:00:00.000 --> 00:00:02.000',
      'Hei',
      '',
      '2',
      '00:00:03.000 --> 00:00:05.000',
      'Maailma &amp; &lt;b&gt;',
      '',
      '3',
      '00:00:05.000 --> 00:00:06.000',
      'Ääkkönen ö å',
      '',
      '4',
      '00:00:06.000 --> 00:00:10.000',
      'Hyvää',
    ),
  );
});

test('captionsVtt: translations count, default length 4 s when last', () => {
  const out = captionsVtt([translation('fi', O + 1000, 'Hello')], { lang: 'fi', originMs: O });
  assert.equal(out, vtt('WEBVTT', '', '1', '00:00:01.000 --> 00:00:05.000', 'Hello'));
});

test('captionsVtt: two cues at the same instant keep only the one with an end', () => {
  const events = [cap('fi', O, 'A'), cap('fi', O, 'B', { endedAt: O + 2000 })];
  const out = captionsVtt(events, { lang: 'fi', originMs: O });
  assert.equal(out, vtt('WEBVTT', '', '1', '00:00:00.000 --> 00:00:02.000', 'B'));
});

test('captionsVtt: escapes &, <, > (so --> cannot appear) and keeps quotes', () => {
  const out = captionsVtt([cap('fi', O, 'a --> b <c> & "d"')], { lang: 'fi', originMs: O });
  assert.equal(out, vtt('WEBVTT', '', '1', '00:00:00.000 --> 00:00:04.000', 'a --&gt; b &lt;c&gt; &amp; "d"'));
});

test('captionsVtt: a multi-line text has no blank line inside the cue', () => {
  const out = captionsVtt([cap('fi', O, 'x\n\ny')], { lang: 'fi', originMs: O });
  assert.equal(out, vtt('WEBVTT', '', '1', '00:00:00.000 --> 00:00:04.000', 'x', 'y'));
});

test('captionsVtt: a cue that starts before the origin is clamped to 0', () => {
  const out = captionsVtt([cap('fi', O - 5000, 'early', { endedAt: O + 1000 })], { lang: 'fi', originMs: O });
  assert.equal(out, vtt('WEBVTT', '', '1', '00:00:00.000 --> 00:00:01.000', 'early'));
});

test('captionsVtt: empty input and empty text give a valid empty file', () => {
  assert.equal(captionsVtt([], { lang: 'fi' }), 'WEBVTT\n');
  assert.equal(captionsVtt([cap('fi', O, '   ')], { lang: 'fi', originMs: O }), 'WEBVTT\n');
});

test('chaptersVtt: exact text, each section lasts until the next, last until endMs, non-sections ignored', () => {
  const events = [
    section(O + 30000, 'Saarna & Evankeliumi'), // given first on purpose
    cap('fi', O + 10000, 'ei luku'),
    section(O, 'Alkusoitto'),
  ];
  const out = chaptersVtt(events, { originMs: O, endMs: O + 100000 });
  assert.equal(
    out,
    vtt(
      'WEBVTT',
      '',
      '1',
      '00:00:00.000 --> 00:00:30.000',
      'Alkusoitto',
      '',
      '2',
      '00:00:30.000 --> 00:01:40.000',
      'Saarna &amp; Evankeliumi',
    ),
  );
});

test('chaptersVtt: empty input is a valid empty file', () => {
  assert.equal(chaptersVtt([], { originMs: 0, endMs: 1000 }), 'WEBVTT\n');
});

test('sectionsJson: rows with kind, index and ends; missing kind/index are null', () => {
  const events = [
    section(O, 'Alkusoitto', { kind: 'intro', index: 0 }),
    section(O + 30000, 'Saarna & Evankeliumi', {}, { endedAt: O + 100000 }),
  ];
  assert.deepEqual(sectionsJson(events, { originMs: O }), [
    { title: 'Alkusoitto', kind: 'intro', index: 0, startMs: 0, endMs: 30000 },
    { title: 'Saarna & Evankeliumi', kind: null, index: null, startMs: 30000, endMs: 100000 },
  ]);
});

test('sectionsJson: an endedAt past the next section is clipped to that start', () => {
  const events = [section(O, 'Yksi', {}, { endedAt: O + 50000 }), section(O + 30000, 'Kaksi')];
  const rows = sectionsJson(events, { originMs: O });
  assert.equal(rows[0].endMs, 30000);
  assert.equal(rows[1].endMs, 30000); // open last section: endMs = startMs
});

test('hymnsJson: groups by number, falls back to title, first-appearance order', () => {
  const events = [
    graphic(O + 5000, { kind: 'hymn-verse', title: 'Virsi ilman numeroa', verse: 1, text: 'Rivi' }),
    graphic(O + 10000, { kind: 'hymn-verse', hymnNumber: '123', title: 'Oi Jumala', verse: 1, lines: ['a', 'b'] }),
    graphic(O + 6000, { kind: 'hymn-verse', title: 'Virsi ilman numeroa', verse: 2, lines: ['e'] }),
    graphic(O + 7000, { kind: 'slide', assetId: A }), // not a hymn
    graphic(O + 20000, { kind: 'hymn-verse', hymnNumber: '123', verse: 2, lines: ['c'] }),
    graphic(O + 30000, { kind: 'hymn-verse', hymnNumber: '123', verse: 3, lines: ['d'] }),
  ];
  assert.deepEqual(hymnsJson(events, { originMs: O }), [
    {
      hymnNumber: null,
      title: 'Virsi ilman numeroa',
      verses: [
        { verse: 1, lines: [], text: 'Rivi', startMs: 5000 },
        { verse: 2, lines: ['e'], text: null, startMs: 6000 },
      ],
    },
    {
      hymnNumber: '123',
      title: 'Oi Jumala',
      verses: [
        { verse: 1, lines: ['a', 'b'], text: null, startMs: 10000 },
        { verse: 2, lines: ['c'], text: null, startMs: 20000 },
        { verse: 3, lines: ['d'], text: null, startMs: 30000 },
      ],
    },
  ]);
});

test('hymnsJson: a number and a title with the same text are different hymns', () => {
  const events = [
    graphic(O, { kind: 'hymn-verse', hymnNumber: '12', lines: ['x'] }),
    graphic(O + 1, { kind: 'hymn-verse', title: '12', lines: ['y'] }),
  ];
  assert.equal(hymnsJson(events, { originMs: O }).length, 2);
});

test('graphicsJson: every graphic in time order, unique asset ids', () => {
  const events = [
    graphic(O + 2000, { kind: 'slide', title: 'Kuva', assetId: A }),
    graphic(O + 4000, { kind: 'image', assetId: A }),
    graphic(O + 6000, { kind: 'text', text: 'Teksti' }),
    graphic(O + 8000, { kind: 'image', assetId: B }),
  ];
  assert.deepEqual(graphicsJson(events, { originMs: O }), {
    graphics: [
      { kind: 'slide', title: 'Kuva', text: null, assetId: A, startMs: 2000 },
      { kind: 'image', title: null, text: null, assetId: A, startMs: 4000 },
      { kind: 'text', title: null, text: 'Teksti', assetId: null, startMs: 6000 },
      { kind: 'image', title: null, text: null, assetId: B, startMs: 8000 },
    ],
    assetIds: [A, B],
  });
});

test('eventsJsonl: one JSON object per line in time order, absolute times kept', () => {
  const later = cap('fi', O + 2000, 'Hei', { endedAt: null });
  const marker = { type: 'marker', lang: null, startedAt: O + 1000, endedAt: null, sourceKey: null, payload: { label: 'x' } };
  const out = eventsJsonl([later, marker]);
  assert.ok(out.endsWith('\n'));
  const lines = out.slice(0, -1).split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), marker);
  assert.deepEqual(JSON.parse(lines[1]), later);
  assert.equal(eventsJsonl([]), '');
});

test('vttSegment: a cue on the border belongs to the segment that holds its start only', () => {
  const events = [
    cap('fi', 9000, 'Border', { endedAt: 11000 }),
    cap('fi', 20000, 'Next', { endedAt: 21000 }),
  ];
  assert.equal(
    vttSegment({ segStartMs: 10000, segEndMs: 20000, events, lang: 'fi', mpegtsAtSegStart: 900000 }),
    vtt('WEBVTT', 'X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000', '', '1', '00:00:00.000 --> 00:00:01.000', 'Border'),
  );
  assert.equal(
    vttSegment({ segStartMs: 20000, segEndMs: 30000, events, lang: 'fi', mpegtsAtSegStart: 1800000 }),
    vtt('WEBVTT', 'X-TIMESTAMP-MAP=MPEGTS:1800000,LOCAL:00:00:00.000', '', '1', '00:00:00.000 --> 00:00:01.000', 'Next'),
  );
});

test('vttSegment: a cue spanning two segments appears, clipped, in both', () => {
  const events = [cap('fi', 15000, 'Spans', { endedAt: 25000 })];
  assert.equal(
    vttSegment({ segStartMs: 10000, segEndMs: 20000, events, lang: 'fi' }),
    vtt('WEBVTT', 'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000', '', '1', '00:00:05.000 --> 00:00:10.000', 'Spans'),
  );
  assert.equal(
    vttSegment({ segStartMs: 20000, segEndMs: 30000, events, lang: 'fi' }),
    vtt('WEBVTT', 'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000', '', '1', '00:00:00.000 --> 00:00:05.000', 'Spans'),
  );
});

test('vttSegment: no cues or other languages give a valid empty segment', () => {
  const events = [cap('sv', 500, 'Hej')];
  assert.equal(
    vttSegment({ segStartMs: 0, segEndMs: 1000, events, lang: 'fi' }),
    'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n',
  );
});

test('buildSidecars: file names, per-language captions, empty input', () => {
  const events = [
    cap('fi', O + 1000, 'Hei', { endedAt: O + 2000 }),
    cap('sv', O + 1000, 'Hej'),
    section(O, 'Alkusoitto'),
    graphic(O + 3000, { kind: 'image', assetId: A }),
  ];
  const files = buildSidecars(events, { originMs: O, endMs: O + 10000, langs: ['fi', 'sv', 'fi'] });
  assert.deepEqual(Object.keys(files).sort(), [
    'captions.fi.vtt',
    'captions.sv.vtt',
    'chapters.vtt',
    'events.jsonl',
    'graphics.json',
    'hymns.json',
    'sections.json',
  ]);
  assert.equal(files['captions.fi.vtt'], captionsVtt(events, { lang: 'fi', originMs: O }));
  assert.equal(files['captions.sv.vtt'], captionsVtt(events, { lang: 'sv', originMs: O }));
  assert.equal(files['chapters.vtt'], chaptersVtt(events, { originMs: O, endMs: O + 10000 }));
  assert.deepEqual(JSON.parse(files['sections.json']), sectionsJson(events, { originMs: O }));
  assert.deepEqual(JSON.parse(files['graphics.json']), graphicsJson(events, { originMs: O }));
  assert.equal(files['events.jsonl'], eventsJsonl(events));
});

test('buildSidecars: empty input gives valid empty files', () => {
  const files = buildSidecars([], { originMs: 0, endMs: 1000, langs: ['fi'] });
  assert.equal(files['captions.fi.vtt'], 'WEBVTT\n');
  assert.equal(files['chapters.vtt'], 'WEBVTT\n');
  assert.equal(files['sections.json'], '[]\n');
  assert.equal(files['hymns.json'], '[]\n');
  assert.deepEqual(JSON.parse(files['graphics.json']), { graphics: [], assetIds: [] });
  assert.equal(files['events.jsonl'], '');
});

test('buildSidecars: rejects a language tag that is not safe in a file name', () => {
  assert.throws(() => buildSidecars([], { langs: ['../x'] }), TypeError);
});
