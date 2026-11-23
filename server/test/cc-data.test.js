// A/53 cc_data and SEI NAL (P9.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ccDataPayload, a53SeiNal, parseA53Sei, addEmulationPrevention, removeEmulationPrevention,
} from '../lib/cc-data.js';

// Fixtures: SEI NAL units written by ffmpeg 6.1 + libx264 with `-a53cc 1`.
// Made by re-encoding a file from server/scripts/e1-make-test.mjs
// (`ffmpeg -i e1.flv -c:v libx264 -a53cc 1 -bf 0 -an -f flv re.flv`): the h264
// decoder exports our cc_data as A53 side data and libx264 writes its own SEI from
// it. The NAL units were taken from the re-encoded FLV (frames carrying EOC, PAC).
const FFMPEG_SEI = [
  // 30 fps, cc_count 1: EOC
  { pairs: [[0x94, 0x2f]], count: 1, hex: '06040eb5003147413934034100fc942fff80' },
  // 25 fps, cc_count 2: PAC row 15 sent twice in one frame
  { pairs: [[0x94, 0x70], [0x94, 0x70]], count: 2, hex: '060411b5003147413934034200fc9470fc9470ff80' },
  // 25 fps, cc_count 2: EOC and one unused slot (cc_valid 0)
  { pairs: [[0x94, 0x2f]], count: 2, hex: '060411b5003147413934034200fc942ffa0000ff80' },
];

test('a53SeiNal matches the SEI libx264 writes (ffmpeg fixture)', () => {
  for (const { pairs, count, hex } of FFMPEG_SEI) {
    assert.equal(a53SeiNal(pairs, { count }).toString('hex'), hex);
  }
});

test('ccDataPayload: flags, cc_count, triplets, filler and marker', () => {
  assert.equal(ccDataPayload([[0x94, 0x20]]).toString('hex'), '4100fc9420ff');
  assert.equal(ccDataPayload([[0x94, 0x20]], { count: 3 }).toString('hex'), '4300fc9420fa0000fa0000ff');
  assert.equal(ccDataPayload([], {}).toString('hex'), '4100fa0000ff'); // at least one slot
  assert.equal(ccDataPayload([[0x94, 0x20]], { header: 'a53' }).toString('hex'), 'c1fffc9420ff');
  assert.throws(() => ccDataPayload([[0x80, 0x80], [0x80, 0x80]], { count: 1 }), RangeError);
  assert.throws(() => ccDataPayload([], { count: 32 }), RangeError);
  assert.throws(() => ccDataPayload([], { header: 'x' }), RangeError);
});

test('a53SeiNal: structure, strict A/53 header, round trip through parseA53Sei', () => {
  const pairs = [[0x94, 0x20], [0x45, 0xe9]];
  const nal = a53SeiNal(pairs, { count: 3, header: 'a53' });
  assert.equal(nal[0], 0x06); // NAL type 6, nal_ref_idc 0
  assert.equal(nal[1], 4); // payload type: user_data_registered_itu_t_t35
  assert.equal(nal[2], 8 + 2 + 9 + 1); // T.35 header + flags/em + 3 triplets + marker
  assert.equal(nal.subarray(3, 6).toString('hex'), 'b50031');
  assert.equal(nal.subarray(6, 10).toString('latin1'), 'GA94');
  assert.equal(nal[10], 0x03);
  assert.equal(nal[11], 0xc3);
  assert.equal(nal[nal.length - 1], 0x80); // rbsp trailing bits
  const back = parseA53Sei(nal);
  assert.equal(back.count, 3);
  assert.deepEqual(back.pairs, pairs);
  assert.deepEqual(back.triplets[2], [0xfa, 0x00, 0x00]);
});

test('parseA53Sei returns null for other NAL units and SEI payloads', () => {
  assert.equal(parseA53Sei(Buffer.from([0x65, 0x88])), null); // IDR slice
  assert.equal(parseA53Sei(Buffer.from('0605021122' + '80', 'hex')), null); // unregistered SEI
  assert.equal(parseA53Sei(null), null);
});

test('emulation prevention: 00 00 0x (x <= 3) gets an 03', () => {
  const cases = [
    ['000000', '00000300'],
    ['000001', '00000301'],
    ['000002', '00000302'],
    ['000003', '00000303'],
    ['000004', '000004'],
    ['0000000000', '00000300000300'],
    ['00000000000000', '00000300000300000300'],
    ['1100', '1100'],
    ['0000', '0000'],
  ];
  for (const [rbsp, ebsp] of cases) {
    assert.equal(addEmulationPrevention(Buffer.from(rbsp, 'hex')).toString('hex'), ebsp, rbsp);
    assert.equal(removeEmulationPrevention(Buffer.from(ebsp, 'hex')).toString('hex'), rbsp, ebsp);
  }
});

test('a53SeiNal output holds no start-code-like 00 00 0x sequence', () => {
  // With valid cc_data every 00 00 is followed by a triplet flag byte (>= 0xf8) or
  // the 0xff marker, so no 03 is needed; the writer still runs the escaping.
  const nal = a53SeiNal([[0x00, 0x00], [0x00, 0x00]], { count: 4 });
  for (let i = 0; i + 2 < nal.length; i += 1) {
    if (nal[i] === 0 && nal[i + 1] === 0) assert.ok(nal[i + 2] > 3, `at ${i}`);
  }
  assert.deepEqual(parseA53Sei(nal).pairs, [[0x00, 0x00], [0x00, 0x00]]);
});
