import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/store.js';
import {
  createToken,
  findTokenByValue,
  hashToken,
  isUsable,
  isValidScope,
  listTokens,
  newToken,
  newTokenId,
  revokeToken,
  scopeAllows,
  validateTokenRequest,
} from '../lib/tokens.js';

const NOW = 1_700_000_000_000;

function store() {
  return openStore(':memory:');
}

test('hashToken is sha256 hex of the value', () => {
  // sha256('abc')
  assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.match(hashToken('x'), /^[0-9a-f]{64}$/);
});

test('newToken is 32 random bytes as hex, and differs each call', () => {
  const a = newToken();
  const b = newToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('newTokenId is tok_ plus 12 hex characters', () => {
  assert.match(newTokenId(), /^tok_[0-9a-f]{12}$/);
  assert.notEqual(newTokenId(), newTokenId());
});

test('isValidScope accepts admin and each stream scope', () => {
  assert.equal(isValidScope('admin'), true);
  for (const kind of ['publish', 'data', 'control', 'view']) {
    assert.equal(isValidScope(`stream:keskus:${kind}`), true, kind);
  }
  assert.equal(isValidScope('stream:a-b_9:view'), true);
  assert.equal(isValidScope('stream:' + 'a'.repeat(32) + ':data'), true);
});

test('isValidScope rejects bad names, kinds and shapes', () => {
  const bad = [
    'stream:' + 'a'.repeat(33) + ':data',
    'stream::data',
    'stream:Keskus:data',
    'stream:keskus:admin',
    'stream:keskus:data:extra',
    'stream:keskus',
    'admin ',
    'Admin',
    'read',
    '',
    undefined,
    null,
    42,
  ];
  for (const s of bad) assert.equal(isValidScope(s), false, String(s));
});

test('scopeAllows: admin allows everything', () => {
  assert.equal(scopeAllows(['admin'], 'stream:x:publish'), true);
  assert.equal(scopeAllows(['admin'], 'stream:x:control'), true);
});

test('scopeAllows: otherwise exact match only', () => {
  const scopes = ['stream:x:publish', 'stream:x:data'];
  assert.equal(scopeAllows(scopes, 'stream:x:publish'), true);
  assert.equal(scopeAllows(scopes, 'stream:x:data'), true);
  assert.equal(scopeAllows(scopes, 'stream:x:control'), false);
  assert.equal(scopeAllows(scopes, 'stream:y:publish'), false);
  assert.equal(scopeAllows([], 'stream:x:view'), false);
  assert.equal(scopeAllows(undefined, 'stream:x:view'), false);
});

test('isUsable: live token without expiry is usable', () => {
  assert.equal(isUsable({ revokedAt: null, expiresAt: null }, NOW), true);
});

test('isUsable: revoked is not usable', () => {
  assert.equal(isUsable({ revokedAt: NOW - 1, expiresAt: null }, NOW), false);
});

test('isUsable: expired is not usable, before expiry is', () => {
  assert.equal(isUsable({ revokedAt: null, expiresAt: NOW + 1000 }, NOW), true);
  assert.equal(isUsable({ revokedAt: null, expiresAt: NOW }, NOW), false);
  assert.equal(isUsable({ revokedAt: null, expiresAt: NOW - 1 }, NOW), false);
});

test('isUsable: missing row is not usable', () => {
  assert.equal(isUsable(null, NOW), false);
});

test('createToken returns the value once and stores only the hash', () => {
  const { db, close } = store();
  try {
    const made = createToken(
      db,
      { scopes: ['stream:keskus:publish', 'stream:keskus:data'], expiresInSeconds: 3600, label: 'phone' },
      NOW,
    );
    assert.match(made.id, /^tok_[0-9a-f]{12}$/);
    assert.match(made.token, /^[0-9a-f]{64}$/);
    assert.deepEqual(made.scopes, ['stream:keskus:publish', 'stream:keskus:data']);
    assert.equal(made.expiresAt, NOW + 3600 * 1000);
    assert.equal(made.label, 'phone');

    const raw = db.prepare('SELECT * FROM tokens WHERE id = ?').get(made.id);
    assert.equal(raw.hash, hashToken(made.token));
    assert.ok(!JSON.stringify(raw).includes(made.token), 'raw value must not be stored');
  } finally {
    close();
  }
});

test('createToken without expiresInSeconds never expires', () => {
  const { db, close } = store();
  try {
    const made = createToken(db, { scopes: ['admin'] }, NOW);
    assert.equal(made.expiresAt, null);
    assert.equal(made.label, null);
  } finally {
    close();
  }
});

test('createToken rejects empty or invalid scopes', () => {
  const { db, close } = store();
  try {
    assert.throws(() => createToken(db, { scopes: [] }, NOW), /non-empty/);
    assert.throws(() => createToken(db, { scopes: ['nope'] }, NOW), /invalid scope/);
    assert.throws(() => createToken(db, {}, NOW), /non-empty/);
  } finally {
    close();
  }
});

test('findTokenByValue finds the row by value, null for unknown', () => {
  const { db, close } = store();
  try {
    const made = createToken(db, { scopes: ['stream:a:view'] }, NOW);
    const row = findTokenByValue(db, made.token);
    assert.equal(row.id, made.id);
    assert.deepEqual(row.scopes, ['stream:a:view']);
    assert.equal(row.expiresAt, null);
    assert.equal(row.revokedAt, null);
    assert.equal(findTokenByValue(db, newToken()), null);
    assert.equal(findTokenByValue(db, made.token.slice(1)), null);
  } finally {
    close();
  }
});

test('listTokens never includes the value or the hash', () => {
  const { db, close } = store();
  try {
    const made = createToken(db, { scopes: ['admin'], label: 'boot' }, NOW);
    const list = listTokens(db);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, made.id);
    assert.equal(list[0].label, 'boot');
    const text = JSON.stringify(list);
    assert.ok(!text.includes(made.token));
    assert.ok(!text.includes(hashToken(made.token)));
    assert.ok(!('hash' in list[0]));
    assert.ok(!('token' in list[0]));
  } finally {
    close();
  }
});

test('revokeToken marks the row; revoked token is not usable; unknown id returns false', () => {
  const { db, close } = store();
  try {
    const made = createToken(db, { scopes: ['admin'] }, NOW);
    assert.equal(revokeToken(db, made.id, NOW + 5), true);
    const row = findTokenByValue(db, made.token);
    assert.equal(row.revokedAt, NOW + 5);
    assert.equal(isUsable(row, NOW + 6), false);
    assert.equal(revokeToken(db, 'tok_000000000000', NOW), false);
  } finally {
    close();
  }
});

test('revoking twice keeps the first revocation time', () => {
  const { db, close } = store();
  try {
    const made = createToken(db, { scopes: ['admin'] }, NOW);
    revokeToken(db, made.id, NOW + 1);
    assert.equal(revokeToken(db, made.id, NOW + 99), true);
    assert.equal(findTokenByValue(db, made.token).revokedAt, NOW + 1);
  } finally {
    close();
  }
});

test('validateTokenRequest accepts a minimal and a full body', () => {
  const min = validateTokenRequest({ scopes: ['stream:keskus:publish'] });
  assert.equal(min.ok, true);
  assert.deepEqual(min.value.scopes, ['stream:keskus:publish']);
  const full = validateTokenRequest({
    scopes: ['stream:keskus:publish', 'stream:keskus:data', 'stream:keskus:data'],
    expiresInSeconds: 43200,
    label: 'phone',
  });
  assert.equal(full.ok, true);
  assert.deepEqual(full.value.scopes, ['stream:keskus:publish', 'stream:keskus:data']);
  assert.equal(full.value.expiresInSeconds, 43200);
  assert.equal(full.value.label, 'phone');
});

test('validateTokenRequest rejects bad bodies', () => {
  const bad = [
    null,
    'text',
    [],
    {},
    { scopes: [] },
    { scopes: 'admin' },
    { scopes: Array.from({ length: 11 }, (_, i) => `stream:s${i}:view`) },
    { scopes: ['stream:Keskus:data'] },
    { scopes: ['admin'], expiresInSeconds: 59 },
    { scopes: ['admin'], expiresInSeconds: 31536001 },
    { scopes: ['admin'], expiresInSeconds: 60.5 },
    { scopes: ['admin'], expiresInSeconds: '3600' },
    { scopes: ['admin'], label: 'x'.repeat(65) },
    { scopes: ['admin'], label: 7 },
  ];
  for (const body of bad) {
    const res = validateTokenRequest(body);
    assert.equal(res.ok, false, JSON.stringify(body));
    assert.equal(typeof res.error, 'string');
  }
});

test('validateTokenRequest accepts the range limits', () => {
  assert.equal(validateTokenRequest({ scopes: ['admin'], expiresInSeconds: 60 }).ok, true);
  assert.equal(validateTokenRequest({ scopes: ['admin'], expiresInSeconds: 31536000 }).ok, true);
  assert.equal(validateTokenRequest({ scopes: ['admin'], label: 'x'.repeat(64) }).ok, true);
});
