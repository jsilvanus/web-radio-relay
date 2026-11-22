// Viewer SSE session for GET /api/v1/viewer/:key (plan P7.5, plan 7.1).
//
// mode=live: events go out as the bus publishes them (the church visitors' page: no delay).
// mode=delayed: events are released at startedAt + the stream's current delay, polled from the store.
//
// Events written: connected, caption, section, graphic. A translation re-sends its caption with the
// translations filled in (same sequence). On connect the current section, graphic and caption are sent once.
// Heartbeat comment every 25 s. Everything is cleaned up when the response closes.
//
// Per-stream config (P8, stream-config.js), read at each send so a change applies at once:
// - translations sent are only the stream's visibleLanguages; composedText shows the first
//   visible language that is not the caption's own language;
// - graphic events are not sent when publicGraphics is false.
//
// Clock and timers are injected so tests run without waiting.

import { captionBySourceKey, dueEvents, latestOfType, translationsOf } from './event-store.js';
import { getConfig } from './stream-config.js';
import { toViewerCaption, toViewerGraphic, toViewerSection } from './viewer-payload.js';

export const VIEWER_MODES = ['live', 'delayed'];

/** How far behind the release clock the delayed poll looks; events older than this are not replayed. */
const WINDOW_MS = 30_000;
const TICK_MS = 500;
const HEARTBEAT_MS = 25_000;
/** Event types a viewer can receive. Translations are read, not sent (they re-send their caption). */
const PUSHED_TYPES = ['caption', 'translation', 'section', 'graphic'];

/** @type {Set<{ close: () => void }>} */
const sessions = new Set();

/**
 * Open a viewer session on an HTTP response. Writes the SSE headers and the connected event.
 * @param {object} args
 * @param {import('node:http').ServerResponse} args.res
 * @param {import('node:sqlite').DatabaseSync} args.db
 * @param {{ subscribe: Function }} args.bus event bus (used in live mode)
 * @param {string} args.stream stream name (already resolved from the viewer key)
 * @param {'live'|'delayed'} args.mode
 * @param {() => number} [args.delayMsOf] current listener delay of the stream, in ms (delayed mode)
 * @param {() => number} [args.nowMs]
 * @param {Function} [args.setTimer]
 * @param {Function} [args.clearTimer]
 * @param {number} [args.tickMs]
 * @param {number} [args.heartbeatMs]
 * @returns {{ close: () => void }}
 */
