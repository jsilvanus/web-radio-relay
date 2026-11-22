import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openStore } from '../lib/store.js';
import { addEvents } from '../lib/event-store.js';
import { createEventBus, storeAndPublish } from '../lib/event-bus.js';
import { validateEvent } from '../lib/events.js';
import { openViewerSession, closeViewerSessions, viewerSessionCount } from '../lib/viewer-sse.js';

const STREAM = 'church';
const T0 = Date.UTC(2026, 2, 10, 12, 0, 0, 0);

/** A fake http response: records what is written and emits 'close' when ended. */
function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writableEnded = false;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  res.write = (chunk) => {
    res.chunks.push(chunk);
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
    res.emit('close');
  };
  return res;
}

/** Parsed SSE frames written so far (comments are skipped). */
function frames(res) {
  const out = [];
  for (const block of res.chunks.join('').split('\n\n')) {
    if (!block.trim() || block.startsWith(':')) continue;
    const name = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    out.push({ event: name, data: JSON.parse(data) });
  }
  return out;
}

const named = (res, name) => frames(res).filter((f) => f.event === name);

function ev(input) {
  const checked = validateEvent(input);
  assert.equal(checked.ok, true, checked.error);
  return checked.event;
}

/** Fake clock and timers: the test advances time and fires timers by hand. */
function clock(start = T0) {
  const state = { now: start, timers: [] };
  state.nowMs = () => state.now;
  state.setTimer = (fn, ms) => {
    const t = { fn, ms, cleared: false };
    state.timers.push(t);
    return t;
  };
  state.clearTimer = (t) => {
    t.cleared = true;
  };
  state.fire = (ms) => {
    for (const t of state.timers) if (!t.cleared && t.ms === ms) t.fn();
  };
  state.active = (ms) => state.timers.filter((t) => !t.cleared && t.ms === ms).length;
  return state;
}

function open(db, bus, clk, args) {
  const res = fakeRes();
  const session = openViewerSession({
    res,
    db,
    bus,
    stream: STREAM,
    nowMs: clk.nowMs,
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
    tickMs: 500,
    heartbeatMs: 25_000,
    ...args,
  });
  return { res, session };
}

