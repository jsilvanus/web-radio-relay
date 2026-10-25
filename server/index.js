/**
 * web radio relay — status, listener delay, captions and archive API
 *
 * Public (listeners, widget):
 *   GET  /api/status                 live state, delay, delayed stream URL
 *   GET  /api/archive                archived MP3 recordings (newest first)
 *   GET  /api/stats                  aggregate anonymous play/session statistics
 *   POST /api/stats/event            play event from the widget
 *   GET  /api/hls/delayed.m3u8       live audio playlist, delayed server side
 *   GET  /api/captions               captions released for listeners (?lang=&from=&limit=)
 *   GET  /api/openapi.json           the OpenAPI document of this API
 *
 * Control (Bearer RELAY_API_TOKEN, see docs/API.md):
 *   POST /api/v1/captions            sender pushes timed captions (and later translations)
 *   GET  /api/v1/delay               read the listener delay
 *   PUT  /api/v1/delay               set the listener delay (0 .. DELAY_MAX_SECONDS)
 *   POST /api/v1/stats/session       stream session start/end (shell scripts)
 *
 * Environment variables:
 *   PORT                     Port to listen on                          (default: 3000)
 *   RELAY_API_TOKEN          Bearer token for /api/v1 (unset = control API answers 503)
 *   DELAY_SECONDS            Listener delay for audio and captions     (default: 0)
 *   DELAY_MAX_SECONDS        Largest delay the API accepts; sizes the ffmpeg playlist (default: 60)
 *   DELAYED_STREAM_URL       Public URL of the delayed playlist        (default: /api/hls/delayed.m3u8)
 *   HLS_SEGMENT_PREFIX       URL prefix of segment files in playlists  (default: /hls/)
 *   CAPTION_RETENTION_SECONDS  How long captions stay in memory        (default: 3600)
 *   HLS_DIR                  Directory containing stream.m3u8           (default: /var/www/radio/hls)
 *   ARCHIVE_DIR              Directory containing archived MP3s         (default: /var/www/radio/archive)
 *   HIDDEN_ARCHIVE_DIR       Directory for hidden (aged-out) archives   (default: /var/www/radio/hidden_archive)
 *   STALE_MS                 ms after which a manifest is stale         (default: 30000)
 *   HLS_STREAM_URL           Public URL returned in /api/status         (default: /hls/stream.m3u8)
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
import { requireBearer } from './lib/auth.js';
import { buildDelayedPlaylist } from './lib/hls-delay.js';
import { CaptionBuffer, validateCaptionBody } from './lib/captions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const HLS_DIR = process.env.HLS_DIR || '/var/www/radio/hls';
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || '/var/www/radio/archive';
const HIDDEN_ARCHIVE_DIR = process.env.HIDDEN_ARCHIVE_DIR || '/var/www/radio/hidden_archive';
/** If the HLS manifest hasn't been updated in this many ms, the stream is stale */
const STALE_MS = Number(process.env.STALE_MS) || 30_000;
/** Public URL for the HLS stream — returned in the /api/status payload */
const HLS_STREAM_URL = process.env.HLS_STREAM_URL || '/hls/stream.m3u8';
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

/** Listener delay in seconds for audio and captions; changeable through PUT /api/v1/delay */
const DELAY_MAX_SECONDS = Math.max(0, Number(process.env.DELAY_MAX_SECONDS ?? 60));
let delaySeconds = Math.min(DELAY_MAX_SECONDS, Math.max(0, Number(process.env.DELAY_SECONDS ?? 0)));
/** Public URL listeners should load; the live playlist stays at HLS_STREAM_URL */
const DELAYED_STREAM_URL = process.env.DELAYED_STREAM_URL || '/api/hls/delayed.m3u8';
/** URL prefix of the segment files named in the delayed playlist (nginx serves them) */
const HLS_SEGMENT_PREFIX = process.env.HLS_SEGMENT_PREFIX || '/hls/';
/** How long captions are kept in memory */
const CAPTION_RETENTION_SECONDS = Math.max(60, Number(process.env.CAPTION_RETENTION_SECONDS ?? 3600));
const captions = new CaptionBuffer();

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

app.use('/api/v1/', controlLimiter);
app.use('/api/', (req, res, next) => (req.path.startsWith('/v1/') ? next() : apiLimiter(req, res, next)));
app.use(express.json({ limit: '256kb' }));
const requireToken = requireBearer(RELAY_API_TOKEN);

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
app.get('/api/status', (_req, res) => {
  const manifestPath = path.join(HLS_DIR, 'stream.m3u8');

  let live = false;
  let lastUpdated = null;

  try {
    const stat = fs.statSync(manifestPath);
    const ageMs = Date.now() - stat.mtimeMs;
    live = ageMs < STALE_MS;
    lastUpdated = stat.mtime.toISOString();
  } catch {
    // manifest doesn't exist yet → stream is not live
  }

  res.json({
    live,
    // What listeners should play: the delayed playlist, so audio and captions line up
    streamUrl: DELAYED_STREAM_URL,
    liveStreamUrl: HLS_STREAM_URL,
    delaySeconds,
    lastUpdated,
  });
});

