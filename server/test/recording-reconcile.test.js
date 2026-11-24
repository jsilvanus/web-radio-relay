// Startup reconciliation of recordings (P5.3): rows a crash left active become interrupted;
// spool files are kept and counted. Uses a temp spool directory and an in-memory database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import { reconcileInterruptedRecordings } from '../lib/recording-service.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reconcile-'));
  const spoolDir = path.join(dir, 'spool');
  fs.mkdirSync(spoolDir, { recursive: true });
  const db = openStore(':memory:').db;
  db.prepare('INSERT INTO streams (name, created_at) VALUES (?, ?)').run('keskus', 1);
  const insert = (id, startedAt, state) => db.prepare(
    'INSERT INTO recordings (id, stream, started_at, ended_at, state, manifest_json) VALUES (?, ?, ?, NULL, ?, NULL)',
  ).run(id, 'keskus', startedAt, state);
  return { dir, spoolDir, db, insert };
}

test('reconcile marks recording, degraded and stopping rows interrupted and counts their spool segments', () => {
  const { dir, spoolDir, db, insert } = setup();
  try {
    insert('s-recording', 100, 'recording');
    insert('s-degraded', 200, 'degraded');
    insert('s-stopping', 300, 'stopping');
    insert('s-stopped', 400, 'stopped');
    insert('s-failed', 500, 'failed');
    insert('s-interrupted', 600, 'interrupted');

    // Two segments and a stray file in the recording session; a segment in the stopping one; none for degraded.
    fs.mkdirSync(path.join(spoolDir, 's-recording'));
    fs.writeFileSync(path.join(spoolDir, 's-recording', '000001.mp4'), 'x');
    fs.writeFileSync(path.join(spoolDir, 's-recording', '000002.mp4'), 'x');
    fs.writeFileSync(path.join(spoolDir, 's-recording', 'notes.txt'), 'x');
    fs.mkdirSync(path.join(spoolDir, 's-stopping'));
    fs.writeFileSync(path.join(spoolDir, 's-stopping', '000001.mp4'), 'x');

    const logs = [];
    const result = reconcileInterruptedRecordings({ db, spoolDir, log: (m) => logs.push(m) });

    assert.deepEqual(result, [
      { sessionId: 's-recording', stream: 'keskus', segments: 2 },
      { sessionId: 's-degraded', stream: 'keskus', segments: 0 },
      { sessionId: 's-stopping', stream: 'keskus', segments: 1 },
    ]);
    const states = Object.fromEntries(
      db.prepare('SELECT id, state FROM recordings').all().map((r) => [r.id, r.state]),
    );
    assert.deepEqual(states, {
      's-recording': 'interrupted',
      's-degraded': 'interrupted',
      's-stopping': 'interrupted',
      's-stopped': 'stopped',
      's-failed': 'failed',
      's-interrupted': 'interrupted',
    });
    assert.equal(logs.length, 3);
    assert.match(logs[0], /s-recording.*2 segment\(s\) left in the spool/);
    // Spool files are left alone.
    assert.equal(fs.existsSync(path.join(spoolDir, 's-recording', '000001.mp4')), true);
    assert.equal(fs.existsSync(path.join(spoolDir, 's-stopping', '000001.mp4')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcile is a no-op on the second run and on an empty table', () => {
  const { dir, spoolDir, db, insert } = setup();
  try {
    assert.deepEqual(reconcileInterruptedRecordings({ db, spoolDir }), []);
    insert('s-once', 100, 'recording');
    assert.equal(reconcileInterruptedRecordings({ db, spoolDir }).length, 1);
    assert.deepEqual(reconcileInterruptedRecordings({ db, spoolDir }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcile refuses a missing database', () => {
  assert.throws(() => reconcileInterruptedRecordings({ db: null, spoolDir: '/tmp/x' }), /needs db/);
});
