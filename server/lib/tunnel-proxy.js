/**
 * Tunnel Proxy Service
 *
 * Routes incoming requests for Canva application, PiControl, and PiControl MCP
 * into the reverse SSH tunnels created from the piecosystem side (church Pi -> VPS).
 *
 * Paths handled:
 *   - Canva:         /canva, /canva/*, /api/v1/canva/*, /api/v1/graphics/canva/* -> CANVA_TUNNEL_URL
 *   - PiControl:     /control, /control/*, /picontrol, /picontrol/*, /ui/api/*    -> PICONTROL_TUNNEL_URL
 *   - PiControl MCP: /mcp, /mcp/*, /api/v1/mcp, /api/v1/mcp/*                   -> PICONTROL_MCP_TUNNEL_URL
 *   - Status:        GET /api/v1/tunnels/status
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import express from 'express';
import { bearerToken, tokensEqual } from './auth.js';
import { findTokenByValue, isUsable, scopeAllows } from './tokens.js';
import { mapDiscoveryToPiSystems, fetchDiscoveryCatalog } from './discovery-client.js';

/**
 * Validates and normalizes a tunnel URL (must be http or https, or port number).
 * @param {string|number|undefined} value
 * @returns {string}
 */
export function normalizeTunnelUrl(value) {
  if (typeof value === 'number') {
    return `http://host.docker.internal:${value}`;
  }
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  if (!text) return '';
  if (/^\d+$/.test(text)) {
    return `http://host.docker.internal:${text}`;
  }
  if (/^:\d+$/.test(text)) {
    return `http://host.docker.internal${text}`;
  }
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return '';
  }
}

/**
 * Rewrites client request path for the target tunnel upstream.
 * @param {string} originalPath
 * @param {'canva' | 'picontrol' | 'mcp'} target
 * @returns {string}
 */
export function rewriteTunnelPath(originalPath, target) {
  let [pathname, search] = String(originalPath || '/').split('?');
  const query = search ? `?${search}` : '';

  // Strip subpath prefix if request passed through without Traefik stripprefix
  if (pathname.startsWith('/relay/')) {
    pathname = pathname.slice('/relay'.length);
  } else if (pathname === '/relay') {
    pathname = '/';
  } else if (pathname.startsWith('/media/')) {
    pathname = pathname.slice('/media'.length);
  } else if (pathname === '/media') {
    pathname = '/';
  }

  // Strip /pi/:system prefix if present
  const piMatch = pathname.match(/^\/pi\/[a-zA-Z0-9_-]+(\/.*|$)/);
  if (piMatch) {
    pathname = piMatch[1] || '/';
  }

  if (target === 'canva') {
    if (pathname === '/canva' || pathname === '/canva/') {
      return `/api/v1/canva/status${query}`;
    }
    if (pathname.startsWith('/canva/api/v1/canva')) {
      return pathname.slice('/canva'.length) + query;
    }
    if (pathname.startsWith('/canva/')) {
      const rest = pathname.slice('/canva/'.length);
      if (rest.startsWith('api/v1/')) {
        return `/${rest}${query}`;
      }
      return `/api/v1/canva/${rest}${query}`;
    }
    return `${pathname}${query}`;
  }

  if (target === 'picontrol') {
    if (pathname === '/control' || pathname === '/control/' || pathname === '/picontrol' || pathname === '/picontrol/') {
      return `/${query}`;
    }
    if (pathname.startsWith('/control/')) {
      return `/${pathname.slice('/control/'.length)}${query}`;
    }
    if (pathname.startsWith('/picontrol/')) {
      return `/${pathname.slice('/picontrol/'.length)}${query}`;
    }
    return `${pathname}${query}`;
  }

  if (target === 'mcp') {
    if (pathname.startsWith('/api/v1/mcp')) {
      return `/mcp${pathname.slice('/api/v1/mcp'.length)}${query}`;
    }
    return `${pathname}${query}`;
  }

  return `${pathname}${query}`;
}

/**
 * Applies standard Canva CORS headers.
 * @param {import('express').Response} res
 * @param {string|undefined} origin
 */
