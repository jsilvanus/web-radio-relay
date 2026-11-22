import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markLateTranslations, createLateCounter } from '../lib/translation-ingest.js';

const tr = (startedAt, extra = {}) => ({
  type: 'translation',
  lang: 'en',
  startedAt,
  sourceKey: `k:${startedAt}:en`,
  payload: { text: 'Good morning', sourceKey: 'k' },
  ...extra,
});

test('a translation that arrived after startedAt plus the delay is marked late', () => {
  const events = [tr(1000)];
  // delay 5 s, received at 7 s: 1000 + 5000 < 7000
  assert.equal(markLateTranslations(events, { delayMs: 5000, nowMs: 7000 }), 1);
  assert.equal(events[0].payload.late, true);
  assert.equal(events[0].payload.text, 'Good morning', 'the rest of the payload is kept');
});

test('exactly on the release time is not late (the rule is strictly less than)', () => {
  const events = [tr(1000)];
  assert.equal(markLateTranslations(events, { delayMs: 5000, nowMs: 6000 }), 0);
  assert.equal('late' in events[0].payload, false);
});

test('a translation that arrives inside the delay is not late', () => {
  const events = [tr(1000)];
  assert.equal(markLateTranslations(events, { delayMs: 5000, nowMs: 5999 }), 0);
});

test('with no delay, a translation is late once its start has passed', () => {
  const events = [tr(1000), tr(2000)];
  assert.equal(markLateTranslations(events, { delayMs: 0, nowMs: 1500 }), 1);
  assert.equal(events[0].payload.late, true);
  assert.equal('late' in events[1].payload, false);
});

test('captions and other events are never marked', () => {
  const caption = { type: 'caption', lang: 'fi', startedAt: 1000, payload: { text: 'Hei', final: true } };
  const section = { type: 'section', startedAt: 1000, payload: { title: 'Saarna' } };
  const events = [caption, section];
  assert.equal(markLateTranslations(events, { delayMs: 0, nowMs: 99_999 }), 0);
  assert.deepEqual(caption.payload, { text: 'Hei', final: true });
  assert.deepEqual(section.payload, { title: 'Saarna' });
});

test('createLateCounter: per-stream counts, zero for unknown streams, sorted entries', () => {
  const counter = createLateCounter();
  assert.equal(counter.get('church'), 0);
  counter.add('church', 2);
  counter.add('church', 1);
  counter.add('alpha', 4);
  counter.add('beta', 0);
  assert.equal(counter.get('church'), 3);
  assert.deepEqual(counter.entries(), [['alpha', 4], ['church', 3]]);
});
