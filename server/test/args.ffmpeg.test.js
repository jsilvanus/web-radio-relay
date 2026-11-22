import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hlsArgs } from '../lib/hls-args.js';
import { recorderArgs, closedSegments } from '../lib/recorder-args.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

function run(args) {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
}

test('hls and recorder args run under real ffmpeg (copy only)', { skip: hasFfmpeg ? false : 'ffmpeg not on PATH' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-args-'));
  try {
    const src = join(dir, 'src.mp4');
    run(['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25',
      '-f', 'lavfi', '-i', 'sine',
      '-t', '3', '-c:v', 'libx264', '-g', '25', '-c:a', 'aac', src]);

    const hlsDir = join(dir, 'hls');
    mkdirSync(join(hlsDir, 'test', 'video'), { recursive: true });
    run(hlsArgs({ stream: 'test', hlsDir, inputArgs: { input: src } }));
    assert.ok(existsSync(join(hlsDir, 'test', 'video', 'stream.m3u8')), 'playlist written');
    assert.ok(existsSync(join(hlsDir, 'test', 'video', '0.ts')), 'first segment written');

    const spool = join(dir, 'spool');
    mkdirSync(join(spool, 's-1'), { recursive: true });
    run(recorderArgs({ stream: 'test', spoolDir: spool, sessionId: 's-1', inputArgs: { input: src } }));
    const first = join(spool, 's-1', '000000.mp4');
    assert.ok(existsSync(first), 'first recorded segment written');
    assert.ok(statSync(first).size > 0, 'segment is not empty');
    // One 3 s segment: it is the newest file, so nothing is closed yet.
    assert.deepEqual(closedSegments(readdirSync(join(spool, 's-1'))), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
