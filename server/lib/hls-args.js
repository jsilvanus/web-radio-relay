/**
 * Copy-only ffmpeg arguments that package one relay stream as a rolling HLS
 * (MPEG-TS) playlist with program date times. Pure: no I/O, no clock reads.
 */
import {
  assertStreamName, assertPositiveInteger, assertDirectory, streamInputArgs,
} from './ffmpeg-input.js';

/**
 * @param {{ stream: string, hlsDir: string, hlsTime?: number, listSize?: number,
 *   rtspBase?: string, inputArgs?: { input: string } }} options
 * @returns {string[]}
 */
export function hlsArgs({
  stream, hlsDir, hlsTime = 4, listSize = 30, rtspBase, inputArgs,
} = {}) {
  assertStreamName(stream);
  const dir = `${assertDirectory(hlsDir, 'hlsDir')}/${stream}/video`;
  assertPositiveInteger(hlsTime, 'hlsTime');
  assertPositiveInteger(listSize, 'listSize');

  return [
    ...streamInputArgs({ stream, rtspBase, inputArgs }),
    '-map', '0',
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', String(hlsTime),
    '-hls_list_size', String(listSize),
    '-hls_flags', 'program_date_time+delete_segments+independent_segments+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', `${dir}/%d.ts`,
    `${dir}/stream.m3u8`,
  ];
}

/**
 * Playlist length that keeps every segment the delayed playlist may need.
 * @param {number} delayMaxSeconds
 * @param {number} hlsTime segment length in seconds
 * @returns {number}
 */
export function listSizeFor(delayMaxSeconds, hlsTime) {
  if (!Number.isFinite(delayMaxSeconds) || delayMaxSeconds < 0) {
    throw new Error('invalid delayMaxSeconds: expected a finite number >= 0');
  }
  assertPositiveInteger(hlsTime, 'hlsTime');
  return Math.max(10, Math.ceil(delayMaxSeconds / hlsTime) + 10);
}
