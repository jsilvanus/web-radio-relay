/**
 * Copy-only ffmpeg arguments that pull one relay stream and push it to one
 * RTMP(S) destination. Pure: the caller spawns ffmpeg with the result.
 */
import { assertStreamName, rtspInputArgs, DEFAULT_RTSP_BASE } from './ffmpeg-input.js';

const RTMP_URL = /^rtmps?:\/\/\S+$/i;

/**
 * @param {{ stream: string, variant?: 'raw'|'cc', url: string, key?: string, rtspBase?: string }} options
 * @returns {string[]}
 */
export function egressArgs({ stream, variant = 'raw', url, key, rtspBase = DEFAULT_RTSP_BASE } = {}) {
  assertStreamName(stream);
  if (variant !== 'raw' && variant !== 'cc') {
    throw new Error('invalid variant: expected raw or cc');
  }
  if (typeof url !== 'string' || !RTMP_URL.test(url)) {
    throw new Error('invalid url: expected rtmp:// or rtmps://');
  }
  const base = url.replace(/\/+$/, '');
  const target = key === undefined || key === null || key === '' ? base : `${base}/${key}`;

  return [
    ...rtspInputArgs(stream, { variant, rtspBase }),
    '-map', '0',
    '-c', 'copy',
    '-f', 'flv',
    target,
  ];
}
