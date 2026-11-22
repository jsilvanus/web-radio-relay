/**
 * FLV reader and writer for the caption embedder (P9.3).
 *
 * Pure: Buffers in, Buffers and plain objects out. No I/O, no clock reads.
 * The parser is streaming: `push(chunk)` takes chunks of any size (a header,
 * a tag or a PreviousTagSize may be split anywhere) and returns the items that
 * completed with that chunk.
 *
 * Layout (Adobe FLV 10.1):
 *   header:  "FLV", version, flags (4 audio, 1 video), DataOffset (9), PreviousTagSize0
 *   tag:     type (8 audio, 9 video, 18 script), DataSize (u24), Timestamp (u24 low),
 *            TimestampExtended (u8, the high byte), StreamID (u24, always 0), data,
 *            PreviousTagSize (u32 = 11 + DataSize)
 *
 * Video tags: AVC (codecId 7) carries a packet type (0 config, 1 NAL units, 2 end),
 * a signed 24-bit composition time and, for type 1, NAL units with a 4-byte length.
 */

export const TAG_AUDIO = 8;
export const TAG_VIDEO = 9;
export const TAG_SCRIPT = 18;

export const AVC_CODEC_ID = 7;
export const AVC_SEQUENCE_HEADER = 0;
export const AVC_NALU = 1;
export const AVC_END_OF_SEQUENCE = 2;

const HEADER_SIZE = 9;
const TAG_HEADER_SIZE = 11;
const PREV_SIZE_BYTES = 4;
const MAX_DATA_SIZE = 0xffffff;
const TIMESTAMP_MOD = 0x1000000;
const MAX_TIMESTAMP = 0xffffffff;
const NALU_LENGTH_BYTES = 4;

/**
 * Byte queue: keeps the unread chunks and hands out exact-size views.
 * Views are never mutated, so a chunk is only gathered once it is needed.
 */
class ByteQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(chunk) {
    const copy = Buffer.from(chunk); // the caller may reuse its buffer
    if (copy.length > 0) {
      this.chunks.push(copy);
      this.length += copy.length;
    }
  }

  /** Makes chunks[0] hold at least n bytes (caller checked this.length >= n). */
  gather(n) {
    if (this.chunks[0].length >= n) return;
    const parts = [];
    let got = 0;
    let i = 0;
    while (got < n) {
      parts.push(this.chunks[i]);
      got += this.chunks[i].length;
      i += 1;
    }
    this.chunks.splice(0, i, Buffer.concat(parts, got));
  }

  peek(n) {
    if (this.length < n) return null;
    this.gather(n);
    return this.chunks[0].subarray(0, n);
  }

  take(n) {
    if (this.length < n) return null;
    this.gather(n);
    const first = this.chunks[0];
    const out = first.subarray(0, n);
    if (first.length === n) this.chunks.shift();
    else this.chunks[0] = first.subarray(n);
    this.length -= n;
    return out;
  }
}

/**
 * Streaming FLV parser.
 * `push(chunk)` returns the items that completed:
 *   { kind: 'header', version, audio, video, dataOffset }
 *   { kind: 'tag', type, timestamp, streamId, data }
 * `timestamp` is in milliseconds and includes the extended byte (unsigned 32-bit).
 * `data` is a view into the parser's buffer; copy it if you keep it long.
 * Extra header bytes (DataOffset > 9) are skipped, not kept.
 * Throws on a bad signature, a bad DataOffset or a PreviousTagSize that does not
 * match the tag it follows.
 * @returns {{ push(chunk: Buffer): object[], pendingBytes(): number }}
 */
