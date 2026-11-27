import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import {
  normalizeTunnelUrl,
  rewriteTunnelPath,
  setCanvaCorsHeaders,
  createTunnelRouter
} from '../lib/tunnel-proxy.js';

test('normalizeTunnelUrl handles valid and invalid URLs', () => {
  assert.equal(normalizeTunnelUrl('http://127.0.0.1:3010'), 'http://127.0.0.1:3010');
  assert.equal(normalizeTunnelUrl('http://127.0.0.1:3010/'), 'http://127.0.0.1:3010');
  assert.equal(normalizeTunnelUrl('https://example.com/tunnel/'), 'https://example.com/tunnel');
  assert.equal(normalizeTunnelUrl('ftp://example.com'), '');
  assert.equal(normalizeTunnelUrl(''), '');
  assert.equal(normalizeTunnelUrl(undefined), '');
  assert.equal(normalizeTunnelUrl('not-a-url'), '');
});

test('rewriteTunnelPath rewrites Canva paths correctly', () => {
  assert.equal(rewriteTunnelPath('/canva', 'canva'), '/api/v1/canva/status');
  assert.equal(rewriteTunnelPath('/canva/', 'canva'), '/api/v1/canva/status');
  assert.equal(rewriteTunnelPath('/canva/push', 'canva'), '/api/v1/canva/push');
  assert.equal(rewriteTunnelPath('/canva/tasks/123?poll=1', 'canva'), '/api/v1/canva/tasks/123?poll=1');
  assert.equal(rewriteTunnelPath('/canva/api/v1/canva/setup', 'canva'), '/api/v1/canva/setup');
  assert.equal(rewriteTunnelPath('/api/v1/canva/action-lists', 'canva'), '/api/v1/canva/action-lists');
  assert.equal(rewriteTunnelPath('/api/v1/graphics/canva/push', 'canva'), '/api/v1/graphics/canva/push');
});

test('rewriteTunnelPath rewrites PiControl paths correctly', () => {
  assert.equal(rewriteTunnelPath('/control', 'picontrol'), '/');
  assert.equal(rewriteTunnelPath('/control/', 'picontrol'), '/');
  assert.equal(rewriteTunnelPath('/picontrol', 'picontrol'), '/');
  assert.equal(rewriteTunnelPath('/control/api/v1/status', 'picontrol'), '/api/v1/status');
  assert.equal(rewriteTunnelPath('/picontrol/ui/api/login', 'picontrol'), '/ui/api/login');
  assert.equal(rewriteTunnelPath('/ui/api/session?renew=1', 'picontrol'), '/ui/api/session?renew=1');
});

test('rewriteTunnelPath rewrites MCP paths correctly', () => {
  assert.equal(rewriteTunnelPath('/mcp', 'mcp'), '/mcp');
  assert.equal(rewriteTunnelPath('/mcp/', 'mcp'), '/mcp/');
  assert.equal(rewriteTunnelPath('/mcp/tools?domain=routing', 'mcp'), '/mcp/tools?domain=routing');
  assert.equal(rewriteTunnelPath('/api/v1/mcp', 'mcp'), '/mcp');
  assert.equal(rewriteTunnelPath('/api/v1/mcp/sse', 'mcp'), '/mcp/sse');
});

test('setCanvaCorsHeaders sets expected CORS headers', () => {
  const headers = {};
  const mockRes = {
    setHeader(k, v) {
      headers[k] = v;
    }
  };
  setCanvaCorsHeaders(mockRes, 'https://example.canva.com');
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://example.canva.com');
  assert.ok(headers['Access-Control-Allow-Methods'].includes('GET'));
  assert.ok(headers['Access-Control-Allow-Headers'].includes('Authorization'));
});

