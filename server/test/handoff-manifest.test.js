import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoffManifest, handoffGroupId } from '../lib/handoff-manifest.js';

const T0 = 1_700_000_000_000;
const urlFor = (key) => `https://s3.example.com/bucket/${key}?X-Amz-Signature=sig`;

/**
 * Hand transcription of Saarnavideo's `lcytManifestSchema`
 * (saarnavideo/src/domain/lcyt-manifest.ts, MANIFEST_VERSION = 1, as of 2026-11-22).
 * Returns a list of problems. Required/limit rules only; Zod's dropping of unknown
 * fields is not checked (we check that we send none by listing the allowed keys).
 */
function checkLcytManifestV1(m) {
  const errors = [];
  const isHttp = (v) => { try { return /^https?:\/\//i.test(v) && !!new URL(v); } catch { return false; } };
  const ms = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const only = (obj, keys, where) => {
    for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${where}: unknown key ${k}`);
  };
  const ROLES = ['clean', 'program', 'dsk'];

  only(m, ['version', 'origin', 'title', 'startedAt', 'endedAt', 'timeAlignment', 'feeds', 'captions', 'dskEvents', 'markers', 'variables'], 'manifest');
  if (m.version !== 1) errors.push('version must be 1');
  if (m.origin?.system !== 'lcyt') errors.push('origin.system must be "lcyt"');
  only(m.origin ?? {}, ['system', 'instance', 'broadcastId', 'videoId', 'groupId'], 'origin');
  for (const k of ['instance', 'broadcastId', 'videoId', 'groupId']) {
    const v = m.origin?.[k];
    if (v != null && typeof v !== 'string' && typeof v !== 'number') errors.push(`origin.${k} must be string|number`);
  }
  const id = m.origin?.groupId ?? m.origin?.videoId ?? m.origin?.broadcastId;
  if (id == null || String(id) === '') errors.push('no origin id (manifestExternalId would throw)');
  if (typeof m.title !== 'string' || m.title.length > 300) errors.push('title: string, max 300');
  for (const k of ['startedAt', 'endedAt']) if (m[k] != null && typeof m[k] !== 'string') errors.push(`${k} must be string|null`);
  if (m.timeAlignment !== undefined && typeof m.timeAlignment !== 'string') errors.push('timeAlignment must be string');

  if (!Array.isArray(m.feeds) || m.feeds.length < 1) errors.push('feeds: at least one');
  const roles = new Set();
  for (const [i, f] of (m.feeds ?? []).entries()) {
    only(f, ['role', 'aliasOf', 'parts', 'durationMs', 'width', 'height', 'fps', 'hasAlpha', 'key'], `feeds[${i}]`);
    if (!ROLES.includes(f.role)) errors.push(`feeds[${i}].role invalid`);
    if (roles.has(f.role)) errors.push(`feeds[${i}].role duplicate`);
    roles.add(f.role);
    if (f.aliasOf != null && !ROLES.includes(f.aliasOf)) errors.push(`feeds[${i}].aliasOf invalid`);
    if (f.aliasOf == null && !(f.parts?.length > 0)) errors.push(`feeds[${i}] needs parts or aliasOf`);
    if (f.durationMs !== undefined && !ms(f.durationMs)) errors.push(`feeds[${i}].durationMs`);
    for (const [j, p] of (f.parts ?? []).entries()) {
      only(p, ['ref', 'startMs', 'playlistStartMs', 'durationMs'], `feeds[${i}].parts[${j}]`);
      if (!isHttp(p.ref)) errors.push(`feeds[${i}].parts[${j}].ref must be http(s) URL`);
      if (!ms(p.startMs)) errors.push(`feeds[${i}].parts[${j}].startMs`);
      if (!ms(p.durationMs)) errors.push(`feeds[${i}].parts[${j}].durationMs`);
    }
  }
  if (!roles.has('clean')) errors.push('a clean feed is required');

  if (!Array.isArray(m.captions)) errors.push('captions must be an array (default [] only when absent)');
  for (const [i, c] of (m.captions ?? []).entries()) {
    only(c, ['language', 'format', 'ref', 'origin', 'alignedTo'], `captions[${i}]`);
    if (typeof c.language !== 'string' || c.language.length < 1 || c.language.length > 35) errors.push(`captions[${i}].language`);
    if (!isHttp(c.ref)) errors.push(`captions[${i}].ref must be http(s) URL`);
  }
  for (const [i, k] of (m.markers ?? []).entries()) {
    only(k, ['atMs', 'kind', 'label'], `markers[${i}]`);
    if (!ms(k.atMs)) errors.push(`markers[${i}].atMs`);
    if (typeof k.kind !== 'string' || k.kind.length > 40) errors.push(`markers[${i}].kind`);
    if (typeof k.label !== 'string' || k.label.length > 200) errors.push(`markers[${i}].label`);
  }
  for (const [k, v] of Object.entries(m.variables ?? {})) {
    if (typeof v !== 'string' && typeof v !== 'number') errors.push(`variables.${k} must be string|number`);
  }
  return errors;
}

function fixture(over = {}) {
  const sessionId = '20231114221320000-3f9a0c2b';
  const events = [
    { type: 'section', startedAt: T0 + 5000, payload: { title: 'Alkusoitto', index: 1 } },
    { type: 'section', startedAt: T0 + 65_000, payload: { title: 'Saarna' } },
    { type: 'marker', startedAt: T0 + 30_000, payload: { label: 'Tarkista ääni' } },
    { type: 'caption', lang: 'fi', startedAt: T0 + 1000, payload: { text: 'Hei' } },
    { type: 'data', startedAt: T0 + 1000, payload: { name: 'hymn', value: 'old' } },
    { type: 'data', startedAt: T0 + 2000, payload: { name: 'hymn', value: 'new' } },
    { type: 'data', startedAt: T0 + 2000, payload: { name: 'verse', value: 3 } },
    { type: 'data', startedAt: T0 + 2000, payload: { name: 'bad name!', value: 'x' } },
    { type: 'data', startedAt: T0 + 2000, payload: { name: 'obj', value: { a: 1 } } },
  ];
  return {
    session: { stream: 'main', sessionId, startedAt: T0, endedAt: T0 + 150_000 },
    segments: [2, 0, 1].map((n) => ({ n, key: `recordings/main/${sessionId}/${String(n).padStart(6, '0')}.mp4`, bytes: 10 })),
    sidecars: ['captions.sv.vtt', 'captions.fi.vtt', 'chapters.vtt', 'sections.json', 'events.jsonl'],
    events,
    urlFor,
    relayName: 'relay-a',
    ...over,
  };
}

test('a fixture session becomes a manifest that passes the transcribed Saarnavideo schema', () => {
  const input = fixture();
  const m = buildHandoffManifest(input);
  assert.deepEqual(checkLcytManifestV1(m), []);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m, 'plain JSON');

  assert.equal(m.version, 1);
  assert.deepEqual(m.origin, { system: 'lcyt', groupId: handoffGroupId('main', input.session.sessionId), instance: 'relay-a' });
  assert.equal(m.origin.groupId, `main-${input.session.sessionId}`);
  assert.equal(m.title, 'main 2023-11-14');
  assert.equal(m.startedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(m.endedAt, '2023-11-14T22:15:50.000Z');
  assert.equal(m.timeAlignment, 'recorded');
  assert.equal(m.dskEvents, undefined);

  assert.equal(m.feeds.length, 1);
  assert.equal(m.feeds[0].role, 'clean');
  assert.equal(m.feeds[0].durationMs, 150_000);
  assert.deepEqual(m.feeds[0].parts.map((p) => [p.startMs, p.durationMs]), [[0, 60000], [60000, 60000], [120000, 30000]]);
  assert.equal(m.feeds[0].parts[0].ref, urlFor(`recordings/main/${input.session.sessionId}/000000.mp4`));

  assert.deepEqual(m.captions.map((c) => [c.language, c.format, c.alignedTo]), [['fi', 'vtt', 'clean'], ['sv', 'vtt', 'clean']]);
  assert.equal(m.captions[0].ref, urlFor(`recordings/main/${input.session.sessionId}/sidecars/captions.fi.vtt`));

  assert.deepEqual(m.markers, [
    { atMs: 5000, kind: 'cue', label: 'Alkusoitto' },
    { atMs: 30000, kind: 'marker', label: 'Tarkista ääni' },
    { atMs: 65000, kind: 'cue', label: 'Saarna' },
  ]);
  assert.deepEqual(m.variables, { hymn: 'new', verse: 3 });
});

test('the manifest contains no credentials of its own: only what urlFor returned', () => {
  const m = buildHandoffManifest(fixture({ urlFor: (k) => `https://x.example.com/${k}` }));
  const text = JSON.stringify(m);
  assert.doesNotMatch(text, /secret|token|apikey|streamkey|password/i);
});

test('a session without an end time has no duration and a full-length last part', () => {
  const m = buildHandoffManifest(fixture({ session: { stream: 'main', sessionId: 's-1', startedAt: T0, endedAt: null } }));
  assert.equal(m.endedAt, null);
  assert.equal('durationMs' in m.feeds[0], false);
  assert.deepEqual(checkLcytManifestV1(m), []);
  assert.equal(m.feeds[0].parts.at(-1).durationMs, 60000);
});

test('a short recording gives one part cut at the session end; gaps in numbering keep their start', () => {
  const short = buildHandoffManifest(fixture({
    session: { stream: 'main', sessionId: 's-1', startedAt: T0, endedAt: T0 + 7000 },
    segments: [{ n: 0, key: 'k0' }],
  }));
  assert.deepEqual(short.feeds[0].parts.map((p) => [p.startMs, p.durationMs]), [[0, 7000]]);

  const gap = buildHandoffManifest(fixture({ segments: [{ n: 0, key: 'k0' }, { n: 2, key: 'k2' }] }));
  assert.deepEqual(gap.feeds[0].parts.map((p) => p.startMs), [0, 120000]);
});

test('segmentSeconds, title and no relayName are honoured; limits are applied', () => {
  const m = buildHandoffManifest(fixture({
    relayName: '',
    title: 'T'.repeat(400),
    segmentSeconds: 10,
    segments: [{ n: 3, key: 'k3' }],
    events: [{ type: 'section', startedAt: T0 + 1, payload: { title: 'L'.repeat(200) } }],
  }));
  assert.equal(m.title.length, 300);
  assert.equal('instance' in m.origin, false);
  assert.equal(m.feeds[0].parts[0].startMs, 30000);
  assert.equal(m.feeds[0].parts[0].durationMs, 10000);
  assert.deepEqual(checkLcytManifestV1(m), []);
});

test('no segments, a bad session or a missing urlFor is refused', () => {
  assert.throws(() => buildHandoffManifest(fixture({ segments: [] })), /no segments/);
  assert.throws(() => buildHandoffManifest(fixture({ session: { stream: 'main' } })), TypeError);
  assert.throws(() => buildHandoffManifest(fixture({ urlFor: undefined })), TypeError);
});

test('the transcribed schema check itself rejects what Saarnavideo rejects', () => {
  const ok = buildHandoffManifest(fixture());
  const bad = structuredClone(ok);
  bad.feeds[0].parts[0].ref = 'recordings/x/000000.mp4';
  assert.ok(checkLcytManifestV1(bad).some((e) => /http\(s\)/.test(e)));
  const noClean = structuredClone(ok);
  noClean.feeds[0].role = 'program';
  assert.ok(checkLcytManifestV1(noClean).some((e) => /clean/.test(e)));
});
