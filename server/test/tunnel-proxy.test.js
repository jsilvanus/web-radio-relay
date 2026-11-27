import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { openStore } from '../lib/store.js';
import { normalizeLocalPortUrl, mapDiscoveryToPiSystems } from '../lib/discovery-client.js';
import {
  normalizeTunnelUrl,
  rewriteTunnelPath,
  setCanvaCorsHeaders,
  parsePiSystems,
  resolveTargetSystem,
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

test('parsePiSystems handles JSON and env conventions', () => {
  const parsed = parsePiSystems({
    systems: {
      keskuskirkko: {
        canva: 'http://127.0.0.1:3010',
        picontrol: 'http://127.0.0.1:3012',
        mcp: 'http://127.0.0.1:3601'
      },
      kappeli: {
        canva: 'http://127.0.0.1:3020',
        picontrol: 'http://127.0.0.1:3022',
        mcp: 'http://127.0.0.1:3602'
      }
    }
  });

  assert.equal(parsed.defaultSystemId, 'keskuskirkko');
  assert.equal(parsed.systems.size, 2);
  assert.equal(parsed.systems.get('keskuskirkko').canva, 'http://127.0.0.1:3010');
  assert.equal(parsed.systems.get('kappeli').picontrol, 'http://127.0.0.1:3022');
});

test('resolveTargetSystem resolves by path, header, query and default', () => {
  const systems = new Map([
    ['keskuskirkko', { canva: 'http://127.0.0.1:3010', picontrol: '', mcp: '' }],
    ['kappeli', { canva: 'http://127.0.0.1:3020', picontrol: '', mcp: '' }]
  ]);

  // Path resolution
  const pathRes = resolveTargetSystem({ url: '/pi/kappeli/canva/push', headers: {} }, systems, 'keskuskirkko');
  assert.equal(pathRes.systemId, 'kappeli');
  assert.ok(pathRes.system);

  // Header resolution
  const headerRes = resolveTargetSystem({ url: '/canva/push', headers: { 'x-pi-target': 'kappeli' } }, systems, 'keskuskirkko');
  assert.equal(headerRes.systemId, 'kappeli');

  // Query resolution
  const queryRes = resolveTargetSystem({ url: '/canva/push', query: { pi: 'kappeli' }, headers: {} }, systems, 'keskuskirkko');
  assert.equal(queryRes.systemId, 'kappeli');

  // Default fallback
  const defaultRes = resolveTargetSystem({ url: '/canva/push', headers: {} }, systems, 'keskuskirkko');
  assert.equal(defaultRes.systemId, 'keskuskirkko');
});

test('multi-system router routes to separate upstream Pi tunnels', async () => {
  let capturedKeskuskirkko = null;
  let capturedKappeli = null;

  // Mock Keskuskirkko upstream
  const mockKeskuskirkko = http.createServer((req, res) => {
    capturedKeskuskirkko = { method: req.method, path: req.url };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ location: 'keskuskirkko' }));
  });
  await new Promise((r) => mockKeskuskirkko.listen(0, '127.0.0.1', r));
  const portKeskuskirkko = mockKeskuskirkko.address().port;

  // Mock Kappeli upstream
  const mockKappeli = http.createServer((req, res) => {
    capturedKappeli = { method: req.method, path: req.url };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ location: 'kappeli' }));
  });
  await new Promise((r) => mockKappeli.listen(0, '127.0.0.1', r));
  const portKappeli = mockKappeli.address().port;

  const router = createTunnelRouter({
    systems: {
      keskuskirkko: {
        canva: `http://127.0.0.1:${portKeskuskirkko}`,
        picontrol: `http://127.0.0.1:${portKeskuskirkko}`,
        mcp: `http://127.0.0.1:${portKeskuskirkko}`
      },
      kappeli: {
        canva: `http://127.0.0.1:${portKappeli}`,
        picontrol: `http://127.0.0.1:${portKappeli}`,
        mcp: `http://127.0.0.1:${portKappeli}`
      }
    }
  });

  const app = express();
  app.use(router);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const relayPort = server.address().port;

  try {
    // 1. Status lists both systems
    const statusRes = await fetch(`http://127.0.0.1:${relayPort}/api/v1/tunnels/status`);
    const statusData = await statusRes.json();
    assert.equal(statusData.totalSystems, 2);
    assert.ok(statusData.systems.keskuskirkko);
    assert.ok(statusData.systems.kappeli);

    // 2. Request to default goes to Keskuskirkko
    const defaultReq = await fetch(`http://127.0.0.1:${relayPort}/canva/status`);
    const defaultData = await defaultReq.json();
    assert.equal(defaultData.location, 'keskuskirkko');
    assert.equal(capturedKeskuskirkko.path, '/api/v1/canva/status');

    // 3. Request to /pi/kappeli goes to Kappeli upstream
    const kappeliReq = await fetch(`http://127.0.0.1:${relayPort}/pi/kappeli/canva/status`);
    const kappeliData = await kappeliReq.json();
    assert.equal(kappeliData.location, 'kappeli');
    assert.equal(capturedKappeli.path, '/api/v1/canva/status');

    // 4. Request with X-Pi-Target: kappeli header goes to Kappeli upstream
    const headerReq = await fetch(`http://127.0.0.1:${relayPort}/control/api/v1/items`, {
      headers: { 'X-Pi-Target': 'kappeli' }
    });
    const headerData = await headerReq.json();
    assert.equal(headerData.location, 'kappeli');
    assert.equal(capturedKappeli.path, '/api/v1/items');

    // 5. Unknown Pi system returns 404
    const unknownReq = await fetch(`http://127.0.0.1:${relayPort}/pi/unknown-church/canva/status`);
    assert.equal(unknownReq.status, 404);
    const unknownData = await unknownReq.json();
    assert.equal(unknownData.code, 'UNKNOWN_PI_SYSTEM');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mockKeskuskirkko.close(r));
    await new Promise((r) => mockKappeli.close(r));
  }
});

