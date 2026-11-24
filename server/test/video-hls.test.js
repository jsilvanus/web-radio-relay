/**
 * Video HLS routes (P6.2, P6.3) over HTTP: the delayed video playlist, the master
 * playlist, the subtitle playlist and the WebVTT segments with stored events.
 * Starts index.js as a child process on a ':memory:' event store, like server.test.js.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'video-token-789';
const PORT = 33000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'videohls-'));
const hls = path.join(dir, 'hls');
const SEG = 4;
const COUNT = 12;
let T0; // end of the last segment, ms
let child;

/** Live video playlist: COUNT segments of 4 s, the last one ending at T0. */
function writeVideoLive() {
  const videoDir = path.join(hls, 'stream', 'video');
  fs.mkdirSync(videoDir, { recursive: true });
  T0 = Date.now();
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG}`, '#EXT-X-MEDIA-SEQUENCE:200'];
  for (let i = 0; i < COUNT; i++) {
    const name = `seg${String(200 + i).padStart(5, '0')}.ts`;
    const start = T0 - (COUNT - i) * SEG * 1000;
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(start).toISOString()}`);
    lines.push(`#EXTINF:${SEG.toFixed(3)},`);
    lines.push(name);
    fs.writeFileSync(path.join(videoDir, name), 'x');
  }
  fs.writeFileSync(path.join(videoDir, 'stream.m3u8'), `${lines.join('\n')}\n`);
}

/** Start of segment i (0-based index in the fixture) on the epoch clock. */
const segStart = (i) => T0 - (COUNT - i) * SEG * 1000;

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

before(async () => {
  writeVideoLive();
  child = spawn(process.execPath, [path.join(here, '..', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HLS_DIR: hls,
      ARCHIVE_DIR: path.join(dir, 'archive'),
      HIDDEN_ARCHIVE_DIR: path.join(dir, 'hidden'),
      STATS_FILE: path.join(dir, 'stats.json'),
      RELAY_API_TOKEN: TOKEN,
      RELAY_DB_PATH: ':memory:',
      METRICS_BEARER_TOKEN: 'metrics-token',
      PUBLISH_AUTH: 'off',
      DELAY_SECONDS: '8',
      DELAY_MAX_SECONDS: '30',
      VIDEO_SUB_LANGS: 'original,sv',
    },
    stdio: 'ignore',
  });
  await waitForServer();
});