// ---------------------------------------------------------------------------
// GET /api/hls/delayed.m3u8 — the live audio playlist, delayed server side
// ---------------------------------------------------------------------------
app.get('/api/hls/delayed.m3u8', (_req, res) => {
  let source;
  try {
    source = fs.readFileSync(path.join(HLS_DIR, 'stream.m3u8'), 'utf8');
  } catch {
    res.status(404).type('text/plain').send('Stream is not live\n');
    return;
  }
  const body = buildDelayedPlaylist(source, {
    delaySeconds,
    nowMs: Date.now(),
    segmentPrefix: HLS_SEGMENT_PREFIX,
  });
  if (body === null) {
    res.status(503).type('text/plain').send('Stream timing is not available (ffmpeg needs program_date_time)\n');
    return;
  }
  res.set('Cache-Control', 'no-cache');
  res.type('application/vnd.apple.mpegurl').send(body);
});

// ---------------------------------------------------------------------------
// GET /api/captions — captions that are due for listeners now
// ---------------------------------------------------------------------------
app.get('/api/captions', (req, res) => {
  const nowMs = Date.now();
  const from = req.query.from === undefined ? undefined : Number(req.query.from);
  if (from !== undefined && !Number.isInteger(from)) {
    return res.status(400).json({ error: 'from must be an integer (epoch milliseconds)' });
  }
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 200));
  const lang = typeof req.query.lang === 'string' ? req.query.lang.toLowerCase() : undefined;
  const { captions: due, next } = captions.released({
    nowMs,
    delayMs: delaySeconds * 1000,
    from,
    lang,
    limit,
  });
  res.set('Cache-Control', 'no-cache');
  res.json({ serverTime: nowMs, delaySeconds, next, captions: due });
});

// ---------------------------------------------------------------------------
// GET /api/openapi.json — the API description (generates the remote CLI)
// ---------------------------------------------------------------------------
app.get('/api/openapi.json', (_req, res) => {
  res.sendFile(path.join(__dirname, 'openapi.json'));
});

// ---------------------------------------------------------------------------
// Control API (Bearer RELAY_API_TOKEN)
// ---------------------------------------------------------------------------
app.post('/api/v1/captions', requireToken, (req, res) => {
  const nowMs = Date.now();
  const checked = validateCaptionBody(req.body, nowMs);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  const accepted = captions.add(checked.segments);
  captions.prune(nowMs - (delaySeconds * 1000 + CAPTION_RETENTION_SECONDS * 1000));
  res.status(202).json({ accepted });
});

app.get('/api/v1/delay', requireToken, (_req, res) => {
  res.json({ delaySeconds, maxSeconds: DELAY_MAX_SECONDS });
});

app.put('/api/v1/delay', requireToken, (req, res) => {
  const value = req.body && req.body.delaySeconds;
  if (!Number.isInteger(value) || value < 0 || value > DELAY_MAX_SECONDS) {
    return res.status(400).json({ error: `delaySeconds must be an integer 0-${DELAY_MAX_SECONDS}` });
  }
  delaySeconds = value;
  res.json({ delaySeconds, maxSeconds: DELAY_MAX_SECONDS });
});

// ---------------------------------------------------------------------------
// GET /api/archive
// ---------------------------------------------------------------------------
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
app.listen(PORT, () => {
  _loadStats();

  console.log(`Tuberadio API server listening on port ${PORT}`);
  console.log(`  HLS_DIR                    : ${HLS_DIR}`);
  console.log(`  ARCHIVE_DIR                : ${ARCHIVE_DIR}`);
  console.log(`  HIDDEN_ARCHIVE_DIR         : ${HIDDEN_ARCHIVE_DIR}`);
  console.log(`  HLS_STREAM_URL             : ${HLS_STREAM_URL}`);
  console.log(`  ARCHIVE_URL_PREFIX         : ${ARCHIVE_URL_PREFIX}`);
  console.log(`  ARCHIVE_AGE_DAYS           : ${ARCHIVE_AGE_DAYS || 'disabled'}`);
  console.log(`  HIDDEN_ARCHIVE_DELETE_DAYS : ${HIDDEN_ARCHIVE_DELETE_DAYS || 'disabled'}`);
  console.log(`  STATS_FILE                 : ${STATS_FILE}`);
  console.log(`  STATS_SESSION_DAYS         : ${STATS_SESSION_DAYS}`);
  console.log(`  RELAY_API_TOKEN            : ${RELAY_API_TOKEN ? '(set)' : '(unset: control API answers 503)'}`);
  console.log(`  DELAY_SECONDS              : ${delaySeconds} (max ${DELAY_MAX_SECONDS})`);
  console.log(`  DELAYED_STREAM_URL         : ${DELAYED_STREAM_URL}`);
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
});
