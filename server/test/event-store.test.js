import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/store.js';
import { addEvents, dueEvents, latestOfType, rangeEvents, prune } from '../lib/event-store.js';

const STREAM = 'main';

function open() {
  return openStore(':memory:');
}

function caption(startedAt, text, extra = {}) {
  return { type: 'caption', lang: 'fi', startedAt, endedAt: null, sourceKey: null, payload: { text, final: true }, ...extra };
}

function section(startedAt, title) {
  return { type: 'section', lang: null, startedAt, endedAt: null, sourceKey: null, payload: { title } };
}

test('addEvents stores events and returns counts', () => {
  const { db, close } = open();
  try {
    const r = addEvents(db, STREAM, [caption(1000, 'a'), section(1100, 'Luku')], 5000);
    assert.deepEqual(r, { added: 2, deduped: 0 });
    const rows = db.prepare('SELECT stream, type, received_at FROM events ORDER BY id').all();
    assert.deepEqual(rows.map((x) => [x.stream, x.type, x.received_at]), [
      [STREAM, 'caption', 5000],
      [STREAM, 'section', 5000],
    ]);
  } finally {
    close();
  }
});

test('dedupe by sourceKey: the same key twice is stored once', () => {
  const { db, close } = open();
  try {
    const first = caption(1000, 'a', { sourceKey: 'cap-1' });
    addEvents(db, STREAM, [first], 5000);
    const r = addEvents(db, STREAM, [caption(1000, 'a again', { sourceKey: 'cap-1' }), caption(1200, 'b', { sourceKey: 'cap-2' })], 6000);
    assert.deepEqual(r, { added: 1, deduped: 1 });
    const texts = dueEvents(db, { stream: STREAM, nowMs: 10_000 }).events.map((e) => e.payload.text);
    assert.deepEqual(texts, ['a', 'b']);
  } finally {
    close();
  }
});

test('dedupe is per stream and per type', () => {
  const { db, close } = open();
  try {
    addEvents(db, STREAM, [caption(1000, 'a', { sourceKey: 'k' })], 1);
    assert.deepEqual(addEvents(db, 'other', [caption(1000, 'a', { sourceKey: 'k' })], 1), { added: 1, deduped: 0 });
    const marker = { type: 'marker', lang: null, startedAt: 1000, endedAt: null, sourceKey: 'k', payload: { label: 'm' } };
    assert.deepEqual(addEvents(db, STREAM, [marker], 1), { added: 1, deduped: 0 });
  } finally {
    close();
  }
});

test('null sourceKey never dedupes', () => {
  const { db, close } = open();
  try {
    const r = addEvents(db, STREAM, [caption(1000, 'same'), caption(1000, 'same')], 1);
    assert.deepEqual(r, { added: 2, deduped: 0 });
    const r2 = addEvents(db, STREAM, [caption(1000, 'same')], 2);
    assert.deepEqual(r2, { added: 1, deduped: 0 });
    assert.equal(dueEvents(db, { stream: STREAM, nowMs: 10_000 }).events.length, 3);
  } finally {
    close();
  }
});

test('addEvents with an empty list changes nothing', () => {
  const { db, close } = open();
  try {
    assert.deepEqual(addEvents(db, STREAM, [], 1), { added: 0, deduped: 0 });
  } finally {
    close();
  }
});

test('dueEvents releases by delay: not before startedAt + delay', () => {
  const { db, close } = open();
  try {
    addEvents(db, STREAM, [caption(10_000, 'early'), caption(20_000, 'late')], 1);
    const now = 25_000;
    const noDelay = dueEvents(db, { stream: STREAM, nowMs: now, from: 0 });
    assert.deepEqual(noDelay.events.map((e) => e.payload.text), ['early', 'late']);

    const delayed = dueEvents(db, { stream: STREAM, nowMs: now, delayMs: 10_000, from: 0 });
    assert.deepEqual(delayed.events.map((e) => e.payload.text), ['early']);

    const exact = dueEvents(db, { stream: STREAM, nowMs: 30_000, delayMs: 10_000, from: 0 });
    assert.deepEqual(exact.events.map((e) => e.payload.text), ['early', 'late'], 'released exactly at startedAt + delay');
  } finally {
    close();
  }
});

test('dueEvents default window is nowMs - delay - 30 s', () => {
  const { db, close } = open();
  try {
    addEvents(db, STREAM, [caption(1000, 'old'), caption(80_000, 'recent')], 1);
    const r = dueEvents(db, { stream: STREAM, nowMs: 100_000 });
    assert.deepEqual(r.events.map((e) => e.payload.text), ['recent']);
    assert.equal(r.next, 80_001);
  } finally {
    close();
  }
});

test('dueEvents: next cursor is last startedAt + 1, or from when empty', () => {
  const { db, close } = open();
  try {
    addEvents(db, STREAM, [caption(1000, 'a'), caption(2000, 'b')], 1);
    const r = dueEvents(db, { stream: STREAM, nowMs: 5000, from: 0 });
    assert.equal(r.next, 2001);
    const after = dueEvents(db, { stream: STREAM, nowMs: 5000, from: r.next });
    assert.deepEqual(after.events, []);
    assert.equal(after.next, r.next);
  } finally {
    close();
  }
});

