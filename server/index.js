/**
 * web radio relay — status, listener delay, captions and archive API
 *
 * Public (listeners, widget):
 *   GET  /api/status                 live state, delay, delayed stream URL
 *   GET  /api/archive                archived MP3 recordings (newest first)
 *   GET  /api/stats                  aggregate anonymous play/session statistics
 *   POST /api/stats/event            play event from the widget
 *   GET  /api/hls/delayed.m3u8       live audio playlist, delayed server side
 *   GET  /api/streams/{s}/hls/video/delayed.m3u8   live video playlist, delayed the same way
 *   GET  /api/streams/{s}/hls/master.m3u8          master: delayed video + subtitle renditions
 *   GET  /api/streams/{s}/hls/subs/{lang}.m3u8     subtitle playlist (one VTT per video segment)
 *   GET  /api/streams/{s}/hls/subs/{lang}/{seq}.vtt  WebVTT captions of one video segment
 *   GET  /api/captions               captions released for listeners (?lang=&from=&limit=)
 *   GET  /api/openapi.json           the OpenAPI document of this API
 *   GET  /listen                     listener page: audio plus captions
 *   GET  /view/{key}                 church visitors' caption page (live, phone first)
 *   GET  /embed/viewer?key=          caption-only overlay for an iframe
 *   GET  /watch?stream=              delayed video player with the viewer panels
 *   GET  /api/v1/viewer/{key}        LCYT-compatible viewer SSE (?mode=live|delayed), public, CORS *
 *
 * Control (Bearer RELAY_API_TOKEN, see docs/API.md):
 *   POST /api/v1/captions            sender pushes timed captions (and later translations)
 *   POST /api/v1/streams/{s}/events  push timeline events (batch of up to 100, see README)
 *   GET  /api/v1/captions/source     status of the pigateway pull (GATEWAY_EVENTS_URL), incl. mapper stats
 *   GET  /api/v1/delay               read the listener delay
 *   PUT  /api/v1/delay               set the listener delay (0 .. DELAY_MAX_SECONDS)
 *   POST /api/v1/stats/session       stream session start/end (shell scripts)
 *   POST /api/v1/tokens              admin: issue a scoped token (value shown once)
 *   GET  /api/v1/tokens              admin: list tokens (never the values)
 *   DELETE /api/v1/tokens/:id        admin: revoke a token
 *   GET    /api/v1/streams/{s}/destinations            list egress destinations with their state (control scope)
 *   POST   /api/v1/streams/{s}/destinations            add a destination (key stored encrypted)
 *   PATCH  /api/v1/streams/{s}/destinations/{id}       change a destination
 *   DELETE /api/v1/streams/{s}/destinations/{id}       remove a destination (stops its egress)
 *   POST   /api/v1/streams/{s}/destinations/{id}/start start one egress child
 *   POST   /api/v1/streams/{s}/destinations/{id}/stop  stop one egress child
 *   GET  /api/v1/streams/{s}/captioner  CEA-608 embedder status and config (scope stream:<s>:control)
 *   PUT  /api/v1/streams/{s}/captioner  configure/start/stop the CEA-608 embedder
 *   GET  /api/v1/streams/{s}/config  per-stream config (scope stream:<s>:control)
 *   PUT  /api/v1/streams/{s}/config  set part of it: visibleLanguages, radio, videoHls, recordOnLive, publicGraphics, viewerKey
 *   POST   /api/v1/streams/{s}/recordings             start recording the stream to S3 (202, needs S3)
 *   DELETE /api/v1/streams/{s}/recordings/current     stop it: uploads the rest, writes session.json
 *   GET    /api/v1/streams/{s}/recordings/{id}/handoff  Saarnavideo handoff manifest with fresh presigned URLs
 *   GET    /api/v1/streams/{s}/recordings             recordings of the stream from the database
 *
 * Internal (not in openapi.json, not proxied by nginx):
 *   POST /internal/mediamtx/auth     MediaMTX authMethod http hook
 *   POST /internal/publish-auth      nginx-rtmp on_publish hook
 *   POST /internal/mediamtx/ready    MediaMTX runOnReady (radio pull, probe, destinations, video HLS, recording)
 *   POST /internal/mediamtx/notready MediaMTX runOnNotReady (stops all of them; the recording uploads the rest)
 *
 * Environment variables:
 *   PORT                     Port to listen on                          (default: 3000)
 *   RELAY_API_TOKEN          Bearer token for /api/v1 (unset = control API answers 503 unless a stored token exists)
 *   HOOK_SECRET              Secret for the /internal hooks (?secret= or x-hook-secret); unset = hooks answer 503
 *   RADIO_ON_READY           "off" keeps MediaMTX ready hooks from starting the radio pull (default: on)
 *   RADIO_SOURCE_URL_TEMPLATE  Input URL of the radio pull and the probe, with {name} (default: unset = no radio)
 *   PUBLISH_AUTH             "on" makes /internal/publish-auth check tokens; anything else allows all (default: off)
 *   RELAY_INTERNAL_CIDRS     IPv4 CIDRs whose reads need no token (default: 172.16.0.0/12,10.0.0.0/8,127.0.0.0/8)
 *   RELAY_DB_PATH            SQLite database file (default: /var/lib/relay/relay.db)
 *   ASSET_DIR                Image asset directory when S3 is unset     (default: /var/lib/relay/assets)
 *   S3_ENDPOINT, S3_BUCKET   Store image assets in S3 (see README)      (default: unset = local ASSET_DIR)
 *   S3_PUBLIC_ENDPOINT, HANDOFF_URL_TTL_SECONDS, RELAY_NAME  Handoff manifest URLs and instance name (see README)
 *   RECORDING_SPOOL_DIR      Local spool for recorder segments           (default: /var/lib/relay/spool)
 *   RECORDING_SPOOL_MAX_BYTES  Spool size above which recordings are degraded (default: 2 GiB)
 *   DELAY_SECONDS            Listener delay for audio and captions     (default: 0)
 *   DELAY_MAX_SECONDS        Largest delay the API accepts; sizes the ffmpeg playlist (default: 60)
 *   HLS_SEGMENT_PREFIX       URL prefix of segment files in playlists  (default: /hls/)
 *   CAPTION_RETENTION_SECONDS  How long captions stay in memory        (default: 3600)
 *   GATEWAY_EVENTS_URL       Base URL of pigateway; captions are pulled from its SSE bus (default: unset / disabled)
 *   GATEWAY_TOKEN            Bearer token for the gateway                (default: unset)
 *   GATEWAY_CAPTION_STREAM   Stream that receives the gateway captions   (default: DEFAULT_STREAM)
 *   RELAY_DB_PATH            SQLite file for the timeline events; ':memory:' for tests (default: /var/lib/relay/relay.db)
 *   HLS_DIR                  Directory containing stream.m3u8           (default: /var/www/radio/hls)
 *   ARCHIVE_DIR              Directory containing archived MP3s         (default: /var/www/radio/archive)
 *   HIDDEN_ARCHIVE_DIR       Directory for hidden (aged-out) archives   (default: /var/www/radio/hidden_archive)
 *   STALE_MS                 ms after which a manifest is stale         (default: 30000)
 *   DEFAULT_STREAM           Stream used by the legacy routes without a name (default: stream)
 *   ARCHIVE_URL_PREFIX       URL prefix for archive MP3 links           (default: /archive)
 *   ARCHIVE_AGE_DAYS         Move recordings to hidden archive after N days (0 = disabled, default: 0)
 *   HIDDEN_ARCHIVE_DELETE_DAYS  Delete from hidden archive after N days (0 = disabled, default: 0)
 *   STATS_FILE               Path to the JSON stats file                (default: /var/www/radio/stats/stats.json)
 *   STATS_SESSION_DAYS       Days of session history to retain          (default: 90)
 *   EMAIL_PROVIDER           Email provider: sendgrid | mailgun         (default: unset / disabled)
 *   EMAIL_TO                 Recipient address for monthly report
 *   EMAIL_FROM               Sender address for monthly report
 *   SENDGRID_API_KEY         SendGrid API key (EMAIL_PROVIDER=sendgrid)
 *   MAILGUN_API_KEY          Mailgun API key  (EMAIL_PROVIDER=mailgun)
 *   MAILGUN_DOMAIN           Mailgun domain   (EMAIL_PROVIDER=mailgun)
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { requireBearer, requireScope, tokensEqual } from './lib/auth.js';
import { openStore } from './lib/store.js';
import { createToken, findTokenByValue, listTokens, revokeToken, validateTokenRequest } from './lib/tokens.js';
import { decide } from './lib/mediamtx-auth.js';
import { createS3Client, s3ConfigFromEnv } from './lib/s3.js';
import { createAssetStore } from './lib/assets.js';
import { registerAssetRoutes } from './lib/asset-routes.js';
import { buildDelayedPlaylist, parseMediaPlaylist } from './lib/hls-delay.js';
import {
  CUE_LOOKBACK_MS, isSubtitleLang, masterPlaylist, segmentSeq, subsPlaylist, vttForSegment,
} from './lib/vtt-segments.js';
import { validateCaptionBody } from './lib/captions.js';
import { isValidStreamName, StreamRegistry } from './lib/streams.js';
import { StreamSupervisor } from './lib/stream-supervisor.js';
import { createReadyHandler } from './lib/ready-hooks.js';
import { createProbeService } from './lib/probe-service.js';
import { createCaptionerService } from './lib/captioner-service.js';
import { GatewayCaptions } from './lib/gateway-captions.js';
import { createGatewayMapper } from './lib/gateway-map.js';
import { addEvents, rangeEvents, eventsAfterId, maxEventId } from './lib/event-store.js';
import { createEventBus, storeAndPublish } from './lib/event-bus.js';
import { openViewerSession, closeViewerSessions, VIEWER_MODES } from './lib/viewer-sse.js';
import { EgressSupervisor } from './lib/egress-supervisor.js';
import { createRecordingService, reconcileInterruptedRecordings } from './lib/recording-service.js';
import { createRecordingRouter } from './lib/recording-routes.js';
import { HlsPackager } from './lib/hls-packager.js';
import { listSizeFor } from './lib/hls-args.js';
import {
  DEFAULT_MAX_DESTINATIONS, createDestination, deleteDestination, destinationExists, listDestinations,
  loadEgressTarget, startableDestinationIds, updateDestination,
} from './lib/destinations.js';
import { DEFAULT_RTSP_BASE } from './lib/ffmpeg-input.js';
import { validateEventBatch } from './lib/events.js';
import { getConfig, putConfig, resolveViewerStream, StreamConfigError, VIEWER_KEY } from './lib/stream-config.js';
import { createLateCounter, markLateTranslations } from './lib/translation-ingest.js';
import { createTunnelRouter } from './lib/tunnel-proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const HLS_DIR = process.env.HLS_DIR || '/var/www/radio/hls';
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || '/var/www/radio/archive';
const HIDDEN_ARCHIVE_DIR = process.env.HIDDEN_ARCHIVE_DIR || '/var/www/radio/hidden_archive';
/** If the HLS manifest hasn't been updated in this many ms, the stream is stale */
const STALE_MS = Number(process.env.STALE_MS) || 30_000;
/** Public URL for the HLS stream — returned in the /api/status payload */
/** URL prefix used to build archive download links returned by /api/archive */
const ARCHIVE_URL_PREFIX = (process.env.ARCHIVE_URL_PREFIX || '/archive').replace(/\/$/, '');
/** Move MP3s older than this many days from ARCHIVE_DIR to HIDDEN_ARCHIVE_DIR; 0 = disabled */
const ARCHIVE_AGE_DAYS = Number(process.env.ARCHIVE_AGE_DAYS) || 0;
/** Delete MP3s from HIDDEN_ARCHIVE_DIR after this many days; 0 = disabled */
const HIDDEN_ARCHIVE_DELETE_DAYS = Number(process.env.HIDDEN_ARCHIVE_DELETE_DAYS) || 0;

