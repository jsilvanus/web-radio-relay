/**
 * Discovery Client for Tunnus Service Discovery & Registry.
 *
 * Integrates with @tunnus/discovery:
 * 1. Pi Gateways self-register with Tunnus as Pi systems with their loop-bound SSH tunnel ports.
 * 2. Media Relay pulls the discovery catalog, resolves the Pi systems and their tunnel ports,
 *    and establishes reverse proxy routing (/pi/:systemId/canva, /control, /mcp).
 * 3. Media Relay advertises and self-registers itself in Tunnus as a 'media-relay',
 *    updating its discovery record with all currently relayed venues and public endpoints.
 */

import {
  fetchDiscoveryCatalog as tunnusFetchCatalog,
  createDiscoveryClient,
  SERVICE_TYPES,
  normalizeLocalPortUrl as tunnusNormalizeLocalPortUrl,
} from '@tunnus/discovery';
import { normalizeTunnelUrl } from './tunnel-proxy.js';

/**
 * Normalizes a port or URL to a Docker host-reachable URL (host.docker.internal).
 * Converts local ports or 127.0.0.1 addresses to host.docker.internal:<port>.
 *
 * @param {string|number|undefined} value
 * @returns {string}
 */
export function normalizeLocalPortUrl(value) {
  const normalized = tunnusNormalizeLocalPortUrl(value);
  if (typeof normalized === 'string' && normalized.endsWith('/') && !normalized.endsWith('://')) {
    try {
      const u = new URL(normalized);
      if (u.pathname === '/') return normalized.slice(0, -1);
    } catch {}
  }
  return normalized;
}

export { tunnusFetchCatalog, createDiscoveryClient, SERVICE_TYPES };

/**
 * Extracts Pi systems, venue profiles, and loop-bound tunnels from a Tunnus Discovery response.
 *
 * Pi Gateways advertise that they are the Pi systems (type: 'pi-system', 'pigateway', etc.)
 * with their SSH tunnel port. The media-relay routes Canva, PiControl, and MCP into that tunnel.
 *
 * @param {object} discoveryData { services: [...] }
 * @returns {Map<string, { id: string, name: string, canva: string, picontrol: string, mcp: string, venue: object|null, metadata: object|null, status: string, updatedAt: number }>}
 */
export function mapDiscoveryToPiSystems(discoveryData) {
  const systems = new Map();
  const services = Array.isArray(discoveryData?.services) ? discoveryData.services : [];

  for (const svc of services) {
    if (!svc || typeof svc !== 'object') continue;

    // Do not treat media-relay itself as a downstream Pi system
    const svcType = String(svc.type || '').toLowerCase();
    const svcId = String(svc.id || '').toLowerCase();
    if (svcType === 'media-relay' || svcId === 'media-relay') continue;

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
        status: svc.disabled ? 'offline' : 'online',
        updatedAt: Date.now(),
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

    // Determine the base tunnel port/URL for the Pi system
    // Pi systems advertise their reverse SSH tunnel port via endpoint_url or metadata.tunnel_port
    let baseTunnelUrl = '';
    const rawEndpoint = svc.endpoint_url || svc.url;
    if (rawEndpoint) {
      baseTunnelUrl = normalizeLocalPortUrl(rawEndpoint);
    }
    const metaTunnelPort =
      svc.metadata?.tunnel_port ||
      svc.metadata?.ssh_tunnel_port ||
      svc.metadata?.port;
    if (metaTunnelPort) {
      baseTunnelUrl = normalizeLocalPortUrl(metaTunnelPort);
    }

    // Default: The Pi system's tunnel hosts Canva, PiControl, and PiControl-MCP
    if (baseTunnelUrl) {
      if (!sys.canva) sys.canva = baseTunnelUrl;
      if (!sys.picontrol) sys.picontrol = baseTunnelUrl;
      if (!sys.mcp) sys.mcp = baseTunnelUrl;
    }

    // Check for explicit separate port overrides in metadata (if provided)
    const metaTunnels = svc.metadata?.tunnels || svc.metadata?.ports || svc.metadata?.tunnel_ports || {};
    if (metaTunnels.canva || metaTunnels.canvaPort || svc.metadata?.canva_port) {
      sys.canva = normalizeLocalPortUrl(metaTunnels.canva || metaTunnels.canvaPort || svc.metadata?.canva_port);
    }
    if (metaTunnels.picontrol || metaTunnels.picontrolPort || metaTunnels.control || svc.metadata?.picontrol_port) {
      sys.picontrol = normalizeLocalPortUrl(
        metaTunnels.picontrol || metaTunnels.picontrolPort || metaTunnels.control || svc.metadata?.picontrol_port,
      );
    }
    if (metaTunnels.mcp || metaTunnels.mcpPort || metaTunnels.picontrolMcp || svc.metadata?.mcp_port) {
      sys.mcp = normalizeLocalPortUrl(
        metaTunnels.mcp || metaTunnels.mcpPort || metaTunnels.picontrolMcp || svc.metadata?.mcp_port,
      );
    }

    // Direct service type matching fallback
    if (svcType === 'piprogram' || svcType === 'canva') {
      if (rawEndpoint) sys.canva = normalizeLocalPortUrl(rawEndpoint);
    } else if (svcType === 'picontrol' || svcType === 'control') {
      if (rawEndpoint) sys.picontrol = normalizeLocalPortUrl(rawEndpoint);
    } else if (svcType === 'mcp' || svcType === 'picontrol-mcp') {
      if (rawEndpoint) sys.mcp = normalizeLocalPortUrl(rawEndpoint);
    }
  }

  return systems;
}

