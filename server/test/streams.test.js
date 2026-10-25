import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidStreamName, StreamRegistry } from '../lib/streams.js';

test('stream names are short safe path segments', () => {
  for (const ok of ['stream', 'messu-1', 'a_b', '0x']) assert.equal(isValidStreamName(ok), true, ok);
  for (const bad of ['', '-x', 'A', '../etc', 'a/b', 'a.b', 'x'.repeat(33), undefined, 7]) {
    assert.equal(isValidStreamName(bad), false, String(bad));
  }
});

test('registry keeps delay and captions per stream, and reads never create state', () => {
  const reg = new StreamRegistry({ defaultDelaySeconds: 5, maxDelaySeconds: 60, maxStreams: 2 });
  assert.equal(reg.peek('a'), null);
  assert.equal(reg.delayOf('a'), 5);
  const a = reg.ensure('a');
  const b = reg.ensure('b');
  assert.notEqual(a.captions, b.captions);
  a.delaySeconds = 20;
  assert.equal(reg.delayOf('a'), 20);
  assert.equal(reg.delayOf('b'), 5);
  assert.equal(reg.ensure('c'), null, 'stream limit reached');
});
