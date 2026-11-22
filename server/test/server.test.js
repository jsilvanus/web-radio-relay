/**
 * End-to-end checks of the HTTP API: starts index.js as a child process on a
 * free port with a temporary HLS directory, then talks to it over HTTP.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openStore } from '../lib/store.js';
import { createToken } from '../lib/tokens.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-123';
const HOOK_SECRET = 'hook-secret-test-456';
const PORT = 31000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuberadio-'));
const hls = path.join(dir, 'hls');
// A file, not ':memory:': the expired-token test inserts a row through its own connection.
const dbPath = path.join(dir, 'relay.db');
fs.mkdirSync(hls);
let child;

/** Write a live playlist whose last segment ended now. */
function writeLive(count = 12, seconds = 4, name = 'stream') {
  const dirPath = path.join(hls, name);
  fs.mkdirSync(dirPath, { recursive: true });
  const end = Date.now();
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${seconds}`, `#EXT-X-MEDIA-SEQUENCE:${200}`];
  for (let i = 0; i < count; i++) {
    const start = end - (count - i) * seconds * 1000;
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(start).toISOString()}`);
    lines.push(`#EXTINF:${seconds.toFixed(3)},`);
    lines.push(`seg${String(200 + i).padStart(5, '0')}.ts`);
    fs.writeFileSync(path.join(dirPath, `seg${String(200 + i).padStart(5, '0')}.ts`), 'x');
  }
  fs.writeFileSync(path.join(dirPath, 'stream.m3u8'), lines.join('\n') + '\n');
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/api/status`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

before(async () => {
  writeLive();
  child = spawn(process.execPath, [path.join(here, '..', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HLS_DIR: hls,
      ARCHIVE_DIR: path.join(dir, 'archive'),
      HIDDEN_ARCHIVE_DIR: path.join(dir, 'hidden'),
      STATS_FILE: path.join(dir, 'stats.json'),
      RELAY_API_TOKEN: TOKEN,
      RELAY_DB_PATH: ':memory:',
      METRICS_BEARER_TOKEN: 'metrics-token',
      HOOK_SECRET: HOOK_SECRET,
      PUBLISH_AUTH: 'off',
      RADIO_SOURCE_URL_TEMPLATE: '',
      DELAY_SECONDS: '8',
      DELAY_MAX_SECONDS: '30',
      RELAY_DB_PATH: dbPath,
    },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(() => {
  child?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status reports the delay and points listeners at the delayed playlist', async () => {
  const body = await (await fetch(`${base}/api/status`)).json();
  assert.equal(body.live, true);
  assert.equal(body.delaySeconds, 8);
  assert.equal(body.name, 'stream');
  assert.equal(body.streamUrl, '/api/streams/stream/hls/delayed.m3u8');
  assert.equal(body.liveStreamUrl, '/hls/stream/stream.m3u8');
});

test('delayed playlist lists segments that ended at least 8 s ago', async () => {
  const res = await fetch(`${base}/api/hls/delayed.m3u8`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /^#EXTM3U/);
  const segs = text.split('\n').filter((l) => l.startsWith('/hls/'));
  assert.equal(segs.length, 6);
  // Last live segment ends at "now"; the newest listed one must end before now - 8 s
  const last = segs[segs.length - 1];
  assert.match(last, /\/hls\/stream\/seg\d{5}\.ts$/);
  const pdts = text.split('\n').filter((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')).map((l) => Date.parse(l.slice(25)));
  const lastEnd = pdts[pdts.length - 1] + 4000;
  assert.ok(lastEnd <= Date.now() - 8000 + 50, 'playlist must not contain segments inside the delay');
});

test('control routes refuse missing or wrong tokens', async () => {
  const noAuth = await fetch(`${base}/api/v1/delay`);
  assert.equal(noAuth.status, 401);
  const wrong = await fetch(`${base}/api/v1/delay`, { headers: { Authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);
  const post = await fetch(`${base}/api/v1/captions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 401);
});