/**
 * Builds the media-relay registration payload for Tunnus Discovery.
 *
 * @param {object} options
 * @param {Map<string, object>} systemsMap Currently active Pi systems
 * @param {string} defaultSystemId
 * @returns {object} Discovery service declaration
 */
export function buildMediaRelayRegistrationPayload(options = {}, systemsMap = new Map(), defaultSystemId = 'keskuskirkko') {
  const publicBaseUrl = (
    options.publicUrl ||
    process.env.PUBLIC_URL ||
    `https://${process.env.DOMAIN || 'media.riihimaenseurakunta.fi'}${
      process.env.DOMAIN_PATH && process.env.DOMAIN_PATH !== '/' ? process.env.DOMAIN_PATH : ''
    }`
  ).replace(/\/+$/, '');

  const venuesObj = {};
  for (const [id, s] of systemsMap.entries()) {
    venuesObj[id] = {
      name: s.name || id,
      canva_url: `${publicBaseUrl}/pi/${id}/canva`,
      control_url: `${publicBaseUrl}/pi/${id}/control`,
      mcp_url: `${publicBaseUrl}/pi/${id}/mcp`,
      status: s.status || 'online',
      has_venue_profile: Boolean(s.venue),
      updated_at: s.updatedAt || Date.now(),
    };
  }

  return {
    id: options.serviceId || process.env.DISCOVERY_SERVICE_ID || 'media-relay',
    name: options.serviceName || process.env.DISCOVERY_SERVICE_NAME || 'Media Relay (Web Radio Relay & Tunnel Router)',
    type: 'media-relay',
    venue: options.venue || process.env.DISCOVERY_VENUE || 'parish-wide',
    endpoint_url: publicBaseUrl,
    capabilities: [
      'audio_relay',
      'hls_streaming',
      'pi_tunnel_router',
      'canva_proxy',
      'picontrol_proxy',
      'mcp_proxy',
    ],
    metadata: {
      relayed_systems: Array.from(systemsMap.keys()),
      venues: venuesObj,
      routes: {
        canva: '/pi/:systemId/canva',
        control: '/pi/:systemId/control',
        mcp: '/pi/:systemId/mcp',
      },
      default_system: defaultSystemId,
      stream_url: `${publicBaseUrl}/hls/stream.m3u8`,
      updated_at: new Date().toISOString(),
    },
    auth: {
      type: 'bearer',
      header_name: 'Authorization',
    },
    disabled: false,
  };
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
  timeoutMs = 10000,
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
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Discovery service returned HTTP ${res.status} from ${discoveryUrl}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registers or updates the media-relay service declaration in Tunnus Discovery.
 * Supports OIDC Basic Auth (clientId:clientSecret) or Bearer token.
 *
 * @param {{
 *   discoveryUrl: string,
 *   payload: object,
 *   clientId?: string,
 *   clientSecret?: string,
 *   token?: string,
 *   fetchImpl?: typeof fetch
 * }} options
 * @returns {Promise<object>}
 */
export async function registerMediaRelayService({
  discoveryUrl,
  payload,
  clientId = '',
  clientSecret = '',
  token = '',
  fetchImpl = fetch,
} = {}) {
  if (!discoveryUrl) return { ok: false, error: 'discoveryUrl is required' };

  const baseUrl = discoveryUrl.replace(/\/api\/v1\/discovery\/?$/, '').replace(/\/+$/, '');
  const serviceId = encodeURIComponent(payload.id || 'media-relay');
  const endpoint = `${baseUrl}/api/v1/discovery/services/${serviceId}`;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (clientId && clientSecret) {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${creds}`;
  } else if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetchImpl(endpoint, {
    method: 'PUT',
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Failed to register media-relay service at ${endpoint} (${res.status}): ${errText}`);
  }

  return await res.json();
}
