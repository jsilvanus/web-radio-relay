import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toViewerCaption, toViewerGraphic, toViewerSection, viewerTimestamp } from '../lib/viewer-payload.js';

// The LCYT example (live-captions-yt/android/lcyt-tv/CLAUDE.md):
// { "text", "composedText": "original<br>translation", "sequence": 42,
//   "timestamp": "2026-03-10T12:00:00.000", "translations": { "fi-FI": "..." } }
const T0 = Date.UTC(2026, 2, 10, 12, 0, 0, 0);

function captionEvent(text, startedAt = T0) {
  return { id: 42, type: 'caption', lang: 'en', startedAt, payload: { text, final: true } };
}

test('viewerTimestamp is ISO with milliseconds and no trailing Z (LCYT format)', () => {
  assert.equal(viewerTimestamp(T0), '2026-03-10T12:00:00.000');
  assert.equal(viewerTimestamp(T0 + 7), '2026-03-10T12:00:00.007');
  assert.equal(viewerTimestamp(T0).endsWith('Z'), false);
});

test('toViewerCaption has exactly the LCYT field names', () => {
  const out = toViewerCaption({
    caption: captionEvent('Hyvää huomenta'),
    translations: [{ lang: 'sv', text: 'God morgon' }],
    section: 'Saarna',
    sequence: 42,
    firstLang: 'sv',
  });
  assert.deepEqual(Object.keys(out).sort(), ['codes', 'composedText', 'sequence', 'text', 'timestamp', 'translations']);
  assert.deepEqual(out, {
    text: 'Hyvää huomenta',
    composedText: 'Hyvää huomenta<br>God morgon',
    translations: { sv: 'God morgon' },
    codes: { section: 'Saarna' },
    sequence: 42,
    timestamp: '2026-03-10T12:00:00.000',
  });
});

test('composedText is the original alone when there is no translation in firstLang', () => {
  const none = toViewerCaption({ caption: captionEvent('Alku'), sequence: 1 });
  assert.equal(none.composedText, 'Alku');
  assert.deepEqual(none.translations, {});
  assert.deepEqual(none.codes, {});

  const otherLang = toViewerCaption({
    caption: captionEvent('Alku'),
    translations: [{ lang: 'en', text: 'Start' }],
    sequence: 1,
    firstLang: 'sv',
  });
  assert.equal(otherLang.composedText, 'Alku');
  assert.deepEqual(otherLang.translations, { en: 'Start' });
});

test('translations accept an array of { lang, text } or a map, and empty texts are dropped', () => {
  const fromArray = toViewerCaption({
    caption: captionEvent('x'),
    translations: [{ lang: 'fi', text: 'a' }, { lang: 'sv', text: '' }, { lang: 'en', text: 'b' }],
    sequence: 3,
  });
  assert.deepEqual(fromArray.translations, { fi: 'a', en: 'b' });

  const fromMap = toViewerCaption({ caption: captionEvent('x'), translations: { 'fi-FI': 'c' }, sequence: 3 });
  assert.deepEqual(fromMap.translations, { 'fi-FI': 'c' });
});

test('a later translation for the same sequence fills the map', () => {
  const first = toViewerCaption({ caption: captionEvent('Alku'), sequence: 42 });
  const later = toViewerCaption({
    caption: captionEvent('Alku'),
    translations: [{ lang: 'en', text: 'Start' }],
    sequence: 42,
    firstLang: 'en',
  });
  assert.equal(first.sequence, later.sequence);
  assert.equal(later.composedText, 'Alku<br>Start');
  assert.equal(later.timestamp, first.timestamp);
});

test('toViewerGraphic keeps the hymn-verse fields and drops absent ones', () => {
  const out = toViewerGraphic({
    id: 7,
    startedAt: T0,
    payload: { kind: 'hymn-verse', hymnNumber: '12', title: 'Virsi', verse: 2, lines: ['Rivi 1', 'Rivi 2'] },
  });
  assert.deepEqual(out, {
    id: 7,
    timestamp: '2026-03-10T12:00:00.000',
    kind: 'hymn-verse',
    title: 'Virsi',
    hymnNumber: '12',
    verse: 2,
    lines: ['Rivi 1', 'Rivi 2'],
  });
  assert.equal('text' in out, false);
});

test('toViewerSection carries title, kind and index when present', () => {
  const out = toViewerSection({ id: 3, startedAt: T0, payload: { title: 'Ehtoollinen', kind: 'liturgy' } });
  assert.deepEqual(out, { id: 3, timestamp: '2026-03-10T12:00:00.000', title: 'Ehtoollinen', kind: 'liturgy' });
});