test('Pi self-registration with token, tunnel ports, venue info and SQLite persistence', async () => {
  const store = openStore(':memory:');
  const db = store.db;
  const relayToken = 'secret-relay-token-12345';

  let capturedUpstreamRequest = null;
  const mockPiUpstream = http.createServer((req, res) => {
    capturedUpstreamRequest = { method: req.method, path: req.url };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Hello from Pi sanctuary' }));
  });
  await new Promise((r) => mockPiUpstream.listen(0, '127.0.0.1', r));
  const upstreamPort = mockPiUpstream.address().port;

  const router = createTunnelRouter({
    db,
    relayApiToken: relayToken
  });

  const app = express();
  app.use(router);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const relayPort = server.address().port;

  try {
    // 1. Registration fails without auth
    const unauthRes = await fetch(`http://127.0.0.1:${relayPort}/api/v1/tunnels/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'keskuskirkko' })
    });
    assert.equal(unauthRes.status, 401);

    // 2. Pi self-registers with token, tunnel ports and venue information
    const venueData = {
      profile: 'keskuskirkko',
      sanctuary: 'Main Sanctuary',
      matrix: {
        inputs: { 3: 'PiPGM1', 4: 'PiPGM2' },
        outputs: { 1: 'Projector Left', 2: 'Projector Right' }
      },
      projectors: ['proj1', 'proj2'],
      atem: { ip: '192.168.1.100' }
    };

    const registerRes = await fetch(`http://127.0.0.1:${relayPort}/api/v1/tunnels/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${relayToken}`
      },
      body: JSON.stringify({
        id: 'keskuskirkko',
        name: 'Riihimäen Keskuskirkko',
        tunnels: {
          canva: `http://127.0.0.1:${upstreamPort}`,
          picontrol: `http://127.0.0.1:${upstreamPort}`,
          mcp: `http://127.0.0.1:${upstreamPort}`
        },
        venue: venueData
      })
    });
    assert.equal(registerRes.status, 201);
    const regJson = await registerRes.json();
    assert.equal(regJson.ok, true);
    assert.equal(regJson.system.id, 'keskuskirkko');
    assert.equal(regJson.system.venue.profile, 'keskuskirkko');

    // 3. Immediately routes traffic to the newly registered Pi system
    const canvaPushRes = await fetch(`http://127.0.0.1:${relayPort}/pi/keskuskirkko/canva/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages: [1] })
    });
    assert.equal(canvaPushRes.status, 200);
    assert.equal(capturedUpstreamRequest.path, '/api/v1/canva/push');

    // 4. Query systems list
    const listRes = await fetch(`http://127.0.0.1:${relayPort}/api/v1/systems`);
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.total, 1);
    assert.equal(listJson.systems[0].id, 'keskuskirkko');
    assert.equal(listJson.systems[0].hasVenue, true);

    // 5. Query system venue endpoint
    const venueRes = await fetch(`http://127.0.0.1:${relayPort}/api/v1/systems/keskuskirkko/venue`);
    assert.equal(venueRes.status, 200);
    const venueJson = await venueRes.json();
    assert.equal(venueJson.profile, 'keskuskirkko');
    assert.deepEqual(venueJson.projectors, ['proj1', 'proj2']);

    // 6. Heartbeat keeps lastSeenAt updated
    const hbRes = await fetch(`http://127.0.0.1:${relayPort}/api/v1/tunnels/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${relayToken}`
      },
      body: JSON.stringify({ id: 'keskuskirkko' })
    });
    assert.equal(hbRes.status, 200);

    // 7. Verify SQLite persistence by re-creating router with same db
    const router2 = createTunnelRouter({ db, relayApiToken: relayToken });
    const app2 = express();
    app2.use(router2);
    const server2 = http.createServer(app2);
    await new Promise((r) => server2.listen(0, '127.0.0.1', r));
    const port2 = server2.address().port;

    try {
      const persistedRes = await fetch(`http://127.0.0.1:${port2}/api/v1/systems/keskuskirkko`);
      assert.equal(persistedRes.status, 200);
      const persistedJson = await persistedRes.json();
      assert.equal(persistedJson.id, 'keskuskirkko');
      assert.equal(persistedJson.venue.profile, 'keskuskirkko');
    } finally {
      await new Promise((r) => server2.close(r));
    }
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mockPiUpstream.close(r));
  }
});

