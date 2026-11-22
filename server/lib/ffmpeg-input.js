/**
 * Shared input side of the copy-only ffmpeg argument builders (egress, recorder, HLS).
 * Pure: no I/O, no clock reads.
 */

export const DEFAULT_RTSP_BASE = 'rtsp://mediamtx:8554';

const STREAM_NAME = /^[a-z0-9_-]{1,32}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** @param {unknown} stream @returns {string} the stream name, or throws */
export function assertStreamName(stream) {
  if (typeof stream !== 'string' || !STREAM_NAME.test(stream)) {
    throw new Error('invalid stream name: expected [a-z0-9_-]{1,32}');
  }
  return stream;
}

/** @param {unknown} value @param {string} label @returns {string} */
export function assertPathSegment(value, label) {
  if (typeof value !== 'string' || !PATH_SEGMENT.test(value)) {
    throw new Error(`invalid ${label}: expected [A-Za-z0-9_-]{1,64}`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @returns {number} */
export function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid ${label}: expected a positive integer`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @returns {string} the value without trailing slashes */
export function assertDirectory(value, label) {
  if (typeof value !== 'string' || value.replace(/\/+$/, '') === '') {
    throw new Error(`invalid ${label}: expected a non-empty path`);
  }
  return value.replace(/\/+$/, '');
}

/** Input flags shared by every builder that reads the relay. */
const LOG_FLAGS = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];

/**
 * RTSP input of a relay stream (the raw or the captioned variant).
 * @returns {string[]}
 */
export function rtspInputArgs(stream, { variant = 'raw', rtspBase = DEFAULT_RTSP_BASE } = {}) {
  const base = String(rtspBase).replace(/\/+$/, '');
  const suffix = variant === 'cc' ? '-cc' : '';
  return [
    ...LOG_FLAGS,
    '-rtsp_transport', 'tcp',
    '-rw_timeout', '10000000',
    '-i', `${base}/live/${stream}${suffix}`,
  ];
}

/**
 * Input for the recorder and HLS builders: the RTSP stream, or a file when
 * `inputArgs.input` is given (test hook; drops the RTSP flags).
 * @returns {string[]}
 */
export function streamInputArgs({ stream, rtspBase, inputArgs }) {
  if (inputArgs === undefined) return rtspInputArgs(stream, { rtspBase });
  if (!inputArgs || typeof inputArgs.input !== 'string' || inputArgs.input === '') {
    throw new Error('inputArgs.input must be a file path');
  }
  return [...LOG_FLAGS, '-i', inputArgs.input];
}
