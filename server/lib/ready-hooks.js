// Decisions for MediaMTX runOnReady / runOnNotReady hooks.
// parseHookPath is pure. createReadyHandler takes its collaborators as arguments, so
// tests pass fakes. The handlers never throw: MediaMTX does not retry a hook, so every
// failure is logged (redacted), listed in `failed` and answered. Each action is
// independent: one failing does not stop the others.

import { isValidStreamName } from './streams.js';
import { redact } from './redact.js';

// Same language as the MediaMTX path regex in mediamtx.yml. The name group is lazy
// so "-cc" is captured as the captioner suffix, not part of the name.
const HOOK_PATH_RE = /^live\/([a-z0-9_-]{1,32}?)(-cc)?$/;
const ACTIVE_RECORDING = new Set(['recording', 'degraded', 'failed']);

/**
 * Parses a MediaMTX path such as `live/<name>` or `live/<name>-cc`.
 * Returns { stream, captioner } or null for anything else.
 */
export function parseHookPath(path) {
  if (typeof path !== 'string') return null;
  const match = HOOK_PATH_RE.exec(path);
  if (!match || !isValidStreamName(match[1])) return null;
  return { stream: match[1], captioner: match[2] === '-cc' };
}

/**
 * @param {object} deps
 * @param {{ start(name: string): unknown, stop(name: string): unknown }} deps.supervisor radio pull
 * @param {{ probe(name: string): Promise<unknown>, clear(name: string): void }} deps.probe
 * @param {boolean | ((stream: string) => boolean)} [deps.radioOnReady] RADIO_ON_READY and the stream's `radio`
 * @param {(message: string) => void} [deps.log]
 * @param {{ start(stream: string, dest: object): unknown, stop(stream: string, id: string): unknown,
 *           stopStream(stream: string): unknown, state(stream: string): Array<{ state: string }> }} [deps.egress]
 *   egress supervisor (P4.3)
 * @param {(stream: string) => string[]} [deps.listStartable] ids of the destinations with enabled and startWith 'stream'
 * @param {(stream: string, id: string) => object} [deps.loadTarget] decrypted egress target (loadEgressTarget); may throw
 * @param {{ start(stream: string): unknown, stop(stream: string): unknown, state(stream: string): { state: string } }} [deps.hls]
 *   video HLS packager (hls-packager.js), started when config.videoHls is on
 * @param {{ start(stream: string): unknown, stop(stream: string): Promise<unknown>,
 *           state(stream: string): { state: string } | null }} [deps.recordings]
 *   recording service (recording-service.js), started when config.recordOnLive is on and S3 is configured
 * @param {boolean} [deps.s3Configured]
 * @param {{ ready(stream: string, config: object): Promise<object>, notready(stream: string): object }} [deps.captioner]
 * @param {(stream: string) => { videoHls: boolean, recordOnLive: boolean }} [deps.getConfig]
 * @returns {{ ready(path: string): Promise<object>, notready(path: string): Promise<object> }}
 *   Without egress, hls or recordings the answer is the legacy `{ action, stream }`. With any of them it
 *   also carries `radio`, `destinations` (a count), `hls`, `recording` and `failed` (names of failed actions).
 */
