import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { signV4, createS3Client, s3ConfigFromEnv } from '../lib/s3.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const ACCESS = 'AKIAIOSFODNN7EXAMPLE';

// 1. AWS SigV4 documentation vector: "GET Object" (single chunk payload).
test('signV4 matches the AWS documentation GET Object example', () => {
  const headers = signV4({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    headers: { range: 'bytes=0-9' },
    payloadHash: EMPTY_SHA256,
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    region: 'us-east-1',
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(headers['x-amz-date'], '20130524T000000Z');
  assert.equal(headers['x-amz-content-sha256'], EMPTY_SHA256);
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

test('signV4 encodes path segments and sorts the query, and does not sign a different body', () => {
  const base = {
    method: 'GET',
    payloadHash: EMPTY_SHA256,
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    region: 'us-east-1',
    now: new Date('2013-05-24T00:00:00Z'),
  };
  // Pre-encoded and raw spellings of the same path give the same signature.
  const raw = signV4({ ...base, url: 'https://h.example.com/b/a%20b.txt?z=1&a=2' });
  const encoded = signV4({ ...base, url: 'https://h.example.com/b/a b.txt?a=2&z=1' });
  assert.equal(raw.authorization, encoded.authorization);
  const otherBody = signV4({ ...base, payloadHash: createHash('sha256').update('x').digest('hex'), url: 'https://h.example.com/b/a%20b.txt?a=2&z=1' });
  assert.notEqual(otherBody.authorization, raw.authorization);
});

// 2. Fake S3 server on node:http.
function startFakeS3() {
  const objects = new Map(); // "/bucket/key" -> { body: Buffer, contentType }
  const state = { failCode: null, failStatus: 403 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const sendError = (status, code) => {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>nope</Message></Error>`);
      };
      if (state.failCode) return sendError(state.failStatus, state.failCode);
      if (!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')) {
        return sendError(403, 'MissingSecurityHeader');
      }
      const digest = createHash('sha256').update(body).digest('hex');
      if (req.headers['x-amz-content-sha256'] !== digest) {
        return sendError(400, 'XAmzContentSHA256Mismatch');
      }
      const path = new URL(req.url, 'http://x').pathname;
      const decoded = decodeURIComponent(path);
      if (req.method === 'PUT') {
        objects.set(decoded, { body, contentType: req.headers['content-type'] });
        res.writeHead(200, { etag: `"${digest.slice(0, 16)}"` });
        return res.end();
      }
      const obj = objects.get(decoded);
      if (req.method === 'HEAD' || req.method === 'GET') {
        if (!obj) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, {
          'content-length': obj.body.length,
          etag: `"${createHash('md5').update(obj.body).digest('hex')}"`,
        });
        return req.method === 'HEAD' ? res.end() : res.end(obj.body);
      }
      if (req.method === 'DELETE') {
        if (!obj) {
          res.writeHead(404);
          return res.end();
        }
        objects.delete(decoded);
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(405);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        objects,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function clientFor(fake, extra = {}) {
  return createS3Client({
    endpoint: fake.endpoint,
    bucket: 'media',
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    ...extra,
  });
}

test('put, head, get and delete round trip', async (t) => {
  const fake = await startFakeS3();
  t.after(() => fake.close());
  const s3 = clientFor(fake);

  const { etag } = await s3.putObject('seg/0001.ts', Buffer.from('hello'), { contentType: 'video/mp2t' });
  assert.ok(etag);
  assert.equal(fake.objects.get('/media/seg/0001.ts').contentType, 'video/mp2t');

  const head = await s3.headObject('seg/0001.ts');
  assert.equal(head.size, 5);
  assert.equal(head.etag, (await s3.headObject('seg/0001.ts')).etag);

  const body = await s3.getObject('seg/0001.ts');
  assert.equal(body.toString(), 'hello');

  await s3.putObject('text.txt', 'as string');
  assert.equal((await s3.getObject('text.txt')).toString(), 'as string');

  await s3.deleteObject('seg/0001.ts');
  assert.equal(fake.objects.has('/media/seg/0001.ts'), false);
});

test('404 gives null for head and get, and delete of a missing key is ok', async (t) => {
  const fake = await startFakeS3();
  t.after(() => fake.close());
  const s3 = clientFor(fake);
  assert.equal(await s3.headObject('missing'), null);
  assert.equal(await s3.getObject('missing'), null);
  await s3.deleteObject('missing');
});

test('non-2xx throws an error with status and the S3 Code', async (t) => {
  const fake = await startFakeS3();
  t.after(() => fake.close());
  fake.state.failCode = 'AccessDenied';
  const s3 = clientFor(fake);
  await assert.rejects(s3.getObject('x'), (err) => {
    assert.match(err.message, /HTTP 403 AccessDenied/);
    assert.equal(err.status, 403);
    assert.equal(err.code, 'AccessDenied');
    return true;
  });
});

test('the secret key and the signature never appear in an error message', async (t) => {
  const fake = await startFakeS3();
  t.after(() => fake.close());
  fake.state.failCode = 'SignatureDoesNotMatch';
  const s3 = clientFor(fake);
  await assert.rejects(s3.putObject('x', 'data'), (err) => {
    assert.match(err.message, /SignatureDoesNotMatch/);
    assert.ok(!err.message.includes(SECRET));
    assert.ok(!err.message.includes('Signature='));
    assert.ok(!err.message.includes(ACCESS));
    assert.ok(!String(err.stack).includes(SECRET));
    return true;
  });
});

test('prefix is applied to every key', async (t) => {
  const fake = await startFakeS3();
  t.after(() => fake.close());
  const s3 = clientFor(fake, { prefix: 'relay/' });
  await s3.putObject('rec/a b.txt', 'one');
  assert.ok(fake.objects.has('/media/relay/rec/a b.txt'));
  assert.equal((await s3.getObject('rec/a b.txt')).toString(), 'one');
  assert.equal(await clientFor(fake).getObject('rec/a b.txt'), null);
});

test('s3ConfigFromEnv reads the variables, defaults the region and prefix, and is null without endpoint or bucket', () => {
  const env = {
    S3_ENDPOINT: ' https://s3.example.com ',
    S3_BUCKET: 'media',
    S3_ACCESS_KEY_ID: 'id',
    S3_SECRET_ACCESS_KEY: 'secret',
  };
  assert.deepEqual(s3ConfigFromEnv(env), {
    endpoint: 'https://s3.example.com',
    bucket: 'media',
    region: 'us-east-1',
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    prefix: 'relay/',
  });
  assert.equal(s3ConfigFromEnv({ ...env, S3_PREFIX: 'x/', S3_REGION: 'eu-north-1' }).prefix, 'x/');
  assert.equal(s3ConfigFromEnv({ ...env, S3_REGION: 'eu-north-1' }).region, 'eu-north-1');
  assert.equal(s3ConfigFromEnv({ S3_BUCKET: 'media' }), null);
  assert.equal(s3ConfigFromEnv({ S3_ENDPOINT: 'https://s3.example.com' }), null);
  assert.equal(s3ConfigFromEnv({}), null);
});
