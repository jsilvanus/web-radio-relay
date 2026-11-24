import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, validateEventBatch, EVENT_TYPES, MAX_EVENTS_PER_REQUEST } from '../lib/events.js';

const HASH = 'a'.repeat(64);
const T = 1_700_000_000_000;

function good(e) {
  const r = validateEvent(e);
  assert.equal(r.ok, true, r.error);
  return r.event;
}

function bad(e, fieldHint) {
  const r = validateEvent(e);
  assert.equal(r.ok, false, `expected rejection of ${JSON.stringify(e)}`);
  assert.match(r.error, new RegExp(fieldHint));
}

test('EVENT_TYPES lists the six plan types', () => {
  assert.deepEqual(EVENT_TYPES, ['caption', 'translation', 'section', 'graphic', 'marker', 'data']);
});

test('caption: good, with final defaulting to true and lang normalised', () => {
  const e = good({ type: 'caption', lang: ' FI ', startedAt: T, payload: { text: '  Hyvää huomenta  ' } });
  assert.equal(e.lang, 'fi');
  assert.deepEqual(e.payload, { text: 'Hyvää huomenta', final: true });
  assert.equal(e.endedAt, null);
  assert.equal(e.sourceKey, null);
});

test('caption: bad lang, missing lang, empty text, long text, bad final, bad startedAt', () => {
  bad({ type: 'caption', lang: 'finnish!', startedAt: T, payload: { text: 'x' } }, 'lang must be a language tag');
  bad({ type: 'caption', startedAt: T, payload: { text: 'x' } }, 'lang is required for caption');
  bad({ type: 'caption', lang: 'fi', startedAt: T, payload: { text: '   ' } }, 'payload.text must be 1-500');
  bad({ type: 'caption', lang: 'fi', startedAt: T, payload: { text: 'x'.repeat(501) } }, 'payload.text must be 1-500');
  bad({ type: 'caption', lang: 'fi', startedAt: T, payload: { text: 'x', final: 'yes' } }, 'payload.final');
  bad({ type: 'caption', lang: 'fi', startedAt: 0, payload: { text: 'x' } }, 'startedAt must be');
  bad({ type: 'caption', lang: 'fi', startedAt: 1.5, payload: { text: 'x' } }, 'startedAt must be');
});

test('caption: endedAt before startedAt is rejected; equal is fine', () => {
  bad({ type: 'caption', lang: 'fi', startedAt: T, endedAt: T - 1, payload: { text: 'x' } }, 'endedAt');
  const e = good({ type: 'caption', lang: 'fi', startedAt: T, endedAt: T, payload: { text: 'x' } });
  assert.equal(e.endedAt, T);
});

test('translation: good with model; needs sourceKey and lang', () => {
  const e = good({
    type: 'translation',
    lang: 'sv',
    startedAt: T,
    payload: { text: 'God morgon', sourceKey: 'cap-1', model: 'opus-x', extra: 1 },
  });
  assert.deepEqual(e.payload, { text: 'God morgon', sourceKey: 'cap-1', model: 'opus-x' });
  bad({ type: 'translation', lang: 'sv', startedAt: T, payload: { text: 'x' } }, 'payload.sourceKey must be a string');
  bad({ type: 'translation', startedAt: T, payload: { text: 'x', sourceKey: 'c' } }, 'lang is required for translation');
  bad({ type: 'translation', lang: 'sv', startedAt: T, payload: { text: 'x', sourceKey: 'c', model: 'm'.repeat(65) } }, 'payload.model');
});

test('section: good with optional kind and index; title limit; index must be >= 0', () => {
  const e = good({ type: 'section', startedAt: T, payload: { title: 'Luku', kind: 'reading', index: 0 } });
  assert.deepEqual(e.payload, { title: 'Luku', kind: 'reading', index: 0 });
  good({ type: 'section', startedAt: T, payload: { title: 'Virsi' } });
  bad({ type: 'section', startedAt: T, payload: { title: '' } }, 'payload.title must be 1-200');
  bad({ type: 'section', startedAt: T, payload: { title: 'x'.repeat(201) } }, 'payload.title must be 1-200');
  bad({ type: 'section', startedAt: T, payload: { title: 'x', index: -1 } }, 'payload.index');
  bad({ type: 'section', startedAt: T, payload: { title: 'x', kind: 'k'.repeat(33) } }, 'payload.kind');
});

