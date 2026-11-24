import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  createFlvParser, parseVideoTag, writeFlvHeader, writeTag, buildVideoTag, TAG_VIDEO,
} from '../lib/flv.js';
import { parseA53Sei } from '../lib/cc-data.js';
import { createCaptionerService } from '../lib/captioner-service.js';

function fakeChild(kind) {
  const child = new EventEmitter();
  if (kind === 'input') child.stdout = new PassThrough();
  else child.stdin = new PassThrough();
  child.kill = () => true;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test('P9.6 starts two copy-only FFmpeg children and publishes the protected -cc path', async () => {
  let clock = 10_000;
  let subscriber;
  let unsubscribed = false;
  const spawned = [];
  const output = [];
  const bus = {
    subscribe(stream, listener) {
      assert.equal(stream, 'church');
      subscriber = listener;
      return () => { unsubscribed = true; };
    },
  };
  const service = createCaptionerService({
    spawnProcess(_command, args) {
      const child = fakeChild(args.includes('pipe:1') ? 'input' : 'output');
      spawned.push({ args, child });
      if (spawned.length === 2) child.stdin.on('data', (chunk) => output.push(Buffer.from(chunk)));
      return child;
    },
    getProbe: () => ({ video: { codec: 'h264', fps: 25 }, audio: { codec: 'aac' } }),
    bus,
    secret: 'unit-test-secret',
    now: () => clock,
    log: () => {},
  });

  try {
    const started = await service.ready('church', {
      enabled: true, lang: 'fi', holdSeconds: 1, syncOffsetMs: 0,
    });
    assert.equal(started.state, 'running');
    assert.equal(spawned.length, 2);
    assert.ok(spawned[0].args.includes('pipe:1'));
    assert.ok(spawned[1].args.includes('pipe:0'));
    assert.match(spawned[1].args.at(-1), /live\/church-cc\?secret=unit-test-secret/);

    subscriber([{
      type: 'caption', lang: 'fi', startedAt: 10_000, endedAt: 12_000,
      payload: { text: 'Hei maailma', final: true },
    }]);
    // A non-final partial must not enter the scheduler.
    subscriber([{
      type: 'caption', lang: 'fi', startedAt: 10_000, endedAt: 12_000,
      payload: { text: 'osittainen', final: false },
    }]);

    const video = buildVideoTag({
      frameType: 1, codecId: 7, avcPacketType: 1, compositionTime: 0,
      nalus: [Buffer.from([0x65, 0x88, 0x84])],
    });
    const flv = Buffer.concat([
      writeFlvHeader({ audio: true, video: true }),
      writeTag({ type: TAG_VIDEO, timestamp: 0, data: video }),
    ]);
    spawned[0].child.stdout.write(flv);

    // The one-second hold is wall-clock based; advance the injected clock and
    // let the scheduled release callback run.
    clock += 1001;
    await new Promise((resolve) => setTimeout(resolve, 1050));

    const parser = createFlvParser();
    const items = parser.push(Buffer.concat(output));
    const videoTag = items.find((item) => item.kind === 'tag' && item.type === TAG_VIDEO);
    assert.ok(videoTag, 'captioned video tag was written to the second FFmpeg');
    const parsed = parseVideoTag(videoTag.data);
    const sei = parsed.nalus.find((nalu) => parseA53Sei(nalu));
    assert.ok(sei, 'A/53 SEI was inserted without re-encoding the frame');
    assert.ok(parseA53Sei(sei).pairs.length > 0, 'final caption produced valid 608 pairs');
    assert.equal(service.state('church').captionsEmbedded, 1);
  } finally {
    service.notready('church');
  }
  assert.equal(unsubscribed, true);
});

test('captioner refuses unsupported source video instead of publishing a broken variant', async () => {
  let spawned = 0;
  const service = createCaptionerService({
    spawnProcess: () => { spawned += 1; return fakeChild('input'); },
    getProbe: () => ({ video: { codec: 'hevc', fps: 25 } }),
    bus: { subscribe: () => () => {} },
    secret: 'secret',
  });
  const status = await service.ready('church', { enabled: true, lang: 'fi', holdSeconds: 16, syncOffsetMs: 1500 });
  assert.equal(status.state, 'failed');
  assert.match(status.error, /requires H.264/);
  assert.equal(spawned, 0);
  service.close();
});