export function createFlvParser() {
  const queue = new ByteQueue();
  let headerDone = false;

  return {
    push(chunk) {
      queue.push(chunk);
      const items = [];
      for (;;) {
        if (!headerDone) {
          const head = queue.peek(HEADER_SIZE);
          if (!head) break;
          if (head[0] !== 0x46 || head[1] !== 0x4c || head[2] !== 0x56) {
            throw new Error('FLV: bad signature');
          }
          const dataOffset = head.readUInt32BE(5);
          if (dataOffset < HEADER_SIZE) throw new Error('FLV: DataOffset below 9');
          const bytes = queue.take(dataOffset + PREV_SIZE_BYTES);
          if (!bytes) break;
          const flags = bytes[4];
          items.push({
            kind: 'header',
            version: bytes[3],
            audio: (flags & 0x04) !== 0,
            video: (flags & 0x01) !== 0,
            dataOffset,
          });
          headerDone = true;
          continue;
        }

        const tagHead = queue.peek(TAG_HEADER_SIZE);
        if (!tagHead) break;
        const dataSize = tagHead.readUIntBE(1, 3);
        const total = TAG_HEADER_SIZE + dataSize + PREV_SIZE_BYTES;
        const bytes = queue.take(total);
        if (!bytes) break;
        const prev = bytes.readUInt32BE(TAG_HEADER_SIZE + dataSize);
        if (prev !== TAG_HEADER_SIZE + dataSize) {
          throw new Error(`FLV: PreviousTagSize ${prev} does not match tag size ${TAG_HEADER_SIZE + dataSize}`);
        }
        items.push({
          kind: 'tag',
          type: bytes[0],
          timestamp: bytes[7] * TIMESTAMP_MOD + bytes.readUIntBE(4, 3),
          streamId: bytes.readUIntBE(8, 3),
          data: bytes.subarray(TAG_HEADER_SIZE, TAG_HEADER_SIZE + dataSize),
        });
      }
      return items;
    },

    /** Bytes received but not yet part of a complete item. */
    pendingBytes() {
      return queue.length;
    },
  };
}

/**
 * Split AVCC NAL units (4-byte big-endian length prefix each).
 * @param {Buffer} payload
 * @returns {Buffer[]} NAL unit payloads (without the length prefix)
 */
function splitNalus(payload) {
  const nalus = [];
  let i = 0;
  while (i < payload.length) {
    if (i + NALU_LENGTH_BYTES > payload.length) throw new Error('FLV AVC: truncated NAL length');
    const length = payload.readUInt32BE(i);
    i += NALU_LENGTH_BYTES;
    if (i + length > payload.length) throw new Error('FLV AVC: NAL unit runs past the tag');
    nalus.push(payload.subarray(i, i + length));
    i += length;
  }
  return nalus;
}

/**
 * Parse the data of a video tag (type 9).
 *
 * AVC packets: `nalus` holds the NAL units of a type 1 packet; `config` holds the
 * raw AVCDecoderConfigurationRecord of a type 0 (sequence header) packet, so it can
 * be written back unchanged. Other codecs return their bytes as `body`.
 * @param {Buffer} data
 * @returns {{ frameType: number, codecId: number, avcPacketType: number | null,
 *   compositionTime: number | null, nalus: Buffer[], config: Buffer | null, body: Buffer | null }}
 */
export function parseVideoTag(data) {
  if (!data || data.length < 1) throw new Error('FLV video tag: empty');
  const frameType = data[0] >> 4;
  const codecId = data[0] & 0x0f;
  if (codecId !== AVC_CODEC_ID) {
    return { frameType, codecId, avcPacketType: null, compositionTime: null, nalus: [], config: null, body: data.subarray(1) };
  }
  if (data.length < 5) throw new Error('FLV AVC video tag: shorter than 5 bytes');
  const avcPacketType = data[1];
  const compositionTime = data.readIntBE(2, 3);
  const payload = data.subarray(5);
  if (avcPacketType === AVC_NALU) {
    return { frameType, codecId, avcPacketType, compositionTime, nalus: splitNalus(payload), config: null, body: null };
  }
  return {
    frameType,
    codecId,
    avcPacketType,
    compositionTime,
    nalus: [],
    config: avcPacketType === AVC_SEQUENCE_HEADER ? payload : null,
    body: null,
  };
}

