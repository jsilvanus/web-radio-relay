import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { GatewayCaptions, SseParser } from '../lib/gateway-captions.js';
import { StreamRegistry } from '../lib/streams.js';

const registry = () => new StreamRegistry({ defaultDelaySeconds: 0, maxDelaySeconds: 60 });

function transcript(epoch, seq, over = {}) {
  const now = Date.now();
  const data = { epoch, seq, session: 's', language: 'fi', text: `caption ${seq}`, startedAt: now - 2000, endedAt: now - 1000, source: 'auditor', ...over };
  return `id: ${epoch}:${seq}\nevent: transcript\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Fake gateway: `handler(req, res, n)` is called for every connection (n counts from 1). */
async function fakeGateway(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res, requests.length);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(r)); },
  };
}

const sse = (res) => res.writeHead(200, { 'Content-Type': 'text/event-stream' });

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('condition not met in time');
}

function make(gw, over = {}) {
  const streams = registry();
  const client = new GatewayCaptions({
    baseUrl: gw.url, token: 'sekret', stream: 'messu', streams,
    backoffMinMs: 10, backoffMaxMs: 40, ...over,
  });
  return { client, streams, items: () => streams.peek('messu')?.captions.items ?? [] };
}

test('SseParser handles CRLF, comments, multi-line data and any chunk split', () => {
  const raw = ': keep-alive\r\n\r\nevent: transcript\r\nid: a:1\r\ndata: {"a":\r\ndata: 1}\r\n\r\nevent: other\ndata: x\n\ndata: y\r\rdata: z\n\n';
  for (let size = 1; size <= raw.length; size++) {
    const events = [];
    const p = new SseParser((e) => events.push(e));
    for (let i = 0; i < raw.length; i += size) p.feed(raw.slice(i, i + size));
    assert.deepEqual(events, [
      { event: 'transcript', data: '{"a":\n1}', id: 'a:1' },
      { event: 'other', data: 'x', id: 'a:1' },
      { event: 'message', data: 'y', id: 'a:1' },
      { event: 'message', data: 'z', id: 'a:1' },
    ], `chunk size ${size}`);
  }
});

test('maps transcripts to captions, sends auth headers, ignores unknown events', async () => {
  const gw = await fakeGateway((_req, res) => {
    sse(res);
    res.write('event: ready\ndata: {"status":"connected"}\n\n: keep-alive\n\nevent: pivoice\ndata: {}\n\n');
    // split mid-event across writes
    const t = transcript('e1', 1);
    res.write(t.slice(0, 20));
    setTimeout(() => res.write(t.slice(20)), 20);
  });
  const { client, items } = make(gw);
  client.start();
  await until(() => items().length === 1);
  const c = items()[0];
  assert.equal(c.lang, 'fi');
  assert.equal(c.text, 'caption 1');
  assert.equal(typeof c.startedAt, 'number');
  assert.ok(c.endedAt >= c.startedAt);
  assert.equal(gw.requests[0].url, '/api/v1/events?types=transcript');
  assert.equal(gw.requests[0].headers.authorization, 'Bearer sekret');
  assert.equal(gw.requests[0].headers.accept, 'text/event-stream');
  assert.equal(gw.requests[0].headers['last-event-id'], undefined);
  const st = client.status();
  assert.equal(st.configured, true);
  assert.equal(st.connected, true);
  assert.equal(st.received, 1);
  assert.ok(st.lastEventAt > 0);
  assert.ok(!JSON.stringify(st).includes('sekret'));
  await client.stop();
  await gw.close();
});

test('reconnects after a drop with Last-Event-ID and de-duplicates replays', async () => {
  const gw = await fakeGateway((_req, res, n) => {
    sse(res);
    if (n === 1) {
      res.write(transcript('e1', 1) + transcript('e1', 2));
      setTimeout(() => res.destroy(), 30);
    } else {
      // gateway replays 2 (already seen), then 3 is new
      res.write(transcript('e1', 2) + transcript('e1', 3));
    }
  });
  const { client, items } = make(gw);
  client.start();
  await until(() => items().length === 3);
  assert.deepEqual(items().map((c) => c.text), ['caption 1', 'caption 2', 'caption 3']);
  assert.equal(gw.requests[1].headers['last-event-id'], 'e1:2');
  const st = client.status();
  assert.equal(st.deduped, 1);
  assert.ok(st.reconnects >= 1);
  await client.stop();
  await gw.close();
});

test('a new epoch resets the dedupe state', async () => {
  const gw = await fakeGateway((_req, res, n) => {
    sse(res);
    if (n === 1) {
      res.write(transcript('e1', 1) + transcript('e1', 2));
      setTimeout(() => res.end(), 30);
    } else {
      res.write(transcript('e2', 1) + transcript('e2', 2));
    }
  });
  const { client, items } = make(gw);
  client.start();
  await until(() => items().length === 4);
  assert.equal(client.status().deduped, 0);
  await client.stop();
  await gw.close();
});

test('bad events are counted and skipped without crashing', async () => {
  const gw = await fakeGateway((_req, res) => {
    sse(res);
    res.write('event: transcript\nid: e1:1\ndata: not json\n\n');
    res.write(transcript('e1', 2, { text: '' }));
    res.write(transcript('e1', 3, { language: 'NOT A LANG!' }));
    res.write(transcript('e1', 4, { startedAt: Date.now() + 3600_000 }));
    res.write('event: transcript\nid: e1:5\ndata: null\n\n');
    res.write(transcript('e1', 6));
  });
  const { client, items } = make(gw);
  client.start();
  await until(() => items().length === 1);
  const st = client.status();
  assert.equal(st.rejected, 5);
  assert.equal(st.received, 1);
  await client.stop();
  await gw.close();
});

test('reconnects with backoff after HTTP errors and records the error without the token', async () => {
  const gw = await fakeGateway((_req, res, n) => {
    if (n < 3) { res.writeHead(401).end('no'); return; }
    sse(res);
    res.write(transcript('e1', 1));
  });
  const { client, items } = make(gw);
  client.start();
  await until(() => items().length === 1);
  assert.equal(gw.requests.length, 3);
  assert.equal(client.status().reconnects, 2);
  assert.match(client.status().lastError, /HTTP 401/);
  await client.stop();
  await gw.close();
});

test('a silent connection is treated as dead after the idle timeout', async () => {
  const gw = await fakeGateway((_req, res, n) => {
    sse(res);
    res.write(n === 1 ? ': hello\n\n' : transcript('e1', 1));
  });
  const { client, items } = make(gw, { idleMs: 80 });
  client.start();
  await until(() => items().length === 1);
  assert.ok(gw.requests.length >= 2);
  await client.stop();
  await gw.close();
});

test('stop() aborts the connection and stops reconnecting', async () => {
  let closed = false;
  const gw = await fakeGateway((req, res) => {
    sse(res);
    res.write(': hi\n\n');
    req.on('close', () => { closed = true; });
  });
  const { client } = make(gw);
  client.start();
  await until(() => client.status().connected);
  await client.stop();
  await until(() => closed);
  assert.equal(client.status().connected, false);
  const count = gw.requests.length;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(gw.requests.length, count);
  await gw.close();
});

test('unconfigured client is inert', async () => {
  const client = new GatewayCaptions({ baseUrl: '', stream: 'a', streams: registry() });
  client.start();
  assert.equal(client.status().configured, false);
  await client.stop();
});
