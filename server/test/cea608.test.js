// CEA-608 pop-on encoder (P9.1). Expected bytes are written by hand from the
// CEA-608 tables (control codes, PAC table, character sets) with odd parity in
// bit 7: a value with an even number of one bits gets 0x80 added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withParity, PADDING, controlPair, rclPair, enmPair, eocPair, edmPair,
  pacPairs, textPairs, wrapText, splitCaption, encodePopOn, MAX_COLUMNS,
} from '../lib/cea608.js';

test('withParity sets bit 7 so the byte has odd parity', () => {
  assert.equal(withParity(0x14), 0x94); // 0001 0100: two ones
  assert.equal(withParity(0x20), 0x20); // one
  assert.equal(withParity(0x2f), 0x2f); // five
  assert.equal(withParity(0x2c), 0x2c); // three
  assert.equal(withParity(0x2e), 0xae); // four
  assert.equal(withParity(0x00), 0x80);
  assert.equal(withParity(0x45), 0x45); // 'E'
  assert.equal(withParity(0x74), 0xf4); // 't'
  assert.equal(withParity(0xf4), 0xf4); // an existing parity bit is recomputed
  assert.deepEqual(PADDING, [0x80, 0x80]);
});

test('miscellaneous control codes, CC1 field 1', () => {
  assert.deepEqual(rclPair(), [0x94, 0x20]); // 0x14 0x20 resume caption loading
  assert.deepEqual(enmPair(), [0x94, 0xae]); // 0x14 0x2E erase non-displayed memory
  assert.deepEqual(eocPair(), [0x94, 0x2f]); // 0x14 0x2F end of caption
  assert.deepEqual(edmPair(), [0x94, 0x2c]); // 0x14 0x2C erase displayed memory
  assert.deepEqual(controlPair(0x2d), [0x94, 0xad]); // carriage return
});

test('PAC: rows, white, indent and tab offsets', () => {
  assert.deepEqual(pacPairs(15, 0), [[0x94, 0x70]]); // 0x14 0x70: row 15, indent 0, white
  assert.deepEqual(pacPairs(14, 0), [[0x94, 0xd0]]); // 0x14 0x50: row 14
  assert.deepEqual(pacPairs(1, 0), [[0x91, 0xd0]]); // 0x11 0x50
  assert.deepEqual(pacPairs(2, 0), [[0x91, 0x70]]); // 0x11 0x70
  assert.deepEqual(pacPairs(11, 0), [[0x10, 0xd0]]); // 0x10 0x50
  assert.deepEqual(pacPairs(12, 0), [[0x13, 0xd0]]); // 0x13 0x50
  assert.deepEqual(pacPairs(15, 4), [[0x94, 0xf2]]); // 0x14 0x72: indent 4
  assert.deepEqual(pacPairs(15, 28), [[0x94, 0xfe]]); // 0x14 0x7E (six ones -> 0xFE): indent 28
  assert.deepEqual(pacPairs(15, 5), [[0x94, 0xf2], [0x97, 0xa1]]); // + TO1 (0x17 0x21)
  assert.deepEqual(pacPairs(15, 15), [[0x94, 0x76], [0x97, 0x23]]); // indent 12 + TO3
  assert.deepEqual(pacPairs(14, 31), [[0x94, 0x5e], [0x97, 0x23]]); // indent 28 + TO3
  assert.throws(() => pacPairs(16, 0), RangeError);
  assert.throws(() => pacPairs(15, 32), RangeError);
});

test('textPairs: basic characters two per pair, null padding', () => {
  assert.deepEqual(textPairs('Ei').pairs, [[0x45, 0xe9]]);
  assert.deepEqual(textPairs('Hei').pairs, [[0xc8, 0xe5], [0xe9, 0x80]]);
  assert.deepEqual(textPairs('é').pairs, [[0xdc, 0x80]]); // 0x5C in the 608 basic set
  assert.deepEqual(textPairs('').pairs, []);
});