export function setCanvaCorsHeaders(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

/**
 * Forwards an HTTP request to a target tunnel URL using Node native streaming.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} targetBaseUrl
 * @param {{ rewrite?: 'canva' | 'picontrol' | 'mcp', timeoutMs?: number, isCanva?: boolean }} options
 */
export function proxyToTunnel(req, res, targetBaseUrl, options = {}) {
  const normalizedTarget = normalizeTunnelUrl(targetBaseUrl);
  if (!normalizedTarget) {
    const name = options.rewrite === 'canva' ? 'Canva' : options.rewrite === 'mcp' ? 'PiControl-MCP' : 'PiControl';
    const code = options.rewrite === 'canva' ? 'CANVA' : options.rewrite === 'mcp' ? 'PICONTROL_MCP' : 'PICONTROL';
    res.status(503).json({
      error: `${name} tunnel is not configured`,
      code: `${code}_TUNNEL_DISABLED`
    });
    return;
  }

  if (options.isCanva && req.method === 'OPTIONS') {
    setCanvaCorsHeaders(res, req.headers.origin);
    res.status(204).end();
    return;
  }

  const rewrittenPath = options.rewrite ? rewriteTunnelPath(req.originalUrl || req.url, options.rewrite) : req.url;
  const targetParsed = new URL(normalizedTarget);
  const targetPath = (targetParsed.pathname.replace(/\/+$/, '') + rewrittenPath).replace(/\/{2,}/g, '/');

  const isHttps = targetParsed.protocol === 'https:';
  const client = isHttps ? https : http;

  // Build forwarded headers
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['keep-alive'];

  headers.host = targetParsed.host;
  const clientIp = req.socket?.remoteAddress || req.ip || '';
  if (clientIp) {
    headers['x-forwarded-for'] = req.headers['x-forwarded-for']
      ? `${req.headers['x-forwarded-for']}, ${clientIp}`
      : clientIp;
  }
  headers['x-forwarded-proto'] = req.protocol || 'http';

  const isEventStream = req.headers.accept?.includes('text/event-stream') || req.path?.includes('/events');
  const timeoutMs = isEventStream ? 0 : (options.timeoutMs ?? 30000);

  const proxyReq = client.request({
    protocol: targetParsed.protocol,
    hostname: targetParsed.hostname,
    port: targetParsed.port || (isHttps ? 443 : 80),
    method: req.method,
    path: targetPath,
    headers,
    timeout: timeoutMs
  });

  if (timeoutMs > 0) {
    proxyReq.setTimeout(timeoutMs, () => {
      proxyReq.destroy(new Error('Tunnel request timed out'));
    });
  }

  proxyReq.on('response', (proxyRes) => {
    if (res.headersSent) return;

    res.status(proxyRes.statusCode || 200);

    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (key.toLowerCase() === 'connection') continue;
      if (value !== undefined) {
        res.setHeader(key, value);
      }
    }

    if (options.isCanva) {
      setCanvaCorsHeaders(res, req.headers.origin);
    }

    if (isEventStream || proxyRes.headers['content-type']?.includes('text/event-stream')) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
    }

    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    if (res.headersSent) return;
    const name = options.rewrite === 'canva' ? 'Canva' : options.rewrite === 'mcp' ? 'PiControl-MCP' : 'PiControl';
    const code = options.rewrite === 'canva' ? 'CANVA' : options.rewrite === 'mcp' ? 'PICONTROL_MCP' : 'PICONTROL';
    console.error(`[tunnel-proxy] ${name} tunnel error (${rewrittenPath}):`, err.message || err.code);
    res.status(502).json({
      error: `${name} tunnel is unreachable`,
      code: `${code}_TUNNEL_UNREACHABLE`,
      details: err.code || 'ECONNREFUSED'
    });
  });

  req.on('aborted', () => {
    proxyReq.destroy();
  });

  if (req.body && (typeof req.body === 'object' || typeof req.body === 'string' || Buffer.isBuffer(req.body))) {
    const isBuffer = Buffer.isBuffer(req.body);
    const isString = typeof req.body === 'string';
    const payload = isBuffer || isString ? req.body : JSON.stringify(req.body);
    if (!isBuffer && !isString && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }
    headers['content-length'] = Buffer.byteLength(payload);
    proxyReq.write(payload);
    proxyReq.end();
  } else {
    req.pipe(proxyReq);
  }
}

/**
 * Loads registered Pi systems from SQLite store.
 * @param {object} db
 * @param {Map<string, object>} systemsMap
 */
export function loadStoredSystems(db, systemsMap) {
  if (!db) return;
  try {
    const rows = db.prepare('SELECT * FROM pi_systems').all();
    for (const row of rows) {
      let venue = null;
      if (row.venue_json) {
        try { venue = JSON.parse(row.venue_json); } catch {}
      }
      systemsMap.set(row.id.toLowerCase(), {
        id: row.id.toLowerCase(),
        name: row.name || row.id,
        canva: row.canva_url || '',
        picontrol: row.picontrol_url || '',
        mcp: row.mcp_url || '',
        venue,
        registeredAt: row.registered_at,
        updatedAt: row.updated_at,
        lastSeenAt: row.last_seen_at,
        status: row.status || 'online'
      });
    }
  } catch (err) {
    console.warn('[tunnel-proxy] Failed to load stored pi_systems:', err.message);
  }
}

