import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/store.js';
import { addEvents, captionBySourceKey, eventsAfterId, maxEventId, translationsOf } from '../lib/event-store.js';
import { createEventBus, storeAndPublish } from '../lib/event-bus.js';
import { validateEvent } from '../lib/events.js';

const STREAM = 'main';
const T0 = 1_700_000_000_000;

function ev(input) {
  const checked = validateEvent(input);
  assert.equal(checked.ok, true, checked.error);
  return checked.event;
}

test('publish hands rows to the listeners of one stream only', () => {
  const bus = createEventBus();
  const seen = [];
  bus.subscribe('a', (rows) => seen.push(['a', rows.length]));
  bus.subscribe('b', (rows) => seen.push(['b', rows.length]));
  bus.publish('a', [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(seen, [['a', 2]]);
});

test('unsubscribe removes the listener and the stream entry when it is the last', () => {
  const bus = createEventBus();
  const off = bus.subscribe('a', () => {});
  bus.subscribe('a', () => {});
  assert.equal(bus.subscriberCount('a'), 2);
  off();
  assert.equal(bus.subscriberCount('a'), 1);
  off();
  assert.equal(bus.subscriberCount('a'), 1);
});

test('a throwing listener does not stop the others', () => {
  const bus = createEventBus();
  let reached = false;
  bus.subscribe('a', () => {
    throw new Error('boom');
  });
  bus.subscribe('a', () => {
    reached = true;
  });
  bus.publish('a', [{ id: 1 }]);
  assert.equal(reached, true);
});

test('publish with no listeners or no rows does nothing', () => {
  const bus = createEventBus();
  assert.doesNotThrow(() => bus.publish('nobody', [{ id: 1 }]));
  let calls = 0;
  bus.subscribe('a', () => calls++);
  bus.publish('a', []);
  assert.equal(calls, 0);
});

test('storeAndPublish publishes exactly the rows it added, with their ids', () => {
  const { db, close } = openStore(':memory:');
  try {
    const bus = createEventBus();
    const published = [];
    bus.subscribe(STREAM, (rows) => published.push(...rows));
    const result = storeAndPublish(db, bus, STREAM, [
      ev({ type: 'caption', lang: 'fi', startedAt: T0, sourceKey: 'k1', payload: { text: 'Yksi' } }),
      ev({ type: 'section', startedAt: T0, payload: { title: 'Luku' } }),
    ], T0 + 1);
    assert.deepEqual(result, { added: 2, deduped: 0 });
    assert.deepEqual(published.map((r) => r.type), ['caption', 'section']);
    assert.ok(published.every((r) => Number.isInteger(r.id) && r.id > 0));
  } finally {
    close();
  }
});

test('storeAndPublish publishes nothing for a deduped batch', () => {
  const { db, close } = openStore(':memory:');
  try {
    const bus = createEventBus();
    let calls = 0;
    bus.subscribe(STREAM, () => calls++);
    const caption = ev({ type: 'caption', lang: 'fi', startedAt: T0, sourceKey: 'dup', payload: { text: 'x' } });
    storeAndPublish(db, bus, STREAM, [caption], T0);
    storeAndPublish(db, bus, STREAM, [caption], T0);
    assert.equal(calls, 1);
  } finally {
    close();
  }
});

test('storeAndPublish publishes nothing when storing fails', () => {
  const { db, close } = openStore(':memory:');
  try {
    const bus = createEventBus();
    let calls = 0;
    bus.subscribe(STREAM, () => calls++);
    // The second row cannot be serialised, so addEvents throws and rolls the batch back.
    const bad = [
      { type: 'caption', lang: 'fi', startedAt: T0, payload: { text: 'x' }, sourceKey: null },
      { type: 'marker', lang: null, startedAt: T0, payload: { n: 1n }, sourceKey: null },
    ];
    assert.throws(() => storeAndPublish(db, bus, STREAM, bad, T0));
    assert.equal(calls, 0);
  } finally {
    close();
  }
});

test('addEvents keeps its signature and still returns counts', () => {
  const { db, close } = openStore(':memory:');
  try {
    assert.deepEqual(addEvents(db, STREAM, [ev({ type: 'marker', startedAt: T0, payload: { label: 'm' } })], T0), {
      added: 1,
      deduped: 0,
    });
  } finally {
    close();
  }
});

test('store helpers: maxEventId, eventsAfterId, captionBySourceKey, translationsOf', () => {
  const { db, close } = openStore(':memory:');
  try {
    assert.equal(maxEventId(db), 0);
    storeAndPublish(db, createEventBus(), STREAM, [
      ev({ type: 'caption', lang: 'fi', startedAt: T0, sourceKey: 'c1', payload: { text: 'Alku' } }),
    ], T0);
    const before = maxEventId(db);
    assert.ok(before > 0);
    storeAndPublish(db, createEventBus(), 'other', [ev({ type: 'marker', startedAt: T0, payload: { label: 'o' } })], T0);
    storeAndPublish(db, createEventBus(), STREAM, [
      ev({ type: 'translation', lang: 'sv', startedAt: T0, sourceKey: 'c1:sv', payload: { text: 'Början', sourceKey: 'c1' } }),
      ev({ type: 'translation', lang: 'en', startedAt: T0, sourceKey: 'c1:en', payload: { text: 'Start', sourceKey: 'c1' } }),
      ev({ type: 'translation', lang: 'en', startedAt: T0, sourceKey: 'other:en', payload: { text: 'Muu', sourceKey: 'other' } }),
    ], T0);

    const added = eventsAfterId(db, STREAM, before);
    assert.deepEqual(added.map((e) => e.type), ['translation', 'translation', 'translation']);
    assert.equal(captionBySourceKey(db, STREAM, 'c1').payload.text, 'Alku');
    assert.equal(captionBySourceKey(db, STREAM, 'missing'), null);
    assert.equal(captionBySourceKey(db, 'other', 'c1'), null, 'other streams are not searched');
    assert.deepEqual(translationsOf(db, STREAM, 'c1').map((t) => [t.lang, t.payload.text]), [
      ['sv', 'Början'],
      ['en', 'Start'],
    ]);
  } finally {
    close();
  }
});
