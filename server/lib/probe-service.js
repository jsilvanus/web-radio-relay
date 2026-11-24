// Runs ffprobe on a stream's source and keeps the last result in memory.
// I/O wiring: spawnProcess is injected (child_process.spawn in index.js, a fake in
// tests). probe() never throws and never rejects; a failed or timed-out probe
// stores null. ffprobe's stderr is discarded, so no URL or secret reaches a log.

import { parseProbe } from './probe.js';
import { redact } from './redact.js';

const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * @param {{ spawnProcess: Function, urlFor: (stream: string) => string,
 *           timeoutMs?: number, log?: (message: string) => void }} options
 */
export function createProbeService({ spawnProcess, urlFor, timeoutMs = 10000, log = () => {} }) {
  const results = new Map();
  // Bumped by clear(): a probe that was running for a stream that went away
  // (notready) must not store its late answer.
  const generations = new Map();
  const generationOf = (stream) => generations.get(stream) ?? 0;

  /** Runs ffprobe once; resolves the parsed result, or null on any failure. */
  function runFfprobe(url) {
    return new Promise((resolve) => {
      let settled = false;
      let output = '';
      let child = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { child?.kill('SIGKILL'); } catch { /* already gone */ }
        finish(null);
      }, timeoutMs);
      try {
        // -rtsp_transport tcp: the MediaMTX config only accepts RTSP over TCP.
        child = spawnProcess(
          'ffprobe',
          ['-v', 'error', '-rtsp_transport', 'tcp', '-show_streams', '-of', 'json', url],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        );
      } catch {
        finish(null);
        return;
      }
      child.stdout?.on('data', (chunk) => {
        if (output.length < MAX_OUTPUT_BYTES) output += chunk;
      });
      child.once('error', () => finish(null));
      child.once('close', (code) => finish(code === 0 ? parseProbe(output) : null));
    });
  }

  return {
    /** Probes the stream's source now and stores the result. Resolves it (or null). */
    async probe(stream) {
      let url = '';
      try {
        url = urlFor(stream);
        if (!url) return null;
        const generation = generationOf(stream);
        const result = await runFfprobe(url);
        if (generationOf(stream) !== generation) return null;
        if (result) results.set(stream, result);
        else results.delete(stream);
        return result;
      } catch (err) {
        log(`probe ${stream} failed: ${redact(String(err?.message || err), [url])}`);
        return null;
      }
    },

    /** The last stored probe of a stream, or null when unknown. */
    get(stream) {
      return results.get(stream) ?? null;
    },

    /** Forgets a stream's probe and cancels any probe still running for it. */
    clear(stream) {
      generations.set(stream, generationOf(stream) + 1);
      results.delete(stream);
    },
  };
}