/**
 * Persists a registered Pi system into SQLite store.
 * @param {object} db
 * @param {object} system
 */
export function saveStoredSystem(db, system) {
  if (!db) return;
  try {
    const venueJson = system.venue ? JSON.stringify(system.venue) : null;
    db.prepare(`
      INSERT INTO pi_systems (id, name, canva_url, picontrol_url, mcp_url, venue_json, registered_at, updated_at, last_seen_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        canva_url = excluded.canva_url,
        picontrol_url = excluded.picontrol_url,
        mcp_url = excluded.mcp_url,
        venue_json = excluded.venue_json,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at,
        status = excluded.status
    `).run(
      system.id,
      system.name || system.id,
      system.canva || '',
      system.picontrol || '',
      system.mcp || '',
      venueJson,
      system.registeredAt || Date.now(),
      system.updatedAt || Date.now(),
      system.lastSeenAt || Date.now(),
      system.status || 'online'
    );
  } catch (err) {
    console.warn('[tunnel-proxy] Failed to persist pi_system:', err.message);
  }
}

/**
 * Deletes a registered Pi system from SQLite store.
 * @param {object} db
 * @param {string} id
 */
export function deleteStoredSystem(db, id) {
  if (!db) return;
  try {
    db.prepare('DELETE FROM pi_systems WHERE id = ?').run(id.toLowerCase());
  } catch (err) {
    console.warn('[tunnel-proxy] Failed to delete pi_system:', err.message);
  }
}

/**
 * Verifies Bearer authentication for tunnel registration and management.
 * @param {import('express').Request} req
 * @param {{ relayApiToken?: string, registrationToken?: string, db?: object }} options
 * @returns {{ authorized: boolean, status?: number, error?: string, role?: string, token?: object }}
 */
export function verifyRegistrationAuth(req, { relayApiToken = '', registrationToken = '', db = null } = {}) {
  const given = bearerToken(req.headers.authorization);
  if (!given) return { authorized: false, status: 401, error: 'Unauthorized: Bearer token required' };

  if (relayApiToken && tokensEqual(given, relayApiToken)) {
    return { authorized: true, role: 'admin' };
  }

  if (registrationToken && tokensEqual(given, registrationToken)) {
    return { authorized: true, role: 'registration' };
  }

  if (db) {
    const row = findTokenByValue(db, given);
    if (row && isUsable(row, Date.now())) {
      if (scopeAllows(row.scopes, 'admin') || scopeAllows(row.scopes, 'system:register')) {
        return { authorized: true, role: 'scoped', token: row };
      }
    }
  }

  if (!relayApiToken && !registrationToken && !db) {
    return { authorized: false, status: 503, error: 'Tunnel registration is not configured: set RELAY_API_TOKEN' };
  }

  return { authorized: false, status: 401, error: 'Unauthorized: Invalid token' };
}

/**
 * Parses and normalizes configurations for multiple Pi systems.
 * Supports:
 *   1. Explicit options.systems or options.piSystems (object or JSON string)
 *   2. Environment variable PI_SYSTEMS (JSON string)
 *   3. Convention environment variables: PI_<NAME>_CANVA_TUNNEL_URL, etc.
 *   4. Single-system fallback (CANVA_TUNNEL_URL, PICONTROL_TUNNEL_URL, PICONTROL_MCP_TUNNEL_URL)
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ defaultSystemId: string, systems: Map<string, { canva: string, picontrol: string, mcp: string }> }}
 */
