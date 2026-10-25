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

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-123';
const PORT = 31000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuberadio-'));
const hls = path.join(dir, 'hls');
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
      METRICS_BEARER_TOKEN: 'metrics-token',
      DELAY_SECONDS: '8',
      DELAY_MAX_SECONDS: '30',
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
