import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.js';
import {
  DEFAULT_CONFIG,
  StreamConfigError,
  getConfig,
  putConfig,
  resolveViewerStream,
  validateConfigPatch,
} from '../lib/stream-config.js';

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);

function withDb(fn) {
  const { db, close } = openStore(':memory:');
  try {
    return fn(db);
  } finally {
    close();
  }
}

test('defaults are the P8 values', () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    visibleLanguages: ['fi'],
    radio: true,
    videoHls: false,
    recordOnLive: false,
    publicGraphics: true,
    viewerKey: null,
  });
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
});

const invalid = [
  ['not an object', [1, 2], /JSON object/],
  ['null body', null, /JSON object/],
  ['unknown field', { colour: 'red' }, /unknown config field: colour/],
  ['empty visibleLanguages', { visibleLanguages: [] }, /1 to 10 language tags/],
  ['eleven languages', { visibleLanguages: Array.from({ length: 11 }, (_, i) => `l${String.fromCharCode(97 + (i % 26))}`) }, /1 to 10/],
  ['not a list', { visibleLanguages: 'fi' }, /1 to 10/],
  ['bad tag', { visibleLanguages: ['finnish!'] }, /language tags such as/],
  ['number tag', { visibleLanguages: [1] }, /language tags such as/],
  ['repeated tag', { visibleLanguages: ['fi', 'FI'] }, /must not repeat/],
  ['radio as string', { radio: 'yes' }, /radio must be true or false/],
  ['videoHls as number', { videoHls: 1 }, /videoHls must be true or false/],
  ['viewerKey too short', { viewerKey: 'short' }, /viewerKey must be null or 8-64/],
  ['viewerKey with capitals', { viewerKey: 'ABCDEFGHIJ' }, /viewerKey must be null or 8-64/],
  ['viewerKey too long', { viewerKey: 'a'.repeat(65) }, /viewerKey must be null or 8-64/],
  ['viewerKey not a string', { viewerKey: 12345678 }, /viewerKey must be null or 8-64/],
];

for (const [name, patch, pattern] of invalid) {
  test(`validateConfigPatch refuses: ${name}`, () => {
    const checked = validateConfigPatch(patch);
    assert.equal(checked.ok, false);
    assert.match(checked.error, pattern);
  });
}

const valid = [
  ['empty patch', {}, {}],
  ['languages are trimmed and lower-cased', { visibleLanguages: [' FI ', 'sv-AX'] }, { visibleLanguages: ['fi', 'sv-ax'] }],
  ['ten languages', { visibleLanguages: ['fi', 'sv', 'en', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ja'] }, { visibleLanguages: ['fi', 'sv', 'en', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ja'] }],
  ['booleans', { radio: false, videoHls: true, recordOnLive: true, publicGraphics: false }, { radio: false, videoHls: true, recordOnLive: true, publicGraphics: false }],
  ['viewerKey set', { viewerKey: 'sunnuntai_2026-a' }, { viewerKey: 'sunnuntai_2026-a' }],
  ['viewerKey cleared', { viewerKey: null }, { viewerKey: null }],
];

for (const [name, patch, expected] of valid) {
  test(`validateConfigPatch accepts: ${name}`, () => {
    assert.deepEqual(validateConfigPatch(patch), { ok: true, value: expected });
  });
}

test('getConfig: a stream without a row has the defaults, and arrays are copies', () => {
  withDb((db) => {
    const config = getConfig(db, 'church');
    assert.deepEqual(config, DEFAULT_CONFIG);
    config.visibleLanguages.push('sv');
    assert.deepEqual(getConfig(db, 'church').visibleLanguages, ['fi']);
  });
});

test('putConfig stores only the sent fields; the rest stays default and a second patch keeps the first', () => {
  withDb((db) => {
    const first = putConfig(db, 'church', { visibleLanguages: ['sv'] }, NOW);
    assert.equal(first.visibleLanguages[0], 'sv');
    assert.equal(first.radio, true);

    const second = putConfig(db, 'church', { publicGraphics: false }, NOW + 1);
    assert.deepEqual(second.visibleLanguages, ['sv']);
    assert.equal(second.publicGraphics, false);

    const row = db.prepare('SELECT config_json, created_at FROM streams WHERE name = ?').get('church');
    assert.deepEqual(JSON.parse(row.config_json), { visibleLanguages: ['sv'], publicGraphics: false });
    assert.equal(row.created_at, NOW, 'created_at is set once, on the first write');
  });
});

test('persistence: a config written through one open store is read back after reopening the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-config-'));
  try {
    const file = path.join(dir, 'relay.db');
    const first = openStore(file);
    try {
      putConfig(first.db, 'church', { radio: false, viewerKey: 'kirkko-viewer-1' }, NOW);
    } finally {
      first.close();
    }
    const reopened = openStore(file);
    try {
      const config = getConfig(reopened.db, 'church');
      assert.equal(config.radio, false);
      assert.equal(config.viewerKey, 'kirkko-viewer-1');
      assert.deepEqual(config.visibleLanguages, ['fi']);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('putConfig refuses an invalid patch with 400 and writes nothing', () => {
  withDb((db) => {
    putConfig(db, 'church', { radio: false }, NOW);
    assert.throws(() => putConfig(db, 'church', { radio: 'no' }, NOW), (err) => err instanceof StreamConfigError && err.status === 400);
    assert.equal(getConfig(db, 'church').radio, false);
  });
});

test('putConfig refuses an invalid stream name with 400', () => {
  withDb((db) => {
    assert.throws(() => putConfig(db, 'Bad Name', {}, NOW), (err) => err.status === 400 && /invalid stream name/.test(err.message));
  });
});

test('a viewerKey used by another stream is 409; the same stream may keep its own key', () => {
  withDb((db) => {
    putConfig(db, 'alpha', { viewerKey: 'shared-key-1' }, NOW);
    assert.throws(() => putConfig(db, 'beta', { viewerKey: 'shared-key-1' }, NOW), (err) => err.status === 409);
    assert.equal(putConfig(db, 'alpha', { viewerKey: 'shared-key-1', radio: false }, NOW).viewerKey, 'shared-key-1');
  });
});

test('resolveViewerStream: the viewer key opens its stream; the name works only without a viewerKey', () => {
  withDb((db) => {
    assert.equal(resolveViewerStream(db, 'stream'), 'stream', 'a stream with no row opens by name');
    // longer than 32 characters, so it cannot be mistaken for a stream name once cleared
    const key = 'alpha-viewer-key-that-is-longer-than-32';
    putConfig(db, 'alpha', { viewerKey: key }, NOW);
    assert.equal(resolveViewerStream(db, key), 'alpha');
    assert.equal(resolveViewerStream(db, 'alpha'), null, 'the name no longer opens it');
    putConfig(db, 'alpha', { viewerKey: null }, NOW);
    assert.equal(resolveViewerStream(db, 'alpha'), 'alpha', 'clearing the key restores the name');
    assert.equal(resolveViewerStream(db, key), null, 'a cleared key opens nothing');
  });
});

test('resolveViewerStream: a key that is neither a name nor a stored key gives null', () => {
  withDb((db) => {
    assert.equal(resolveViewerStream(db, 'Not A Key'), null);
    assert.equal(resolveViewerStream(db, undefined), null);
  });
});