export function parsePiSystems(options = {}, env = process.env) {
  const systems = new Map();

  // 1. JSON config input
  const systemsInput = options.systems ?? options.piSystems ?? env.PI_SYSTEMS;
  if (systemsInput) {
    try {
      const parsed = typeof systemsInput === 'string' ? JSON.parse(systemsInput) : systemsInput;
      if (parsed && typeof parsed === 'object') {
        for (const [id, cfg] of Object.entries(parsed)) {
          if (!id || typeof cfg !== 'object') continue;
          systems.set(id.toLowerCase(), {
            canva: normalizeTunnelUrl(cfg.canva || cfg.canvaTunnelUrl),
            picontrol: normalizeTunnelUrl(cfg.picontrol || cfg.picontrolTunnelUrl),
            mcp: normalizeTunnelUrl(cfg.mcp || cfg.picontrolMcpTunnelUrl)
          });
        }
      }
    } catch (e) {
      console.warn('[tunnel-proxy] Failed to parse PI_SYSTEMS JSON:', e.message);
    }
  }

  // 2. Convention environment variables: PI_<NAME>_(CANVA|PICONTROL|MCP)_TUNNEL_URL
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^PI_([A-Z0-9_]+)_(CANVA|PICONTROL|MCP)_TUNNEL_URL$/);
    if (match) {
      const id = match[1].toLowerCase().replace(/_/g, '-');
      const kind = match[2].toLowerCase();
      if (!systems.has(id)) {
        systems.set(id, { canva: '', picontrol: '', mcp: '' });
      }
      const entry = systems.get(id);
      entry[kind] = normalizeTunnelUrl(value);
    }
  }

  // 3. Single-system default fallback
  const defaultSystemId = (options.defaultSystemId || env.DEFAULT_PI_SYSTEM || 'keskuskirkko').toLowerCase();
  const defaultCanva = normalizeTunnelUrl(options.canvaTunnelUrl ?? env.CANVA_TUNNEL_URL);
  const defaultPicontrol = normalizeTunnelUrl(options.picontrolTunnelUrl ?? env.PICONTROL_TUNNEL_URL);
  const defaultMcp = normalizeTunnelUrl(options.picontrolMcpTunnelUrl ?? env.PICONTROL_MCP_TUNNEL_URL);

  if (defaultCanva || defaultPicontrol || defaultMcp || systems.size === 0) {
    if (!systems.has(defaultSystemId)) {
      systems.set(defaultSystemId, {
        canva: defaultCanva,
        picontrol: defaultPicontrol,
        mcp: defaultMcp
      });
    } else {
      const entry = systems.get(defaultSystemId);
      if (!entry.canva) entry.canva = defaultCanva;
      if (!entry.picontrol) entry.picontrol = defaultPicontrol;
      if (!entry.mcp) entry.mcp = defaultMcp;
    }
  }

  return {
    defaultSystemId,
    systems
  };
}

/**
 * Resolves the target Pi system ID from request path, headers, or query params.
 * @param {import('express').Request} req
 * @param {Map<string, { canva: string, picontrol: string, mcp: string }>} systemsMap
 * @param {string} defaultSystemId
 * @returns {{ systemId: string, system: { canva: string, picontrol: string, mcp: string } | null }}
 */
export function resolveTargetSystem(req, systemsMap, defaultSystemId) {
  let targetId = defaultSystemId;
  const path = req.originalUrl || req.url || '/';

  // 1. Path routing: /pi/:systemId/...
  const piMatch = path.match(/^\/pi\/([a-zA-Z0-9_-]+)(\/.*|$)/);
  if (piMatch) {
    targetId = piMatch[1].toLowerCase();
  } else if (req.headers && (req.headers['x-pi-system'] || req.headers['x-pi-target'])) {
    targetId = String(req.headers['x-pi-system'] || req.headers['x-pi-target']).trim().toLowerCase();
  } else if (req.query && (req.query.pi || req.query.system)) {
    targetId = String(req.query.pi || req.query.system).trim().toLowerCase();
  }

  const system = systemsMap.get(targetId) || null;
  return {
    systemId: targetId,
    system
  };
}

/**
 * Creates an Express router that mounts Canva, PiControl, and PiControl MCP tunnel routing
 * with support for multiple Pi systems and subpath prefixes.
 *
 * @param {{
 *   canvaTunnelUrl?: string,
 *   picontrolTunnelUrl?: string,
 *   picontrolMcpTunnelUrl?: string,
 *   defaultSystemId?: string,
 *   systems?: object | string,
 *   timeoutMs?: number
 * }} options
 * @returns {express.Router}
 */
