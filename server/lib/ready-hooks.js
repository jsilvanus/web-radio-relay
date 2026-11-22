// Decisions for MediaMTX runOnReady / runOnNotReady hooks.
// parseHookPath is pure. createReadyHandler takes its collaborators (supervisor,
// probe, log) as arguments, so tests pass fakes. The handlers never throw: MediaMTX
// does not retry a hook, so every failure is logged (redacted) and answered.

import { isValidStreamName } from './streams.js';
import { redact } from './redact.js';

// Same language as the MediaMTX path regex in mediamtx.yml. The name group is lazy
// so "-cc" is captured as the captioner suffix, not part of the name.
const HOOK_PATH_RE = /^live\/([a-z0-9_-]{1,32}?)(-cc)?$/;

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
 * @param {{ supervisor: { start(name: string): Promise<unknown>, stop(name: string): Promise<unknown> },
 *           probe: { probe(name: string): Promise<unknown>, clear(name: string): void },
 *           radioOnReady?: boolean, log?: (message: string) => void }} deps
 * @returns {{ ready(path: string): Promise<{ action: string, stream?: string }>,
 *             notready(path: string): Promise<{ action: string, stream?: string }> }}
 */
export function createReadyHandler({ supervisor, probe, radioOnReady = true, log = () => {} }) {
  const describe = (err) => redact(String(err?.message || err));

  // Not awaited: a probe can take up to its timeout and MediaMTX waits for the answer.
  // probe() never rejects by contract; the catch only guards a broken fake or override.
  const probeInBackground = (name) => {
    Promise.resolve().then(() => probe.probe(name)).catch(() => {});
  };

  return {
    /** A live/<name> source is ready: start the radio pull (when on) and probe the input. */
    async ready(path) {
      const hook = parseHookPath(path);
      if (!hook || hook.captioner) return { action: 'ignored' };
      probeInBackground(hook.stream);
      if (!radioOnReady) return { action: 'ignored', stream: hook.stream };
      try {
        await supervisor.start(hook.stream);
      } catch (err) {
        log(`ready ${hook.stream}: radio start failed: ${describe(err)}`);
        return { action: 'error', stream: hook.stream };
      }
      return { action: 'start', stream: hook.stream };
    },

    /** A live/<name> source dropped: forget the probe and stop the radio pull. */
    async notready(path) {
      const hook = parseHookPath(path);
      if (!hook || hook.captioner) return { action: 'ignored' };
      probe.clear(hook.stream);
      try {
        await supervisor.stop(hook.stream);
      } catch (err) {
        log(`notready ${hook.stream}: radio stop failed: ${describe(err)}`);
        return { action: 'error', stream: hook.stream };
      }
      return { action: 'stop', stream: hook.stream };
    },
  };
}
