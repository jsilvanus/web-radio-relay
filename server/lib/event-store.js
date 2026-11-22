// Timeline event storage (plan 7, P7.1) on the `events` table of store.js.
//
// Functions take an open node:sqlite handle (`store.db`) and expect events
// already checked by validateEvent. No clock reads: callers pass nowMs.
// Release rule, as in captions.js: an event is due when
// startedAt <= nowMs - delayMs.

const DEFAULT_WINDOW_MS = 30_000;

const COLUMNS = 'id, type, lang, started_at, ended_at, payload_json, source_key, received_at';

function toEvent(row) {
  return {
    id: row.id,
    type: row.type,
    lang: row.lang,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sourceKey: row.source_key,
    payload: JSON.parse(row.payload_json),
    receivedAt: row.received_at,
  };
}

/**
 * Store validated events. A non-null sourceKey that is already stored for this
 * stream and type is ignored (counted as deduped). Events without a sourceKey
 * are always stored (SQLite never treats NULLs as equal).
 * @returns {{ added: number, deduped: number }}
 */
export function addEvents(db, stream, events, nowMs) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events
       (stream, type, lang, started_at, ended_at, payload_json, source_key, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  let deduped = 0;
  db.exec('BEGIN');
  try {
    for (const e of events) {
      const result = insert.run(
        stream,
        e.type,
        e.lang ?? null,
        e.startedAt,
        e.endedAt ?? null,
        JSON.stringify(e.payload),
        e.sourceKey ?? null,
        nowMs,
      );
      if (result.changes) added++;
      else deduped++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { added, deduped };
}

/**
 * Events released to listeners, oldest first.
 * Due when started_at <= nowMs - delayMs and started_at >= from
 * (from defaults to nowMs - delayMs - 30 s). An empty or missing `types` list
 * means no type filter.
 * @returns {{ events: object[], next: number }} `next` is the `from` for the next poll
 */
export function dueEvents(db, { stream, nowMs, delayMs = 0, from, types, lang, limit = 200 }) {
  const cutoff = nowMs - delayMs;
  const start = from ?? cutoff - DEFAULT_WINDOW_MS;

  const where = ['stream = ?', 'started_at <= ?', 'started_at >= ?'];
  const params = [stream, cutoff, start];
  if (types && types.length) {
    where.push(`type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }
  if (lang) {
    where.push('lang = ?');
    params.push(lang);
  }
  params.push(limit);

  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM events WHERE ${where.join(' AND ')} ORDER BY started_at, id LIMIT ?`)
    .all(...params);
  const events = rows.map(toEvent);
  const next = events.length ? events[events.length - 1].startedAt + 1 : start;
  return { events, next };
}

/**
 * The newest event of one type that is due (same release rule as dueEvents),
 * or null. For "current section" and similar.
 */
export function latestOfType(db, stream, type, nowMs, delayMs = 0) {
  const row = db
    .prepare(
      `SELECT ${COLUMNS} FROM events
       WHERE stream = ? AND type = ? AND started_at <= ?
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(stream, type, nowMs - delayMs);
  return row ? toEvent(row) : null;
}

/**
 * Every event of a stream that starts in [fromMs, toMs), oldest first. No
 * release delay: for archives and the timeline of a finished stream.
 */
export function rangeEvents(db, { stream, fromMs, toMs }) {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM events
       WHERE stream = ? AND started_at >= ? AND started_at < ?
       ORDER BY started_at, id`,
    )
    .all(stream, fromMs, toMs);
  return rows.map(toEvent);
}

/**
 * Delete events that start before `olderThanMs`, on any stream.
 * @returns {number} deleted count
 */
export function prune(db, olderThanMs) {
  return db.prepare('DELETE FROM events WHERE started_at < ?').run(olderThanMs).changes;
}
