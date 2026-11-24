import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, migrate, openStore } from '../lib/store.js';

const TABLES = ['destinations', 'events', 'recordings', 'schema_version', 'streams', 'tokens'];

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

function version(db) {
  return db.prepare('SELECT version FROM schema_version').all().map((r) => r.version);
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'relay-store-'));
}

test('in-memory store creates all tables at the latest version', () => {
  const { db, close } = openStore(':memory:');
  try {
    assert.deepEqual(tableNames(db), TABLES);
    assert.deepEqual(version(db), [MIGRATIONS.length]);
    assert.equal(MIGRATIONS.length, 2);
  } finally {
    close();
  }
});

test('tokens table has a label column (migration 2)', () => {
  const { db, close } = openStore(':memory:');
  try {
    const cols = db.prepare('PRAGMA table_info(tokens)').all().map((c) => c.name);
    assert.ok(cols.includes('label'));
  } finally {
    close();
  }
});

test('events has the (stream, started_at) index', () => {
  const { db, close } = openStore(':memory:');
  try {
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'").all();
    assert.ok(idx.some((r) => r.name === 'events_stream_started_at'));
  } finally {
    close();
  }
});

test('opening a file store twice runs migrations once', () => {
  const dir = tempDir();
  const path = join(dir, 'nested', 'relay.db');
  try {
    const first = openStore(path);
    first.db.prepare('INSERT INTO streams (name, created_at) VALUES (?, ?)').run('keskus', 1);
    first.close();

    const second = openStore(path);
    try {
      assert.deepEqual(version(second.db), [MIGRATIONS.length]);
      assert.deepEqual(tableNames(second.db), TABLES);
      const row = second.db.prepare('SELECT name FROM streams').get();
      assert.equal(row.name, 'keskus');
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file store uses WAL and foreign keys', () => {
  const dir = tempDir();
  try {
    const { db, close } = openStore(join(dir, 'relay.db'));
    try {
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    } finally {
      close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openStore without a path uses RELAY_DB_PATH', () => {
  const dir = tempDir();
  const saved = process.env.RELAY_DB_PATH;
  process.env.RELAY_DB_PATH = join(dir, 'from-env.db');
  try {
    const { db, close } = openStore();
    try {
      assert.deepEqual(version(db), [MIGRATIONS.length]);
    } finally {
      close();
    }
  } finally {
    if (saved === undefined) delete process.env.RELAY_DB_PATH;
    else process.env.RELAY_DB_PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing migration rolls back its own changes and keeps the old version', () => {
  const { db, close } = openStore(':memory:');
  try {
    const broken = [
      ...MIGRATIONS,
      'CREATE TABLE half_done (a INTEGER); SELECT * FROM no_such_table;',
    ];
    assert.throws(() => migrate(db, broken), /no such table/);
    assert.deepEqual(version(db), [MIGRATIONS.length]);
    assert.ok(!tableNames(db).includes('half_done'));
  } finally {
    close();
  }
});

test('migrate applies only the migrations above the stored version', () => {
  const { db, close } = openStore(':memory:');
  try {
    const extra = [...MIGRATIONS, 'CREATE TABLE extra (id INTEGER PRIMARY KEY);'];
    migrate(db, extra);
    assert.deepEqual(version(db), [MIGRATIONS.length + 1]);
    assert.ok(tableNames(db).includes('extra'));
  } finally {
    close();
  }
});

test('events rejects a duplicate (stream, type, source_key)', () => {
  const { db, close } = openStore(':memory:');
  try {
    const insert = db.prepare(
      'INSERT INTO events (stream, type, source_key, received_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('keskus', 'caption', 'src-1', 1000);
    assert.throws(() => insert.run('keskus', 'caption', 'src-1', 2000), /UNIQUE constraint failed/);
    // A different stream or type with the same key is allowed.
    insert.run('other', 'caption', 'src-1', 2000);
    insert.run('keskus', 'marker', 'src-1', 2000);
  } finally {
    close();
  }
});

test('destinations are unique per stream and name', () => {
  const { db, close } = openStore(':memory:');
  try {
    db.prepare('INSERT INTO streams (name, created_at) VALUES (?, ?)').run('keskus', 1);
    const insert = db.prepare(
      'INSERT INTO destinations (id, stream, name, created_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('d1', 'keskus', 'youtube', 1);
    assert.throws(() => insert.run('d2', 'keskus', 'youtube', 2), /UNIQUE constraint failed/);
  } finally {
    close();
  }
});
