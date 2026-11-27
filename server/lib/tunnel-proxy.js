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
 * Creates an Express router that mounts Canva, PiControl, and PiControl MCP tunnel routing.
 * @param {{
 *   canvaTunnelUrl?: string,
 *   picontrolTunnelUrl?: string,
 *   picontrolMcpTunnelUrl?: string,
 *   timeoutMs?: number
 * }} options
 * @returns {express.Router}
 */
export function createTunnelRouter(options = {}) {
  const router = express.Router();

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
  const canvaUrl = normalizeTunnelUrl(options.canvaTunnelUrl ?? process.env.CANVA_TUNNEL_URL);
  const picontrolUrl = normalizeTunnelUrl(options.picontrolTunnelUrl ?? process.env.PICONTROL_TUNNEL_URL);
  const picontrolMcpUrl = normalizeTunnelUrl(options.picontrolMcpTunnelUrl ?? process.env.PICONTROL_MCP_TUNNEL_URL);
  const timeoutMs = options.timeoutMs ?? 30000;

  // Status endpoint
  router.get('/api/v1/tunnels/status', (_req, res) => {
    res.json({
      canva: {
        configured: Boolean(canvaUrl),
        target: canvaUrl || null,
        routes: ['/canva', '/api/v1/canva', '/api/v1/graphics/canva']
      },
      picontrol: {
        configured: Boolean(picontrolUrl),
        target: picontrolUrl || null,
        routes: ['/control', '/picontrol', '/ui/api']
      },
      picontrolMcp: {
        configured: Boolean(picontrolMcpUrl),
        target: picontrolMcpUrl || null,
        routes: ['/mcp', '/api/v1/mcp']
      }
    });
  });

  // Canva routes
  const canvaHandler = (req, res) => {
    proxyToTunnel(req, res, canvaUrl, {
      rewrite: 'canva',
      timeoutMs,
      isCanva: true
    });
  };

  router.all('/api/v1/canva', canvaHandler);
  router.all('/api/v1/canva/*', canvaHandler);
  router.all('/api/v1/graphics/canva', canvaHandler);
  router.all('/api/v1/graphics/canva/*', canvaHandler);
  router.all('/canva', canvaHandler);
  router.all('/canva/*', canvaHandler);

  // PiControl routes
  const picontrolHandler = (req, res) => {
    proxyToTunnel(req, res, picontrolUrl, {
      rewrite: 'picontrol',
      timeoutMs
    });
  };

  router.all('/control', picontrolHandler);
  router.all('/control/*', picontrolHandler);
  router.all('/picontrol', picontrolHandler);
  router.all('/picontrol/*', picontrolHandler);
  router.all('/ui/api', picontrolHandler);
  router.all('/ui/api/*', picontrolHandler);

  // PiControl MCP routes
  const picontrolMcpHandler = (req, res) => {
    proxyToTunnel(req, res, picontrolMcpUrl, {
      rewrite: 'mcp',
      timeoutMs: 0 // MCP streams can be long-lived
    });
  };

  router.all('/mcp', picontrolMcpHandler);
  router.all('/mcp/*', picontrolMcpHandler);
  router.all('/api/v1/mcp', picontrolMcpHandler);
  router.all('/api/v1/mcp/*', picontrolMcpHandler);

  return router;
}
