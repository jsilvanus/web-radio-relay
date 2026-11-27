/**
 * Discovery Client for pulling registered edge Pi systems from Tunnus / OIDC discovery service.
 *
 * Pi applications self-register with Tunnus (/api/v1/discovery/services).
 * This service pulls the registered services, extracts their venue information and
 * local loop-bound SSH tunnel ports, and registers them into the relay's routing table.
 */

import { normalizeTunnelUrl } from './tunnel-proxy.js';

/**
 * Normalizes a port or URL to a Docker host-reachable URL (host.docker.internal).
 * Converts local ports or 127.0.0.1 addresses to host.docker.internal:<port>.
 *
 * @param {string|number|undefined} value
 * @returns {string}
 */
export function normalizeLocalPortUrl(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    return `http://host.docker.internal:${String(value).trim()}`;
  }
  const str = String(value).trim();
  try {
    const parsed = new URL(str);
    // If it's a loop-bound address on the VPS, Docker container reaches it via host.docker.internal
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      const port = parsed.port ? `:${parsed.port}` : '';
      return `${parsed.protocol}//host.docker.internal${port}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    }
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return normalizeTunnelUrl(value);
  }
}

/**
 * Extracts Pi systems, venue profiles, and loop-bound tunnels from a Tunnus Discovery response.
 *
 * @param {object} discoveryData { services: [...] }
 * @returns {Map<string, { id: string, name: string, canva: string, picontrol: string, mcp: string, venue: object|null, metadata: object|null, status: string, updatedAt: number }>}
 */
export function mapDiscoveryToPiSystems(discoveryData) {
  const systems = new Map();
  const services = Array.isArray(discoveryData?.services) ? discoveryData.services : [];

  for (const svc of services) {
    if (!svc || typeof svc !== 'object') continue;

    // Use venue as the system ID (e.g. 'keskuskirkko', 'kappeli') or fall back to svc.id
    const rawId = String(svc.venue || svc.id || '').trim().toLowerCase();
    const systemId = rawId.replace(/[^a-z0-9_-]/g, '-');
    if (!systemId) continue;

    if (!systems.has(systemId)) {
      systems.set(systemId, {
        id: systemId,
        name: svc.venue_name || svc.name || systemId,
        canva: '',
        picontrol: '',
        mcp: '',
        venue: null,
        metadata: {},
        status: 'online',
        updatedAt: Date.now()
      });
    }

    const sys = systems.get(systemId);

    // Extract venue profile
    if (svc.metadata?.venue) {
      sys.venue = svc.metadata.venue;
    } else if (svc.metadata?.venue_profile) {
      sys.venue = svc.metadata.venue_profile;
    } else if (svc.venue && (!sys.venue || typeof sys.venue !== 'object')) {
      sys.venue = { venue: svc.venue, name: svc.name, serviceId: svc.id };
    }

    // Extract metadata
    if (svc.metadata && typeof svc.metadata === 'object') {
      sys.metadata = { ...sys.metadata, ...svc.metadata };
    }

    // 1. Check for explicit tunnel mapping in metadata
    const metaTunnels = svc.metadata?.tunnels || svc.metadata?.ports || svc.metadata?.tunnel_ports || {};
    if (metaTunnels.canva || metaTunnels.canvaPort) {
      sys.canva = normalizeLocalPortUrl(metaTunnels.canva || metaTunnels.canvaPort);
    }
    if (metaTunnels.picontrol || metaTunnels.picontrolPort || metaTunnels.control) {
      sys.picontrol = normalizeLocalPortUrl(metaTunnels.picontrol || metaTunnels.picontrolPort || metaTunnels.control);
    }
    if (metaTunnels.mcp || metaTunnels.mcpPort || metaTunnels.picontrolMcp) {
      sys.mcp = normalizeLocalPortUrl(metaTunnels.mcp || metaTunnels.mcpPort || metaTunnels.picontrolMcp);
    }

    // 2. Direct service type and endpoint mapping
    const type = String(svc.type || '').toLowerCase();
    const endpoint = svc.endpoint_url || svc.url;

    if (type === 'piprogram' || type === 'canva') {
      if (!sys.canva && endpoint) sys.canva = normalizeLocalPortUrl(endpoint);
    } else if (type === 'picontrol' || type === 'control') {
      if (!sys.picontrol && endpoint) sys.picontrol = normalizeLocalPortUrl(endpoint);
    } else if (type === 'mcp' || type === 'picontrol-mcp') {
      if (!sys.mcp && endpoint) sys.mcp = normalizeLocalPortUrl(endpoint);
    } else if (type === 'pigateway' || type === 'piecosystem') {
      if (svc.metadata?.canva_port) sys.canva = normalizeLocalPortUrl(svc.metadata.canva_port);
      if (svc.metadata?.picontrol_port) sys.picontrol = normalizeLocalPortUrl(svc.metadata.picontrol_port);
      if (svc.metadata?.mcp_port) sys.mcp = normalizeLocalPortUrl(svc.metadata.mcp_port);
    }
  }

  return systems;
}

/**
 * Fetches services from Tunnus / OIDC discovery endpoint.
 *
 * @param {{
 *   discoveryUrl: string,
 *   token?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number
 * }} options
 * @returns {Promise<object>}
 */
export async function fetchDiscoveryCatalog({
  discoveryUrl,
  token = '',
  fetchImpl = fetch,
  timeoutMs = 10000
} = {}) {
  if (!discoveryUrl) return null;

  const headers = { Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(discoveryUrl, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`Discovery service returned HTTP ${res.status} from ${discoveryUrl}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