export function createReadyHandler({
  supervisor,
  probe,
  radioOnReady = true,
  log = () => {},
  egress = null,
  listStartable = () => [],
  loadTarget = null,
  hls = null,
  recordings = null,
  s3Configured = false,
  getConfig = null,
  captioner = null,
}) {
  const extended = Boolean(egress || hls || recordings || captioner);
  const describe = (err, secrets = []) => redact(String(err?.message || err), secrets);

  // Not awaited: a probe can take up to its timeout and MediaMTX waits for the answer.
  // probe() never rejects by contract; the catch only guards a broken fake or override.
  const probeInBackground = (name) => {
    Promise.resolve().then(() => probe.probe(name)).catch(() => {});
  };

  // Radio: 'start' | 'stop' | 'ignored' | 'error'.
  async function radioStart(stream) {
    let radioOn;
    try {
      radioOn = typeof radioOnReady === 'function' ? radioOnReady(stream) : radioOnReady;
    } catch (err) {
      log(`ready ${stream}: radio setting unreadable: ${describe(err)}`);
      return 'error';
    }
    if (!radioOn) return 'ignored';
    try {
      await supervisor.start(stream);
      return 'start';
    } catch (err) {
      log(`ready ${stream}: radio start failed: ${describe(err)}`);
      return 'error';
    }
  }

  async function radioStop(stream) {
    try {
      await supervisor.stop(stream);
      return 'stop';
    } catch (err) {
      log(`notready ${stream}: radio stop failed: ${describe(err)}`);
      return 'error';
    }
  }

  /** Starts every startable destination. Returns the count started; failures go to `failed`. */
  function startDestinations(stream, failed) {
    let ids;
    try {
      ids = listStartable(stream);
    } catch (err) {
      log(`ready ${stream}: destinations unreadable: ${describe(err)}`);
      failed.push('destinations');
      return 0;
    }
    let started = 0;
    for (const id of ids) {
      let target = null;
      try {
        target = loadTarget(stream, id);
        if (target.enabled === false || target.startWith === 'manual') continue;
        egress.start(stream, target);
        started++;
      } catch (err) {
        log(`ready ${stream}: destination ${id} not started: ${describe(err, [target?.key])}`);
        failed.push(`destination:${id}`);
      }
    }
    return started;
  }

  function startHls(stream, config, failed) {
    if (!hls || !config.videoHls) return 'ignored';
    try {
      hls.start(stream);
      return 'start';
    } catch (err) {
      log(`ready ${stream}: video HLS start failed: ${describe(err)}`);
      failed.push('hls');
      return 'error';
    }
  }


  async function startCaptioner(stream, config, failed) {
    if (!captioner) return 'ignored';
    try {
      const result = await captioner.ready(stream, config.captioner || { enabled: false });
      if (result?.state === 'failed') failed.push('captioner');
      return result?.state || 'unknown';
    } catch (err) {
      log('ready ' + stream + ': captioner start failed: ' + describe(err));
      failed.push('captioner');
      return 'error';
    }
  }

  function stopCaptioner(stream, failed) {
    if (!captioner) return 'ignored';
    try {
      const result = captioner.notready(stream);
      return result?.state || 'stop';
    } catch (err) {
      log('notready ' + stream + ': captioner stop failed: ' + describe(err));
      failed.push('captioner');
      return 'error';
    }
  }

  function startRecording(stream, config, failed) {
    if (!recordings || !config.recordOnLive) return 'ignored';
    if (!s3Configured) {
      log(`ready ${stream}: recordOnLive is on but S3 is not configured: not recording`);
      return 'ignored';
    }
    try {
      recordings.start(stream);
      return 'start';
    } catch (err) {
      log(`ready ${stream}: recording start failed: ${describe(err)}`);
      failed.push('recording');
      return 'error';
    }
  }

  function stopHls(stream, failed) {
    if (!hls) return 'ignored';
    try {
      const current = hls.state(stream);
      if (!current || current.state === 'off') return 'ignored';
      hls.stop(stream);
      return 'stop';
    } catch (err) {
      log(`notready ${stream}: video HLS stop failed: ${describe(err)}`);
      failed.push('hls');
      return 'error';
    }
  }

  async function stopRecording(stream, failed) {
    if (!recordings) return 'ignored';
    try {
      const current = recordings.state(stream);
      if (!current || !ACTIVE_RECORDING.has(current.state)) return 'ignored';
      await recordings.stop(stream);
      return 'stop';
    } catch (err) {
      log(`notready ${stream}: recording stop failed: ${describe(err)}`);
      failed.push('recording');
      return 'error';
    }
  }

  return {
    /**
     * A live/<name> source is ready: start the radio pull, the startable destinations, video HLS
     * and the recording (each only when on), and probe the input.
     */
    async ready(path) {
      const hook = parseHookPath(path);
      if (!hook || hook.captioner) return { action: 'ignored' };
      const { stream } = hook;
      probeInBackground(stream);

      const radio = await radioStart(stream);
      if (!extended) return { action: radio, stream };

      const failed = [];
      if (radio === 'error') failed.push('radio');

      let config = { videoHls: false, recordOnLive: false };
      let configOk = true;
      if (getConfig) {
        try {
          config = getConfig(stream);
        } catch (err) {
          configOk = false;
          log(`ready ${stream}: stream config unreadable: ${describe(err)}`);
          failed.push('config');
        }
      }

      const destinations = egress ? startDestinations(stream, failed) : 0;
      const hlsState = configOk ? startHls(stream, config, failed) : 'error';
      const recording = configOk ? startRecording(stream, config, failed) : 'error';
      const captionerState = configOk ? await startCaptioner(stream, config, failed) : 'error';

      const started = radio === 'start' || destinations > 0 || hlsState === 'start' || recording === 'start' || captionerState === 'running';
      const action = failed.length ? 'error' : started ? 'start' : 'ignored';
      return { action, stream, radio, destinations, hls: hlsState, recording, captioner: captionerState, failed };
    },

    /**
     * A live/<name> source dropped: stop the radio pull, the stream's destinations, video HLS and
     * the recording (the recording uploads what is left in the spool).
     */
    async notready(path) {
      const hook = parseHookPath(path);
      if (!hook || hook.captioner) return { action: 'ignored' };
      const { stream } = hook;
      probe.clear(stream);

      const captionerState = stopCaptioner(stream, []);
      const radio = await radioStop(stream);
      if (!extended) return radio === 'error' ? { action: 'error', stream } : { action: 'stop', stream };

      const failed = [];
      if (radio === 'error') failed.push('radio');

      let destinations = 0;
      if (egress) {
        try {
          destinations = egress.state(stream).filter((d) => d.state !== 'off').length;
          egress.stopStream(stream);
        } catch (err) {
          log(`notready ${stream}: destinations stop failed: ${describe(err)}`);
          failed.push('destinations');
        }
      }

      const hlsState = stopHls(stream, failed);
      const recording = await stopRecording(stream, failed);
      const action = failed.length ? 'error' : 'stop';
      return { action, stream, radio, destinations, hls: hlsState, recording, captioner: captionerState, failed };
    },
  };
}
