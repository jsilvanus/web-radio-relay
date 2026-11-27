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

/**
 * Validates and normalizes a tunnel URL (must be http or https).
 * @param {string|undefined} value
 * @returns {string}
 */
export function normalizeTunnelUrl(value) {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  if (!text) return '';
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
  const { defaultSystemId, systems } = parsePiSystems(options);
  const timeoutMs = options.timeoutMs ?? 30000;

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
