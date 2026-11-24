// LCYT handoff manifest v1 for Saarnavideo (P5.4). Pure: no I/O, no clock reads.
//
// Shape and limits follow Saarnavideo's `lcytManifestSchema`
// (saarnavideo/src/domain/lcyt-manifest.ts, MANIFEST_VERSION 1). All times are
// milliseconds on the recording's timeline (t = 0 is the first frame of the
// first segment, which starts when the session starts). The manifest never
// carries credentials; the only secret-like part is the signature in a
// presigned URL that `urlFor` returns.

export const MANIFEST_VERSION = 1;
export const DEFAULT_SEGMENT_SECONDS = 60;

const CAPTION_FILE = /^captions\.([a-z]{2,3}(?:-[a-z0-9]{1,8})*)\.vtt$/;
const VARIABLE_KEY = /^[\p{L}\p{N}_-]{1,40}$/u;
const MAX_TITLE = 300;
const MAX_LABEL = 200;
const MAX_VARIABLE_VALUE = 500;
const MAX_VARIABLES = 100;

const iso = (ms) => new Date(ms).toISOString();

/** Stable broadcast id: one recording session = one Saarnavideo project. */
export function handoffGroupId(stream, sessionId) {
  return `${stream}-${sessionId}`;
}

/**
 * Parts of the single `clean` feed: one per uploaded segment. Segment N starts
 * N x segmentSeconds after the recording started (the recorder cuts every
 * segmentSeconds); every part lasts segmentSeconds except the last, which ends
 * where the session ended. A recorder restart can shift later segments by a
 * few seconds: the numbering is the only timing the segments carry.
 */
function partsOf(segments, { segmentSeconds, durationMs, urlFor }) {
  const segMs = segmentSeconds * 1000;
  return [...segments]
    .sort((a, b) => a.n - b.n)
    .map((seg) => {
      const startMs = seg.n * segMs;
      let len = segMs;
      if (durationMs != null) len = Math.min(segMs, Math.max(0, durationMs - startMs));
      return { ref: urlFor(seg.key), startMs, durationMs: len };
    });
}

/** Section events are the cue markers Saarnavideo cuts sections from; marker events stay plain markers. */
function markersOf(events, originMs) {
  const out = [];
  for (const e of events ?? []) {
    if (!e) continue;
    let kind;
    let label;
    if (e.type === 'section') {
      kind = 'cue';
      label = e.payload?.title;
    } else if (e.type === 'marker') {
      kind = 'marker';
      label = e.payload?.label;
    } else continue;
    if (typeof label !== 'string' || !Number.isFinite(e.startedAt)) continue;
    out.push({ atMs: Math.max(0, Math.round(e.startedAt - originMs)), kind, label: label.slice(0, MAX_LABEL) });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** `data` events as free key/value variables; the last value of a name wins. Names Saarnavideo would skip are left out here. */
function variablesOf(events) {
  const vars = {};
  const sorted = (events ?? []).filter((e) => e?.type === 'data').sort((a, b) => a.startedAt - b.startedAt);
  for (const e of sorted) {
    const { name, value } = e.payload ?? {};
    if (typeof name !== 'string' || !VARIABLE_KEY.test(name)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) vars[name] = value;
    else if (typeof value === 'string') vars[name] = value.slice(0, MAX_VARIABLE_VALUE);
  }
  return Object.fromEntries(Object.entries(vars).slice(0, MAX_VARIABLES));
}

/**
 * @param {object} p
 * @param {{ stream: string, sessionId: string, startedAt: number, endedAt: number|null }} p.session  epoch ms
 * @param {{ n: number, key: string, bytes?: number }[]} p.segments  uploaded segments (keys for urlFor)
 * @param {string[]} p.sidecars   sidecar file names of the session (`captions.<lang>.vtt`, ...)
 * @param {object[]} p.events     timeline events of the session (events.js shape)
 * @param {(key: string) => string} p.urlFor  object key (relative to the S3 prefix) -> http(s) URL
 * @param {string} [p.relayName]  instance name of this relay (origin.instance)
 * @param {string} [p.title]
 * @param {number} [p.segmentSeconds]
 * @returns {object} manifest v1
 */
export function buildHandoffManifest({
  session, segments, sidecars = [], events = [], urlFor, relayName, title, segmentSeconds = DEFAULT_SEGMENT_SECONDS,
}) {
  if (!session?.stream || !session?.sessionId || !Number.isFinite(session.startedAt)) {
    throw new TypeError('session needs stream, sessionId and startedAt');
  }
  if (typeof urlFor !== 'function') throw new TypeError('urlFor must be a function');
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('the recording has no segments');

  const { stream, sessionId, startedAt, endedAt } = session;
  const durationMs = Number.isFinite(endedAt) && endedAt > startedAt ? endedAt - startedAt : null;
  const prefix = `recordings/${stream}/${sessionId}/sidecars/`;

  const captions = [];
  for (const name of [...sidecars].sort()) {
    const m = CAPTION_FILE.exec(name);
    if (m) captions.push({ language: m[1], format: 'vtt', ref: urlFor(`${prefix}${name}`), origin: 'relay', alignedTo: 'clean' });
  }

  const feed = { role: 'clean', parts: partsOf(segments, { segmentSeconds, durationMs, urlFor }) };
  if (durationMs != null) feed.durationMs = durationMs;

  const manifest = {
    version: MANIFEST_VERSION,
    origin: { system: 'lcyt', groupId: handoffGroupId(stream, sessionId) },
    title: (title ?? `${stream} ${iso(startedAt).slice(0, 10)}`).slice(0, MAX_TITLE),
    startedAt: iso(startedAt),
    endedAt: endedAt != null ? iso(endedAt) : null,
    timeAlignment: 'recorded',
    feeds: [feed],
    captions,
    markers: markersOf(events, startedAt),
    variables: variablesOf(events),
  };
  if (relayName) manifest.origin.instance = relayName;
  return manifest;
}
