/**
 * Live CEA-608 FLV caption embedder (P9.6).
 *
 * Owns the two copy-only FFmpeg children for each enabled stream. The first
 * reads MediaMTX's raw RTSP path to FLV stdout; Node holds tags long enough for
 * late captions, inserts A/53 SEI into AVC access units, then pipes the FLV to
 * the second FFmpeg which publishes the -cc RTMP path.
 */
import { createFlvParser, parseVideoTag, buildVideoTag, writeFlvHeader, writeTag, TAG_VIDEO, AVC_NALU } from './flv.js';
import { createHoldBuffer } from './hold-buffer.js';
import { createCaptioner } from './captioner.js';
import { a53SeiNal } from './cc-data.js';
import { performance } from 'node:perf_hooks';

const DEFAULT_CONFIG = Object.freeze({ enabled: false, lang: 'fi', holdSeconds: 16, syncOffsetMs: 1500 });
const SUPPORTED_FPS = new Set([25, 30, 50]);

function checkedConfig(value = {}, defaults = DEFAULT_CONFIG) {
  const config = { ...defaults, ...(value || {}) };
  if (typeof config.enabled !== 'boolean') throw new TypeError('captioner.enabled must be boolean');
  if (typeof config.lang !== 'string' || !/^[a-z]{2,3}(-[a-z0-9]{1,8})*$/.test(config.lang)) {
    throw new TypeError('captioner.lang must be a language tag');
  }
  if (!Number.isFinite(config.holdSeconds) || config.holdSeconds < 1 || config.holdSeconds > 60) {
    throw new TypeError('captioner.holdSeconds must be 1-60');
  }
  if (!Number.isInteger(config.syncOffsetMs) || config.syncOffsetMs < -10000 || config.syncOffsetMs > 10000) {
    throw new TypeError('captioner.syncOffsetMs must be an integer -10000..10000');
  }
  return config;
}

/**
 * Add the scheduler's 608 pairs to one FLV AVC video tag. PTS (not DTS) chooses
 * the caption frame, while the caller still writes tags in decode order.
 */
export function embedCaptionFrame({ data, timestamp, scheduler, fps, wallTimeMs, syncOffsetMs = 0 }) {
  const video = parseVideoTag(data);
  if (video.codecId !== 7 || video.avcPacketType !== AVC_NALU || video.nalus.length === 0) return data;
  const ptsMs = timestamp + video.compositionTime;
  const frameIndex = Math.max(0, Math.round((ptsMs * fps) / 1000));
  const pairs = scheduler.pairsForFrame(frameIndex, wallTimeMs + video.compositionTime - syncOffsetMs);
  const sei = a53SeiNal(pairs, { count: scheduler.ccCount });
  // Prefix SEI belongs after AUD/SPS/PPS and before the first VCL NAL.
  const firstSlice = video.nalus.findIndex((nalu) => {
    const type = nalu[0] & 0x1f;
    return type >= 1 && type <= 5;
  });
  const at = firstSlice < 0 ? video.nalus.length : firstSlice;
  const nalus = [...video.nalus.slice(0, at), sei, ...video.nalus.slice(at)];
  return buildVideoTag({ ...video, nalus });
}

function frameRate(probe) {
  const value = probe?.video?.fps;
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return SUPPORTED_FPS.has(rounded) && Math.abs(value - rounded) < 0.1 ? rounded : null;
}

/**
 * @param {object} options
 * @param {Function} options.spawnProcess child_process.spawn
 * @param {(stream: string) => object|null} options.getProbe
 * @param {(stream: string) => Promise<object|null>} [options.probe]
 * @param {object} options.bus createEventBus() instance
 * @param {string} [options.rtspBase]
 * @param {string} [options.rtmpBase]
 * @param {string} [options.secret]
 * @param {number} [options.defaultHoldSeconds]
 * @param {number} [options.defaultSyncOffsetMs]
 * @param {Function} [options.now]
 * @param {Function} [options.log]
 */