test('normalizeLocalPortUrl normalizes ports and loopback addresses to host.docker.internal', () => {
  assert.equal(normalizeLocalPortUrl(3010), 'http://host.docker.internal:3010');
  assert.equal(normalizeLocalPortUrl('3012'), 'http://host.docker.internal:3012');
  assert.equal(normalizeLocalPortUrl(':3601'), 'http://host.docker.internal:3601');
  assert.equal(normalizeLocalPortUrl('http://127.0.0.1:3010/'), 'http://host.docker.internal:3010');
  assert.equal(normalizeLocalPortUrl('http://localhost:3012'), 'http://host.docker.internal:3012');
  assert.equal(normalizeLocalPortUrl('https://example.com/canva'), 'https://example.com/canva');
});

test('mapDiscoveryToPiSystems extracts venues, loop-bound tunnel ports and profiles', () => {
  const discoveryCatalog = {
    updated_at: '2026-11-27T07:00:00Z',
    services: [
      {
        id: 'keskuskirkko-pi',
        name: 'Keskuskirkko — Sali (Pi Program)',
        type: 'piprogram',
        venue: 'keskuskirkko',
        metadata: {
          tunnels: {
            canva: 3010,
            picontrol: 3012,
            mcp: 3601
          },
          venue: {
            profile: 'keskuskirkko',
            sanctuary: 'Main'
          }
        }
      },
      {
        id: 'kappeli-pi',
        name: 'Kappeli Edge Pi',
        type: 'piecosystem',
        venue: 'kappeli',
        metadata: {
          ports: {
            canva: '3020',
            picontrol: '3022',
            mcp: '3602'
          },
          venue_profile: {
            profile: 'kappeli'
          }
        }
      }
    ]
  };

  const systems = mapDiscoveryToPiSystems(discoveryCatalog);
  assert.equal(systems.size, 2);

  const keskuskirkko = systems.get('keskuskirkko');
  assert.ok(keskuskirkko);
  assert.equal(keskuskirkko.canva, 'http://host.docker.internal:3010');
  assert.equal(keskuskirkko.picontrol, 'http://host.docker.internal:3012');
  assert.equal(keskuskirkko.mcp, 'http://host.docker.internal:3601');
  assert.equal(keskuskirkko.venue.profile, 'keskuskirkko');

  const kappeli = systems.get('kappeli');
  assert.ok(kappeli);
  assert.equal(kappeli.canva, 'http://host.docker.internal:3020');
  assert.equal(kappeli.picontrol, 'http://host.docker.internal:3022');
  assert.equal(kappeli.mcp, 'http://host.docker.internal:3602');
  assert.equal(kappeli.venue.profile, 'kappeli');
});