test('PUT /api/v1/delay changes the delay within the configured maximum', async () => {
  const ok = await fetch(`${base}/api/v1/delay`, { method: 'PUT', headers: auth, body: JSON.stringify({ delaySeconds: 12 }) });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.delaySeconds, 12);
  assert.equal(body.maxSeconds, 30);
  assert.equal(body.stream, 'stream');
  const high = await fetch(`${base}/api/v1/delay`, { method: 'PUT', headers: auth, body: JSON.stringify({ delaySeconds: 31 }) });
  assert.equal(high.status, 400);
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.delaySeconds, 12);
});

test('captions: pushed captions are released only after the delay', async () => {
  const now = Date.now();
  const sent = await fetch(`${base}/api/v1/captions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      segments: [
        { lang: 'fi', text: 'Vanha lause', startedAt: now - 20_000, endedAt: now - 19_000 },
        { lang: 'fi', text: 'Tuore lause', startedAt: now - 1_000 },
        { lang: 'sv', text: 'Svensk text', startedAt: now - 20_000 },
      ],
    }),
  });
  assert.equal(sent.status, 202);
  assert.deepEqual(await sent.json(), { stream: 'stream', accepted: 3 });

  const list = await (await fetch(`${base}/api/captions?lang=fi&from=${now - 30_000}`)).json();
  assert.equal(list.delaySeconds, 12);
  assert.deepEqual(list.captions.map((c) => c.text), ['Vanha lause']);
  assert.equal(list.stream, 'stream');
  assert.equal(list.captions[0].lang, 'fi');
  assert.ok(typeof list.next === 'number');
});

test('captions: invalid bodies are refused with a message that names the field', async () => {
  const res = await fetch(`${base}/api/v1/captions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ segments: [{ lang: 'fi', text: '', startedAt: Date.now() }] }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /text/);
});

test('stats session route moved under /api/v1 and needs the token', async () => {
  const res = await fetch(`${base}/api/v1/stats/session`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ event: 'start', streamName: 'stream' }),
  });
  assert.equal(res.status, 200);
  const old = await fetch(`${base}/api/stats/session`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(old.status, 404);
});

test('OpenAPI document is served', async () => {
  const doc = await (await fetch(`${base}/api/openapi.json`)).json();
  assert.equal(doc.openapi, '3.1.0');
  assert.ok(doc.paths['/api/v1/captions']);
});

test('listener page is served and loads hls.js and the caption feed', async () => {
  const res = await fetch(`${base}/listen`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /hls\.min\.js/);
  assert.match(html, /\/captions\?limit=200/);
  assert.match(html, /\/api\/streams\//);
});

test('root and named stream paths redirect to listener page', async () => {
  const root = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/listen');

  const stream = await fetch(`${base}/keskuskirkko`, { redirect: 'manual' });
  assert.equal(stream.status, 302);
  assert.equal(stream.headers.get('location'), '/listen?stream=keskuskirkko');
});

test('two streams keep their own delay and captions', async () => {
  writeLive(12, 4, 'messu');
  const put = await fetch(`${base}/api/v1/streams/messu/delay`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ delaySeconds: 0 }),
  });
  assert.equal(put.status, 200);
  const now = Date.now();
  const sent = await fetch(`${base}/api/v1/streams/messu/captions`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ segments: [{ lang: 'fi', text: 'Messu alkaa', startedAt: now - 2_000 }] }),
  });
  assert.equal(sent.status, 202);

  const messu = await (await fetch(`${base}/api/streams/messu/captions?from=${now - 60_000}`)).json();
  assert.deepEqual(messu.captions.map((c) => c.text), ['Messu alkaa']);
  assert.equal(messu.delaySeconds, 0);

  const main = await (await fetch(`${base}/api/captions?from=${now - 60_000}`)).json();
  assert.equal(main.captions.some((c) => c.text === 'Messu alkaa'), false, 'messu captions stay on messu');
  assert.equal(main.delaySeconds, 12);

  const list = await (await fetch(`${base}/api/streams`)).json();
  const names = list.streams.map((x) => x.name);
  assert.ok(names.includes('messu') && names.includes('stream'));

  const playlist = await (await fetch(`${base}/api/streams/messu/hls/delayed.m3u8`)).text();
  assert.ok(playlist.includes('/hls/messu/seg'));
});