export function createCaptionerService({
  spawnProcess,
  getProbe = () => null,
  probe = null,
  bus,
  rtspBase = 'rtsp://mediamtx:8554',
  rtmpBase = 'rtmp://mediamtx:1935',
  secret = '',
  defaultHoldSeconds = 16,
  defaultSyncOffsetMs = 1500,
  // Epoch-aligned monotonic time: avoids NTP wall-clock steps while staying comparable to Pi timestamps.
  now = () => performance.timeOrigin + performance.now(),
  log = () => {},
} = {}) {
  if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess is required');
  if (!bus || typeof bus.subscribe !== 'function') throw new TypeError('event bus is required');
  const sessions = new Map();
  const active = new Map();
  const live = new Set();
  const serviceDefaults = { ...DEFAULT_CONFIG, holdSeconds: defaultHoldSeconds, syncOffsetMs: defaultSyncOffsetMs };

  const urlFor = (base, path) => `${base.replace(/\/$/, '')}/${path}`;

  function state(stream) {
    const session = sessions.get(stream);
    if (!session) return {
      stream, state: live.has(stream) && active.get(stream)?.enabled ? 'waiting' : 'off', running: false,
      holdSeconds: active.get(stream)?.holdSeconds ?? defaultHoldSeconds,
      captionsEmbedded: 0, lateCount: 0, replacedCharacters: 0, error: null,
    };
    const stats = session.scheduler?.stats() ?? {};
    return {
      stream, state: session.state, running: session.state === 'running',
      holdSeconds: session.config.holdSeconds,
      captionsEmbedded: stats.embedded ?? 0,
      lateCount: stats.late ?? 0,
      lateMsMax: stats.lateMsMax ?? 0,
      replacedCharacters: stats.replacedChars ?? 0,
      pendingCaptions: stats.pending ?? 0,
      error: session.error,
    };
  }

  function stop(stream, reason = 'stopped') {
    const session = sessions.get(stream);
    if (!session) return state(stream);
    sessions.delete(stream);
    session.unsubscribe?.();
    if (session.timer) clearTimeout(session.timer);
    session.hold?.clear();
    session.stopping = true;
    for (const child of [session.input, session.output]) {
      try { child?.kill('SIGTERM'); } catch { /* already exited */ }
    }
    try { session.output?.stdin?.end(); } catch { /* already closed */ }
    log(`captioner ${stream}: ${reason}`);
    return { stream, state: 'off', running: false };
  }

  function start(stream, configValue) {
    const config = checkedConfig(configValue, serviceDefaults);
    active.set(stream, config);
    if (!config.enabled) {
      stop(stream, 'disabled');
      return state(stream);
    }
    if (sessions.has(stream)) stop(stream, 'reconfiguring');

    const probeInfo = getProbe(stream);
    const fps = frameRate(probeInfo);
    if (!fps || probeInfo?.video?.codec !== 'h264') {
      const message = !probeInfo?.video
        ? 'video probe is unavailable'
        : `captioner requires H.264 at 25/30/50/60 fps (got ${probeInfo.video.codec || 'unknown'} @ ${probeInfo.video.fps ?? 'unknown'})`;
      sessions.set(stream, { config, state: 'failed', error: message });
      log(`captioner ${stream}: ${message}`);
      return state(stream);
    }

    const parser = createFlvParser();
    const hold = createHoldBuffer({ holdMs: config.holdSeconds * 1000, now });
    const scheduler = createCaptioner({ fps });
    const session = {
      config, fps, parser, hold, scheduler, input: null, output: null,
      timer: null, unsubscribe: null, state: 'starting', error: null,
      stopping: false,
    };
    sessions.set(stream, session);

    const inputUrl = urlFor(rtspBase, `live/${stream}`);
    let publishUrl;
    try {
      publishUrl = new URL(urlFor(rtmpBase, `live/${stream}-cc`));
    } catch {
      session.state = 'failed';
      session.error = 'MEDIAMTX_RTMP_BASE is not a valid URL';
      return state(stream);
    }
    if (!secret) {
      session.state = 'failed';
      session.error = 'HOOK_SECRET is not configured';
      return state(stream);
    }
    publishUrl.searchParams.set('secret', secret);

    try {
      session.input = spawnProcess('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp',
        '-i', inputUrl, '-map', '0', '-c', 'copy', '-f', 'flv', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      session.output = spawnProcess('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'flv', '-i', 'pipe:0',
        '-map', '0', '-c', 'copy', '-f', 'flv', publishUrl.toString(),
      ], { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (err) {
      session.state = 'failed';
      session.error = String(err?.message || err);
      stop(stream, 'spawn failed');
      sessions.set(stream, { config, state: 'failed', error: session.error });
      return state(stream);
    }

    const fail = (err) => {
      if (session.stopping || sessions.get(stream) !== session) return;
      session.error = String(err?.message || err || 'FFmpeg exited');
      session.state = 'failed';
      stop(stream, 'ffmpeg failed');
      sessions.set(stream, { config, state: 'failed', error: session.error });
    };
    session.input.once('error', fail);
    session.output.once('error', fail);
    session.input.stdout.once('error', fail);
    session.output.stdin.once('error', fail);
    session.input.once('close', (code) => { if (!session.stopping && code !== 0) fail(new Error(`input ffmpeg exited ${code}`)); });
    session.output.once('close', (code) => { if (!session.stopping && code !== 0) fail(new Error(`output ffmpeg exited ${code}`)); });

    const write = (buffer) => {
      if (session.output?.stdin?.writable && !session.output.stdin.destroyed) {
        if (!session.output.stdin.write(buffer)) session.input?.stdout?.pause();
      }
    };
    session.output.stdin.on('drain', () => session.input?.stdout?.resume());

    function release(nowMs = now()) {
      if (sessions.get(stream) !== session || session.stopping) return;
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
      const due = hold.due(nowMs);
      for (const entry of due) {
        const item = entry.item;
        if (item.kind !== 'tag') continue;
        let data = item.data;
        if (item.type === TAG_VIDEO) {
          const before = scheduler.stats().embedded;
          data = embedCaptionFrame({
            data, timestamp: item.timestamp, scheduler, fps,
            wallTimeMs: entry.wallTimeMs, syncOffsetMs: config.syncOffsetMs,
          });
          if (scheduler.stats().embedded > before) session.embeddedAt = item.timestamp;
        }
        write(writeTag({ ...item, data }));
      }
      const next = hold.nextDueAt();
      if (next !== null && Number.isFinite(nowMs)) {
        session.timer = setTimeout(release, Math.max(0, next - now()));
        session.timer.unref?.();
      }
    }

    session.input.stdout.on('data', (chunk) => {
      try {
        for (const item of parser.push(chunk)) {
          if (item.kind === 'header') {
            write(writeFlvHeader({ audio: item.audio, video: item.video, version: item.version, dataOffset: item.dataOffset }));
          } else {
            hold.push(item, item.timestamp);
          }
        }
        release();
      } catch (err) { fail(err); }
    });
    session.input.stdout.once('end', () => {
      // Drain through the same embed path; the final frames must not lose their captions.
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
      release(Number.POSITIVE_INFINITY);
      try { session.output?.stdin?.end(); } catch { /* closed */ }
    });

    session.unsubscribe = bus.subscribe(stream, (rows) => {
      for (const row of rows) {
        if (row.type !== 'caption' || row.lang !== config.lang) continue;
        const payload = row.payload || {};
        if (payload.final === false || typeof payload.text !== 'string' || !payload.text.trim()) continue;
        try {
          scheduler.addCaption({
            text: payload.text,
            startedAtMs: row.startedAt,
            endedAtMs: row.endedAt,
          });
        } catch (err) {
          log(`captioner ${stream}: caption rejected: ${String(err?.message || err)}`);
        }
      }
    });
    session.state = 'running';
    log(`captioner ${stream}: started at ${fps} fps, hold ${config.holdSeconds}s`);
    return state(stream);
  }

  async function ready(stream, configValue) {
    const config = checkedConfig(configValue, serviceDefaults);
    active.set(stream, config);
    live.add(stream);
    if (!config.enabled) return state(stream);
    let probeInfo = getProbe(stream);
    if ((!probeInfo?.video || !frameRate(probeInfo)) && typeof probe === 'function') {
      try { probeInfo = await probe(stream); } catch { /* reported by start() */ }
    }
    return start(stream, config);
  }

  async function configure(stream, configValue) {
    const config = checkedConfig(configValue);
    active.set(stream, config);
    if (live.has(stream)) {
      if (config.enabled) {
        const probeInfo = getProbe(stream);
        if ((!probeInfo?.video || !frameRate(probeInfo)) && typeof probe === 'function') {
          try { await probe(stream); } catch { /* start() returns the useful status */ }
        }
        return start(stream, config);
      }
      stop(stream, 'disabled');
    }
    return state(stream);
  }

  function notready(stream) {
    live.delete(stream);
    active.delete(stream);
    return stop(stream, 'source not ready');
  }

  function close() {
    for (const stream of [...sessions.keys()]) stop(stream, 'service shutdown');
    active.clear();
    live.clear();
  }

  return { ready, notready, configure, start, stop, state, close };
}

export { DEFAULT_CONFIG as DEFAULT_CAPTIONER_CONFIG };