/** Absolute path to the JSON file that stores anonymous aggregate stats */
const STATS_FILE = process.env.STATS_FILE || '/var/www/radio/stats/stats.json';
/** Maximum age (days) for stream-session history kept in stats.json */
const STATS_SESSION_DAYS = Number(process.env.STATS_SESSION_DAYS) || 90;
/** Bearer token for the control API (/api/v1). Unset = control routes answer 503. */
const RELAY_API_TOKEN = process.env.RELAY_API_TOKEN || '';
/** Secret for /internal/* hooks. Also the internal secret that `-cc` captioner publishes must present. */
const HOOK_SECRET = process.env.HOOK_SECRET || '';
/** When not "on", /internal/publish-auth answers 200 for every publish (default). */
const PUBLISH_AUTH_ON = process.env.PUBLISH_AUTH === 'on';
const RELAY_INTERNAL_CIDRS = (process.env.RELAY_INTERNAL_CIDRS || '172.16.0.0/12,10.0.0.0/8,127.0.0.0/8')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/** SQLite store: streams, scoped tokens, destinations, recordings, events */
const store = openStore();
const db = store.db;
/** Directory for image assets when S3 is not configured (S3 wins when S3_ENDPOINT and S3_BUCKET are set) */
const ASSET_DIR = process.env.ASSET_DIR || '/var/lib/relay/assets';
const s3Config = s3ConfigFromEnv(process.env);
/** One S3 client for assets and recordings; null when S3 is not configured. */
const s3Client = s3Config ? createS3Client(s3Config) : null;
const assetStore = createAssetStore({ s3: s3Client, dir: ASSET_DIR });

/** Upstream reverse-SSH tunnel target for Canva application (e.g. http://host.docker.internal:3010) */
const CANVA_TUNNEL_URL = process.env.CANVA_TUNNEL_URL || '';
/** Upstream reverse-SSH tunnel target for PiControl operator UI and API (e.g. http://host.docker.internal:3012) */
const PICONTROL_TUNNEL_URL = process.env.PICONTROL_TUNNEL_URL || '';
/** Upstream reverse-SSH tunnel target for PiControl MCP server (e.g. http://host.docker.internal:3601) */
const PICONTROL_MCP_TUNNEL_URL = process.env.PICONTROL_MCP_TUNNEL_URL || '';

/** Stream used by the legacy routes (/api/status, /api/captions, /api/hls/...) */
const DEFAULT_STREAM = process.env.DEFAULT_STREAM || 'stream';
/** Largest listener delay the API accepts; also sizes the ffmpeg playlist (on-publish.sh) */
const DELAY_MAX_SECONDS = Math.max(0, Number(process.env.DELAY_MAX_SECONDS ?? 60));
/** Initial listener delay for every stream; changed per stream through the control API */
const INITIAL_DELAY_SECONDS = Math.min(DELAY_MAX_SECONDS, Math.max(0, Number(process.env.DELAY_SECONDS ?? 0)));
/** URL prefix of segment files in playlists; segments live in <prefix><stream>/ */
const HLS_SEGMENT_PREFIX = process.env.HLS_SEGMENT_PREFIX || '/hls/';
/** How long captions are kept in memory */
const CAPTION_RETENTION_SECONDS = Math.max(60, Number(process.env.CAPTION_RETENTION_SECONDS ?? 3600));
/** Delay and captions for every stream, keyed by stream name */
const streams = new StreamRegistry({
  defaultDelaySeconds: INITIAL_DELAY_SECONDS,
  maxDelaySeconds: DELAY_MAX_SECONDS,
});
/** In-process fan-out of stored timeline events to the viewer SSE (P7.5) */
const eventBus = createEventBus();
/** Translations stored after their release time (P8), per stream; exposed in /metrics. */
const lateTranslations = createLateCounter();
/**
 * Store timeline events of one stream and publish them (gateway pull and push route). A translation that
 * arrived after startedAt + the stream's current delay is stored with payload.late and counted (P8).
 */
function storeStreamEvents(stream, events, nowMs) {
  markLateTranslations(events, { delayMs: streams.delayOf(stream) * 1000, nowMs });
  const before = maxEventId(db);
  const result = storeAndPublish(db, eventBus, stream, events, nowMs);
  if (result.added > 0) {
    lateTranslations.add(stream, eventsAfterId(db, stream, before).filter((r) => r.type === 'translation' && r.payload.late).length);
  }
  return result;
}
/** Captions pulled from pigateway's SSE bus; disabled when GATEWAY_EVENTS_URL is unset */
const GATEWAY_EVENTS_URL = process.env.GATEWAY_EVENTS_URL || '';
const GATEWAY_CAPTION_STREAM = process.env.GATEWAY_CAPTION_STREAM || DEFAULT_STREAM;
const gatewayCaptions = new GatewayCaptions({
  baseUrl: isValidStreamName(GATEWAY_CAPTION_STREAM) ? GATEWAY_EVENTS_URL : '',
  token: process.env.GATEWAY_TOKEN || '',
  stream: GATEWAY_CAPTION_STREAM,
  streams,
  retentionSeconds: CAPTION_RETENTION_SECONDS,
  log: (msg) => console.log(`[gateway-captions] ${msg}`),
  mapper: createGatewayMapper(),
  storeEvents: (stream, events, nowMs) => storeStreamEvents(stream, events, nowMs),
});
/** Input URL of the radio pull and of the probe, with {name}. Deployment config only. */
const RADIO_SOURCE_URL_TEMPLATE = process.env.RADIO_SOURCE_URL_TEMPLATE || '';
/** "off" keeps the MediaMTX ready hook from starting the radio pull (the probe still runs). */
const RADIO_ON_READY = (process.env.RADIO_ON_READY ?? 'on').trim().toLowerCase() !== 'off';
const supervisor = new StreamSupervisor({
  hlsDir: HLS_DIR, archiveDir: ARCHIVE_DIR,
  logDir: process.env.LOG_DIR || '/var/log/tuberadio',
  sourceTemplate: RADIO_SOURCE_URL_TEMPLATE, staleMs: STALE_MS,
  onSession: (name, event, timestamp) => { if (event === 'start') recordSessionStart(name, timestamp); else recordSessionEnd(name, timestamp); }
});
/** Last ffprobe result per stream (in memory); empty when RADIO_SOURCE_URL_TEMPLATE is unset. */
const probeService = createProbeService({
  spawnProcess: spawn,
  urlFor: (name) => RADIO_SOURCE_URL_TEMPLATE.replaceAll('{name}', name),
  log: (msg) => console.log(`[probe] ${msg}`),
});