test('graphic: hymn-verse with lines or text, slide/image need assetId, clear needs nothing', () => {
  const hymn = good({
    type: 'graphic',
    startedAt: T,
    payload: { kind: 'hymn-verse', hymnNumber: '123', title: 'Virsi', verse: 2, lines: ['Riemu', ''] },
  });
  assert.deepEqual(hymn.payload.lines, ['Riemu', '']);
  good({ type: 'graphic', startedAt: T, payload: { kind: 'hymn-verse', text: 'Riemu' } });
  good({ type: 'graphic', startedAt: T, payload: { kind: 'slide', assetId: `${HASH}.png` } });
  good({ type: 'graphic', startedAt: T, payload: { kind: 'image', assetId: `${HASH}.webp` } });
  good({ type: 'graphic', startedAt: T, payload: { kind: 'clear' } });
  good({ type: 'graphic', startedAt: T, payload: { kind: 'text', text: 'Hiljaisuus' } });

  bad({ type: 'graphic', startedAt: T, payload: { kind: 'hymn-verse', title: 'x' } }, 'hymn-verse needs payload.lines or payload.text');
  bad({ type: 'graphic', startedAt: T, payload: { kind: 'hymn-verse', lines: [] } }, 'hymn-verse needs');
  bad({ type: 'graphic', startedAt: T, payload: { kind: 'slide' } }, 'slide needs payload.assetId');
  bad({ type: 'graphic', startedAt: T, payload: { kind: 'image', assetId: HASH } }, 'payload.assetId');
  bad({ type: 'graphic', startedAt: T, payload: { kind: 'image', assetId: `../${HASH}.png` } }, 'payload.assetId');
  bad({ type: 'graphic', startedAt: T, payload: { kind: 'video' } }, 'payload.kind must be one of');
  bad({ type: 'graphic', startedAt: T, payload: { kind: 'text', text: 'x'.repeat(501) } }, 'payload.text must be at most 500');
  bad({ type: 'graphic', startedAt: T, payload: { kind: 'text', title: 'x'.repeat(201) } }, 'payload.title must be at most 200');
  bad({ type: 'graphic', startedAt: T, payload: { kind: 'hymn-verse', text: 'x', verse: 0 } }, 'payload.verse');
  bad({ type: 'graphic', startedAt: T, payload: { kind: 'hymn-verse', hymnNumber: 'n'.repeat(17), text: 'x' } }, 'payload.hymnNumber');
  bad({ type: 'graphic', startedAt: T, payload: { kind: 'hymn-verse', lines: 'Riemu' } }, 'payload.lines must be an array');
  bad({ type: 'graphic', startedAt: T, payload: { kind: 'hymn-verse', lines: Array(21).fill('x') } }, 'payload.lines must be an array');
  bad({ type: 'graphic', startedAt: T, payload: { kind: 'hymn-verse', lines: ['x'.repeat(201)] } }, 'payload.lines\\[0\\]');
  bad({ type: 'graphic', startedAt: T, payload: { kind: 'hymn-verse', lines: [1] } }, 'payload.lines\\[0\\]');
});

test('marker: good; label required and limited', () => {
  assert.deepEqual(good({ type: 'marker', startedAt: T, payload: { label: 'Alku', x: 1 } }).payload, { label: 'Alku' });
  bad({ type: 'marker', startedAt: T, payload: { label: ' ' } }, 'payload.label must be 1-200');
  bad({ type: 'marker', startedAt: T, payload: { label: 'x'.repeat(201) } }, 'payload.label must be 1-200');
});

test('data: good with any JSON value; name limit; size limit; undefined rejected', () => {
  const e = good({ type: 'data', startedAt: T, payload: { name: 'tila', value: { a: [1, 'ö'] } } });
  assert.deepEqual(e.payload, { name: 'tila', value: { a: [1, 'ö'] } });
  good({ type: 'data', startedAt: T, payload: { name: 'n', value: null } });
  good({ type: 'data', startedAt: T, payload: { name: 'n', value: 'x' } });
  bad({ type: 'data', startedAt: T, payload: { name: 'n'.repeat(65), value: 1 } }, 'payload.name must be 1-64');
  bad({ type: 'data', startedAt: T, payload: { name: 'n' } }, 'payload.value is required');
  bad({ type: 'data', startedAt: T, payload: { name: 'n', value: 'x'.repeat(4100) } }, 'payload.value must be at most 4096');
  bad({ type: 'data', startedAt: T, payload: { name: 'n', value: () => 1 } }, 'payload.value must be JSON');
});

test('top-level: unknown type, missing payload, bad sourceKey, non-object', () => {
  bad({ type: 'video', startedAt: T, payload: {} }, 'type must be one of');
  bad({ type: 'marker', startedAt: T }, 'payload must be an object');
  bad({ type: 'marker', startedAt: T, payload: { label: 'x' }, sourceKey: '' }, 'sourceKey must be 1-128');
  bad({ type: 'marker', startedAt: T, payload: { label: 'x' }, sourceKey: 'k'.repeat(129) }, 'sourceKey must be 1-128');
  bad({ type: 'marker', startedAt: T, payload: { label: 'x' }, sourceKey: 7 }, 'sourceKey must be a string');
  bad(null, 'event must be an object');
  bad(['marker'], 'event must be an object');
});

test('validateEvent strips unknown top-level fields', () => {
  const e = good({ type: 'marker', startedAt: T, payload: { label: 'x' }, secret: 'nope', id: 99, receivedAt: 1 });
  assert.deepEqual(Object.keys(e).sort(), ['endedAt', 'lang', 'payload', 'sourceKey', 'startedAt', 'type']);
});

test('validateEventBatch: good batch, bare array accepted, empty and too large rejected', () => {
  const ok = validateEventBatch({ events: [{ type: 'marker', startedAt: T, payload: { label: 'a' } }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.events.length, 1);
  assert.equal(validateEventBatch([{ type: 'marker', startedAt: T, payload: { label: 'a' } }]).ok, true);
  assert.equal(validateEventBatch({ events: [] }).ok, false);
  assert.equal(validateEventBatch({}).ok, false);
  assert.equal(validateEventBatch('x').ok, false);
  const many = Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, () => ({ type: 'marker', startedAt: T, payload: { label: 'a' } }));
  assert.match(validateEventBatch({ events: many }).error, /at most 100 events/);
  const exact = Array.from({ length: MAX_EVENTS_PER_REQUEST }, () => ({ type: 'marker', startedAt: T, payload: { label: 'a' } }));
  assert.equal(validateEventBatch({ events: exact }).ok, true);
});

test('validateEventBatch: one bad event rejects all and names its index', () => {
  const r = validateEventBatch({
    events: [
      { type: 'marker', startedAt: T, payload: { label: 'a' } },
      { type: 'caption', startedAt: T, payload: { text: 'x' } },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /^events\[1\]: lang is required for caption/);
});