test('textPairs: Finnish letters as base character + extended code (sent twice)', () => {
  // ä: 'a' (0x61), then 0x13 0x31
  assert.deepEqual(textPairs('ä').pairs, [[0x61, 0x80], [0x13, 0x31], [0x13, 0x31]]);
  // ö: 'o' (0x6F -> 0xEF), then 0x13 0x33 (-> 0xB3)
  assert.deepEqual(textPairs('ö').pairs, [[0xef, 0x80], [0x13, 0xb3], [0x13, 0xb3]]);
  // å: 'a', then 0x13 0x39 (-> 0xB9)
  assert.deepEqual(textPairs('å').pairs, [[0x61, 0x80], [0x13, 0xb9], [0x13, 0xb9]]);
  // Ä: 'A' (0x41 -> 0xC1), 0x13 0x30 (-> 0xB0); Ö: 'O' (0x4F), 0x13 0x32; Å: 'A', 0x13 0x38
  assert.deepEqual(textPairs('Ä').pairs, [[0xc1, 0x80], [0x13, 0xb0], [0x13, 0xb0]]);
  assert.deepEqual(textPairs('Ö').pairs, [[0x4f, 0x80], [0x13, 0x32], [0x13, 0x32]]);
  assert.deepEqual(textPairs('Å').pairs, [[0xc1, 0x80], [0x13, 0x38], [0x13, 0x38]]);
  // The base character shares a pair with the character before it.
  assert.deepEqual(textPairs('pä').pairs, [[0x70, 0x61], [0x13, 0x31], [0x13, 0x31]]);
  assert.equal(textPairs('äöåÄÖÅ').replaced, 0);
});

test('textPairs: special characters, and replacement of unknown ones', () => {
  assert.deepEqual(textPairs('°').pairs, [[0x91, 0x31], [0x91, 0x31]]); // 0x11 0x31
  assert.deepEqual(textPairs('♪').pairs, [[0x91, 0x37], [0x91, 0x37]]); // 0x11 0x37
  // '*' is not in the basic set (0x2A is á): extended 0x12 0x28 after a base '.'
  assert.deepEqual(textPairs('*').pairs, [[0xae, 0x80], [0x92, 0xa8], [0x92, 0xa8]]);
  const euro = textPairs('€');
  assert.deepEqual(euro.pairs, [[0xbf, 0x80]]); // '?'
  assert.equal(euro.replaced, 1);
  const macron = textPairs('ō'); // no 608 code: accent removed
  assert.deepEqual(macron.pairs, [[0xef, 0x80]]);
  assert.equal(macron.replaced, 1);
});

test('wrapText and splitCaption: 32 columns at word boundaries', () => {
  assert.deepEqual(wrapText('  yksi   kaksi '), ['yksi kaksi']);
  const words = 'Herra on minun paimeneni, ei minulta mitään puutu. Hän vie minut';
  const lines = wrapText(words);
  for (const line of lines) assert.ok([...line].length <= MAX_COLUMNS, line);
  assert.deepEqual(lines, ['Herra on minun paimeneni, ei', 'minulta mitään puutu. Hän vie', 'minut']);
  assert.deepEqual(wrapText('x'.repeat(40)), ['x'.repeat(32), 'x'.repeat(8)]);
  assert.deepEqual(wrapText('ä'.repeat(32)), ['ä'.repeat(32)]); // counted in characters
  assert.deepEqual(splitCaption(words), [['Herra on minun paimeneni, ei', 'minulta mitään puutu. Hän vie'], ['minut']]);
});

test('encodePopOn: one line goes to row 15, controls doubled', () => {
  assert.deepEqual(encodePopOn('Hi'), [
    [0x94, 0x20], [0x94, 0x20], // RCL
    [0x94, 0xae], [0x94, 0xae], // ENM
    [0x94, 0x70], [0x94, 0x70], // PAC row 15 indent 0 white
    [0xc8, 0xe9], // 'H' 'i'
  ]);
});

test('encodePopOn: two lines on rows 14 and 15; centring', () => {
  const text = `${'a'.repeat(30)} bb`;
  const pairs = encodePopOn(text);
  assert.deepEqual(pairs.slice(4, 6), [[0x94, 0xd0], [0x94, 0xd0]]); // row 14
  const row15 = pairs.findIndex((p) => p[0] === 0x94 && p[1] === 0x70);
  assert.equal(row15, 4 + 2 + 15); // after 15 pairs of 'a'
  assert.deepEqual(pairs.slice(row15 + 2), [[0x62, 0x62]]); // 'b' 'b'

  const centred = encodePopOn('Hi', { align: 'center' }); // column 15 = indent 12 + TO3
  assert.deepEqual(centred.slice(4, 8), [[0x94, 0x76], [0x94, 0x76], [0x97, 0x23], [0x97, 0x23]]);

  assert.deepEqual(encodePopOn('Hi', { rows: [1, 2] }).slice(4, 6), [[0x91, 0x70], [0x91, 0x70]]);
});

test('encodePopOn: too long or empty text throws; replaced count', () => {
  assert.throws(() => encodePopOn('x'.repeat(65)), RangeError);
  assert.throws(() => encodePopOn('   '), RangeError);
  assert.equal(encodePopOn('a € b').replaced, 1);
  assert.equal(encodePopOn('äö').replaced, 0);
});
