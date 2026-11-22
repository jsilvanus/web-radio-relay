import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayMapper } from '../lib/gateway-map.js';

const NOW = 1_800_000_000_000;

test('translation becomes a translation event keyed by sourceKey and language', () => {
  const m = createGatewayMapper();
  const [ev] = m.map({
    event: 'translation',
    data: JSON.stringify({ sourceKey: 'auditor:12', sourceSeq: 12, lang: 'sv', text: 'Hej', startMs: NOW - 5000, endMs: NOW - 4000, model: 'tr-1' }),
  }, NOW);
  assert.deepEqual(ev, {
    type: 'translation',
    lang: 'sv',
    startedAt: NOW - 5000,
    endedAt: NOW - 4000,
    sourceKey: 'auditor:12:sv',
    payload: { text: 'Hej', sourceKey: 'auditor:12', model: 'tr-1' },
  });
  assert.deepEqual(m.stats(), { mapped: 1, rejected: 0, unknown: 0 });
});

test('translation without startMs is rejected and counted', () => {
  const m = createGatewayMapper();
  const out = m.map({ event: 'translation', data: { sourceKey: 'a:1', lang: 'en', text: 'Hi' } }, NOW);
  assert.deepEqual(out, []);
  assert.deepEqual(m.stats(), { mapped: 0, rejected: 1, unknown: 0 });
});

test('translation without sourceKey is rejected', () => {
  const m = createGatewayMapper();
  assert.deepEqual(m.map({ event: 'translation', data: { lang: 'en', text: 'Hi', startMs: NOW, endMs: NOW } }, NOW), []);
  assert.equal(m.stats().rejected, 1);
});

test('rundown becomes a section event when the section title changes', () => {
  const m = createGatewayMapper();
  const first = m.map({
    event: 'rundown',
    data: { loaded: true, title: 'Messu', currentIndex: 0, currentItem: { id: 'i1', line: 1, index: 0, title: 'Alkulaulu', section: 'Alkulaulu' }, display: { activeSection: 'Alkulaulu' } },
  }, NOW);
  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'section');
  assert.equal(first[0].startedAt, NOW);
  assert.equal(first[0].sourceKey, `rundown:i1:${NOW}`);
  assert.deepEqual(first[0].payload, { title: 'Alkulaulu', index: 0 });

  const second = m.map({
    event: 'rundown',
    data: { currentItem: { id: 'i2', index: 1, title: 'Virsi 12' }, display: { activeSection: 'Alkulaulu' } },
  }, NOW + 1000);
  assert.deepEqual(second, []);

  const third = m.map({
    event: 'rundown',
    data: { currentItem: { id: 'i3', index: 2, title: 'Saarna' }, display: { activeSection: 'Saarna' } },
  }, NOW + 2000);
  assert.equal(third.length, 1);
  assert.equal(third[0].payload.title, 'Saarna');
  assert.equal(third[0].payload.index, 2);
});

test('an unchanged section is skipped, and so is a rundown with no title', () => {
  const m = createGatewayMapper();
  const snapshot = { currentItem: { id: 'x', index: 3, section: 'Rukous' } };
  assert.equal(m.map({ event: 'rundown', data: snapshot }, NOW).length, 1);
  assert.deepEqual(m.map({ event: 'rundown', data: snapshot }, NOW + 1), []);
  assert.deepEqual(m.map({ event: 'rundown', data: { currentItem: null, display: {} } }, NOW + 2), []);
  assert.deepEqual(m.stats(), { mapped: 1, rejected: 0, unknown: 0 });
});

test('a rundown section falls back from display to item section to item title', () => {
  const m = createGatewayMapper();
  const [byItemSection] = m.map({ event: 'rundown', data: { currentItem: { id: 'a', section: 'Lukukappale', title: 'Joh 3' } } }, NOW);
  assert.equal(byItemSection.payload.title, 'Lukukappale');
  const [byTitle] = m.map({ event: 'rundown', data: { currentItem: { id: 'b', title: 'Päivän virsi' } } }, NOW + 1);
  assert.equal(byTitle.payload.title, 'Päivän virsi');
  assert.equal(byTitle.payload.index, undefined);
});

test('graphic data is validated as a relay event, startedAt defaults to now', () => {
  const m = createGatewayMapper();
  const [ev] = m.map({
    event: 'graphic',
    data: { type: 'graphic', payload: { kind: 'hymn-verse', hymnNumber: '123', title: 'Virsi', verse: 2, lines: ['Rivi yksi', 'Rivi kaksi'] } },
  }, NOW);
  assert.equal(ev.type, 'graphic');
  assert.equal(ev.startedAt, NOW);
  assert.equal(ev.payload.kind, 'hymn-verse');
  assert.deepEqual(ev.payload.lines, ['Rivi yksi', 'Rivi kaksi']);
  assert.deepEqual(m.stats(), { mapped: 1, rejected: 0, unknown: 0 });
});

test('graphic keeps a startedAt given by the sender', () => {
  const m = createGatewayMapper();
  const [ev] = m.map({ event: 'graphic', data: { type: 'graphic', startedAt: NOW - 500, payload: { kind: 'text', text: 'Hei' } } }, NOW);
  assert.equal(ev.startedAt, NOW - 500);
});

test('an invalid graphic is rejected and counted', () => {
  const m = createGatewayMapper();
  assert.deepEqual(m.map({ event: 'graphic', data: { type: 'graphic', payload: { kind: 'fireworks', text: 'x' } } }, NOW), []);
  assert.deepEqual(m.map({ event: 'graphic', data: { type: 'graphic', payload: { kind: 'image' } } }, NOW), []);
  assert.deepEqual(m.map({ event: 'graphic', data: { type: 'section', payload: { kind: 'text', text: 'x' } } }, NOW), []);
  assert.deepEqual(m.map({ event: 'graphic', data: '{not json' }, NOW), []);
  assert.deepEqual(m.stats(), { mapped: 0, rejected: 4, unknown: 0 });
});

test('unknown event names are ignored and counted', () => {
  const m = createGatewayMapper();
  assert.deepEqual(m.map({ event: 'telemetry', data: '{"x":1}' }, NOW), []);
  assert.deepEqual(m.map({ event: 'transcript', data: '{}' }, NOW), []);
  assert.deepEqual(m.stats(), { mapped: 0, rejected: 0, unknown: 2 });
});

test('stats returns a copy, not the live counters', () => {
  const m = createGatewayMapper();
  const s = m.stats();
  s.mapped = 99;
  assert.equal(m.stats().mapped, 0);
});
