/**
 * CEA-608 pop-on caption encoder (P9.1): channel CC1, field 1.
 *
 * Pure: text in, byte pairs out. A pair is `[b1, b2]`, both bytes with odd
 * parity in bit 7, ready for cc_data (cc_type 0).
 *
 * Pop-on: the text is loaded into the non-displayed memory (RCL, ENM, PAC,
 * characters) while the previous caption is still on screen; `eocPair()` (End Of
 * Caption) swaps the memories so the text appears on that frame, `edmPair()`
 * (Erase Displayed Memory) clears it. Control codes are sent twice in a row
 * (CEA-608 "redundant control codes"); a decoder ignores the second copy when it
 * arrives as the very next pair of the field.
 *
 * Characters: the basic set (0x20-0x7F, with the 608 substitutions such as
 * 0x2A = á), the special set (0x11 0x30-0x3F) and the two extended sets
 * (0x12/0x13 0x20-0x3F). An extended character is sent after its nearest basic
 * character, because a decoder that knows the extended code replaces (backspaces
 * over) the character before it, and a decoder that does not keeps the base
 * character. Characters outside every set are replaced by their base letter
 * (accents removed) or '?', and counted.
 */

/** Columns per caption row. */
export const MAX_COLUMNS = 32;
/** Rows used by one pop-on caption. */
export const MAX_ROWS = 2;

/** Odd parity in bit 7 for a 7-bit value. */
export function withParity(b) {
  const v = b & 0x7f;
  let ones = 0;
  for (let x = v; x; x >>= 1) ones += x & 1;
  return ones % 2 === 1 ? v : v | 0x80;
}

/** A pair with parity applied. */
function pair(b1, b2) {
  return [withParity(b1), withParity(b2)];
}

/** Padding pair (two nulls with parity). */
export const PADDING = Object.freeze([0x80, 0x80]);

// Miscellaneous control codes, channel 1 (first byte 0x14 on field 1).
const MISC = 0x14;
export const RCL = 0x20; // resume caption loading (pop-on)
export const EDM = 0x2c; // erase displayed memory
export const ENM = 0x2e; // erase non-displayed memory
export const EOC = 0x2f; // end of caption (flip memories)

/** One miscellaneous control code pair for CC1. */
export function controlPair(code) {
  return pair(MISC, code);
}
export function rclPair() {
  return controlPair(RCL);
}
export function enmPair() {
  return controlPair(ENM);
}
export function eocPair() {
  return controlPair(EOC);
}
export function edmPair() {
  return controlPair(EDM);
}

/** Control pair sent twice, as the standard recommends. */
function doubled(p) {
  return [p, [...p]];
}

// PAC first byte (CC1) and whether the row uses the 0x60-0x7F second-byte range.
const PAC_ROWS = {
  1: [0x11, false], 2: [0x11, true], 3: [0x12, false], 4: [0x12, true],
  5: [0x15, false], 6: [0x15, true], 7: [0x16, false], 8: [0x16, true],
  9: [0x17, false], 10: [0x17, true], 11: [0x10, false], 12: [0x13, false],
  13: [0x13, true], 14: [0x14, false], 15: [0x14, true],
};

/**
 * Preamble Address Code: row 1-15, white, no underline, indent (column) 0-28 in
 * steps of 4. Columns that are not a multiple of 4 add a Tab Offset pair (TO1-3).
 * @returns {number[][]} one or two pairs (not doubled)
 */
export function pacPairs(row, column = 0) {
  const entry = PAC_ROWS[row];
  if (!entry) throw new RangeError('row must be 1-15');
  if (!Number.isInteger(column) || column < 0 || column > MAX_COLUMNS - 1) throw new RangeError('column must be 0-31');
  const indent = Math.min(28, column - (column % 4));
  const [b1, high] = entry;
  // 0x50 + 2*(indent/4): "indent N, white"; bit 0 would be underline.
  const b2 = (high ? 0x70 : 0x50) + (indent / 4) * 2;
  const out = [pair(b1, b2)];
  const tab = column - indent;
  if (tab > 0) out.push(pair(0x17, 0x20 + tab)); // TO1..TO3
  return out;
}

// Basic set: printable ASCII except where 608 puts other characters.
const BASIC_SUBST = new Map([
  ['á', 0x2a], ['é', 0x5c], ['í', 0x5e], ['ó', 0x5f], ['ú', 0x60],
  ['ç', 0x7b], ['÷', 0x7c], ['Ñ', 0x7d], ['ñ', 0x7e], ['█', 0x7f],
]);
const ASCII_NOT_BASIC = new Set(['*', '\\', '^', '_', '`', '{', '|', '}', '~']);

// Special characters: 0x11 0x30-0x3F (CC1). Two-byte, no base character needed.
const SPECIAL = '®°½¿™¢£♪à\u00a0èâêîôû'; // \u00a0 = transparent space
// Extended Spanish/French/misc: 0x12 0x20-0x3F; Portuguese/German/Danish: 0x13 0x20-0x3F.
const EXT_12 = 'ÁÉÓÚÜü‘¡*’—©℠•“”ÀÂÇÈÊËëÎÏïÔÙùÛ«»';

const EXT_13 = new Map(
  ['Ã', 'ã', 'Í', 'Ì', 'ì', 'Ò', 'ò', 'Õ', 'õ', '{', '}', '\\', '^', '_', '|', '~',
    'Ä', 'ä', 'Ö', 'ö', 'ß', '¥', '¤', '¦', 'Å', 'å', 'Ø', 'ø', '┌', '┐', '└', '┘']
    .map((c, idx) => [c, 0x20 + idx]),
);