test('headers: SSE, CORS *, and a connected event naming the stream and mode', () => {
  const { db, close } = openStore(':memory:');
  try {
    const clk = clock();
    const { res } = open(db, createEventBus(), clk, { mode: 'live' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
    assert.deepEqual(frames(res)[0], { event: 'connected', data: { ok: true, stream: STREAM, mode: 'live' } });
  } finally {
    close();
  }
});

test('live: a caption stored through storeAndPublish reaches the viewer at once', () => {
  const { db, close } = openStore(':memory:');
  try {
    const bus = createEventBus();
    const clk = clock();
    const { res } = open(db, bus, clk, { mode: 'live' });
    storeAndPublish(db, bus, STREAM, [ev({ type: 'caption', lang: 'en', startedAt: T0, sourceKey: 'c1', payload: { text: 'Hei' } })], T0);
    const captions = named(res, 'caption');
    assert.equal(captions.length, 1);
    assert.equal(captions[0].data.text, 'Hei');
    assert.equal(captions[0].data.timestamp, '2026-03-10T12:00:00.000');
    assert.equal(typeof captions[0].data.sequence, 'number');
  } finally {
    close();
  }
});

test('live: a translation re-sends its caption with the same sequence and translations filled', () => {
  const { db, close } = openStore(':memory:');
  try {
    const bus = createEventBus();
    const clk = clock();
    const { res } = open(db, bus, clk, { mode: 'live' });
    storeAndPublish(db, bus, STREAM, [ev({ type: 'caption', lang: 'fi', startedAt: T0, sourceKey: 'c1', payload: { text: 'Hyvää' } })], T0);
    storeAndPublish(db, bus, STREAM, [ev({
      type: 'translation', lang: 'sv', startedAt: T0, sourceKey: 'c1:sv', payload: { text: 'God', sourceKey: 'c1' },
    })], T0 + 100);
    const captions = named(res, 'caption');
    assert.equal(captions.length, 2);
    assert.equal(captions[0].data.sequence, captions[1].data.sequence);
    assert.deepEqual(captions[0].data.translations, {});
    assert.deepEqual(captions[1].data.translations, { sv: 'God' });
    assert.equal(captions[1].data.composedText, 'Hyvää<br>God');
    // The translation itself is not a frame of its own.
    assert.equal(frames(res).some((f) => f.event === 'translation'), false);
  } finally {
    close();
  }
});

test('live: section and graphic events are sent as they are stored', () => {
  const { db, close } = openStore(':memory:');
  try {
    const bus = createEventBus();
    const clk = clock();
    const { res } = open(db, bus, clk, { mode: 'live' });
    storeAndPublish(db, bus, STREAM, [
      ev({ type: 'section', startedAt: T0, payload: { title: 'Saarna', index: 2 } }),
      ev({ type: 'graphic', startedAt: T0, payload: { kind: 'hymn-verse', hymnNumber: '12', lines: ['Rivi'] } }),
    ], T0);
    assert.equal(named(res, 'section')[0].data.title, 'Saarna');
    assert.equal(named(res, 'graphic')[0].data.hymnNumber, '12');
  } finally {
    close();
  }
});

test('live: on connect the current section, graphic and caption are sent once, in that order', () => {
  const { db, close } = openStore(':memory:');
  try {
    addEvents(db, STREAM, [
      ev({ type: 'section', startedAt: T0 - 5000, payload: { title: 'Alkuvirsi' } }),
      ev({ type: 'graphic', startedAt: T0 - 4000, payload: { kind: 'text', text: 'Tervetuloa' } }),
      ev({ type: 'caption', lang: 'fi', startedAt: T0 - 3000, sourceKey: 'old', payload: { text: 'Vanha' } }),
      ev({ type: 'caption', lang: 'fi', startedAt: T0 - 1000, sourceKey: 'new', payload: { text: 'Uusi' } }),
    ], T0);
    const bus = createEventBus();
    const clk = clock();
    const { res } = open(db, bus, clk, { mode: 'live' });
    assert.deepEqual(frames(res).map((f) => f.event), ['connected', 'section', 'graphic', 'caption']);
    assert.equal(named(res, 'caption')[0].data.text, 'Uusi');
    assert.equal(named(res, 'caption')[0].data.codes.section, 'Alkuvirsi');
    assert.equal(named(res, 'graphic')[0].data.text, 'Tervetuloa');
  } finally {
    close();
  }
});

test('live: close unsubscribes and ends the response; later publishes are not written', () => {
  const { db, close } = openStore(':memory:');
  try {
    const bus = createEventBus();
    const clk = clock();
    const { res, session } = open(db, bus, clk, { mode: 'live' });
    assert.equal(bus.subscriberCount(STREAM), 1);
    const before = res.chunks.length;
    session.close();
    assert.equal(res.writableEnded, true);
    assert.equal(bus.subscriberCount(STREAM), 0);
    storeAndPublish(db, bus, STREAM, [ev({ type: 'caption', lang: 'en', startedAt: T0, payload: { text: 'late' } })], T0);
    assert.equal(res.chunks.length, before);
  } finally {
    close();
  }
});

test('delayed: an event waits until startedAt plus the delay, then goes out once', () => {
  const { db, close } = openStore(':memory:');
  try {
    const bus = createEventBus();
    const clk = clock();
    let delayMs = 2000;
    const { res } = open(db, bus, clk, { mode: 'delayed', delayMsOf: () => delayMs });
    addEvents(db, STREAM, [ev({ type: 'caption', lang: 'fi', startedAt: T0, sourceKey: 'd1', payload: { text: 'Viive' } })], T0);

    clk.fire(500);
    assert.equal(named(res, 'caption').length, 0, 'not yet released');

    clk.now = T0 + 1999;
    clk.fire(500);
    assert.equal(named(res, 'caption').length, 0, 'still inside the delay');

    clk.now = T0 + 2000;
    clk.fire(500);
    assert.equal(named(res, 'caption').length, 1, 'released at startedAt + delay');

    clk.now = T0 + 5000;
    clk.fire(500);
    assert.equal(named(res, 'caption').length, 1, 'never sent twice');
  } finally {
    close();
  }
});

test('delayed: two events with the same startedAt are both sent, once each', () => {
  const { db, close } = openStore(':memory:');
  try {
    const clk = clock();
    const { res } = open(db, createEventBus(), clk, { mode: 'delayed', delayMsOf: () => 0 });
    addEvents(db, STREAM, [
      ev({ type: 'caption', lang: 'fi', startedAt: T0, sourceKey: 'a', payload: { text: 'A' } }),
      ev({ type: 'section', startedAt: T0, payload: { title: 'Luku' } }),
    ], T0);
    clk.fire(500);
    clk.fire(500);
    assert.equal(named(res, 'caption').length, 1);
    assert.equal(named(res, 'section').length, 1);
  } finally {
    close();
  }
});

test('delayed: a translation arriving after its caption re-sends the caption with the translation', () => {
  const { db, close } = openStore(':memory:');
  try {
    const clk = clock();
    const { res } = open(db, createEventBus(), clk, { mode: 'delayed', delayMsOf: () => 0 });
    addEvents(db, STREAM, [ev({ type: 'caption', lang: 'fi', startedAt: T0, sourceKey: 'c9', payload: { text: 'Alku' } })], T0);
    clk.fire(500);
    assert.equal(named(res, 'caption').length, 1);

    clk.now = T0 + 800;
    addEvents(db, STREAM, [ev({
      type: 'translation', lang: 'en', startedAt: T0, sourceKey: 'c9:en', payload: { text: 'Start', sourceKey: 'c9' },
    })], clk.now);
    clk.fire(500);
    const captions = named(res, 'caption');
    assert.equal(captions.length, 2);
    assert.equal(captions[1].data.sequence, captions[0].data.sequence);
    assert.deepEqual(captions[1].data.translations, { en: 'Start' });
    assert.equal(captions[1].data.composedText, 'Alku<br>Start');
  } finally {
    close();
  }
});

test('delayed: on connect the window is marked seen, so earlier captions are not replayed', () => {
  const { db, close } = openStore(':memory:');
  try {
    addEvents(db, STREAM, [
      ev({ type: 'caption', lang: 'fi', startedAt: T0 - 20_000, sourceKey: 'x1', payload: { text: 'Ensimmäinen' } }),
      ev({ type: 'caption', lang: 'fi', startedAt: T0 - 10_000, sourceKey: 'x2', payload: { text: 'Toinen' } }),
    ], T0);
    const clk = clock();
    const { res } = open(db, createEventBus(), clk, { mode: 'delayed', delayMsOf: () => 0 });
    clk.fire(500);
    const captions = named(res, 'caption');
    assert.equal(captions.length, 1, 'only the state caption');
    assert.equal(captions[0].data.text, 'Toinen');
  } finally {
    close();
  }
});

test('heartbeat: a comment line on the heartbeat timer, and cleanup on close', () => {
  const { db, close } = openStore(':memory:');
  try {
    const clk = clock();
    const sessionsBefore = viewerSessionCount();
    const { res, session } = open(db, createEventBus(), clk, { mode: 'delayed', delayMsOf: () => 0 });
    assert.equal(viewerSessionCount(), sessionsBefore + 1);
    clk.fire(25_000);
    assert.ok(res.chunks.some((c) => c === ': keep-alive\n\n'));
    assert.equal(clk.active(500), 1);
    assert.equal(clk.active(25_000), 1);
    session.close();
    assert.equal(clk.active(500), 0);
    assert.equal(clk.active(25_000), 0);
    assert.equal(viewerSessionCount(), sessionsBefore);
  } finally {
    close();
  }
});

test('closeViewerSessions ends every open session', () => {
  const { db, close } = openStore(':memory:');
  try {
    const bus = createEventBus();
    const clk = clock();
    closeViewerSessions(); // sessions left open by earlier tests
    const a = open(db, bus, clk, { mode: 'live' });
    const b = open(db, bus, clk, { mode: 'delayed', delayMsOf: () => 0 });
    assert.equal(viewerSessionCount(), 2);
    closeViewerSessions();
    assert.equal(a.res.writableEnded, true);
    assert.equal(b.res.writableEnded, true);
    assert.equal(viewerSessionCount(), 0);
  } finally {
    close();
  }
});