test('stream names are checked before anything else', async () => {
  const bad = await fetch(`${base}/api/streams/..%2Fetc/status`);
  assert.equal(bad.status, 400);
  const badPush = await fetch(`${base}/api/v1/streams/BAD_NAME/captions`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ segments: [{ lang: 'fi', text: 'x', startedAt: Date.now() }] }),
  });
  assert.equal(badPush.status, 400);
});

test('health answers without a token', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('metrics need the metrics token and list stream liveness', async () => {
  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  assert.equal((await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 401);
  const res = await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer metrics-token' } });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /web_radio_relay_stream_live\{stream="stream"\} 1/);
  assert.match(text, /web_radio_relay_uptime_seconds \d+/);
});

test('caption source status is token protected and reports disabled when no gateway is set', async () => {
  assert.equal((await fetch(`${base}/api/v1/captions/source`)).status, 401);
  const body = await (await fetch(`${base}/api/v1/captions/source`, { headers: auth })).json();
  assert.equal(body.captionSource.configured, false);
  assert.equal(body.captionSource.connected, false);
  assert.deepEqual(body.captionSource.mapper, { mapped: 0, rejected: 0, unknown: 0 });
});

test('event push: a valid batch is accepted with added and deduped counts', async () => {
  const now = Date.now();
  const events = [
    { type: 'section', startedAt: now, payload: { title: 'Saarna', index: 2 }, sourceKey: 'push-sec-1' },
    { type: 'marker', startedAt: now, payload: { label: 'Kohta A' } },
    { type: 'data', startedAt: now, payload: { name: 'virsi', value: { n: 12 } } },
  ];
  const first = await fetch(`${base}/api/v1/streams/stream/events`, { method: 'POST', headers: auth, body: JSON.stringify({ events }) });
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { added: 3, deduped: 0 });

  const again = await fetch(`${base}/api/v1/streams/stream/events`, { method: 'POST', headers: auth, body: JSON.stringify({ events: [events[0]] }) });
  assert.equal(again.status, 202);
  assert.deepEqual(await again.json(), { added: 0, deduped: 1 });
});

test('event push: one invalid event rejects the batch and the message names its index', async () => {
  const now = Date.now();
  const res = await fetch(`${base}/api/v1/streams/stream/events`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ events: [
      { type: 'marker', startedAt: now, payload: { label: 'ok' } },
      { type: 'graphic', startedAt: now, payload: { kind: 'fireworks' } },
    ] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /^events\[1\]: /);
});

test('event push: refuses a missing token and a bad stream name', async () => {
  const body = JSON.stringify({ events: [{ type: 'marker', startedAt: Date.now(), payload: { label: 'x' } }] });
  const noToken = await fetch(`${base}/api/v1/streams/stream/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(noToken.status, 401);
  const badName = await fetch(`${base}/api/v1/streams/BAD%20NAME/events`, { method: 'POST', headers: auth, body });
  assert.equal(badName.status, 400);
});

// --- scoped tokens (P2.2) ---------------------------------------------------

const json = (body) => JSON.stringify(body);
const withToken = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const sha256hex = (v) => createHash('sha256').update(v).digest('hex');
let phone; // issued with stream:keskus:publish + stream:keskus:data
let admin; // issued with the admin scope

test('token API: admin issues a token; the value is returned once', async () => {
  const res = await fetch(`${base}/api/v1/tokens`, {
    method: 'POST',
    headers: auth,
    body: json({ scopes: ['stream:keskus:publish', 'stream:keskus:data'], expiresInSeconds: 3600, label: 'phone' }),
  });
  assert.equal(res.status, 201);
  phone = await res.json();
  assert.match(phone.id, /^tok_[0-9a-f]{12}$/);
  assert.match(phone.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(phone.scopes, ['stream:keskus:publish', 'stream:keskus:data']);
  assert.equal(phone.label, 'phone');
  assert.equal(typeof phone.expiresAt, 'number');
  assert.ok(phone.expiresAt > Date.now());
});

test('token API: the list never shows values or hashes', async () => {
  const res = await fetch(`${base}/api/v1/tokens`, { headers: auth });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.ok(body.tokens.some((t) => t.id === phone.id && t.label === 'phone'));
  assert.ok(!text.includes(phone.token));
  assert.ok(!text.includes(sha256hex(phone.token)));
  assert.ok(!body.tokens.some((t) => 'hash' in t || 'token' in t));
});

test('token API: invalid bodies answer 400', async () => {
  const bad = [
    undefined,
    { scopes: [] },
    { scopes: ['stream:Keskus:data'] },
    { scopes: ['admin'], expiresInSeconds: 10 },
    { scopes: ['admin'], label: 'x'.repeat(65) },
  ];
  for (const body of bad) {
    const res = await fetch(`${base}/api/v1/tokens`, {
      method: 'POST',
      headers: auth,
      body: body === undefined ? undefined : json(body),
    });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(typeof (await res.json()).error, 'string');
  }
});

test('token API: a stream token is 403 on admin routes, no token is 401', async () => {
  assert.equal((await fetch(`${base}/api/v1/tokens`, { headers: withToken(phone.token) })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/tokens`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/tokens`, { headers: withToken('unknown') })).status, 401);
});

test('token API: a stored admin token works, and deleting it makes it 401', async () => {
  const res = await fetch(`${base}/api/v1/tokens`, {
    method: 'POST',
    headers: auth,
    body: json({ scopes: ['admin'] }),
  });
  assert.equal(res.status, 201);
  admin = await res.json();
  assert.equal(admin.expiresAt, null);
  assert.equal((await fetch(`${base}/api/v1/tokens`, { headers: withToken(admin.token) })).status, 200);

  const del = await fetch(`${base}/api/v1/tokens/${admin.id}`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 204);
  assert.equal((await fetch(`${base}/api/v1/tokens`, { headers: withToken(admin.token) })).status, 401);
  // revoking again is still 204; an unknown id is 404
  assert.equal((await fetch(`${base}/api/v1/tokens/${admin.id}`, { method: 'DELETE', headers: auth })).status, 204);
  const unknown = await fetch(`${base}/api/v1/tokens/tok_000000000000`, { method: 'DELETE', headers: auth });
  assert.equal(unknown.status, 404);
});

test('token API: an expired token is 401', async () => {
  const store = openStore(dbPath);
  let expired;
  try {
    // issued two minutes ago with a one-minute life: expired now
    expired = createToken(store.db, { scopes: ['admin'], expiresInSeconds: 60 }, Date.now() - 120_000);
  } finally {
    store.close();
  }
  assert.equal((await fetch(`${base}/api/v1/tokens`, { headers: withToken(expired.token) })).status, 401);
});

test('old control routes keep the env token only; stored tokens do not open them', async () => {
  assert.equal((await fetch(`${base}/api/v1/delay`, { headers: auth })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/delay`, { headers: withToken(phone.token) })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/delay`, { headers: withToken(admin.token) })).status, 401);
});

// --- internal hooks (P2.3 / P3.2) ---------------------------------------------

const form = (fields) => new URLSearchParams(fields).toString();
const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
const mediamtx = (body, headers = {}) =>
  fetch(`${base}/internal/mediamtx/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: json(body),
  });

/** Starts another API process on `port` with the given env; resolves once it answers. */
async function startExtra(port, env) {
  const extraDir = fs.mkdtempSync(path.join(dir, 'extra-'));
  const proc = spawn(process.execPath, [path.join(here, '..', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HLS_DIR: hls,
      ARCHIVE_DIR: path.join(extraDir, 'archive'),
      HIDDEN_ARCHIVE_DIR: path.join(extraDir, 'hidden'),
      STATS_FILE: path.join(extraDir, 'stats.json'),
      RELAY_API_TOKEN: TOKEN,
      METRICS_BEARER_TOKEN: 'metrics-token',
      RELAY_DB_PATH: path.join(extraDir, 'relay.db'),
      HOOK_SECRET: '',
      PUBLISH_AUTH: '',
      ...env,
    },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/api/status`)).ok) return { url, proc };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('extra server did not start');
}

test('internal hooks: missing or wrong secret is 401 (both answer styles)', async () => {
  const body = { action: 'publish', path: 'live/keskus', query: '' };
  assert.equal((await mediamtx(body)).status, 401);
  assert.equal((await mediamtx(body, { 'x-hook-secret': 'wrong' })).status, 401);
  const wrongQuery = await fetch(`${base}/internal/mediamtx/auth?secret=wrong`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: json(body),
  });
  assert.equal(wrongQuery.status, 401);
  const noSecret = await fetch(`${base}/internal/publish-auth`, { method: 'POST', headers: formHeaders, body: form({ name: 'keskus' }) });
  assert.equal(noSecret.status, 200, 'PUBLISH_AUTH is off: publishes are allowed without the secret');
});

test('mediamtx hook: publish with a stored token, reads from inside, captioner path, other actions', async () => {
  const publish = await mediamtx({ action: 'publish', path: 'live/keskus', query: `token=${phone.token}` }, { 'x-hook-secret': HOOK_SECRET });
  assert.equal(publish.status, 200);
  assert.equal((await publish.json()).allow, true);
  assert.equal((await mediamtx({ action: 'publish', path: 'live/keskus', password: phone.token }, { 'x-hook-secret': HOOK_SECRET })).status, 200);
  assert.equal((await mediamtx({ action: 'publish', path: 'live/keskus', query: '' }, { 'x-hook-secret': HOOK_SECRET })).status, 401);
  assert.equal((await mediamtx({ action: 'publish', path: 'live/other', query: `token=${phone.token}` }, { 'x-hook-secret': HOOK_SECRET })).status, 401);
  assert.equal((await mediamtx({ action: 'read', path: 'live/keskus', ip: '172.17.0.4' }, { 'x-hook-secret': HOOK_SECRET })).status, 200);
  assert.equal((await mediamtx({ action: 'read', path: 'live/keskus', ip: '203.0.113.9' }, { 'x-hook-secret': HOOK_SECRET })).status, 401);
  assert.equal((await mediamtx({ action: 'api', path: 'live/keskus', ip: '172.17.0.4' }, { 'x-hook-secret': HOOK_SECRET })).status, 401);
  assert.equal((await mediamtx({ action: 'publish', path: 'live/keskus-cc', query: `secret=${HOOK_SECRET}` }, { 'x-hook-secret': HOOK_SECRET })).status, 200);
  assert.equal((await mediamtx({ action: 'publish', path: 'live/keskus-cc', query: '' }, { 'x-hook-secret': HOOK_SECRET })).status, 401);
  const denied = await (await mediamtx({ action: 'publish', path: 'live/keskus', query: 'token=nope' }, { 'x-hook-secret': HOOK_SECRET })).text();
  assert.ok(!denied.includes('nope'), 'a deny body never echoes the token');
});

test('publish-auth: with PUBLISH_AUTH off every publish is allowed', async () => {
  const withBadToken = await fetch(`${base}/internal/publish-auth?secret=wrong`, {
    method: 'POST',
    headers: formHeaders,
    body: form({ name: 'keskus', args: 'token=nope', addr: '203.0.113.9' }),
  });
  assert.equal(withBadToken.status, 200);
});

test('publish-auth: with PUBLISH_AUTH on, token scope decides (403), a bad secret is 401', async () => {
  const dbPath2 = path.join(dir, 'publish-on.db');
  const store2 = openStore(dbPath2);
  let good, other;
  try {
    good = createToken(store2.db, { scopes: ['stream:keskus:publish'] }, Date.now());
    other = createToken(store2.db, { scopes: ['stream:other:publish'] }, Date.now());
  } finally {
    store2.close();
  }
  const port = PORT + 1;
  const extra = await startExtra(port, { HOOK_SECRET: 'extra-hook-secret', PUBLISH_AUTH: 'on', RELAY_DB_PATH: dbPath2 });
  try {
    const hook = (secret, args, name = 'keskus') =>
      fetch(`${extra.url}/internal/publish-auth?secret=${secret}`, {
        method: 'POST',
        headers: formHeaders,
        body: form({ name, args, addr: '203.0.113.9' }),
      });
    assert.equal((await hook('extra-hook-secret', `token=${good.token}`)).status, 200);
    assert.equal((await hook('extra-hook-secret', `token=${other.token}`)).status, 403);
    assert.equal((await hook('extra-hook-secret', '')).status, 403);
    assert.equal((await hook('extra-hook-secret', 'token=nope')).status, 403);
    assert.equal((await hook('wrong', `token=${good.token}`)).status, 401);
    const viaMediamtx = await fetch(`${extra.url}/internal/mediamtx/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hook-secret': 'extra-hook-secret' },
      body: json({ action: 'publish', path: 'live/keskus', query: `token=${good.token}` }),
    });
    assert.equal(viaMediamtx.status, 200);
  } finally {
    extra.proc.kill();
  }
});