test('pulling discovery catalog registers Pi systems and routes traffic', async () => {
  let capturedUpstream = null;
  const mockUpstream = http.createServer((req, res) => {
    capturedUpstream = { path: req.url, method: req.method };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ routed: true, target: 'mockUpstream' }));
  });
  await new Promise((r) => mockUpstream.listen(0, '0.0.0.0', r));
  const upstreamPort = mockUpstream.address().port;

  // Mock Tunnus / OIDC discovery server
  const mockDiscoveryServer = http.createServer((req, res) => {
    if (req.url === '/api/v1/discovery') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        updated_at: new Date().toISOString(),
        services: [
          {
            id: 'keskuskirkko-node',
            name: 'Keskuskirkko Pi',
            type: 'pigateway',
            venue: 'keskuskirkko',
            metadata: {
              tunnels: {
                canva: `http://127.0.0.1:${upstreamPort}`,
                picontrol: `http://127.0.0.1:${upstreamPort}`,
                mcp: `http://127.0.0.1:${upstreamPort}`
              },
              venue: {
                sanctuary: 'Main Church',
                matrix: { inputs: [1, 2, 3, 4] }
              }
            }
          }
        ]
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => mockDiscoveryServer.listen(0, '127.0.0.1', r));
  const discoveryPort = mockDiscoveryServer.address().port;

  const store = openStore(':memory:');
  const router = createTunnelRouter({
    db: store.db,
    discoveryServiceUrl: `http://127.0.0.1:${discoveryPort}/api/v1/discovery`,
    discoveryPollIntervalSeconds: 0 // manual sync in test
  });

  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const relayPort = server.address().port;

  try {
    // 1. Check discovery status
    const statusRes = await fetch(`http://127.0.0.1:${relayPort}/api/v1/discovery/status`);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.configured, true);
    assert.equal(statusJson.discoveryUrl, `http://127.0.0.1:${discoveryPort}/api/v1/discovery`);

    // 2. Trigger manual sync from discovery service
    const syncRes = await fetch(`http://127.0.0.1:${relayPort}/api/v1/discovery/sync`, { method: 'POST' });
    assert.equal(syncRes.status, 200);
    const syncJson = await syncRes.json();
    assert.equal(syncJson.ok, true);
    assert.equal(syncJson.synced, 1);
    assert.deepEqual(syncJson.systems, ['keskuskirkko']);

    // 3. Traffic to /pi/keskuskirkko/canva/push routes to the discovered Pi upstream
    const canvaRes = await fetch(`http://127.0.0.1:${relayPort}/pi/keskuskirkko/canva/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slides: [1] })
    });
    assert.equal(canvaRes.status, 200);
    assert.equal(capturedUpstream.path, '/api/v1/canva/push');

    // 4. Discovered venue data is accessible
    const venueRes = await fetch(`http://127.0.0.1:${relayPort}/api/v1/systems/keskuskirkko/venue`);
    assert.equal(venueRes.status, 200);
    const venueJson = await venueRes.json();
    assert.equal(venueJson.sanctuary, 'Main Church');
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => mockUpstream.close(r));
    await new Promise((r) => mockDiscoveryServer.close(r));
  }
});
