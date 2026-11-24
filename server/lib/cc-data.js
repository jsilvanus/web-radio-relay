/**
 * ATSC A/53 cc_data and its H.264 SEI NAL unit (P9.2).
 *
 * Pure: byte pairs in, Buffers out.
 *
 * cc_data() (A/53 Part 4, 6.2.3.1):
 *   bit 7, process_cc_data_flag(1)=1, zero_bit(1)=0, cc_count(5)
 *   one byte (em_data / reserved)
 *   cc_count x { marker_bits(5)=11111, cc_valid(1), cc_type(2), cc_data_1(8), cc_data_2(8) }
 *   marker_bits(8)=0xFF
 *
 * The SEI wraps it as user_data_registered_itu_t_t35 (payloadType 4):
 *   country 0xB5, provider 0x0031, user_identifier "GA94", user_data_type_code 0x03,
 *   cc_data(), then rbsp_trailing_bits; emulation prevention bytes are inserted.
 *
 * The first two bytes have two spellings. A/53 (2009 and later) marks bit 7 and
 * the second byte as reserved, all ones: 0xC0|count, 0xFF. ffmpeg (libx264
 * `-a53cc`, the path LCYT's re-encode mode uses towards YouTube) writes the
 * older process_em_data_flag = 0 and em_data = 0: 0x40|count, 0x00. Decoders read
 * only process_cc_data_flag and cc_count. The default is 'ffmpeg', so our SEI is
 * byte-identical to what libx264 sends (test fixture); 'a53' is the strict form.
 *
 * Field-1 (CEA-608 CC1/CC2) pairs use cc_type 0 with cc_valid 1. Unused slots up
 * to `count` are filled with cc_valid 0 (cc_type 2, data 0x00 0x00), the usual
 * A/53 filler.
 */

export const CC_TYPE_FIELD1 = 0;
export const CC_TYPE_FIELD2 = 1;
const FILLER = Object.freeze([0xfa, 0x00, 0x00]); // marker 11111, valid 0, type 2
const MAX_CC_COUNT = 31;

/**
 * cc_data() bytes for field-1 pairs.
 * @param {number[][]} pairs `[b1, b2]` with parity already applied
 * @param {{ count?: number, header?: 'ffmpeg'|'a53' }} [options] count: total cc_count
 *   (>= pairs.length), default pairs.length and at least 1; header: see above
 * @returns {Buffer}
 */
export function ccDataPayload(pairs, { count, header = 'ffmpeg' } = {}) {
  if (header !== 'ffmpeg' && header !== 'a53') throw new RangeError("header must be 'ffmpeg' or 'a53'");
  const n = count ?? Math.max(1, pairs.length);
  if (!Number.isInteger(n) || n < pairs.length || n < 1 || n > MAX_CC_COUNT) {
    throw new RangeError(`cc_count must be an integer ${Math.max(1, pairs.length)}-${MAX_CC_COUNT}`);
  }
  const out = Buffer.alloc(2 + n * 3 + 1);
  const a53 = header === 'a53';
  out[0] = (a53 ? 0xc0 : 0x40) | n; // bit 7, process_cc_data_flag 1, zero_bit 0, cc_count
  out[1] = a53 ? 0xff : 0x00; // reserved / em_data
  for (let i = 0; i < n; i += 1) {
    const at = 2 + i * 3;
    if (i < pairs.length) {
      const [b1, b2] = pairs[i];
      // cc_type 1 (field 2) when the pair was tagged `field: 2`, else field 1
      const type = pairs[i].field === 2 ? CC_TYPE_FIELD2 : CC_TYPE_FIELD1;
      out[at] = 0xf8 | 0x04 | type; // marker, cc_valid 1, cc_type
      out[at + 1] = b1 & 0xff;
      out[at + 2] = b2 & 0xff;
    } else {
      out[at] = FILLER[0];
      out[at + 1] = FILLER[1];
      out[at + 2] = FILLER[2];
    }
  }
  out[out.length - 1] = 0xff; // marker_bits
  return out;
}

/**
 * Insert emulation prevention bytes: 0x000000-0x000003 become 0x00000300-0x00000303.
 * @param {Buffer} rbsp
 * @returns {Buffer}
 */
export function addEmulationPrevention(rbsp) {
  const out = [];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

/**
 * Remove emulation prevention bytes (the inverse of addEmulationPrevention).
 * @param {Buffer} ebsp
 * @returns {Buffer}
 */
export function removeEmulationPrevention(ebsp) {
  const out = [];
  let zeros = 0;
  for (const b of ebsp) {
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

/** SEI payload_type / payload_size coding (0xFF runs for values >= 255). */
function seiNumber(v) {
  const out = [];
  while (v >= 255) {
    out.push(0xff);
    v -= 255;
  }
  out.push(v);
  return out;
}

/**
 * Complete SEI NAL unit (header byte 0x06 included, no start code or length
 * prefix) carrying the pairs as A/53 closed captions.
 * @param {number[][]} pairs
 * @param {{ count?: number, header?: 'ffmpeg'|'a53' }} [options] passed to ccDataPayload
 * @returns {Buffer}
 */
export function a53SeiNal(pairs, options) {
  const cc = ccDataPayload(pairs, options);
  const payload = Buffer.concat([
    Buffer.from([0xb5, 0x00, 0x31]), // T.35 country (USA), provider (ATSC)
    Buffer.from('GA94', 'latin1'),
    Buffer.from([0x03]), // user_data_type_code: cc_data
    cc,
  ]);
  const rbsp = Buffer.concat([
    Buffer.from([...seiNumber(4), ...seiNumber(payload.length)]),
    payload,
    Buffer.from([0x80]), // rbsp_trailing_bits
  ]);
  return Buffer.concat([Buffer.from([0x06]), addEmulationPrevention(rbsp)]);
}

/**
 * Read the field-1 pairs back from an SEI NAL unit (header byte included).
 * Returns null when the NAL is not an A/53 GA94 cc_data SEI. Pairs with
 * cc_valid 0 or another cc_type are left out.
 * @param {Buffer} nal
 * @returns {{ count: number, pairs: number[][], triplets: number[][] } | null}
 */
export function parseA53Sei(nal) {
  if (!nal || nal.length < 2 || (nal[0] & 0x1f) !== 6) return null;
  const rbsp = removeEmulationPrevention(nal.subarray(1));
  let i = 0;
  while (i < rbsp.length && rbsp[i] !== 0x80) {
    let type = 0;
    while (rbsp[i] === 0xff) {
      type += 255;
      i += 1;
    }
    type += rbsp[i++];
    let size = 0;
    while (rbsp[i] === 0xff) {
      size += 255;
      i += 1;
    }
    size += rbsp[i++];
    const p = rbsp.subarray(i, i + size);
    i += size;
    if (type !== 4 || p.length < 10) continue;
    if (p[0] !== 0xb5 || p.readUInt16BE(1) !== 0x31 || p.toString('latin1', 3, 7) !== 'GA94' || p[7] !== 3) continue;
    const count = p[8] & 0x1f;
    const triplets = [];
    const pairs = [];
    for (let k = 0; k < count; k += 1) {
      const at = 10 + k * 3;
      if (at + 3 > p.length) break;
      const t = [p[at], p[at + 1], p[at + 2]];
      triplets.push(t);
      if ((t[0] & 0x04) && (t[0] & 0x03) === CC_TYPE_FIELD1) pairs.push([t[1], t[2]]);
    }
    return { count, pairs, triplets };
  }
  return null;
}
