import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operations } from '../src/operations.generated.js';
import { callOperation } from '../src/client.js';
import { parseArgs, run } from '../src/cli.js';
import { operationsFromSpec } from '../scripts/generate.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const find = (id) => operations.find((o) => o.operationId === id);

function recorder(response = { status: 200, body: { ok: true } }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    return { status: response.status, ok: response.status < 300, text: async () => text };
  };
  return { calls, fetchImpl };
}

test('generated table matches the OpenAPI document', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const spec = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'server', 'openapi.json'), 'utf8'));
  assert.deepEqual(operationsFromSpec(spec), operations);
});

test('bearer operations are marked and public ones are not', () => {
  assert.equal(find('setDelay').bearer, true);
  assert.equal(find('publishCaptions').bearer, true);
  assert.equal(find('getStatus').bearer, false);
});

test('path and query parameters are filled, bearer header added', async () => {
  const { calls, fetchImpl } = recorder();
  const op = { operationId: 'x', method: 'GET', path: '/api/a/{id}', bearer: true, body: null,
    parameters: [{ name: 'id', in: 'path', required: true }, { name: 'lang', in: 'query', required: false }] };
  await callOperation(op, { server: 'https://r.example/', token: 't0k', params: { id: 'a b', lang: 'fi' }, fetchImpl });
  assert.equal(calls[0].url, 'https://r.example/api/a/a%20b?lang=fi');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t0k');
});

test('a missing required parameter is an error', async () => {
  const op = { operationId: 'x', method: 'GET', path: '/a/{id}', bearer: false, body: null,
    parameters: [{ name: 'id', in: 'path', required: true }] };
  await assert.rejects(callOperation(op, { server: 'http://x', fetchImpl: recorder().fetchImpl }), /missing --id/);
});

test('bearer operation without a token fails before sending', async () => {
  const rec = recorder();
  await assert.rejects(callOperation(find('getDelay'), { server: 'http://x', fetchImpl: rec.fetchImpl }), /needs a token/);
  assert.equal(rec.calls.length, 0);
});

test('run() prints JSON, sends the body, and exits 1 on an HTTP error', async () => {
  const out = []; const err = [];
  const rec = recorder({ status: 400, body: { error: 'bad' } });
  const code = await run(['setDelay', '--server', 'http://x', '--token', 't', '--body', '{"delaySeconds":5}'], {
    stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, fetchImpl: rec.fetchImpl,
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(rec.calls[0].init.body).delaySeconds, 5);
  assert.match(err.join(''), /"bad"/);
});

test('run() without a server or with an unknown operation exits 2', async () => {
  const err = [];
  assert.equal(await run(['getStatus'], { env: {}, stderr: { write: (s) => err.push(s) } }), 2);
  assert.equal(await run(['nope', '--server', 'http://x'], { stderr: { write: (s) => err.push(s) } }), 2);
});

test('parseArgs separates the command from flags', () => {
  assert.deepEqual(parseArgs(['setDelay', '--server', 'u', '--verbose']), {
    command: 'setDelay', flags: { server: 'u', verbose: 'true' },
  });
});
