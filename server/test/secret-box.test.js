import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertKey, encrypt, decrypt } from '../lib/secret-box.js';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

test('round trip: ascii, unicode and empty string', () => {
  for (const text of ['stream-key-123', 'äöå Ä Ö Å ✓ 🎵', '']) {
    assert.equal(decrypt(encrypt(text, KEY), KEY), text);
  }
});

test('encrypting the same text twice gives different blobs (random IV)', () => {
  const a = encrypt('same', KEY);
  const b = encrypt('same', KEY);
  assert.notEqual(a, b);
  assert.equal(decrypt(a, KEY), 'same');
  assert.equal(decrypt(b, KEY), 'same');
});

test('blob has the v1 format with a 12-byte IV and 16-byte tag', () => {
  const parts = encrypt('x', KEY).split(':');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
  assert.equal(Buffer.from(parts[1], 'base64').length, 12);
  assert.equal(Buffer.from(parts[2], 'base64').length, 16);
});

test('wrong key fails with a generic message', () => {
  const blob = encrypt('secret-value', KEY);
  assert.throws(() => decrypt(blob, OTHER_KEY), { message: 'cannot decrypt secret' });
});

test('a flipped byte in the ciphertext fails', () => {
  const [v, iv, tag, data] = encrypt('secret-value', KEY).split(':');
  const bytes = Buffer.from(data, 'base64');
  bytes[0] ^= 0x01;
  const tampered = [v, iv, tag, bytes.toString('base64')].join(':');
  assert.throws(() => decrypt(tampered, KEY), { message: 'cannot decrypt secret' });
});

test('a flipped byte in the tag fails', () => {
  const [v, iv, tag, data] = encrypt('secret-value', KEY).split(':');
  const bytes = Buffer.from(tag, 'base64');
  bytes[0] ^= 0x80;
  const tampered = [v, iv, bytes.toString('base64'), data].join(':');
  assert.throws(() => decrypt(tampered, KEY), { message: 'cannot decrypt secret' });
});

test('bad format fails without leaking key or plaintext', () => {
  const bad = [
    '',
    'not-a-blob',
    'v2:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AA==',
    'v1:only:three',
    'v1:!!!:AAAAAAAAAAAAAAAAAAAAAA==:AA==',
    'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AA==:extra',
    undefined,
    42,
  ];
  for (const blob of bad) {
    assert.throws(
      () => decrypt(blob, KEY),
      (err) => {
        assert.equal(err.message, 'cannot decrypt secret');
        assert.ok(!err.message.includes(KEY));
        return true;
      },
      `blob ${JSON.stringify(blob)} should fail`,
    );
  }
});

test('error messages never contain the key or the plaintext', () => {
  const blob = encrypt('plain-secret-text', KEY);
  assert.throws(() => decrypt(blob, OTHER_KEY), (err) => {
    assert.ok(!err.message.includes(OTHER_KEY));
    assert.ok(!err.message.includes('plain-secret-text'));
    return true;
  });
});

test('assertKey accepts 64 hex characters in either case', () => {
  assert.doesNotThrow(() => assertKey('0123456789abcdef'.repeat(2) + 'ABCDEF'.repeat(5) + 'ab'));
  assert.doesNotThrow(() => assertKey('F'.repeat(64)));
});

test('assertKey rejects short, long, non-hex and missing keys', () => {
  const message = 'RELAY_SECRET_KEY must be 64 hex characters';
  const bad = ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ' ' + 'a'.repeat(63), '', undefined, null, 123, Buffer.alloc(32)];
  for (const key of bad) {
    assert.throws(() => assertKey(key), { message });
  }
});

test('encrypt and decrypt reject an invalid key with the same message', () => {
  const message = 'RELAY_SECRET_KEY must be 64 hex characters';
  assert.throws(() => encrypt('x', 'short'), { message });
  assert.throws(() => decrypt('v1:a:b:c', undefined), { message });
});