/** Captioner probes its raw MediaMTX input independently of the optional radio pull URL. */
const CAPTIONER_RTSP_BASE = process.env.MEDIAMTX_RTSP_BASE || DEFAULT_RTSP_BASE;
const CAPTIONER_RTMP_BASE = process.env.MEDIAMTX_RTMP_BASE || 'rtmp://mediamtx:1935';
const CAPTIONER_RTSP_ROOT = CAPTIONER_RTSP_BASE.endsWith('/') ? CAPTIONER_RTSP_BASE.slice(0, -1) : CAPTIONER_RTSP_BASE;
const captionerProbeService = createProbeService({
  spawnProcess: spawn,
  urlFor: (name) => `${CAPTIONER_RTSP_ROOT}/live/${name}`,
  log: (msg) => console.log(`[captioner-probe] ${msg}`),
});

// Clear both probe caches on not-ready; a reconnect may change the source codec or frame rate.
const readyHookProbe = {
  probe: (name) => probeService.probe(name),
  clear: (name) => { probeService.clear(name); captionerProbeService.clear(name); },
};

/** Live CEA-608 embedder: raw RTSP -> FLV/Node SEI edit -> captioned RTMP variant. */
const captionerService = createCaptionerService({
  spawnProcess: spawn,
  getProbe: (name) => captionerProbeService.get(name),
  probe: (name) => captionerProbeService.probe(name),
  bus: eventBus,
  rtspBase: CAPTIONER_RTSP_BASE,
  rtmpBase: CAPTIONER_RTMP_BASE,
  secret: HOOK_SECRET,
  defaultHoldSeconds: Number(process.env.CAPTION_HOLD_SECONDS) || 16,
  defaultSyncOffsetMs: Number(process.env.CAPTION_SYNC_OFFSET_MS ?? 1500),
  log: (msg) => console.log(`[captioner] ${msg}`),
});
/** Secret key (64 hex) that seals destination stream keys at rest. Unset = keys cannot be stored (503). */
const RELAY_SECRET_KEY = process.env.RELAY_SECRET_KEY || '';
/** Most destinations one stream may have (P4.1). */
const MAX_DESTINATIONS_PER_STREAM = (() => {
  const n = Number(process.env.MAX_DESTINATIONS_PER_STREAM);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_DESTINATIONS;
})();
/** One ffmpeg child per (stream, destination), pushing copies of the relay's streams to RTMP(S) (P4.3). */
const egress = new EgressSupervisor({
  rtspBase: process.env.MEDIAMTX_RTSP_BASE || DEFAULT_RTSP_BASE,
  spawnProcess: spawn,
});

/** Local spool of the recorder segments (P5.3); each closed segment is uploaded to S3 and removed from here. */
const RECORDING_SPOOL_DIR = process.env.RECORDING_SPOOL_DIR || '/var/lib/relay/spool';
/** Spool size above which recordings are marked degraded (nothing unuploaded is deleted). */
const RECORDING_SPOOL_MAX_BYTES = (() => {
  const n = Number(process.env.RECORDING_SPOOL_MAX_BYTES);
  return Number.isInteger(n) && n > 0 ? n : 2 * 1024 ** 3;
})();
/** Recorders for S3 recordings; start answers 503 when S3 is not configured. */
const recordings = createRecordingService({
  db,
  s3: s3Client,
  spoolDir: RECORDING_SPOOL_DIR,
  spoolMaxBytes: RECORDING_SPOOL_MAX_BYTES,
  handoffTtlSeconds: (() => {
    const n = Number(process.env.HANDOFF_URL_TTL_SECONDS);
    return Number.isInteger(n) && n >= 1 && n <= 604800 ? n : 86400;
  })(),
  relayName: process.env.RELAY_NAME || '',
  rtspBase: process.env.MEDIAMTX_RTSP_BASE || DEFAULT_RTSP_BASE,
  spawnProcess: spawn,
  log: (msg) => console.log(msg),
});
// Rows a crash left in recording/degraded/stopping become interrupted; spool files stay on disk.
reconcileInterruptedRecordings({ db, spoolDir: RECORDING_SPOOL_DIR, log: (msg) => console.log(msg) });

/** Video HLS packager (P6.1): <HLS_DIR>/<stream>/video/, started by the ready hook when videoHls is on. */
const hlsPackager = new HlsPackager({
  hlsDir: HLS_DIR,
  hlsTime: 4,
  listSize: listSizeFor(DELAY_MAX_SECONDS, 4),
  rtspBase: process.env.MEDIAMTX_RTSP_BASE || DEFAULT_RTSP_BASE,
  spawnProcess: spawn,
});

/**
 * MediaMTX ready and notready hooks: start or stop the radio pull, the stream's startable
 * destinations, the video HLS packager and the recording. Each is independent (ready-hooks.js).
 */
const readyHooks = createReadyHandler({
  supervisor, probe: readyHookProbe,
  // RADIO_ON_READY=off wins; otherwise the stream's own `radio` setting decides (P8).
  radioOnReady: (name) => RADIO_ON_READY && getConfig(db, name).radio,
  log: (msg) => console.log(`[ready-hooks] ${msg}`),
  egress,
  listStartable: (name) => startableDestinationIds(db, name),
  loadTarget: (name, id) => loadEgressTarget(db, name, id, { secretKey: RELAY_SECRET_KEY }),
  hls: hlsPackager,
  recordings,
  s3Configured: Boolean(s3Client),
  getConfig: (name) => getConfig(db, name),
  captioner: captionerService,
});

/** Email provider: 'sendgrid' | 'mailgun' | '' (disabled) */
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || '').toLowerCase();
const EMAIL_TO = process.env.EMAIL_TO || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY || '';
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN || '';

// ---------------------------------------------------------------------------
// CORS — all responses allow any origin so the embeddable widget works across
// different domains
// ---------------------------------------------------------------------------
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.options('*', (_req, res) => res.sendStatus(204));

// ---------------------------------------------------------------------------
// Reverse SSH Tunnel Proxy: Canva Application, PiControl & PiControl MCP
// Mounted before body parsers and stream routing so large uploads and SSE pass through.
// Supports pulling registered Pi systems and venue profiles from Tunnus Discovery API.
// ---------------------------------------------------------------------------
app.use(createTunnelRouter({
  db,
  relayApiToken: RELAY_API_TOKEN,
  discoveryServiceUrl: process.env.DISCOVERY_SERVICE_URL || process.env.TUNNUS_DISCOVERY_URL,
  discoveryToken: process.env.DISCOVERY_TOKEN || process.env.TUNNUS_TOKEN,
  canvaTunnelUrl: CANVA_TUNNEL_URL,
  picontrolTunnelUrl: PICONTROL_TUNNEL_URL,
  picontrolMcpTunnelUrl: PICONTROL_MCP_TUNNEL_URL
}));

