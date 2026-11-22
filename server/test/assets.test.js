import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';
import {
  detectImageType,
  assetIdFor,
  isValidAssetId,
  assetContentType,
  createAssetStore,
  ASSET_ID_PATTERN,
} from '../lib/assets.js';
import { registerAssetRoutes } from '../lib/asset-routes.js';
import { requireScope } from '../lib/auth.js';
import { openStore } from '../lib/store.js';
import { createToken } from '../lib/tokens.js';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Tiny PNG-looking buffer: signature plus a seed, so each seed hashes differently. */
function png(seed = 'a') {
  return Buffer.concat([Buffer.from(PNG_SIG), Buffer.from(`seed-${seed}`)]);
}
function jpeg(seed = 'a') {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`seed-${seed}`)]);
}
function webp(seed = 'a') {
  const size = Buffer.from([4, 0, 0, 0]);
  return Buffer.concat([Buffer.from('RIFF'), size, Buffer.from('WEBP'), Buffer.from(`seed-${seed}`)]);
}

// ---------------------------------------------------------------------------
// Magic bytes, ids, content types
// ---------------------------------------------------------------------------

test('detectImageType recognises PNG, JPEG and WebP by their magic bytes', () => {
  assert.equal(detectImageType(png()), 'png');
  assert.equal(detectImageType(jpeg()), 'jpg');
  assert.equal(detectImageType(webp()), 'webp');
});

test('detectImageType rejects other data, short buffers and non-buffers', () => {
  assert.equal(detectImageType(Buffer.from('GIF89a......')), null);
  assert.equal(detectImageType(Buffer.from('%PDF-1.7')), null);
  assert.equal(detectImageType(Buffer.from([0x89, 0x50])), null);
  // RIFF without WEBP is a WAV file, not an image
  assert.equal(detectImageType(Buffer.from('RIFF\0\0\0\0WAVEfmt ')), null);
  assert.equal(detectImageType(Buffer.from('RIFF\0\0\0\0WEBP')), 'webp');
  assert.equal(detectImageType('not a buffer'), null);
});

test('assetIdFor is sha256 of the bytes plus the extension', () => {
  const buf = png('id');
  const hash = createHash('sha256').update(buf).digest('hex');
  assert.equal(assetIdFor(buf, 'png'), `${hash}.png`);
  assert.match(assetIdFor(buf, 'jpg'), ASSET_ID_PATTERN);
  assert.throws(() => assetIdFor(buf, 'gif'), /unsupported asset extension/);
});

test('isValidAssetId and assetContentType guard the id format', () => {
  const id = assetIdFor(png('x'), 'webp');
  assert.equal(isValidAssetId(id), true);
  assert.equal(assetContentType(id), 'image/webp');
  assert.equal(assetContentType(assetIdFor(jpeg('x'), 'jpg')), 'image/jpeg');
  assert.equal(isValidAssetId('../x'), false);
  assert.equal(isValidAssetId('a'.repeat(64) + '.gif'), false);
  assert.equal(isValidAssetId('A'.repeat(64) + '.png'), false, 'upper-case hex is not a stored id');
  assert.equal(assetContentType('../x'), null);
});

// ---------------------------------------------------------------------------
// Store: local directory
// ---------------------------------------------------------------------------

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-assets-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('local store puts a file named by its id and reuses it on a second put', async () => {
  const dir = path.join(root, 'local');
  const store = createAssetStore({ dir });
  const buf = png('local-1');

  const first = await store.put(buf);
  assert.equal(first.reused, false);
  assert.equal(first.size, buf.length);
  assert.equal(first.assetId, assetIdFor(buf, 'png'));
  assert.ok(fs.existsSync(path.join(dir, first.assetId)));

  const second = await store.put(buf);
  assert.equal(second.reused, true);
  assert.equal(second.assetId, first.assetId);
  assert.deepEqual(fs.readdirSync(dir), [first.assetId], 'no duplicate or temporary file is left');
});

test('local store get returns the same bytes, null for unknown ids', async () => {
  const dir = path.join(root, 'local-get');
  const store = createAssetStore({ dir });
  const buf = jpeg('get');
  const { assetId } = await store.put(buf);
  assert.ok((await store.get(assetId)).equals(buf));
  assert.equal(await store.get(assetIdFor(png('never-stored'), 'png')), null);
});