test('dueEvents: limit, ordering by startedAt then id, stream isolation', () => {
  const { db, close } = open();
  try {
    addEvents(db, STREAM, [caption(3000, 'c'), caption(1000, 'a'), caption(1000, 'b')], 1);
    addEvents(db, 'other', [caption(1500, 'x')], 1);
    const r = dueEvents(db, { stream: STREAM, nowMs: 5000, from: 0, limit: 2 });
    assert.deepEqual(r.events.map((e) => e.payload.text), ['a', 'b']);
    assert.equal(r.events[0].id < r.events[1].id, true);
    const all = dueEvents(db, { stream: STREAM, nowMs: 5000, from: 0 });
    assert.deepEqual(all.events.map((e) => e.payload.text), ['a', 'b', 'c']);
  } finally {
    close();
  }
});

test('dueEvents: type and lang filters', () => {
  const { db, close } = open();
  try {
    addEvents(
      db,
      STREAM,
      [
        caption(1000, 'fi-cap'),
        caption(1100, 'sv-cap', { lang: 'sv' }),
        section(1200, 'Luku'),
        { type: 'translation', lang: 'sv', startedAt: 1300, endedAt: null, sourceKey: null, payload: { text: 'sv-tr', sourceKey: 'c' } },
      ],
      1,
    );
    const types = dueEvents(db, { stream: STREAM, nowMs: 5000, from: 0, types: ['section', 'translation'] });
    assert.deepEqual(types.events.map((e) => e.type), ['section', 'translation']);
    const sv = dueEvents(db, { stream: STREAM, nowMs: 5000, from: 0, lang: 'sv' });
    assert.deepEqual(sv.events.map((e) => e.payload.text ?? e.payload.title), ['sv-cap', 'sv-tr']);
    const both = dueEvents(db, { stream: STREAM, nowMs: 5000, from: 0, types: ['caption'], lang: 'fi' });
    assert.deepEqual(both.events.map((e) => e.payload.text), ['fi-cap']);
    const none = dueEvents(db, { stream: STREAM, nowMs: 5000, from: 0, types: [] });
    assert.equal(none.events.length, 4, 'empty types list means no filter');
  } finally {
    close();
  }
});

test('returned event objects have the documented shape', () => {
  const { db, close } = open();
  try {
    addEvents(db, STREAM, [caption(1000, 'a', { sourceKey: 'k1', endedAt: 1500 })], 777);
    const [e] = dueEvents(db, { stream: STREAM, nowMs: 5000, from: 0 }).events;
    assert.deepEqual(Object.keys(e).sort(), ['endedAt', 'id', 'lang', 'payload', 'receivedAt', 'sourceKey', 'startedAt', 'type']);
    assert.equal(e.startedAt, 1000);
    assert.equal(e.endedAt, 1500);
    assert.equal(e.sourceKey, 'k1');
    assert.equal(e.receivedAt, 777);
    assert.deepEqual(e.payload, { text: 'a', final: true });
  } finally {
    close();
  }
});

test('latestOfType: newest due event of the type, honours delay, null when none', () => {
  const { db, close } = open();
  try {
    addEvents(db, STREAM, [section(1000, 'Ensin'), section(5000, 'Sitten'), section(9000, 'Viimeinen'), caption(9500, 'x')], 1);
    assert.equal(latestOfType(db, STREAM, 'section', 6000).payload.title, 'Sitten');
    assert.equal(latestOfType(db, STREAM, 'section', 6000, 2000).payload.title, 'Ensin', 'released at startedAt + delay');
    assert.equal(latestOfType(db, STREAM, 'section', 10_000).payload.title, 'Viimeinen');
    assert.equal(latestOfType(db, STREAM, 'graphic', 10_000), null);
    assert.equal(latestOfType(db, STREAM, 'section', 500), null);
    assert.equal(latestOfType(db, 'other', 'section', 10_000), null);
  } finally {
    close();
  }
});

test('rangeEvents: [fromMs, toMs), oldest first, no delay applied', () => {
  const { db, close } = open();
  try {
    addEvents(db, STREAM, [caption(1000, 'a'), caption(2000, 'b'), caption(3000, 'c'), caption(4000, 'd')], 1);
    const r = rangeEvents(db, { stream: STREAM, fromMs: 2000, toMs: 4000 });
    assert.deepEqual(r.map((e) => e.payload.text), ['b', 'c']);
    assert.deepEqual(rangeEvents(db, { stream: STREAM, fromMs: 0, toMs: 10_000 }).length, 4);
    assert.deepEqual(rangeEvents(db, { stream: 'other', fromMs: 0, toMs: 10_000 }), []);
  } finally {
    close();
  }
});

test('prune deletes events older than the cutoff and returns the count', () => {
  const { db, close } = open();
  try {
    addEvents(db, STREAM, [caption(1000, 'a'), caption(2000, 'b'), caption(3000, 'c')], 1);
    addEvents(db, 'other', [caption(500, 'x')], 1);
    assert.equal(prune(db, 2000), 2);
    assert.deepEqual(rangeEvents(db, { stream: STREAM, fromMs: 0, toMs: 9999 }).map((e) => e.payload.text), ['b', 'c']);
    assert.equal(prune(db, 0), 0);
  } finally {
    close();
  }
});

test('Finnish text (ä ö å) round-trips through the store', () => {
  const { db, close } = open();
  try {
    const text = 'Äiti ja isä ovat åkerilla. Hyvää yötä, Öö!';
    addEvents(db, STREAM, [caption(1000, text), section(1100, 'Ylistyslaulu äö')], 1);
    const [c, s] = dueEvents(db, { stream: STREAM, nowMs: 5000, from: 0 }).events;
    assert.equal(c.payload.text, text);
    assert.equal(s.payload.title, 'Ylistyslaulu äö');
    assert.equal(rangeEvents(db, { stream: STREAM, fromMs: 0, toMs: 9999 })[0].payload.text, text);
  } finally {
    close();
  }
});