test('internal hooks answer 503 when HOOK_SECRET is unset', async () => {
  const port = PORT + 2;
  const extra = await startExtra(port, { PUBLISH_AUTH: 'on' });
  try {
    const mtx = await fetch(`${extra.url}/internal/mediamtx/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hook-secret': 'anything' },
      body: json({ action: 'read', path: 'live/keskus', ip: '172.17.0.4' }),
    });
    assert.equal(mtx.status, 503);
    const pub = await fetch(`${extra.url}/internal/publish-auth?secret=anything`, {
      method: 'POST',
      headers: formHeaders,
      body: form({ name: 'keskus', args: 'token=x' }),
    });
    assert.equal(pub.status, 503);
    const ready = await fetch(`${extra.url}/internal/mediamtx/ready?path=live/keskus`, {
      method: 'POST',
      headers: { 'x-hook-secret': 'anything' },
    });
    assert.equal(ready.status, 503);
  } finally {
    extra.proc.kill();
  }
});

const hook = (route, query, headers = {}) =>
  fetch(`${base}/internal/mediamtx/${route}?${query}`, { method: 'POST', headers });

test('ready/notready: missing or wrong secret is 401 (header and query)', async () => {
  assert.equal((await hook('ready', 'path=live/keskus')).status, 401);
  assert.equal((await hook('ready', 'path=live/keskus', { 'x-hook-secret': 'wrong' })).status, 401);
  assert.equal((await hook('notready', 'path=live/keskus&secret=wrong')).status, 401);
});

test('ready/notready: valid secret; live paths answer 200, other and -cc paths are ignored', async () => {
  const headers = { 'x-hook-secret': HOOK_SECRET };
  // RADIO_SOURCE_URL_TEMPLATE is empty in this server, so the start fails and is answered, not raised.
  const ready = await hook('ready', 'path=live/keskus', headers);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { action: 'error', stream: 'keskus' });
  const viaQuery = await hook('ready', `path=live/keskus&secret=${HOOK_SECRET}`);
  assert.equal(viaQuery.status, 200);
  assert.deepEqual(await viaQuery.json(), { action: 'error', stream: 'keskus' });
  assert.deepEqual(await (await hook('ready', 'path=other/keskus', headers)).json(), { action: 'ignored' });
  assert.deepEqual(await (await hook('ready', 'path=live/keskus-cc', headers)).json(), { action: 'ignored' });
  assert.deepEqual(await (await hook('ready', '', headers)).json(), { action: 'ignored' });
  const notready = await hook('notready', 'path=live/keskus', headers);
  assert.equal(notready.status, 200);
  assert.deepEqual(await notready.json(), { action: 'stop', stream: 'keskus' });
  assert.deepEqual(await (await hook('notready', 'path=live/keskus-cc', headers)).json(), { action: 'ignored' });
});

test('GET /api/v1/streams/:name needs the token and has probe null until the source is probed', async () => {
  const bearer = { Authorization: `Bearer ${TOKEN}` };
  assert.equal((await fetch(`${base}/api/v1/streams/keskus`)).status, 401);
  const res = await fetch(`${base}/api/v1/streams/keskus`, { headers: bearer });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stream.name, 'keskus');
  assert.equal(body.stream.probe, null);
  assert.equal((await fetch(`${base}/api/v1/streams/Bad!`, { headers: bearer })).status, 400);
  // "lifecycle" is a valid stream name: the list route must still win over the name route.
  const list = await (await fetch(`${base}/api/v1/streams/lifecycle`, { headers: bearer })).json();
  assert.ok(Array.isArray(list.streams));
});