/**
 * Build the data of a video tag: the inverse of parseVideoTag.
 * @param {object} tag
 * @param {number} tag.frameType 0-15
 * @param {number} [tag.codecId=7]
 * @param {number} [tag.avcPacketType] 0 config, 1 NAL units, 2 end (AVC only)
 * @param {number} [tag.compositionTime=0] signed 24-bit (AVC only)
 * @param {Buffer[]} [tag.nalus=[]] NAL units, without length prefix (type 1)
 * @param {Buffer} [tag.config] raw config record (type 0)
 * @param {Buffer} [tag.body] bytes after the header (non-AVC codecs)
 * @returns {Buffer}
 */
export function buildVideoTag({ frameType, codecId = AVC_CODEC_ID, avcPacketType, compositionTime = 0, nalus = [], config, body }) {
  if (!Number.isInteger(frameType) || frameType < 0 || frameType > 15) throw new RangeError('frameType must be 0-15');
  if (!Number.isInteger(codecId) || codecId < 0 || codecId > 15) throw new RangeError('codecId must be 0-15');
  const first = (frameType << 4) | codecId;
  if (codecId !== AVC_CODEC_ID) {
    return Buffer.concat([Buffer.from([first]), body ?? Buffer.alloc(0)]);
  }
  const header = Buffer.alloc(5);
  header[0] = first;
  header[1] = avcPacketType;
  header.writeIntBE(compositionTime, 2, 3);
  let payload;
  if (avcPacketType === AVC_NALU) {
    const parts = [];
    for (const nalu of nalus) {
      const length = Buffer.alloc(NALU_LENGTH_BYTES);
      length.writeUInt32BE(nalu.length, 0);
      parts.push(length, nalu);
    }
    payload = Buffer.concat(parts);
  } else if (avcPacketType === AVC_SEQUENCE_HEADER) {
    payload = config ?? Buffer.alloc(0);
  } else {
    payload = Buffer.alloc(0);
  }
  return Buffer.concat([header, payload]);
}

/**
 * FLV file header followed by PreviousTagSize0 (always 0).
 * @param {{ audio?: boolean, video?: boolean, version?: number, dataOffset?: number }} [options]
 * @returns {Buffer}
 */
export function writeFlvHeader({ audio = false, video = false, version = 1, dataOffset = HEADER_SIZE } = {}) {
  if (dataOffset < HEADER_SIZE) throw new RangeError('dataOffset must be at least 9');
  const out = Buffer.alloc(dataOffset + PREV_SIZE_BYTES);
  out.write('FLV', 0, 'latin1');
  out[3] = version;
  out[4] = (audio ? 0x04 : 0) | (video ? 0x01 : 0);
  out.writeUInt32BE(dataOffset, 5);
  return out;
}

/**
 * One tag with its trailing PreviousTagSize.
 * @param {{ type: number, timestamp?: number, streamId?: number, data: Buffer }} tag
 *   timestamp in milliseconds, 0 to 2^32-1
 * @returns {Buffer}
 */
export function writeTag({ type, timestamp = 0, streamId = 0, data }) {
  if (!Number.isInteger(type) || type < 0 || type > 255) throw new RangeError('type must be 0-255');
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIMESTAMP) {
    throw new RangeError('timestamp must be an integer 0 to 2^32-1');
  }
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > MAX_DATA_SIZE) throw new RangeError('streamId must be 0 to 2^24-1');
  if (data.length > MAX_DATA_SIZE) throw new RangeError('tag data larger than 2^24-1 bytes');
  const size = data.length;
  const out = Buffer.alloc(TAG_HEADER_SIZE + size + PREV_SIZE_BYTES);
  out[0] = type;
  out.writeUIntBE(size, 1, 3);
  out.writeUIntBE(timestamp % TIMESTAMP_MOD, 4, 3);
  out[7] = Math.floor(timestamp / TIMESTAMP_MOD);
  out.writeUIntBE(streamId, 8, 3);
  data.copy(out, TAG_HEADER_SIZE);
  out.writeUInt32BE(TAG_HEADER_SIZE + size, TAG_HEADER_SIZE + size);
  return out;
}