// ---------------------------------------------------------------------------
// Rate limiting — prevent excessive filesystem access from any single client
// ---------------------------------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// /api/v1 has its own, higher limit (pivoice pushes captions several times a minute)
const controlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Playback traffic (HLS playlists, segments' captions, images, the viewer stream) comes
// from many visitors behind one address (the church Wi-Fi), so it gets its own, much
// higher limit per IP instead of the 60/min API limit.
const mediaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Math.max(60, Number(process.env.PUBLIC_MEDIA_RATE_LIMIT) || 6000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
const isMediaPath = (p) => /^\/streams\/[^/]+\/hls\//.test(p) || p.startsWith('/hls/') || p.startsWith('/assets/');

// The public viewer stream (P7.5) is not control traffic: it uses the media limiter instead (see below).
app.use('/api/v1/', (req, res, next) => (req.path.startsWith('/viewer/') ? next() : controlLimiter(req, res, next)));
app.use('/api/', (req, res, next) => {
  if (req.path.startsWith('/v1/')) return next();
  return isMediaPath(req.path) ? mediaLimiter(req, res, next) : apiLimiter(req, res, next);
});
app.use(express.json({ limit: '256kb' }));
const requireToken = requireBearer(RELAY_API_TOKEN);
/** Bearer token for GET /metrics (Prometheus scrape). Unset = /metrics answers 503. */
const METRICS_BEARER_TOKEN = process.env.METRICS_BEARER_TOKEN || '';
const requireMetricsToken = requireBearer(METRICS_BEARER_TOKEN);

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

// In-memory stats cache — loaded once at startup, written through on every mutation.
let _statsCache = null;
let _writePending = false;

function _emptyStats() {
  return { livePlayCount: 0, archivePlays: {}, streamSessions: [] };
}

function _loadStats() {
  try {
    const raw = fs.readFileSync(STATS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    _statsCache = {
      livePlayCount: Number(parsed.livePlayCount) || 0,
      archivePlays: (parsed.archivePlays && typeof parsed.archivePlays === 'object')
        ? parsed.archivePlays : {},
      streamSessions: Array.isArray(parsed.streamSessions) ? parsed.streamSessions : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[stats] Could not parse ${STATS_FILE}: ${err.message} — starting fresh`);
    }
    _statsCache = _emptyStats();
  }
}

function _saveStats() {
  if (_writePending) return;
  _writePending = true;
  setImmediate(function _doWrite() {
    _writePending = false;
    const tmpPath = STATS_FILE + '.tmp';
    try {
      fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(_statsCache, null, 2), 'utf8');
      fs.renameSync(tmpPath, STATS_FILE);
    } catch (err) {
      console.error(`[stats] Write failed: ${err.message}`);
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  });
}

function _pruneOldSessions() {
  const cutoff = Date.now() - STATS_SESSION_DAYS * 24 * 60 * 60 * 1000;
  _statsCache.streamSessions = _statsCache.streamSessions.filter(function (s) {
    const ts = s.startedAt ? new Date(s.startedAt).getTime() : 0;
    return ts > cutoff;
  });
}

function recordLivePlay() {
  _statsCache.livePlayCount = (_statsCache.livePlayCount || 0) + 1;
  _saveStats();
}

function recordArchivePlay(filename) {
  if (!_statsCache.archivePlays[filename]) _statsCache.archivePlays[filename] = 0;
  _statsCache.archivePlays[filename] += 1;
  _saveStats();
}

function recordSessionStart(streamName, startedAt) {
  _pruneOldSessions();
  _statsCache.streamSessions.push({
    streamName: streamName || 'unknown',
    startedAt: startedAt || new Date().toISOString(),
    endedAt: null,
    durationSeconds: null,
  });
  _saveStats();
}

function recordSessionEnd(streamName, endedAt) {
  const endTime = endedAt ? new Date(endedAt) : new Date();
  let matched = false;
  for (let i = _statsCache.streamSessions.length - 1; i >= 0; i--) {
    const s = _statsCache.streamSessions[i];
    if (s.streamName === streamName && s.endedAt === null) {
      s.endedAt = endTime.toISOString();
      s.durationSeconds = Math.round((endTime.getTime() - new Date(s.startedAt).getTime()) / 1000);
      matched = true;
      break;
    }
  }
  if (!matched) {
    _statsCache.streamSessions.push({
      streamName: streamName || 'unknown',
      startedAt: null,
      endedAt: endTime.toISOString(),
      durationSeconds: null,
    });
  }
  _saveStats();
}

// ---------------------------------------------------------------------------
// Monthly email report helpers
// ---------------------------------------------------------------------------

/**
 * Build the monthly stats report for a given year/month (1-indexed).
 * Returns { subject, text, html }.
 */
function _buildMonthlyReport(year, month) {
  const monthName = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long' });
  const subject = `Tuberadio stats — ${monthName} ${year}`;

  const startOfMonth = new Date(year, month - 1, 1).getTime();
  const endOfMonth = new Date(year, month, 1).getTime();

  // Sessions in this month
  const sessions = _statsCache.streamSessions.filter(function (s) {
    const ts = s.startedAt ? new Date(s.startedAt).getTime() : 0;
    return ts >= startOfMonth && ts < endOfMonth;
  });

  const totalSessions = sessions.length;
  const totalSeconds = sessions.reduce(function (sum, s) { return sum + (s.durationSeconds || 0); }, 0);
  const totalHours = (totalSeconds / 3600).toFixed(1);

  // Archive plays this month — approximate using filename timestamp embedded in key
  let archivePlaysThisMonth = 0;
  const topArchive = [];
  Object.keys(_statsCache.archivePlays).forEach(function (filename) {
    // Filename: YYYY-MM-DD_HH-MM-SS_name.mp3
    const m = filename.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const fileYear = Number(m[1]);
      const fileMonth = Number(m[2]);
      if (fileYear === year && fileMonth === month) {
        const count = _statsCache.archivePlays[filename];
        archivePlaysThisMonth += count;
        topArchive.push({ filename, count });
      }
    }
  });
  topArchive.sort(function (a, b) { return b.count - a.count; });
  const top5 = topArchive.slice(0, 5);

  const liveCount = _statsCache.livePlayCount; // lifetime total (no per-month breakdown stored)

  const text = [
    `Tuberadio Monthly Report — ${monthName} ${year}`,
    '='.repeat(45),
    '',
    `Live play button clicks (lifetime total): ${liveCount}`,
    `Broadcast sessions this month: ${totalSessions}`,
    `Total hours on air this month: ${totalHours} h`,
    `Archive downloads this month: ${archivePlaysThisMonth}`,
    '',
    top5.length ? 'Top archive recordings this month:' : 'No archive downloads this month.',
    ...top5.map(function (r, i) { return `  ${i + 1}. ${r.filename} — ${r.count} download${r.count !== 1 ? 's' : ''}`; }),
    '',
    `Report generated: ${new Date().toISOString()}`,
  ].join('\n');

  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:auto">
<h2>Tuberadio Monthly Report</h2>
<h3>${monthName} ${year}</h3>
<table style="border-collapse:collapse;width:100%">
  <tr><td style="padding:8px;border-bottom:1px solid #eee">Live play button clicks (lifetime total)</td><td style="padding:8px;border-bottom:1px solid #eee"><strong>${liveCount}</strong></td></tr>
  <tr><td style="padding:8px;border-bottom:1px solid #eee">Broadcast sessions this month</td><td style="padding:8px;border-bottom:1px solid #eee"><strong>${totalSessions}</strong></td></tr>
  <tr><td style="padding:8px;border-bottom:1px solid #eee">Total hours on air</td><td style="padding:8px;border-bottom:1px solid #eee"><strong>${totalHours} h</strong></td></tr>
  <tr><td style="padding:8px">Archive downloads this month</td><td style="padding:8px"><strong>${archivePlaysThisMonth}</strong></td></tr>
</table>
${top5.length ? `<h4>Top archive recordings</h4><ol>${top5.map(function (r) { return `<li>${r.filename} — ${r.count} download${r.count !== 1 ? 's' : ''}</li>`; }).join('')}</ol>` : ''}
<p style="color:#888;font-size:12px">Generated ${new Date().toISOString()}</p>
</body></html>`;

  return { subject, text, html };
}

/**
 * Send an email using the configured provider.
 * Uses Node's built-in https module — no dependencies.
 */
function _sendEmail(subject, text, html) {
  if (!EMAIL_PROVIDER || !EMAIL_TO || !EMAIL_FROM) {
    console.log('[email] Provider not configured — skipping monthly report');
    return;
  }

  if (EMAIL_PROVIDER === 'sendgrid') {
    if (!SENDGRID_API_KEY) { console.error('[email] SENDGRID_API_KEY not set'); return; }
    const body = JSON.stringify({
      personalizations: [{ to: [{ email: EMAIL_TO }] }],
      from: { email: EMAIL_FROM },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    });
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, function (res) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`[email] Monthly report sent via SendGrid (${res.statusCode})`);
      } else {
        console.error(`[email] SendGrid error: HTTP ${res.statusCode}`);
      }
    });
    req.on('error', function (e) { console.error(`[email] SendGrid request error: ${e.message}`); });
    req.write(body);
    req.end();
    return;
  }

  if (EMAIL_PROVIDER === 'mailgun') {
    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) { console.error('[email] MAILGUN_API_KEY or MAILGUN_DOMAIN not set'); return; }
    // Mailgun expects form-encoded data
    const params = new URLSearchParams({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject,
      text,
      html,
    });
    const body = params.toString();
    const auth = Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64');
    const req = https.request({
      hostname: 'api.mailgun.net',
      path: `/v3/${MAILGUN_DOMAIN}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, function (res) {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`[email] Monthly report sent via Mailgun (${res.statusCode})`);
      } else {
        console.error(`[email] Mailgun error: HTTP ${res.statusCode}`);
      }
    });
    req.on('error', function (e) { console.error(`[email] Mailgun request error: ${e.message}`); });
    req.write(body);
    req.end();
    return;
  }

  console.error(`[email] Unknown EMAIL_PROVIDER: ${EMAIL_PROVIDER}`);
}

/**
 * Scheduler — checks once per hour whether the month just rolled over.
 * Sends the previous month's report on the first check after midnight on the 1st.
 */
let _lastReportMonth = null; // 'YYYY-MM' string of the last sent report

function _initEmailScheduler() {
  if (!EMAIL_PROVIDER || !EMAIL_TO) return;

  function _check() {
    const now = new Date();
    if (now.getDate() !== 1) return; // only on the 1st of the month

    // Previous month
    const reportDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const reportKey = `${reportDate.getFullYear()}-${String(reportDate.getMonth() + 1).padStart(2, '0')}`;

    if (_lastReportMonth === reportKey) return; // already sent this month's report
    _lastReportMonth = reportKey;

    console.log(`[email] Sending monthly report for ${reportKey}`);
    const { subject, text, html } = _buildMonthlyReport(reportDate.getFullYear(), reportDate.getMonth() + 1);
    _sendEmail(subject, text, html);
  }

  // Check immediately (handles a server restart on the 1st), then every hour
  _check();
  setInterval(_check, 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------
/** Resolve the stream named in the path, or the default stream for legacy routes. */
function streamFromRequest(req, res, next) {
  const name = req.params.name ?? DEFAULT_STREAM;
  if (!isValidStreamName(name)) return res.status(400).json({ error: 'invalid stream name' });
  req.stream = name;
  next();
}

/** Status of one stream: live state from its manifest, and its delay. */
function streamStatus(name) {
  let live = false;
  let lastUpdated = null;
  try {
    const stat = fs.statSync(path.join(HLS_DIR, name, 'stream.m3u8'));
    live = Date.now() - stat.mtimeMs < STALE_MS;
    lastUpdated = stat.mtime.toISOString();
  } catch {
    // no manifest yet: the stream is not live
  }
  return {
    name,
    live,
    // What listeners should play: the delayed playlist, so audio and captions line up
    streamUrl: `/api/streams/${name}/hls/delayed.m3u8`,
    liveStreamUrl: `${HLS_SEGMENT_PREFIX}${name}/stream.m3u8`,
    delaySeconds: streams.delayOf(name),
    lastUpdated,
  };
}

// ---------------------------------------------------------------------------
// GET /api/health (container healthcheck) and GET /metrics (Prometheus, Bearer
// METRICS_BEARER_TOKEN)
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/metrics', requireMetricsToken, (_req, res) => {
  let names = [];
  try {
    names = fs.readdirSync(HLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidStreamName(d.name))
      .map((d) => d.name);
  } catch {
    // HLS directory not created yet
  }
  const lines = [
    '# TYPE web_radio_relay_uptime_seconds gauge',
    `web_radio_relay_uptime_seconds ${Math.round(process.uptime())}`,
    '# TYPE web_radio_relay_stream_live gauge',
    ...names.sort().map((n) => `web_radio_relay_stream_live{stream="${n}"} ${streamStatus(n).live ? 1 : 0}`),
    '# TYPE web_radio_relay_live_plays_total counter',
    `web_radio_relay_live_plays_total ${_statsCache.livePlayCount}`,
    '# TYPE web_radio_relay_stream_sessions_total counter',
    `web_radio_relay_stream_sessions_total ${_statsCache.streamSessions.length}`,
    '# TYPE relay_translations_late_total counter',
    ...lateTranslations.entries().map(([s, n]) => `relay_translations_late_total{stream="${s}"} ${n}`),
    '',
  ];
  res.type('text/plain; version=0.0.4').send(lines.join('\n'));
});

// ---------------------------------------------------------------------------
// Authenticated managed stream lifecycle. Source URLs are deployment config only.
// ---------------------------------------------------------------------------
app.post('/api/v1/streams/:name/start', requireToken, streamFromRequest, async (req, res) => {
  try { res.status(202).json({ stream: await supervisor.start(req.stream) }); }
  catch (err) { res.status(err.statusCode || 503).json({ error: err.message || 'unable to start stream' }); }
});
app.post('/api/v1/streams/:name/stop', requireToken, streamFromRequest, async (req, res) => {
  try { res.json({ stream: await supervisor.stop(req.stream) }); }
  catch (err) { res.status(err.statusCode || 503).json({ error: err.message || 'unable to stop stream' }); }
});
/** Lifecycle state of a stream plus its last input probe (null when unknown). */
const streamView = (name) => ({ ...supervisor.state(name), probe: probeService.get(name) });
app.get('/api/v1/streams/:name/lifecycle', requireToken, streamFromRequest, (_req, res) => {
  res.json({ stream: streamView(_req.stream) });
});
app.get('/api/v1/streams/lifecycle', requireToken, (_req, res) => {
  res.json({ streams: supervisor.list().map((s) => ({ ...s, probe: probeService.get(s.name) })) });
});
// Must stay after /api/v1/streams/lifecycle above: "lifecycle" is a valid stream name.
app.get('/api/v1/streams/:name', requireToken, streamFromRequest, (req, res) => {
  res.json({ stream: streamView(req.stream) });
});

// ---------------------------------------------------------------------------
// Egress destinations (P4.1, P4.3). Scope stream:<name>:control (admin passes).
// Responses never contain a stream key; errors never contain one either.
// ---------------------------------------------------------------------------
const requireStreamControl = requireScope((req) => `stream:${req.params.name}:control`, { adminToken: RELAY_API_TOKEN, db });

/** Maps errors from the destination helpers to a status; anything else is a 500 without details. */
function destinationRoute(handler) {
  return (req, res) => {
    try {
      handler(req, res);
    } catch (err) {
      if (err.statusCode) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      console.error('[destinations]', err.name);
      res.status(500).json({ error: 'internal error' });
    }
  };
}

app.get('/api/v1/streams/:name/destinations', requireStreamControl, streamFromRequest, destinationRoute((req, res) => {
  const destinations = listDestinations(db, req.stream).map((d) => ({ ...d, state: egress.state(req.stream, d.id) }));
  res.json({ stream: req.stream, destinations });
}));

app.post('/api/v1/streams/:name/destinations', requireStreamControl, streamFromRequest, destinationRoute((req, res) => {
  const destination = createDestination(db, req.stream, req.body, {
    secretKey: RELAY_SECRET_KEY, maxPerStream: MAX_DESTINATIONS_PER_STREAM, nowMs: Date.now(),
  });
  res.status(201).json({ destination: { ...destination, state: egress.state(req.stream, destination.id) } });
}));

app.patch('/api/v1/streams/:name/destinations/:id', requireStreamControl, streamFromRequest, destinationRoute((req, res) => {
  const { destination, targetChanged } = updateDestination(db, req.stream, req.params.id, req.body, { secretKey: RELAY_SECRET_KEY });
  // A running child keeps the url and key it was started with: stop it when those change.
  if (targetChanged) egress.stop(req.stream, destination.id);
  res.json({ destination: { ...destination, state: egress.state(req.stream, destination.id) } });
}));

app.delete('/api/v1/streams/:name/destinations/:id', requireStreamControl, streamFromRequest, destinationRoute((req, res) => {
  if (!deleteDestination(db, req.stream, req.params.id)) {
    res.status(404).json({ error: 'destination not found' });
    return;
  }
  egress.stop(req.stream, req.params.id);
  res.status(204).end();
}));

app.post('/api/v1/streams/:name/destinations/:id/start', requireStreamControl, streamFromRequest, destinationRoute((req, res) => {
  const target = loadEgressTarget(db, req.stream, req.params.id, { secretKey: RELAY_SECRET_KEY });
  if (!target.enabled) throw Object.assign(new Error('destination is disabled'), { statusCode: 409 });
  res.json({ id: target.id, state: egress.start(req.stream, target) });
}));

app.post('/api/v1/streams/:name/destinations/:id/stop', requireStreamControl, streamFromRequest, destinationRoute((req, res) => {
  if (!destinationExists(db, req.stream, req.params.id)) {
    res.status(404).json({ error: 'destination not found' });
    return;
  }
  res.json({ id: req.params.id, state: egress.stop(req.stream, req.params.id) });
}));

// ---------------------------------------------------------------------------
// Recordings to S3 (P5.3). Scope stream:<name>:control (admin passes).
// ---------------------------------------------------------------------------
app.use(createRecordingRouter({ service: recordings, adminToken: RELAY_API_TOKEN, db }));

// ---------------------------------------------------------------------------
// GET /api/streams — every stream the relay knows about
// ---------------------------------------------------------------------------
app.get('/api/streams', (_req, res) => {
  let names = [];
  try {
    names = fs.readdirSync(HLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidStreamName(d.name))
      .map((d) => d.name);
  } catch {
    // HLS directory not created yet
  }
  for (const name of streams.entries.keys()) if (!names.includes(name)) names.push(name);
  for (const item of supervisor.list()) if (!names.includes(item.name)) names.push(item.name);
  res.json({ streams: names.sort().map(streamStatus) });
});

// ---------------------------------------------------------------------------
// GET /api/streams/:name/status and GET /api/status (default stream)
// ---------------------------------------------------------------------------
app.get(['/api/streams/:name/status', '/api/status'], streamFromRequest, (req, res) => {
  res.json(streamStatus(req.stream));
});

// ---------------------------------------------------------------------------
// GET /api/streams/:name/hls/delayed.m3u8 and the default stream's alias
// ---------------------------------------------------------------------------
app.get(['/api/streams/:name/hls/delayed.m3u8', '/api/hls/delayed.m3u8'], streamFromRequest, (req, res) => {
  let source;
  try {
    source = fs.readFileSync(path.join(HLS_DIR, req.stream, 'stream.m3u8'), 'utf8');
  } catch {
    res.status(404).type('text/plain').send('Stream is not live\n');
    return;
  }
  const body = buildDelayedPlaylist(source, {
    delaySeconds: streams.delayOf(req.stream),
    nowMs: Date.now(),
    segmentPrefix: `${HLS_SEGMENT_PREFIX}${req.stream}/`,
  });
  if (body === null) {
    res.status(503).type('text/plain').send('Stream timing is not available (ffmpeg needs program_date_time)\n');
    return;
  }
  res.set('Cache-Control', 'no-cache');
  res.type('application/vnd.apple.mpegurl').send(body);
});

// ---------------------------------------------------------------------------
// Video HLS (P6.2, P6.3): delayed video playlist, WebVTT renditions and master.
// The live video playlist is <HLS_DIR>/<stream>/video/stream.m3u8 (hls-args.js).
// ---------------------------------------------------------------------------
const VIDEO_SUB_LANGS = (process.env.VIDEO_SUB_LANGS || 'fi').split(',').map((s) => s.trim()).filter(Boolean);
for (const lang of VIDEO_SUB_LANGS) {
  if (!isSubtitleLang(lang)) throw new Error(`VIDEO_SUB_LANGS: invalid language tag "${lang}"`);
}
const VIDEO_BANDWIDTH = Number(process.env.VIDEO_BANDWIDTH || 2500000);
const VIDEO_RESOLUTION = process.env.VIDEO_RESOLUTION || '1280x720';
if (!Number.isInteger(VIDEO_BANDWIDTH) || VIDEO_BANDWIDTH <= 0) throw new Error('VIDEO_BANDWIDTH must be a positive integer');
if (!/^\d+x\d+$/.test(VIDEO_RESOLUTION)) throw new Error('VIDEO_RESOLUTION must look like 1280x720');

/** Wall-clock start of the first timed video segment seen per stream: the PTS origin of the WebVTT maps. */
const videoOriginMs = new Map();

/** Live video playlist of a stream with its parsed segments, or null when there is no video HLS. */
function liveVideo(stream) {
  let text;
  try {
    text = fs.readFileSync(path.join(HLS_DIR, stream, 'video', 'stream.m3u8'), 'utf8');
  } catch {
    return null;
  }
  const parsed = parseMediaPlaylist(text);
  if (!videoOriginMs.has(stream)) {
    const first = parsed.segments.find((s) => s.startMs != null);
    if (first) videoOriginMs.set(stream, first.startMs);
  }
  return { text, parsed, originMs: videoOriginMs.get(stream) };
}

// GET /api/streams/:name/hls/master.m3u8 — subtitle renditions plus the delayed video
app.get('/api/streams/:name/hls/master.m3u8', streamFromRequest, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/vnd.apple.mpegurl').send(masterPlaylist({
    stream: req.stream,
    langs: VIDEO_SUB_LANGS,
    bandwidth: VIDEO_BANDWIDTH,
    resolution: VIDEO_RESOLUTION,
  }));
});

// GET /api/streams/:name/hls/video/delayed.m3u8 — the delayed video playlist (as the audio one)
app.get('/api/streams/:name/hls/video/delayed.m3u8', streamFromRequest, (req, res) => {
  const live = liveVideo(req.stream);
  if (live === null) {
    res.status(404).type('text/plain').send('Video is not live\n');
    return;
  }
  const body = buildDelayedPlaylist(live.text, {
    delaySeconds: streams.delayOf(req.stream),
    nowMs: Date.now(),
    segmentPrefix: `${HLS_SEGMENT_PREFIX}${req.stream}/video/`,
  });
  if (body === null) {
    res.status(503).type('text/plain').send('Stream timing is not available (ffmpeg needs program_date_time)\n');
    return;
  }
  res.set('Cache-Control', 'no-cache');
  res.type('application/vnd.apple.mpegurl').send(body);
});

// GET /api/streams/:name/hls/subs/:lang.m3u8 — subtitle media playlist, one VTT per video segment
app.get('/api/streams/:name/hls/subs/:lang.m3u8', streamFromRequest, (req, res) => {
  const lang = req.params.lang;
  if (!isSubtitleLang(lang)) return res.status(400).json({ error: 'invalid subtitle language' });
  const live = liveVideo(req.stream);
  if (live === null) {
    res.status(404).type('text/plain').send('Video is not live\n');
    return;
  }
  // Same window as the delayed video playlist, so the segments line up
  const delayed = buildDelayedPlaylist(live.text, {
    delaySeconds: streams.delayOf(req.stream),
    nowMs: Date.now(),
    segmentPrefix: `${HLS_SEGMENT_PREFIX}${req.stream}/video/`,
  });
  if (delayed === null) {
    res.status(503).type('text/plain').send('Stream timing is not available (ffmpeg needs program_date_time)\n');
    return;
  }
  const { header, segments } = parseMediaPlaylist(delayed);
  res.set('Cache-Control', 'no-cache');
  res.type('application/vnd.apple.mpegurl').send(subsPlaylist({
    stream: req.stream,
    lang,
    segments,
    mediaSequence: header.mediaSequence,
    targetDuration: header.targetDuration,
  }));
});

// GET /api/streams/:name/hls/subs/:lang/:seq.vtt — captions of one video segment
app.get('/api/streams/:name/hls/subs/:lang/:seq.vtt', streamFromRequest, (req, res) => {
  const { lang, seq } = req.params;
  if (!isSubtitleLang(lang)) return res.status(400).json({ error: 'invalid subtitle language' });
  if (!/^\d+$/.test(seq)) return res.status(400).json({ error: 'seq must be an integer' });
  const live = liveVideo(req.stream);
  const segment = live && live.parsed.segments.find((s) => segmentSeq(s.uri) === Number(seq));
  if (!segment || segment.startMs == null || segment.duration == null) {
    return res.status(404).type('text/plain').send('Segment not found\n');
  }
  const segStartMs = segment.startMs;
  const segEndMs = segStartMs + Math.round(segment.duration * 1000);
  const events = rangeEvents(db, {
    stream: req.stream,
    fromMs: segStartMs - CUE_LOOKBACK_MS,
    toMs: segEndMs,
  });
  res.set('Cache-Control', 'no-cache');
  res.type('text/vtt; charset=utf-8').send(vttForSegment({
    segStartMs,
    segEndMs,
    events,
    lang,
    originMs: live.originMs,
  }));
});

// ---------------------------------------------------------------------------
// GET /api/streams/:name/captions and GET /api/captions — captions due now
// ---------------------------------------------------------------------------
app.get(['/api/streams/:name/captions', '/api/captions'], streamFromRequest, (req, res) => {
  const nowMs = Date.now();
  const from = req.query.from === undefined ? undefined : Number(req.query.from);
  if (from !== undefined && !Number.isInteger(from)) {
    return res.status(400).json({ error: 'from must be an integer (epoch milliseconds)' });
  }
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 200));
  const lang = typeof req.query.lang === 'string' ? req.query.lang.toLowerCase() : undefined;
  const delaySeconds = streams.delayOf(req.stream);
  const entry = streams.peek(req.stream);
  const { captions: due, next } = entry
    ? entry.captions.released({ nowMs, delayMs: delaySeconds * 1000, from, lang, limit })
    : { captions: [], next: from ?? nowMs - delaySeconds * 1000 - 30_000 };
  res.set('Cache-Control', 'no-cache');
  res.json({ stream: req.stream, serverTime: nowMs, delaySeconds, next, captions: due });
});

// ---------------------------------------------------------------------------
// GET /api/openapi.json — the API description (generates the remote CLI)
// ---------------------------------------------------------------------------
app.get('/api/openapi.json', (_req, res) => {
  res.sendFile(path.join(__dirname, 'openapi.json'));
});

// ---------------------------------------------------------------------------
// Image assets: upload per stream (scope stream:<name>:data, admin passes), public GET by id.
// Registered before the catch-all stream redirect below.
registerAssetRoutes(app, {
  store: assetStore,
  requireUpload: requireScope((req) => `stream:${req.params.name}:data`, { adminToken: RELAY_API_TOKEN, db }),
});

// GET /listen — the listener page: delayed audio plus captions in one view
// ---------------------------------------------------------------------------
app.get('/listen', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').sendFile(path.join(__dirname, 'public', 'listen.html'));
});

// Viewer pages (P7b): the church page, the caption embed and the watch player, plus their assets.
// Registered before the /:stream catch-all below, or /watch would be taken for a stream name.
const VIEWER_DIR = path.join(__dirname, 'public', 'viewer');
app.use('/viewer', express.static(VIEWER_DIR, { maxAge: '5m' }));
function viewerPage(file, keyOf) {
  return (req, res) => {
    if (!isValidStreamName(keyOf(req))) return res.status(404).send('Not Found');
    res.set('Cache-Control', 'no-cache');
    res.type('html').sendFile(path.join(VIEWER_DIR, file));
  };
}
app.get('/view/:key', viewerPage('view.html', (req) => req.params.key));
app.get('/embed/viewer', viewerPage('embed.html', (req) => String(req.query.key ?? '')));
app.get('/watch', viewerPage('watch.html', (req) => String(req.query.stream ?? '')));

// Root path redirects to /listen
app.get('/', (_req, res) => {
  res.redirect(302, '/listen');
});

// Stream shortcut (e.g. /keskuskirkko) redirects to /listen?stream=keskuskirkko
app.get('/:stream([a-z0-9_-]{1,32})', (req, res) => {
  const stream = req.params.stream;
  if (!isValidStreamName(stream)) return res.status(404).send('Not Found');
  res.redirect(302, `/listen?stream=${encodeURIComponent(stream)}`);
});

// ---------------------------------------------------------------------------
// Control API (Bearer RELAY_API_TOKEN). Each route exists per stream and,
// without a name, for the default stream.
// ---------------------------------------------------------------------------
app.post(['/api/v1/streams/:name/captions', '/api/v1/captions'], requireToken, streamFromRequest, (req, res) => {
  const nowMs = Date.now();
  const checked = validateCaptionBody(req.body, nowMs);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  const entry = streams.ensure(req.stream);
  if (!entry) return res.status(409).json({ error: 'too many streams' });
  const accepted = entry.captions.add(checked.segments);
  entry.captions.prune(nowMs - (entry.delaySeconds * 1000 + CAPTION_RETENTION_SECONDS * 1000));
  // Bridge the legacy caption POST into the shared timeline so the live embedder and viewer see it too.
  storeStreamEvents(req.stream, checked.segments.map((segment) => ({
    type: 'caption', lang: segment.lang, startedAt: segment.startedAt, endedAt: segment.endedAt,
    payload: { text: segment.text, final: true },
  })), nowMs);
  res.status(202).json({ stream: req.stream, accepted });
});

// Timeline events pushed by a sender (P7.2): validated as a batch, stored with the event store.
app.post('/api/v1/streams/:name/events', requireToken, streamFromRequest, (req, res) => {
  const checked = validateEventBatch(req.body);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  const nowMs = Date.now();
  const { added, deduped } = storeStreamEvents(req.stream, checked.events, nowMs);
  res.status(202).json({ added, deduped });
});

// GET /api/v1/viewer/{key} — LCYT-compatible viewer SSE (plan P7.5). Public: no Bearer token, CORS *,
// public rate limit. The key is the stream's viewerKey when it has one (P8), else the stream name, which
// only works while the stream has no viewerKey.
app.get('/api/v1/viewer/:key', mediaLimiter, (req, res) => {
  const key = req.params.key;
  if (!isValidStreamName(key) && !VIEWER_KEY.test(key)) {
    return res.status(400).json({ error: 'Invalid viewer key: a viewer key (8-64 characters) or a stream name.' });
  }
  const stream = resolveViewerStream(db, key);
  if (!stream) return res.status(404).json({ error: 'Unknown viewer key' });
  const requested = req.query.mode === undefined ? 'live' : req.query.mode;
  if (!VIEWER_MODES.includes(requested)) {
    return res.status(400).json({ error: 'mode must be live or delayed' });
  }
  openViewerSession({
    res,
    db,
    bus: eventBus,
    stream,
    mode: requested,
    delayMsOf: () => streams.delayOf(stream) * 1000,
  });
});

// Per-stream config (P8). Scope stream:<s>:control; the env admin token and admin tokens pass.

app.get('/api/v1/streams/:name/config', requireStreamControl, streamFromRequest, (req, res) => {
  res.json({ stream: req.stream, config: getConfig(db, req.stream) });
});

app.put('/api/v1/streams/:name/config', requireStreamControl, streamFromRequest, (req, res) => {
  try {
    const config = putConfig(db, req.stream, req.body ?? {}, Date.now());
    res.json({ stream: req.stream, config });
  } catch (err) {
    if (err instanceof StreamConfigError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// CEA-608 embedder configuration and runtime status (P9.6).
app.get('/api/v1/streams/:name/captioner', requireStreamControl, streamFromRequest, (req, res) => {
  const config = getConfig(db, req.stream).captioner;
  res.json({ stream: req.stream, config, status: captionerService.state(req.stream) });
});

app.put('/api/v1/streams/:name/captioner', requireStreamControl, streamFromRequest, async (req, res) => {
  try {
    const stored = putConfig(db, req.stream, { captioner: req.body ?? {} }, Date.now());
    const status = await captionerService.configure(req.stream, stored.captioner);
    res.json({ stream: req.stream, config: stored.captioner, status });
  } catch (err) {
    if (err instanceof StreamConfigError) return res.status(err.status).json({ error: err.message });
    if (err instanceof TypeError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

app.get('/api/v1/captions/source', requireToken, (_req, res) => {
  res.json({ captionSource: gatewayCaptions.status() });
});

app.get(['/api/v1/streams/:name/delay', '/api/v1/delay'], requireToken, streamFromRequest, (req, res) => {
  res.json({ stream: req.stream, delaySeconds: streams.delayOf(req.stream), maxSeconds: DELAY_MAX_SECONDS });
});

app.put(['/api/v1/streams/:name/delay', '/api/v1/delay'], requireToken, streamFromRequest, (req, res) => {
  const value = req.body && req.body.delaySeconds;
  if (!Number.isInteger(value) || value < 0 || value > DELAY_MAX_SECONDS) {
    return res.status(400).json({ error: `delaySeconds must be an integer 0-${DELAY_MAX_SECONDS}` });
  }
  const entry = streams.ensure(req.stream);
  if (!entry) return res.status(409).json({ error: 'too many streams' });
  entry.delaySeconds = value;
  res.json({ stream: req.stream, delaySeconds: value, maxSeconds: DELAY_MAX_SECONDS });
});

// ---------------------------------------------------------------------------
// GET /api/archive
// ---------------------------------------------------------------------------
// Scoped tokens (admin only). The env RELAY_API_TOKEN and stored admin tokens pass.
const requireAdmin = requireScope(() => 'admin', { adminToken: RELAY_API_TOKEN, db });

app.post('/api/v1/tokens', requireAdmin, (req, res) => {
  const check = validateTokenRequest(req.body);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  const made = createToken(db, check.value, Date.now());
  res.status(201).json({
    id: made.id,
    token: made.token,
    scopes: made.scopes,
    expiresAt: made.expiresAt,
    label: made.label,
  });
});

app.get('/api/v1/tokens', requireAdmin, (_req, res) => {
  res.json({ tokens: listTokens(db) });
});

app.delete('/api/v1/tokens/:id', requireAdmin, (req, res) => {
  if (!revokeToken(db, req.params.id, Date.now())) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Internal hooks (MediaMTX and nginx-rtmp). nginx answers 404 for /internal/
// from the public side; these are reached on the Docker network only.
// ---------------------------------------------------------------------------

/**
 * Checks the hook secret given as `?secret=` or `x-hook-secret`. Returns null
 * when it matches, else the status to answer: 503 (HOOK_SECRET unset) or 401.
 */
function hookSecretStatus(req) {
  if (!HOOK_SECRET) return 503;
  const given = [req.query.secret, req.get('x-hook-secret')].filter((v) => typeof v === 'string' && v.length > 0);
  return given.some((g) => tokensEqual(g, HOOK_SECRET)) ? null : 401;
}

const lookupStoredToken = (token) => findTokenByValue(db, token);

app.post('/internal/mediamtx/auth', (req, res) => {
  const status = hookSecretStatus(req);
  if (status) {
    res.status(status).json({ error: status === 503 ? 'HOOK_SECRET is not set' : 'Unauthorized' });
    return;
  }
  const body = req.body || {};
  const result = decide(
    {
      action: body.action,
      path: body.path,
      query: body.query,
      user: body.user,
      password: body.password,
      ip: body.ip,
      protocol: body.protocol,
    },
    { lookupToken: lookupStoredToken, internalSecret: HOOK_SECRET, internalCidrs: RELAY_INTERNAL_CIDRS, nowMs: Date.now() },
  );
  res.status(result.allow ? 200 : 401).json(result);
});

// nginx-rtmp posts a form body (name, args, addr, ...). With PUBLISH_AUTH off,
// every publish is allowed and the secret is not checked.
app.post('/internal/publish-auth', express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => {
  if (!PUBLISH_AUTH_ON) {
    res.status(200).end();
    return;
  }
  const status = hookSecretStatus(req);
  if (status) {
    res.status(status).end();
    return;
  }
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name : '';
  const result = decide(
    { action: 'publish', path: `live/${name}`, query: typeof body.args === 'string' ? body.args : '', ip: body.addr, protocol: 'rtmp' },
    { lookupToken: lookupStoredToken, internalSecret: HOOK_SECRET, internalCidrs: RELAY_INTERNAL_CIDRS, nowMs: Date.now() },
  );
  res.status(result.allow ? 200 : 403).end();
});

// MediaMTX runOnReady / runOnNotReady (query `path`, secret as ?secret= or x-hook-secret).
// Answers 200 for any valid path: MediaMTX does not retry, and failures are logged by the handler.
app.post('/internal/mediamtx/ready', async (req, res) => {
  const status = hookSecretStatus(req);
  if (status) {
    res.status(status).json({ error: status === 503 ? 'HOOK_SECRET is not set' : 'Unauthorized' });
    return;
  }
  res.json(await readyHooks.ready(req.query.path));
});

app.post('/internal/mediamtx/notready', async (req, res) => {
  const status = hookSecretStatus(req);
  if (status) {
    res.status(status).json({ error: status === 503 ? 'HOOK_SECRET is not set' : 'Unauthorized' });
    return;
  }
  res.json(await readyHooks.notready(req.query.path));
});

app.get('/api/archive', (_req, res) => {
  let recordings = [];

  try {
    recordings = fs
      .readdirSync(ARCHIVE_DIR)
      .filter((f) => f.endsWith('.mp3'))
      .sort()
      .reverse()
      .map((filename) => {
        const filePath = path.join(ARCHIVE_DIR, filename);
        let sizeBytes = 0;
        try {
          sizeBytes = fs.statSync(filePath).size;
        } catch {
          // ignore
        }

        // Filename pattern: YYYY-MM-DD_HH-MM-SS_<streamname>.mp3
        // Parse the leading timestamp for a human-readable date
        const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_(.+)\.mp3$/);
        let startedAt = null;
        let streamName = null;
        if (match) {
          startedAt = `${match[1]}T${match[2].replace(/-/g, ':')}`;
          streamName = match[3];
        }

        return {
          filename,
          url: `${ARCHIVE_URL_PREFIX}/${filename}`,
          startedAt,
          streamName,
          sizeBytes,
        };
      });
  } catch {
    // archive dir doesn't exist yet
  }

  res.json({ recordings });
});

// ---------------------------------------------------------------------------
// GET /api/stats
// ---------------------------------------------------------------------------
app.get('/api/stats', (_req, res) => {
  res.json({
    livePlayCount: _statsCache.livePlayCount,
    archivePlays: _statsCache.archivePlays,
    recentSessions: _statsCache.streamSessions.slice(-20),
  });
});

// ---------------------------------------------------------------------------
// POST /api/stats/event
// Widget-facing. Body: { type: 'live-play' | 'archive-play', filename?: string }
// ---------------------------------------------------------------------------
app.post('/api/stats/event', (req, res) => {
  const { type, filename } = req.body || {};

  if (type === 'live-play') {
    recordLivePlay();
    return res.json({ ok: true });
  }

  if (type === 'archive-play') {
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: 'filename required for archive-play' });
    }
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res.status(400).json({ error: 'invalid filename' });
    }
    recordArchivePlay(filename);
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'type must be live-play or archive-play' });
});

// ---------------------------------------------------------------------------
// POST /api/v1/stats/session
// Internal use (shell scripts). Body: { event: 'start'|'end', streamName, timestamp? }
// Requires Authorization: Bearer <RELAY_API_TOKEN>
// ---------------------------------------------------------------------------
app.post('/api/v1/stats/session', requireToken, (req, res) => {
  const { event, streamName, timestamp } = req.body || {};

  if (event === 'start') {
    recordSessionStart(streamName, timestamp);
    return res.json({ ok: true });
  }

  if (event === 'end') {
    recordSessionEnd(streamName, timestamp);
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'event must be start or end' });
});

// ---------------------------------------------------------------------------
// Archive maintenance — move aged recordings to hidden archive; optionally
// delete very old files from the hidden archive.
// Runs once at startup and then every hour.
// ---------------------------------------------------------------------------

/**
 * Return the age of a file in whole completed days, based on its mtime.
 * @param {string} filePath
 * @returns {number}
 */
function fileAgeInDays(filePath) {
  const stat = fs.statSync(filePath);
  return Math.floor((Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24));
}

function runArchiveMaintenance() {
  // 1. Move recordings older than ARCHIVE_AGE_DAYS from ARCHIVE_DIR → HIDDEN_ARCHIVE_DIR
  if (ARCHIVE_AGE_DAYS > 0) {
    try {
      fs.mkdirSync(HIDDEN_ARCHIVE_DIR, { recursive: true });
      const files = fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.mp3'));
      for (const filename of files) {
        const src = path.join(ARCHIVE_DIR, filename);
        try {
          if (fileAgeInDays(src) >= ARCHIVE_AGE_DAYS) {
            const dest = path.join(HIDDEN_ARCHIVE_DIR, filename);
            // Use copy-then-delete to support moves across different filesystems/volumes
            fs.copyFileSync(src, dest);
            fs.unlinkSync(src);
            console.log(`[archive] Moved to hidden archive: ${filename}`);
          }
        } catch (err) {
          console.error(`[archive] Error processing ${filename}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[archive] Error reading ARCHIVE_DIR: ${err.message}`);
    }
  }

  // 2. Delete recordings older than HIDDEN_ARCHIVE_DELETE_DAYS from HIDDEN_ARCHIVE_DIR
  if (HIDDEN_ARCHIVE_DELETE_DAYS > 0) {
    try {
      fs.mkdirSync(HIDDEN_ARCHIVE_DIR, { recursive: true });
      const files = fs.readdirSync(HIDDEN_ARCHIVE_DIR).filter((f) => f.endsWith('.mp3'));
      for (const filename of files) {
        const filePath = path.join(HIDDEN_ARCHIVE_DIR, filename);
        try {
          if (fileAgeInDays(filePath) >= HIDDEN_ARCHIVE_DELETE_DAYS) {
            fs.unlinkSync(filePath);
            console.log(`[archive] Permanently deleted: ${filename}`);
          }
        } catch (err) {
          console.error(`[archive] Error deleting ${filename}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[archive] Error reading HIDDEN_ARCHIVE_DIR: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  _loadStats();

  console.log(`Tuberadio API server listening on port ${PORT}`);
  console.log(`  HLS_DIR                    : ${HLS_DIR}`);
  console.log(`  ARCHIVE_DIR                : ${ARCHIVE_DIR}`);
  console.log(`  HIDDEN_ARCHIVE_DIR         : ${HIDDEN_ARCHIVE_DIR}`);
  console.log(`  DEFAULT_STREAM             : ${DEFAULT_STREAM}`);
  console.log(`  ARCHIVE_URL_PREFIX         : ${ARCHIVE_URL_PREFIX}`);
  console.log(`  ARCHIVE_AGE_DAYS           : ${ARCHIVE_AGE_DAYS || 'disabled'}`);
  console.log(`  HIDDEN_ARCHIVE_DELETE_DAYS : ${HIDDEN_ARCHIVE_DELETE_DAYS || 'disabled'}`);
  console.log(`  STATS_FILE                 : ${STATS_FILE}`);
  console.log(`  STATS_SESSION_DAYS         : ${STATS_SESSION_DAYS}`);
  console.log(`  RELAY_API_TOKEN            : ${RELAY_API_TOKEN ? '(set)' : '(unset: control API answers 503)'}`);
  console.log(`  CANVA_TUNNEL_URL           : ${CANVA_TUNNEL_URL || '(disabled)'}`);
  console.log(`  PICONTROL_TUNNEL_URL       : ${PICONTROL_TUNNEL_URL || '(disabled)'}`);
  console.log(`  PICONTROL_MCP_TUNNEL_URL   : ${PICONTROL_MCP_TUNNEL_URL || '(disabled)'}`);
  console.log(`  DELAY_SECONDS              : ${INITIAL_DELAY_SECONDS} initial (max ${DELAY_MAX_SECONDS})`);
  console.log(`  CAPTION_RETENTION_SECONDS  : ${CAPTION_RETENTION_SECONDS}`);
  console.log(`  EMAIL_PROVIDER             : ${EMAIL_PROVIDER || 'disabled'}`);
  if (EMAIL_PROVIDER) {
    console.log(`  EMAIL_TO                   : ${EMAIL_TO || '(unset)'}`);
    console.log(`  EMAIL_FROM                 : ${EMAIL_FROM || '(unset)'}`);
  }

  if (ARCHIVE_AGE_DAYS > 0 || HIDDEN_ARCHIVE_DELETE_DAYS > 0) {
    runArchiveMaintenance();
    setInterval(runArchiveMaintenance, 60 * 60 * 1000); // run every hour
  }

  _initEmailScheduler();

  if (GATEWAY_EVENTS_URL && !isValidStreamName(GATEWAY_CAPTION_STREAM)) {
    console.error('[gateway-captions] GATEWAY_CAPTION_STREAM is not a valid stream name - disabled');
  } else if (GATEWAY_EVENTS_URL) {
    console.log(`  GATEWAY_EVENTS_URL         : ${GATEWAY_EVENTS_URL} -> stream ${GATEWAY_CAPTION_STREAM}`);
    gatewayCaptions.start();
  }
});

function shutdown() {
  closeViewerSessions();
  void Promise.allSettled([gatewayCaptions.stop(), supervisor.close(), egress.close(), hlsPackager.close(), recordings.close(), captionerService.close()]).finally(() => server.close(() => store.close()));
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