export function openViewerSession({
  res,
  db,
  bus,
  stream,
  mode,
  delayMsOf = () => 0,
  nowMs = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
  tickMs = TICK_MS,
  heartbeatMs = HEARTBEAT_MS,
}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  const handles = [];
  let unsubscribe = null;
  /** Delayed mode: event id -> { type, startedAt } of events already released to this viewer. */
  const sent = new Map();

  const releaseDelay = () => (mode === 'delayed' ? delayMsOf() : 0);
  const releaseAt = () => nowMs() - releaseDelay();

  function write(name, data) {
    if (!closed) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** The caption payload as it stands now: visible translations stored so far, section in effect at its time. */
  function captionData(row) {
    const { visibleLanguages } = getConfig(db, stream);
    const translations = (row.sourceKey ? translationsOf(db, stream, row.sourceKey) : [])
      .filter((t) => visibleLanguages.includes(t.lang));
    const section = latestOfType(db, stream, 'section', row.startedAt);
    return toViewerCaption({
      caption: row,
      translations: translations.map((t) => ({ lang: t.lang, text: t.payload.text })),
      section: section ? section.payload.title : undefined,
      sequence: row.id,
      firstLang: visibleLanguages.find((lang) => lang !== row.lang),
    });
  }

  function sendCaption(row) {
    if (row.payload.final === false) return;
    write('caption', captionData(row));
  }

  function sendRow(row) {
    if (row.type === 'caption') sendCaption(row);
    else if (row.type === 'section') write('section', toViewerSection(row));
    else if (row.type === 'graphic') {
      if (getConfig(db, stream).publicGraphics) write('graphic', toViewerGraphic(row));
    }
  }

  /** The caption a translation belongs to (payload.sourceKey), else the latest caption due. */
  function captionFor(translation) {
    const key = translation.payload.sourceKey;
    return (key && captionBySourceKey(db, stream, key)) || latestOfType(db, stream, 'caption', nowMs(), releaseDelay());
  }

  /** A translation in a language the stream does not show is not a reason to re-send a caption. */
  const isVisible = (translation) => getConfig(db, stream).visibleLanguages.includes(translation.lang);

  function onBus(rows) {
    for (const row of rows) {
      if (row.type === 'translation') {
        if (!isVisible(row)) continue;
        const caption = captionFor(row);
        if (caption) sendCaption(caption);
      } else {
        sendRow(row);
      }
    }
  }

  /**
   * Delayed mode: release what is due and not yet sent. With `silent`, mark it as sent without sending
   * (used on connect, when the state events already cover the current moment).
   */
  function release({ silent = false } = {}) {
    if (closed) return;
    const now = nowMs();
    const delayMs = releaseDelay();
    const cutoff = now - delayMs;
    for (const [id, item] of sent) {
      if (item.startedAt < cutoff - WINDOW_MS) sent.delete(id);
    }
    // The limit grows with what is already sent, so a burst inside the window cannot hide the unsent rest.
    const { events } = dueEvents(db, {
      stream,
      nowMs: now,
      delayMs,
      from: cutoff - WINDOW_MS,
      types: PUSHED_TYPES,
      limit: sent.size + 200,
    });
    const fresh = events.filter((e) => !sent.has(e.id));
    for (const e of fresh) sent.set(e.id, { type: e.type, startedAt: e.startedAt });
    if (silent) return;

    // Captions go out once per batch, after the batch, so a translation in the same batch is included.
    const captions = new Map();
    for (const e of fresh) {
      if (e.type === 'caption') {
        captions.set(e.id, e);
      } else if (e.type === 'translation') {
        if (!isVisible(e)) continue;
        const caption = captionFor(e);
        if (caption && sent.get(caption.id)?.type === 'caption') captions.set(caption.id, caption);
      } else if (e.type === 'section' || e.type === 'graphic') {
        sendRow(e);
      }
    }
    for (const caption of captions.values()) sendCaption(caption);
  }

  // Connect: one current state, then the stream. Delayed mode marks the window as already seen first.
  write('connected', { ok: true, stream, mode });
  if (mode === 'delayed') release({ silent: true });
  const at = releaseAt();
  const section = latestOfType(db, stream, 'section', at);
  const graphic = getConfig(db, stream).publicGraphics ? latestOfType(db, stream, 'graphic', at) : null;
  const caption = latestOfType(db, stream, 'caption', at);
  if (section) write('section', toViewerSection(section));
  if (graphic) write('graphic', toViewerGraphic(graphic));
  if (caption) sendCaption(caption);

  if (mode === 'live') {
    unsubscribe = bus.subscribe(stream, onBus);
  } else {
    handles.push({ handle: setTimer(() => release(), tickMs), clear: clearTimer });
  }
  handles.push({ handle: setTimer(() => { if (!closed) res.write(': keep-alive\n\n'); }, heartbeatMs), clear: clearTimer });

  function close() {
    if (closed) return;
    closed = true;
    for (const { handle, clear } of handles) clear(handle);
    if (unsubscribe) unsubscribe();
    sessions.delete(session);
    if (!res.writableEnded) res.end();
  }

  const session = { close };
  sessions.add(session);
  res.on('close', close);
  return session;
}

/** End every open viewer session (shutdown: SSE responses would keep server.close() waiting). */
export function closeViewerSessions() {
  for (const session of [...sessions]) session.close();
}

/** Number of open viewer sessions (metrics and tests). */
export function viewerSessionCount() {
  return sessions.size;
}