test('tunnel router answers status endpoint', async () => {
  const router = createTunnelRouter({
    canvaTunnelUrl: 'http://127.0.0.1:3010',
    picontrolTunnelUrl: '',
    picontrolMcpTunnelUrl: 'http://127.0.0.1:3601'
  });

  const app = express();
  app.use(router);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/tunnels/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.canva.configured, true);
    assert.equal(body.canva.target, 'http://127.0.0.1:3010');
    assert.equal(body.picontrol.configured, false);
    assert.equal(body.picontrol.target, null);
    assert.equal(body.picontrolMcp.configured, true);
    assert.equal(body.picontrolMcp.target, 'http://127.0.0.1:3601');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('tunnel router returns 503 when tunnel URL is not configured', async () => {
  const router = createTunnelRouter({
    canvaTunnelUrl: '',
    picontrolTunnelUrl: '',
    picontrolMcpTunnelUrl: ''
  });

  const app = express();
  app.use(router);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const resCanva = await fetch(`http://127.0.0.1:${port}/canva/push`);
    assert.equal(resCanva.status, 503);
    const bodyCanva = await resCanva.json();
    assert.equal(bodyCanva.code, 'CANVA_TUNNEL_DISABLED');

    const resControl = await fetch(`http://127.0.0.1:${port}/control/api/v1/status`);
    assert.equal(resControl.status, 503);
    const bodyControl = await resControl.json();
    assert.equal(bodyControl.code, 'PICONTROL_TUNNEL_DISABLED');

    const resMcp = await fetch(`http://127.0.0.1:${port}/mcp/tools`);
    assert.equal(resMcp.status, 503);
    const bodyMcp = await resMcp.json();
    assert.equal(bodyMcp.code, 'PICONTROL_MCP_TUNNEL_DISABLED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('tunnel router answers Canva OPTIONS preflight with 204 and CORS', async () => {
  const router = createTunnelRouter({
    canvaTunnelUrl: 'http://127.0.0.1:3010'
  });

  const app = express();
  app.use(router);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/canva/push`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://www.canva.com' }
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://www.canva.com');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('tunnel router proxies requests and bodies to upstream', async () => {
  let receivedMethod = '';
  let receivedPath = '';
  let receivedBody = '';
  let receivedAuth = '';

  const mockUpstream = http.createServer(async (req, res) => {
    receivedMethod = req.method;
    receivedPath = req.url;
    receivedAuth = req.headers.authorization || '';

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    receivedBody = Buffer.concat(chunks).toString();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstreamPath: req.url }));
  });

  await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = mockUpstream.address().port;

  const router = createTunnelRouter({
    canvaTunnelUrl: `http://127.0.0.1:${upstreamPort}`,
    picontrolTunnelUrl: `http://127.0.0.1:${upstreamPort}`,
    picontrolMcpTunnelUrl: `http://127.0.0.1:${upstreamPort}`
  });

  const app = express();
  app.use(router);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // Test Canva POST proxying
    const postRes = await fetch(`http://127.0.0.1:${port}/canva/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer canva-test-token'
      },
      body: JSON.stringify({ slides: [1, 2] })
    });
    assert.equal(postRes.status, 200);
    assert.equal(receivedMethod, 'POST');
    assert.equal(receivedPath, '/api/v1/canva/push');
    assert.equal(receivedAuth, 'Bearer canva-test-token');
    assert.deepEqual(JSON.parse(receivedBody), { slides: [1, 2] });

    // Test PiControl GET proxying
    const getRes = await fetch(`http://127.0.0.1:${port}/control/api/v1/status?verbose=1`);
    assert.equal(getRes.status, 200);
    assert.equal(receivedMethod, 'GET');
    assert.equal(receivedPath, '/api/v1/status?verbose=1');

    // Test PiControl MCP proxying
    const mcpRes = await fetch(`http://127.0.0.1:${port}/mcp/tools`, {
      headers: { Authorization: 'Bearer mcp-token' }
    });
    assert.equal(mcpRes.status, 200);
    assert.equal(receivedMethod, 'GET');
    assert.equal(receivedPath, '/mcp/tools');
    assert.equal(receivedAuth, 'Bearer mcp-token');

    // Test subpath proxying (e.g. /relay/canva/push or /media/control/api/v1/status)
    const subpathRes = await fetch(`http://127.0.0.1:${port}/relay/canva/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subpathTest: true })
    });
    assert.equal(subpathRes.status, 200);
    assert.equal(receivedPath, '/api/v1/canva/push');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => mockUpstream.close(resolve));
  }
});

test('rewriteTunnelPath supports subpath prefixes like /relay and /media', () => {
  assert.equal(rewriteTunnelPath('/relay/canva/push', 'canva'), '/api/v1/canva/push');
  assert.equal(rewriteTunnelPath('/media/canva/status', 'canva'), '/api/v1/canva/status');
  assert.equal(rewriteTunnelPath('/relay/control/api/status', 'picontrol'), '/api/status');
  assert.equal(rewriteTunnelPath('/media/mcp/sse', 'mcp'), '/mcp/sse');
});