/** Base character shown by decoders that do not know an extended code. */
const EXT_BASE = new Map([
  ['‘', "'"], ['’', "'"], ['¡', '!'], ['*', '.'], ['—', '-'], ['©', 'c'], ['℠', ' '], ['•', '.'],
  ['“', '"'], ['”', '"'], ['«', '"'], ['»', '"'], ['{', '('], ['}', ')'], ['\\', '/'], ['^', ' '],
  ['_', '-'], ['|', '!'], ['~', '-'], ['ß', 's'], ['¥', 'Y'], ['¤', 'o'], ['¦', '!'],
  ['┌', '+'], ['┐', '+'], ['└', '+'], ['┘', '+'], ['Ø', 'O'], ['ø', 'o'],
]);

function charCode(ch) {
  if (BASIC_SUBST.has(ch)) return { basic: BASIC_SUBST.get(ch) };
  const cp = ch.codePointAt(0);
  if (cp >= 0x20 && cp <= 0x7e && !ASCII_NOT_BASIC.has(ch)) return { basic: cp };
  let i = SPECIAL.indexOf(ch);
  if (i >= 0) return { special: [0x11, 0x30 + i] };
  i = EXT_12.indexOf(ch);
  if (i >= 0) return { extended: [0x12, 0x20 + i] };
  i = EXT_13.get(ch);
  if (i !== undefined) return { extended: [0x13, i] };
  return null;
}

/** Basic-set byte for the base character of an extended character. */
function baseFor(ch) {
  const mapped = EXT_BASE.get(ch);
  const base = mapped ?? ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const code = charCode(base);
  return code && code.basic !== undefined ? code.basic : 0x20;
}

/** Replacement for a character outside every 608 set. */
function replacement(ch) {
  const stripped = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (stripped.length === 1) {
    const code = charCode(stripped);
    if (code && code.basic !== undefined) return code.basic;
  }
  return 0x3f; // '?'
}

/**
 * Byte pairs for one line of text (no PAC). Basic characters go two per pair;
 * special and extended characters get a pair of their own, sent twice.
 * @param {string} line
 * @returns {{ pairs: number[][], replaced: number }}
 */
export function textPairs(line) {
  const pairs = [];
  let pending = null; // a basic byte waiting for a partner
  let replaced = 0;
  const flush = () => {
    if (pending !== null) {
      pairs.push(pair(pending, 0x00));
      pending = null;
    }
  };
  const basic = (b) => {
    if (pending === null) pending = b;
    else {
      pairs.push(pair(pending, b));
      pending = null;
    }
  };
  for (const ch of line) {
    const code = charCode(ch);
    if (!code) {
      replaced += 1;
      basic(replacement(ch));
    } else if (code.basic !== undefined) {
      basic(code.basic);
    } else if (code.special) {
      flush();
      pairs.push(...doubled(pair(...code.special)));
    } else {
      basic(baseFor(ch));
      flush();
      pairs.push(...doubled(pair(...code.extended)));
    }
  }
  flush();
  return { pairs, replaced };
}

/**
 * Wrap text at word boundaries into lines of at most `maxChars` characters.
 * Whitespace runs become one space; a word longer than a line is cut.
 * @returns {string[]} all lines (may be more than two)
 */
export function wrapText(text, maxChars = MAX_COLUMNS) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (let word of words) {
    while ([...word].length > maxChars) {
      if (line) {
        lines.push(line);
        line = '';
      }
      const chars = [...word];
      lines.push(chars.slice(0, maxChars).join(''));
      word = chars.slice(maxChars).join('');
    }
    if (!word) continue;
    if (!line) line = word;
    else if ([...line].length + 1 + [...word].length <= maxChars) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Split text into captions of at most two wrapped lines each.
 * @returns {string[][]} one array of lines per pop-on caption
 */
export function splitCaption(text, { maxChars = MAX_COLUMNS, maxRows = MAX_ROWS } = {}) {
  const lines = wrapText(text, maxChars);
  const out = [];
  for (let i = 0; i < lines.length; i += maxRows) out.push(lines.slice(i, i + maxRows));
  return out;
}

/**
 * Load pairs for one pop-on caption (everything except EOC): RCL, ENM, then per
 * line a PAC and its characters. Control codes are doubled.
 *
 * @param {string} text wrapped at word boundaries to 32 columns, at most two lines
 * @param {object} [options]
 * @param {number[]} [options.rows=[14, 15]] rows for a two-line caption; a one-line
 *   caption uses the last row
 * @param {'left'|'center'} [options.align='left'] indent 0, or centred by column
 * @returns {number[][]} pairs with parity; `.replaced` holds the count of
 *   characters that had no 608 code
 * @throws {RangeError} when the text needs more than `rows.length` lines
 */
export function encodePopOn(text, { rows = [14, 15], align = 'left' } = {}) {
  const lines = wrapText(text, MAX_COLUMNS);
  if (lines.length === 0) throw new RangeError('caption text is empty');
  if (lines.length > rows.length) {
    throw new RangeError(`caption needs ${lines.length} lines, only ${rows.length} rows; split it with splitCaption()`);
  }
  const useRows = rows.slice(rows.length - lines.length);
  const pairs = [...doubled(rclPair()), ...doubled(enmPair())];
  let replaced = 0;
  lines.forEach((line, i) => {
    const length = [...line].length;
    const column = align === 'center' ? Math.floor((MAX_COLUMNS - length) / 2) : 0;
    for (const p of pacPairs(useRows[i], column)) pairs.push(...doubled(p));
    const t = textPairs(line);
    replaced += t.replaced;
    pairs.push(...t.pairs);
  });
  Object.defineProperty(pairs, 'replaced', { value: replaced, enumerable: false });
  return pairs;
}
