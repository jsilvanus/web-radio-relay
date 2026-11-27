// PostgreSQL adapter for web-radio-relay.
// Provides the identical synchronous DatabaseSync interface (prepare.run, prepare.get, prepare.all, exec, close)
// backed by a worker thread with pg.Client.
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'pg-worker.js');

export const PG_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS streams (
    name         TEXT PRIMARY KEY,
    title        TEXT,
    config_json  TEXT,
    created_at   BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tokens (
    id           TEXT PRIMARY KEY,
    hash         TEXT NOT NULL UNIQUE,
    scopes_json  TEXT,
    expires_at   BIGINT,
    created_at   BIGINT NOT NULL,
    revoked_at   BIGINT
  );

  CREATE TABLE IF NOT EXISTS destinations (
    id           TEXT PRIMARY KEY,
    stream       TEXT NOT NULL REFERENCES streams(name) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    kind         TEXT,
    url          TEXT,
    key_enc      TEXT,
    variant      TEXT,
    enabled      INTEGER NOT NULL DEFAULT 1,
    start_with   TEXT NOT NULL DEFAULT 'stream',
    created_at   BIGINT NOT NULL,
    UNIQUE (stream, name)
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id             TEXT PRIMARY KEY,
    stream         TEXT NOT NULL REFERENCES streams(name) ON DELETE CASCADE,
    started_at     BIGINT NOT NULL,
    ended_at       BIGINT,
    state          TEXT NOT NULL,
    manifest_json  TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id            BIGSERIAL PRIMARY KEY,
    stream        TEXT NOT NULL,
    type          TEXT NOT NULL,
    lang          TEXT,
    started_at    BIGINT,
    ended_at      BIGINT,
    payload_json  TEXT,
    source_key    TEXT,
    received_at   BIGINT NOT NULL,
    UNIQUE (stream, type, source_key)
  );
  CREATE INDEX IF NOT EXISTS events_stream_started_at ON events (stream, started_at);
  `,
  `
  ALTER TABLE tokens ADD COLUMN IF NOT EXISTS label TEXT;
  `,
  `
  CREATE TABLE IF NOT EXISTS pi_systems (
    id            TEXT PRIMARY KEY,
    name          TEXT,
    canva_url     TEXT,
    picontrol_url TEXT,
    mcp_url       TEXT,
    venue_json    TEXT,
    registered_at BIGINT NOT NULL,
    updated_at    BIGINT NOT NULL,
    last_seen_at  BIGINT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'online'
  );
  `,
];

/**
 * Converts SQLite parameter markers '?' to PostgreSQL '$1, $2, ...'
 * and adjusts SQLite-specific clauses to PostgreSQL standard syntax.
 * @param {string} sql
 * @returns {string}
 */
export function toPgSql(sql) {
  let paramIndex = 0;
  let converted = sql.replace(/\?/g, () => `$${++paramIndex}`);

  // SQLite 'INSERT OR IGNORE INTO streams (...) VALUES (...)' -> 'INSERT INTO streams (...) VALUES (...) ON CONFLICT (name) DO NOTHING'
  converted = converted.replace(
    /INSERT\s+OR\s+IGNORE\s+INTO\s+streams\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi,
    'INSERT INTO streams ($1) VALUES ($2) ON CONFLICT (name) DO NOTHING',
  );

  // SQLite 'INSERT OR IGNORE INTO events (...) VALUES (...)' -> 'INSERT INTO events (...) VALUES (...) ON CONFLICT DO NOTHING'
  converted = converted.replace(
    /INSERT\s+OR\s+IGNORE\s+INTO\s+events\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi,
    'INSERT INTO events ($1) VALUES ($2) ON CONFLICT DO NOTHING',
  );

  // Generic fallback for any remaining INSERT OR IGNORE
  converted = converted.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');

  return converted;
}

/**
 * Creates a synchronous PostgreSQL store matching node:sqlite DatabaseSync interface.
 * @param {string|object} config Connection string or pg.Client config object
 * @param {string[]} [migrations]
 * @returns {{ db: object, close: Function }}
 */
export function openPgStore(config, migrations = PG_MIGRATIONS) {
  const connectionConfig =
    typeof config === 'string'
      ? { connectionString: config }
      : config;

  const sab = new SharedArrayBuffer(4);
  const signal = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();

  const worker = new Worker(WORKER_PATH);
  worker.postMessage({ port: port2, signal, config: connectionConfig }, [port2]);

  // Wait for worker initialization
  Atomics.wait(signal, 0, 0);
  Atomics.store(signal, 0, 0);
  const initMsg = receiveMessageOnPort(port1);
  if (!initMsg || !initMsg.message || !initMsg.message.ok) {
    worker.terminate();
    const err = initMsg?.message?.error || 'Failed to initialize PostgreSQL connection in worker';
    throw new Error(`[openPgStore] Connection failed: ${err}`);
  }

  function callWorker(payload) {
    port1.postMessage(payload);
    Atomics.wait(signal, 0, 0);
    Atomics.store(signal, 0, 0);
    const res = receiveMessageOnPort(port1);
    if (!res || !res.message) {
      throw new Error('[openPgStore] No response from PostgreSQL worker thread');
    }
    if (!res.message.ok) {
      const err = new Error(res.message.error || 'PostgreSQL query error');
      if (res.message.code) err.code = res.message.code;
      throw err;
    }
    return res.message;
  }

  const db = {
    isPostgres: true,
    prepare(sql) {
      const pgSql = toPgSql(sql);
      return {
        run(...params) {
          const res = callWorker({ type: 'query', sql: pgSql, params });
          return { changes: res.rowCount };
        },
        get(...params) {
          const res = callWorker({ type: 'query', sql: pgSql, params });
          return res.rows && res.rows.length > 0 ? res.rows[0] : null;
        },
        all(...params) {
          const res = callWorker({ type: 'query', sql: pgSql, params });
          return res.rows || [];
        },
      };
    },
    exec(sql) {
      callWorker({ type: 'exec', sql });
    },
    close() {
      try {
        callWorker({ type: 'close' });
      } catch {}
      worker.terminate();
    },
  };

  // Run migrations
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const currentObj = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get();
    const current = currentObj ? Number(currentObj.v) : 0;

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
