/**
 * Copy-only ffmpeg arguments that record one relay stream as fragmented MP4
 * segments into a spool directory, plus the rule for which segments are safe
 * to upload. Pure: no I/O.
 */
import {
  assertStreamName, assertPathSegment, assertPositiveInteger, assertDirectory, streamInputArgs,
} from './ffmpeg-input.js';

const SEGMENT_FILE = /^\d{6}\.mp4$/;

/**
 * @param {{ stream: string, spoolDir: string, sessionId: string, segmentSeconds?: number,
 *   rtspBase?: string, inputArgs?: { input: string } }} options
 * @returns {string[]}
 */
export function recorderArgs({
  stream, spoolDir, sessionId, segmentSeconds = 60, rtspBase, inputArgs,
} = {}) {
  assertStreamName(stream);
  const dir = assertDirectory(spoolDir, 'spoolDir');
  assertPathSegment(sessionId, 'sessionId');
  assertPositiveInteger(segmentSeconds, 'segmentSeconds');

  return [
    ...streamInputArgs({ stream, rtspBase, inputArgs }),
    '-map', '0',
    '-c', 'copy',
    '-f', 'segment',
    '-segment_time', String(segmentSeconds),
    '-segment_format', 'mp4',
    '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof',
    '-reset_timestamps', '1',
    `${dir}/${sessionId}/%06d.mp4`,
  ];
}

/**
 * Segments that ffmpeg has finished writing: every `NNNNNN.mp4` name in order
 * except the newest one, which ffmpeg may still be writing. Other names are ignored.
 * @param {string[]} fileNames
 * @returns {string[]}
 */
export function closedSegments(fileNames) {
  const names = (fileNames || [])
    .filter((name) => typeof name === 'string' && SEGMENT_FILE.test(name))
    .sort();
  return names.slice(0, -1);
}