test('traversal guard: a malformed id is refused before any read', async () => {
  const dir = path.join(root, 'guard', 'assets');
  fs.mkdirSync(dir, { recursive: true });
  // A file one level above the store directory that "../x" would reach
  fs.writeFileSync(path.join(root, 'guard', 'x'), 'secret');
  const store = createAssetStore({ dir });
  assert.equal(await store.get('../x'), null);
  assert.equal(await store.get('../../etc/passwd'), null);
  assert.equal(await store.get('x'), null);
});

test('put refuses bytes that are not an image', async () => {
  const store = createAssetStore({ dir: path.join(root, 'refuse') });
  await assert.rejects(() => store.put(Buffer.from('plain text')), /not a PNG, JPEG or WebP/);
});

test('createAssetStore needs an S3 client or a directory', () => {
  assert.throws(() => createAssetStore({}), /needs an s3 client or a dir/);
});

// ---------------------------------------------------------------------------
// Store: S3 (in-memory fake with the same three methods as createS3Client)
// ---------------------------------------------------------------------------

function fakeS3() {
  const objects = new Map();
  const calls = [];
  return {
    objects,
    calls,
    async headObject(key) {
      calls.push(['head', key]);
      return objects.has(key) ? { size: objects.get(key).body.length, etag: 'e' } : null;
    },
    async putObject(key, body, opts) {
      calls.push(['put', key]);
      objects.set(key, { body: Buffer.from(body), contentType: opts.contentType });
      return { etag: 'e' };
    },
    async getObject(key) {
      calls.push(['get', key]);
      return objects.has(key) ? objects.get(key).body : null;
    },
  };
}

test('S3 store writes assets/<id> with the image content type and dedupes', async () => {
  const s3 = fakeS3();
  const store = createAssetStore({ s3 });
  const buf = webp('s3');
  const id = assetIdFor(buf, 'webp');

  const first = await store.put(buf);
  assert.deepEqual(first, { assetId: id, size: buf.length, reused: false });
  assert.equal(s3.objects.get(`assets/${id}`).contentType, 'image/webp');

  const second = await store.put(buf);
  assert.equal(second.reused, true);
  assert.equal(s3.objects.size, 1);

  assert.ok((await store.get(id)).equals(buf));
});

test('S3 store makes no calls for a malformed id', async () => {
  const s3 = fakeS3();
  const store = createAssetStore({ s3 });
  assert.equal(await store.get('../x'), null);
  assert.deepEqual(s3.calls, []);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const ADMIN = 'env-admin-token';

/** App with the asset routes; returns base URL, tokens and a close function. */
async function routeApp() {
  const { db, close: closeStore } = openStore(':memory:');
  const dir = path.join(root, `routes-${Math.random().toString(36).slice(2)}`);
  const app = express();
  registerAssetRoutes(app, {
    store: createAssetStore({ dir }),
    requireUpload: requireScope((req) => `stream:${req.params.name}:data`, { adminToken: ADMIN, db }),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  const kirkko = createToken(db, { scopes: ['stream:kirkko:data'], label: 'kirkko' }, now).token;
  const other = createToken(db, { scopes: ['stream:other:data'], label: 'other' }, now).token;
  return {
    base,
    kirkko,
    other,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          closeStore();
          resolve();
        });
      }),
  };
}

