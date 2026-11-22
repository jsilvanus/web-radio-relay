// SQLite store (node:sqlite). Schema is owned here; no I/O is wired into index.js yet.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_DB_PATH = '/var/lib/relay/relay.db';

// Each entry runs once, in order, inside its own transaction. Never edit a
// shipped entry; append a new one instead.
export const MIGRATIONS = [
  `
  CREATE TABLE streams (
    name         TEXT PRIMARY KEY,
    title        TEXT,
    config_json  TEXT,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE tokens (
    id           TEXT PRIMARY KEY,
    hash         TEXT NOT NULL UNIQUE,
    scopes_json  TEXT,
    expires_at   INTEGER,
    created_at   INTEGER NOT NULL,
    revoked_at   INTEGER
  );

  CREATE TABLE destinations (
    id           TEXT PRIMARY KEY,
    stream       TEXT NOT NULL REFERENCES streams(name) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    kind         TEXT,
    url          TEXT,
    key_enc      TEXT,
    variant      TEXT,
    enabled      INTEGER NOT NULL DEFAULT 1,
    start_with   INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    UNIQUE (stream, name)
  );

  CREATE TABLE recordings (
    id             TEXT PRIMARY KEY,
    stream         TEXT NOT NULL REFERENCES streams(name) ON DELETE CASCADE,
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER,
    state          TEXT NOT NULL,
    manifest_json  TEXT
  );

  CREATE TABLE events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    stream        TEXT NOT NULL,
    type          TEXT NOT NULL,
    lang          TEXT,
    started_at    INTEGER,
    ended_at      INTEGER,
    payload_json  TEXT,
    source_key    TEXT,
    received_at   INTEGER NOT NULL,
    UNIQUE (stream, type, source_key)
  );
  CREATE INDEX events_stream_started_at ON events (stream, started_at);
  `,
];

// Applies every migration above the stored schema version. Throws (after a
// ROLLBACK) if one fails; the version then stays at the last good migration.
export function migrate(db, migrations = MIGRATIONS) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;

  for (let i = current; i < migrations.length; i++) {
    const version = i + 1;
    db.exec('BEGIN');
    try {
      db.exec(migrations[i]);
      db.exec('DELETE FROM schema_version');
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

export function openStore(path = process.env.RELAY_DB_PATH || DEFAULT_DB_PATH) {
  const memory = path === ':memory:';
  if (!memory) mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  try {
    if (!memory) db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }

  return {
    db,
    close() {
      db.close();
    },
  };
}
