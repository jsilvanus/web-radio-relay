// Parses `ffprobe -v error -show_streams -of json` output into the small shape the
// API returns. Pure: no I/O. Attached cover art (attached_pic) is not the picture
// and is skipped. Unknown or malformed fields become null, never a guess.

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);

/** "num/den" from ffprobe avg_frame_rate, rounded to 3 decimals; null for 0/0 or junk. */
export function parseFrameRate(value) {
  const m = /^(\d+)\/(\d+)$/.exec(typeof value === 'string' ? value.trim() : '');
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (num <= 0 || den <= 0) return null;
  return Math.round((num / den) * 1000) / 1000;
}

function videoOf(stream) {
  return {
    codec: text(stream.codec_name),
    width: toNumber(stream.width),
    height: toNumber(stream.height),
    fps: parseFrameRate(stream.avg_frame_rate),
  };
}

function audioOf(stream) {
  return {
    codec: text(stream.codec_name),
    sampleRate: toNumber(stream.sample_rate),
    channels: toNumber(stream.channels),
  };
}

/**
 * @param {string | object} input ffprobe JSON, as text or already parsed
 * @returns {{ video: object | null, audio: object | null } | null} null when the input is not ffprobe output
 */
export function parseProbe(input) {
  let data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input); } catch { return null; }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.streams)) return null;
  const streams = data.streams.filter(
    (s) => s && typeof s === 'object' && s.disposition?.attached_pic !== 1,
  );
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  return {
    video: video ? videoOf(video) : null,
    audio: audio ? audioOf(audio) : null,
  };
}