/** POST raw bytes; returns { status, headers, json }. */
async function upload(app, stream, bytes, { type, token } = {}) {
  const headers = {};
  if (type) headers['content-type'] = type;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${app.base}/api/v1/streams/${stream}/assets`, {
    method: 'POST',
    headers,
    body: bytes,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, headers: res.headers, json };
}

test('upload with a scoped token answers 201 and reused flips on the second upload', async () => {
  const app = await routeApp();
  try {
    const buf = png('route-1');
    const first = await upload(app, 'kirkko', buf, { type: 'image/png', token: app.kirkko });
    assert.equal(first.status, 201);
    assert.deepEqual(first.json, { assetId: assetIdFor(buf, 'png'), size: buf.length, reused: false });

    const second = await upload(app, 'kirkko', buf, { type: 'image/png', token: app.kirkko });
    assert.equal(second.status, 201);
    assert.equal(second.json.reused, true);
    assert.equal(second.json.assetId, first.json.assetId);
  } finally {
    await app.close();
  }
});

test('the env admin token may upload to any stream', async () => {
  const app = await routeApp();
  try {
    const res = await upload(app, 'other', jpeg('admin'), { type: 'image/jpeg', token: ADMIN });
    assert.equal(res.status, 201);
    assert.equal(res.json.reused, false);
  } finally {
    await app.close();
  }
});

test('image/jpeg is matched with the detected jpg type', async () => {
  const app = await routeApp();
  try {
    const res = await upload(app, 'kirkko', jpeg('ok'), { type: 'image/jpeg; charset=binary', token: app.kirkko });
    assert.equal(res.status, 201);
    assert.match(res.json.assetId, /\.jpg$/);
  } finally {
    await app.close();
  }
});

test('a Content-Type that does not match the bytes answers 415', async () => {
  const app = await routeApp();
  try {
    const res = await upload(app, 'kirkko', jpeg('mismatch'), { type: 'image/png', token: app.kirkko });
    assert.equal(res.status, 415);
    const unknown = await upload(app, 'kirkko', Buffer.from('GIF89a....'), { type: 'image/png', token: app.kirkko });
    assert.equal(unknown.status, 415);
  } finally {
    await app.close();
  }
});

test('an unsupported Content-Type answers 415', async () => {
  const app = await routeApp();
  try {
    const res = await upload(app, 'kirkko', png('type'), { type: 'text/plain', token: app.kirkko });
    assert.equal(res.status, 415);
  } finally {
    await app.close();
  }
});

test('an empty body answers 400', async () => {
  const app = await routeApp();
  try {
    const res = await upload(app, 'kirkko', Buffer.alloc(0), { type: 'image/png', token: app.kirkko });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('a body over 10 MB answers 413 (decided from Content-Length, body not read)', async () => {
  const app = await routeApp();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        `${app.base}/api/v1/streams/kirkko/assets`,
        {
          method: 'POST',
          headers: {
            'content-type': 'image/png',
            'content-length': String(10 * 1024 * 1024 + 1),
            authorization: `Bearer ${app.kirkko}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
          req.destroy();
        },
      );
      req.on('error', (err) => {
        if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
        reject(err);
      });
      req.write(png('big').subarray(0, 16));
    });
    assert.equal(status, 413);
  } finally {
    await app.close();
  }
});

test('upload without a token answers 401', async () => {
  const app = await routeApp();
  try {
    const res = await upload(app, 'kirkko', png('anon'), { type: 'image/png' });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test('upload with a token for another stream answers 403', async () => {
  const app = await routeApp();
  try {
    const res = await upload(app, 'kirkko', png('wrong-scope'), { type: 'image/png', token: app.other });
    assert.equal(res.status, 403);
  } finally {
    await app.close();
  }
});

test('an invalid stream name answers 400 after the scope check', async () => {
  const app = await routeApp();
  try {
    const res = await upload(app, 'BAD%20NAME', png('name'), { type: 'image/png', token: ADMIN });
    assert.equal(res.status, 400);
  } finally {
    await app.close();
  }
});

test('GET serves the stored bytes with type, cache and nosniff headers', async () => {
  const app = await routeApp();
  try {
    const buf = webp('serve');
    const up = await upload(app, 'kirkko', buf, { type: 'image/webp', token: app.kirkko });
    const res = await fetch(`${app.base}/api/assets/${up.json.assetId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/webp');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(buf));
  } finally {
    await app.close();
  }
});

test('GET answers 404 for an unknown id and for a malformed one', async () => {
  const app = await routeApp();
  try {
    const unknown = await fetch(`${app.base}/api/assets/${assetIdFor(png('nope'), 'png')}`);
    assert.equal(unknown.status, 404);
    const malformed = await fetch(`${app.base}/api/assets/not-an-id`);
    assert.equal(malformed.status, 404);
  } finally {
    await app.close();
  }
});