after(() => {
  child?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('delayed video playlist lists the last six segments that ended 8 s ago, with video URLs', async () => {
  const res = await fetch(`${base}/api/streams/stream/hls/video/delayed.m3u8`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /mpegurl/);
  const text = await res.text();
  assert.match(text, /^#EXTM3U/);
  const segs = text.split('\n').filter((l) => l.startsWith('/hls/'));
  assert.equal(segs.length, 6);
  assert.ok(segs.every((s) => s.startsWith('/hls/stream/video/')), 'segment URLs point at the video directory');
  const pdts = text.split('\n').filter((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')).map((l) => Date.parse(l.slice(25)));
  assert.ok(pdts[pdts.length - 1] + SEG * 1000 <= Date.now() - 8000 + 50, 'nothing inside the delay');
});

test('video delayed playlist answers 404 for a stream without video HLS', async () => {
  const res = await fetch(`${base}/api/streams/nothere/hls/video/delayed.m3u8`);
  assert.equal(res.status, 404);
});

test('audio delayed playlist is unchanged by the video route', async () => {
  const res = await fetch(`${base}/api/streams/stream/hls/delayed.m3u8`);
  assert.equal(res.status, 404, 'the fixture writes only the video playlist');
});

test('master playlist names the subtitle group and the delayed video variant', async () => {
  const res = await fetch(`${base}/api/streams/stream/hls/master.m3u8`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="original",NAME="original",DEFAULT=NO,AUTOSELECT=YES,URI="/api/streams/stream/hls/subs/original.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="sv",NAME="sv",DEFAULT=NO,AUTOSELECT=YES,URI="/api/streams/stream/hls/subs/sv.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,SUBTITLES="subs"',
    '/api/streams/stream/hls/video/delayed.m3u8',
    '',
  ].join('\n'));
});

test('subtitle playlist has one VTT per delayed video segment, same media sequence', async () => {
  const video = await (await fetch(`${base}/api/streams/stream/hls/video/delayed.m3u8`)).text();
  const sub = await fetch(`${base}/api/streams/stream/hls/subs/original.m3u8`);
  assert.equal(sub.status, 200);
  const text = await sub.text();
  const seqOf = (t) => t.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)[1];
  assert.equal(seqOf(text), seqOf(video));
  const vtts = text.split('\n').filter((l) => l.endsWith('.vtt'));
  assert.equal(vtts.length, 6);
  assert.match(vtts[0], /^\/api\/streams\/stream\/hls\/subs\/original\/\d+\.vtt$/);
  const durations = text.split('\n').filter((l) => l.startsWith('#EXTINF:'));
  assert.equal(durations.length, 6);
});

test('subtitle playlist and VTT reject bad languages and sequence numbers', async () => {
  assert.equal((await fetch(`${base}/api/streams/stream/hls/subs/FI.m3u8`)).status, 400);
  assert.equal((await fetch(`${base}/api/streams/stream/hls/subs/original/abc.vtt`)).status, 400);
  assert.equal((await fetch(`${base}/api/streams/stream/hls/subs/original/999.vtt`)).status, 404);
});

test('pushed captions and translations land in the matching VTT segments', async () => {
  const pushed = await fetch(`${base}/api/v1/streams/stream/events`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      events: [
        // inside segment 5 (index 5 of the fixture is seq 205)
        { type: 'caption', lang: 'fi', startedAt: segStart(5) + 1000, endedAt: segStart(5) + 3000, payload: { text: 'Äiti ja isä' } },
        // translation crossing the border between segments 5 and 6
        { type: 'translation', lang: 'sv', startedAt: segStart(5) + 3500, endedAt: segStart(6) + 1000, payload: { text: 'Över gränsen', sourceKey: 'tr-border' } },
        // in segment 6 only
        { type: 'caption', lang: 'fi', startedAt: segStart(6) + 500, endedAt: segStart(6) + 2000, payload: { text: 'Åbo öppnar' } },
      ],
    }),
  });
  assert.equal(pushed.status, 202);
  assert.equal((await pushed.json()).added, 3);
});

test('a VTT segment holds its own cues, clipped at the border, with the timestamp map', async () => {
  const seq5 = 200 + 5;
  const seq6 = 200 + 6;

  const fi5 = await fetch(`${base}/api/streams/stream/hls/subs/original/${seq5}.vtt`);
  assert.equal(fi5.status, 200);
  assert.match(fi5.headers.get('content-type'), /text\/vtt/);
  const text5 = await fi5.text();
  // origin = the first segment the process saw (seq 200): segment 5 starts 20 s later, 1.8 M ticks
  assert.equal(text5, 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:2700000,LOCAL:00:00:00.000\n\n1\n00:00:01.000 --> 00:00:03.000\nÄiti ja isä\n');

  const sv5 = await (await fetch(`${base}/api/streams/stream/hls/subs/sv/${seq5}.vtt`)).text();
  assert.ok(sv5.includes('00:00:03.500 --> 00:00:04.000\nÖver gränsen'), sv5);

  const sv6 = await (await fetch(`${base}/api/streams/stream/hls/subs/sv/${seq6}.vtt`)).text();
  assert.ok(sv6.includes('00:00:00.000 --> 00:00:01.000\nÖver gränsen'), 'the border cue is in the next segment too');
  assert.equal(sv6.includes('Åbo'), false, 'fi caption does not appear in sv');

  const fi6 = await (await fetch(`${base}/api/streams/stream/hls/subs/original/${seq6}.vtt`)).text();
  assert.ok(fi6.includes('00:00:00.500 --> 00:00:02.000\nÅbo öppnar'));
});

test('a segment without cues is a valid empty WebVTT file', async () => {
  const res = await fetch(`${base}/api/streams/stream/hls/subs/original/200.vtt`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n');
});