export function createTunnelRouter(options = {}) {
  const router = express.Router();
  const db = options.db || null;
  const { defaultSystemId, systems } = parsePiSystems(options);
  const timeoutMs = options.timeoutMs ?? 30000;

  // Load any previously registered Pi systems from SQLite persistence
  if (db) {
    loadStoredSystems(db, systems);
  }

  // Support subpath staging prefix (e.g. /relay or /media) if not already stripped upstream
  router.use((req, _res, next) => {
    if (req.url.startsWith('/relay/')) {
      req.url = req.url.slice('/relay'.length);
    } else if (req.url === '/relay') {
      req.url = '/';
    } else if (req.url.startsWith('/media/')) {
      req.url = req.url.slice('/media'.length);
    } else if (req.url === '/media') {
      req.url = '/';
    }
    next();
  });

  const getAuthOptions = () => ({
    relayApiToken: options.relayApiToken ?? process.env.RELAY_API_TOKEN,
    registrationToken: options.registrationToken ?? process.env.TUNNEL_REGISTRATION_TOKEN,
    db
  });

  // ---------------------------------------------------------------------------
  // Tunnus / OIDC Discovery Pull Service
  // Pulls registered Pi systems, venue profiles, and loop-bound SSH tunnel ports
  // from central Tunnus service discovery (/api/v1/discovery).
  // ---------------------------------------------------------------------------
  const discoveryUrl = options.discoveryServiceUrl ?? process.env.DISCOVERY_SERVICE_URL ?? process.env.TUNNUS_DISCOVERY_URL ?? '';
  const discoveryToken = options.discoveryToken ?? process.env.DISCOVERY_TOKEN ?? process.env.TUNNUS_TOKEN ?? '';
  const pollIntervalSeconds = Number(options.discoveryPollIntervalSeconds ?? process.env.DISCOVERY_POLL_INTERVAL_SECONDS ?? 30);

  let lastDiscoverySyncAt = null;
  let lastDiscoveryError = null;

  async function syncFromDiscovery() {
    if (!discoveryUrl) return { ok: false, error: 'DISCOVERY_SERVICE_URL is not configured' };
    try {
      const catalog = await fetchDiscoveryCatalog({
        discoveryUrl,
        token: discoveryToken,
        fetchImpl: options.fetchImpl || fetch,
        timeoutMs: options.discoveryTimeoutMs || 10000
      });
      const discovered = mapDiscoveryToPiSystems(catalog);
      let count = 0;
      for (const [id, sys] of discovered.entries()) {
        const existing = systems.get(id);
        const updated = {
          id,
          name: sys.name || (existing ? existing.name : id),
          canva: sys.canva || (existing ? existing.canva : ''),
          picontrol: sys.picontrol || (existing ? existing.picontrol : ''),
          mcp: sys.mcp || (existing ? existing.mcp : ''),
          venue: sys.venue !== null ? sys.venue : (existing ? existing.venue : null),
          metadata: { ...(existing?.metadata || {}), ...(sys.metadata || {}) },
          registeredAt: existing?.registeredAt || Date.now(),
          updatedAt: Date.now(),
          lastSeenAt: Date.now(),
          status: 'online',
          source: 'discovery'
        };
        systems.set(id, updated);
        if (db) saveStoredSystem(db, updated);
        count++;
      }
      lastDiscoverySyncAt = Date.now();
      lastDiscoveryError = null;
      return { ok: true, synced: count, systems: Array.from(discovered.keys()), updatedAt: lastDiscoverySyncAt };
    } catch (err) {
      lastDiscoveryError = err.message;
      console.warn(`[discovery] Failed to pull discovery catalog from ${discoveryUrl}:`, err.message);
      return { ok: false, error: err.message };
    }
  }

  if (discoveryUrl) {
    syncFromDiscovery().catch(() => {});
    if (pollIntervalSeconds > 0) {
      const timer = setInterval(() => {
        syncFromDiscovery().catch(() => {});
      }, pollIntervalSeconds * 1000);
      timer.unref?.();
    }
  }

  // Discovery status endpoint
  router.get(['/api/v1/discovery/status', '/api/v1/tunnels/discovery'], (_req, res) => {
    res.json({
      configured: Boolean(discoveryUrl),
      discoveryUrl: discoveryUrl || null,
      pollIntervalSeconds,
      lastSyncAt: lastDiscoverySyncAt,
      lastError: lastDiscoveryError,
      totalSystems: systems.size
    });
  });

  // Manually trigger a pull from the discovery service
  router.post(['/api/v1/discovery/sync', '/api/v1/tunnels/sync'], async (_req, res) => {
    const result = await syncFromDiscovery();
    res.status(result.ok ? 200 : 502).json(result);
  });

  // ---------------------------------------------------------------------------
  // Pi Self-Registration & Lifecycle Endpoints
  // ---------------------------------------------------------------------------

  // Self-register a Pi system with its tunnel targets and venue information
  router.post(['/api/v1/tunnels/register', '/api/v1/systems/register'], express.json(), (req, res) => {
    const authCheck = verifyRegistrationAuth(req, getAuthOptions());
    if (!authCheck.authorized) {
      if (authCheck.status === 401) res.set('WWW-Authenticate', 'Bearer');
      res.status(authCheck.status || 401).json({ error: authCheck.error });
      return;
    }

    const body = req.body || {};
    const id = String(body.id || body.systemId || '').trim().toLowerCase();
    if (!id || !/^[a-z0-9_-]{1,64}$/.test(id)) {
      res.status(400).json({
        error: 'Invalid or missing system id (must be 1-64 alphanumeric chars, underscores or hyphens)',
        code: 'INVALID_SYSTEM_ID'
      });
      return;
    }

    const tunnels = body.tunnels || body.ports || {};
    const canvaUrl = normalizeTunnelUrl(body.canva || body.canvaTunnelUrl || tunnels.canva || tunnels.canvaPort);
    const picontrolUrl = normalizeTunnelUrl(body.picontrol || body.picontrolTunnelUrl || tunnels.picontrol || tunnels.picontrolPort);
    const mcpUrl = normalizeTunnelUrl(body.mcp || body.picontrolMcpTunnelUrl || tunnels.mcp || tunnels.mcpPort);

    const now = Date.now();
    const existing = systems.get(id);

    const systemRecord = {
      id,
      name: String(body.name || (existing ? existing.name : id)).slice(0, 120),
      canva: canvaUrl || (existing ? existing.canva : ''),
      picontrol: picontrolUrl || (existing ? existing.picontrol : ''),
      mcp: mcpUrl || (existing ? existing.mcp : ''),
      venue: body.venue !== undefined ? body.venue : (existing ? existing.venue : null),
      metadata: body.metadata !== undefined ? body.metadata : (existing ? existing.metadata : null),
      registeredAt: existing?.registeredAt || now,
      updatedAt: now,
      lastSeenAt: now,
      status: 'online'
    };

    systems.set(id, systemRecord);
    if (db) saveStoredSystem(db, systemRecord);

    const isNew = !existing || !existing.registeredAt;
    res.status(isNew ? 201 : 200).json({
      ok: true,
      registered: true,
      system: {
        id,
        name: systemRecord.name,
        status: systemRecord.status,
        tunnels: {
          canva: systemRecord.canva || null,
          picontrol: systemRecord.picontrol || null,
          mcp: systemRecord.mcp || null
        },
        routes: {
          canva: `/pi/${id}/canva`,
          canvaApi: `/pi/${id}/api/v1/canva`,
          picontrol: `/pi/${id}/control`,
          mcp: `/pi/${id}/mcp`
        },
        venue: systemRecord.venue,
        registeredAt: systemRecord.registeredAt,
        updatedAt: systemRecord.updatedAt,
        lastSeenAt: systemRecord.lastSeenAt
      }
    });
  });

  // Heartbeat to keep status 'online' and update lastSeenAt
  router.post(['/api/v1/tunnels/heartbeat', '/api/v1/systems/:systemId/heartbeat'], express.json(), (req, res) => {
    const authCheck = verifyRegistrationAuth(req, getAuthOptions());
    if (!authCheck.authorized) {
      if (authCheck.status === 401) res.set('WWW-Authenticate', 'Bearer');
      res.status(authCheck.status || 401).json({ error: authCheck.error });
      return;
    }

    const id = String(req.params.systemId || req.body?.id || req.body?.systemId || '').trim().toLowerCase();
    const system = systems.get(id);
    if (!system) {
      res.status(404).json({ error: `Pi system '${id}' not found`, code: 'SYSTEM_NOT_FOUND' });
      return;
    }

    const now = Date.now();
    system.lastSeenAt = now;
    system.status = 'online';
    if (req.body?.venue) system.venue = req.body.venue;
    if (req.body?.metadata) system.metadata = req.body.metadata;
    system.updatedAt = now;

    if (db) saveStoredSystem(db, system);

    res.json({ ok: true, id, status: 'online', lastSeenAt: now });
  });

  // Unregister / mark offline
  router.post('/api/v1/tunnels/unregister', express.json(), (req, res) => {
    const authCheck = verifyRegistrationAuth(req, getAuthOptions());
    if (!authCheck.authorized) {
      if (authCheck.status === 401) res.set('WWW-Authenticate', 'Bearer');
      res.status(authCheck.status || 401).json({ error: authCheck.error });
      return;
    }

    const id = String(req.body?.id || req.body?.systemId || '').trim().toLowerCase();
    const system = systems.get(id);
    if (!system) {
      res.status(404).json({ error: `Pi system '${id}' not found`, code: 'SYSTEM_NOT_FOUND' });
      return;
    }

    system.status = 'offline';
    system.updatedAt = Date.now();
    if (db) saveStoredSystem(db, system);

    res.json({ ok: true, unregistered: true, id, status: 'offline' });
  });

  // Delete / purge a system registration
  router.delete(['/api/v1/systems/:systemId', '/api/v1/tunnels/register/:systemId'], (req, res) => {
    const authCheck = verifyRegistrationAuth(req, getAuthOptions());
    if (!authCheck.authorized) {
      if (authCheck.status === 401) res.set('WWW-Authenticate', 'Bearer');
      res.status(authCheck.status || 401).json({ error: authCheck.error });
      return;
    }

    const id = req.params.systemId.toLowerCase();
    if (!systems.has(id)) {
      res.status(404).json({ error: `Pi system '${id}' not found`, code: 'SYSTEM_NOT_FOUND' });
      return;
    }

    systems.delete(id);
    if (db) deleteStoredSystem(db, id);

    res.json({ ok: true, deleted: true, id });
  });

  // ---------------------------------------------------------------------------
  // Systems & Venue Query Endpoints
  // ---------------------------------------------------------------------------

  // List all registered systems with venue summary
  router.get('/api/v1/systems', (_req, res) => {
    const result = [];
    for (const [id, s] of systems.entries()) {
      result.push({
        id,
        name: s.name || id,
        status: s.status || 'online',
        tunnels: {
          canva: s.canva || null,
          picontrol: s.picontrol || null,
          mcp: s.mcp || null
        },
        hasVenue: Boolean(s.venue),
        venueSummary: s.venue?.profile || s.venue?.name || (typeof s.venue === 'string' ? s.venue : null),
        registeredAt: s.registeredAt || null,
        lastSeenAt: s.lastSeenAt || null
      });
    }
    res.json({ systems: result, defaultSystem: defaultSystemId, total: result.length });
  });

  // Get specific system with complete venue information
  router.get('/api/v1/systems/:systemId', (req, res) => {
    const id = req.params.systemId.toLowerCase();
    const s = systems.get(id);
    if (!s) {
      res.status(404).json({ error: `Pi system '${id}' not found`, code: 'SYSTEM_NOT_FOUND' });
      return;
    }
    res.json({
      id,
      name: s.name || id,
      status: s.status || 'online',
      tunnels: {
        canva: s.canva || null,
        picontrol: s.picontrol || null,
        mcp: s.mcp || null
      },
      routes: {
        canva: `/pi/${id}/canva`,
        picontrol: `/pi/${id}/control`,
        mcp: `/pi/${id}/mcp`
      },
      venue: s.venue || null,
      metadata: s.metadata || null,
      registeredAt: s.registeredAt || null,
      updatedAt: s.updatedAt || null,
      lastSeenAt: s.lastSeenAt || null
    });
  });

  // Get raw venue information of a system
  router.get('/api/v1/systems/:systemId/venue', (req, res) => {
    const id = req.params.systemId.toLowerCase();
    const s = systems.get(id);
    if (!s) {
      res.status(404).json({ error: `Pi system '${id}' not found`, code: 'SYSTEM_NOT_FOUND' });
      return;
    }
    if (!s.venue) {
      res.status(404).json({ error: `No venue information registered for Pi system '${id}'`, code: 'NO_VENUE_INFO' });
      return;
    }
    res.json(s.venue);
  });

  const buildStatusResponse = (systemFilter = null) => {
    const listSystems = systemFilter ? (systems.has(systemFilter) ? [systemFilter] : []) : Array.from(systems.keys());
    const systemsObj = {};
    for (const sysId of listSystems) {
      const cfg = systems.get(sysId);
      if (!cfg) continue;
      systemsObj[sysId] = {
        canva: {
          configured: Boolean(cfg.canva),
          target: cfg.canva || null,
          routes: [`/pi/${sysId}/canva`, `/pi/${sysId}/api/v1/canva`, `/pi/${sysId}/api/v1/graphics/canva`]
        },
        picontrol: {
          configured: Boolean(cfg.picontrol),
          target: cfg.picontrol || null,
          routes: [`/pi/${sysId}/control`, `/pi/${sysId}/picontrol`, `/pi/${sysId}/ui/api`]
        },
        picontrolMcp: {
          configured: Boolean(cfg.mcp),
          target: cfg.mcp || null,
          routes: [`/pi/${sysId}/mcp`, `/pi/${sysId}/api/v1/mcp`]
        }
      };
    }

    const defaultCfg = systems.get(defaultSystemId) || { canva: '', picontrol: '', mcp: '' };

    return {
      defaultSystem: defaultSystemId,
      totalSystems: systems.size,
      systems: systemsObj,
      // Backward compatibility fields for single-system clients
      canva: {
        configured: Boolean(defaultCfg.canva),
        target: defaultCfg.canva || null,
        routes: ['/canva', '/api/v1/canva', '/api/v1/graphics/canva']
      },
      picontrol: {
        configured: Boolean(defaultCfg.picontrol),
        target: defaultCfg.picontrol || null,
        routes: ['/control', '/picontrol', '/ui/api']
      },
      picontrolMcp: {
        configured: Boolean(defaultCfg.mcp),
        target: defaultCfg.mcp || null,
        routes: ['/mcp', '/api/v1/mcp']
      }
    };
  };

  // Status endpoints
  router.get('/api/v1/tunnels/status', (_req, res) => {
    res.json(buildStatusResponse());
  });

  router.get('/pi/:systemId/api/v1/tunnels/status', (req, res) => {
    const sysId = req.params.systemId.toLowerCase();
    if (!systems.has(sysId)) {
      res.status(404).json({
        error: `Pi system '${sysId}' is not registered`,
        code: 'UNKNOWN_PI_SYSTEM',
        availableSystems: Array.from(systems.keys())
      });
      return;
    }
    res.json(buildStatusResponse(sysId));
  });

  // Handler factory for a service
  const createServiceHandler = (serviceName, rewriteTarget, isCanva = false, timeout = timeoutMs) => {
    return (req, res) => {
      const { systemId, system } = resolveTargetSystem(req, systems, defaultSystemId);
      if (!system) {
        res.status(404).json({
          error: `Pi system '${systemId}' is not registered`,
          code: 'UNKNOWN_PI_SYSTEM',
          availableSystems: Array.from(systems.keys())
        });
        return;
      }

      const targetUrl = system[serviceName];
      if (!targetUrl) {
        const name = serviceName === 'canva' ? 'Canva' : serviceName === 'mcp' ? 'PiControl-MCP' : 'PiControl';
        const code = serviceName === 'canva' ? 'CANVA' : serviceName === 'mcp' ? 'PICONTROL_MCP' : 'PICONTROL';
        res.status(503).json({
          error: `${name} tunnel is not configured for Pi system '${systemId}'`,
          code: `${code}_TUNNEL_DISABLED`,
          systemId
        });
        return;
      }

      proxyToTunnel(req, res, targetUrl, {
        rewrite: rewriteTarget,
        timeoutMs: timeout,
        isCanva
      });
    };
  };

  const canvaHandler = createServiceHandler('canva', 'canva', true);
  const picontrolHandler = createServiceHandler('picontrol', 'picontrol', false);
  const picontrolMcpHandler = createServiceHandler('mcp', 'mcp', false, 0);

  // Standard (default system) routes
  router.all('/api/v1/canva', canvaHandler);
  router.all('/api/v1/canva/*', canvaHandler);
  router.all('/api/v1/graphics/canva', canvaHandler);
  router.all('/api/v1/graphics/canva/*', canvaHandler);
  router.all('/canva', canvaHandler);
  router.all('/canva/*', canvaHandler);

  router.all('/control', picontrolHandler);
  router.all('/control/*', picontrolHandler);
  router.all('/picontrol', picontrolHandler);
  router.all('/picontrol/*', picontrolHandler);
  router.all('/ui/api', picontrolHandler);
  router.all('/ui/api/*', picontrolHandler);

  router.all('/mcp', picontrolMcpHandler);
  router.all('/mcp/*', picontrolMcpHandler);
  router.all('/api/v1/mcp', picontrolMcpHandler);
  router.all('/api/v1/mcp/*', picontrolMcpHandler);

  // Multi-Pi system routes (/pi/:systemId/...)
  router.all('/pi/:systemId/canva', canvaHandler);
  router.all('/pi/:systemId/canva/*', canvaHandler);
  router.all('/pi/:systemId/api/v1/canva', canvaHandler);
  router.all('/pi/:systemId/api/v1/canva/*', canvaHandler);
  router.all('/pi/:systemId/api/v1/graphics/canva', canvaHandler);
  router.all('/pi/:systemId/api/v1/graphics/canva/*', canvaHandler);

  router.all('/pi/:systemId/control', picontrolHandler);
  router.all('/pi/:systemId/control/*', picontrolHandler);
  router.all('/pi/:systemId/picontrol', picontrolHandler);
  router.all('/pi/:systemId/picontrol/*', picontrolHandler);
  router.all('/pi/:systemId/ui/api', picontrolHandler);
  router.all('/pi/:systemId/ui/api/*', picontrolHandler);

  router.all('/pi/:systemId/mcp', picontrolMcpHandler);
  router.all('/pi/:systemId/mcp/*', picontrolMcpHandler);
  router.all('/pi/:systemId/api/v1/mcp', picontrolMcpHandler);
  router.all('/pi/:systemId/api/v1/mcp/*', picontrolMcpHandler);

  return router;
}
