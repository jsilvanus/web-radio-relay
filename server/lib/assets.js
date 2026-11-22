/**
 * Image assets: magic-byte detection, content-addressed ids and a store that
 * keeps the bytes in S3 (`assets/<assetId>`) or in a local directory.
 *
 * Ids are the SHA-256 of the bytes plus the extension, so the same image
 * uploaded twice is stored once. Every id is checked against ASSET_ID_PATTERN
 * before it becomes a key or a file name (path traversal guard), so a bad id
 * never reaches the disk or the bucket.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Stored id: 64 hex characters, a dot and one of the three extensions. */
export const ASSET_ID_PATTERN = /^[a-f0-9]{64}\.(png|jpg|webp)$/;

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** Largest accepted image, in bytes (10 MB). */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

/**
 * Image type from the first bytes of the file.
 * @param {Buffer} buffer
 * @returns {'png' | 'jpg' | 'webp' | null}
 */
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/**
 * Content-addressed id: sha256 hex of the bytes, a dot and the extension.
 * @param {Buffer} buffer
 * @param {'png' | 'jpg' | 'webp'} ext
 * @returns {string}
 */
export function assetIdFor(buffer, ext) {
  if (!MIME_BY_EXT[ext]) throw new Error(`unsupported asset extension: ${ext}`);
  const hash = createHash('sha256').update(buffer).digest('hex');
  return `${hash}.${ext}`;
}

/** True when the value is a well-formed asset id. */
export function isValidAssetId(assetId) {
  return typeof assetId === 'string' && ASSET_ID_PATTERN.test(assetId);
}

/**
 * Content-Type to serve for an asset id, or null for a malformed id.
 * @param {string} assetId
 * @returns {string | null}
 */
export function assetContentType(assetId) {
  if (!isValidAssetId(assetId)) return null;
  return MIME_BY_EXT[assetId.slice(assetId.lastIndexOf('.') + 1)];
}

/**
 * Store for image bytes. With an S3 client the objects go to `assets/<id>`;
 * otherwise to files in `dir`.
 *
 * put(buffer) -> { assetId, size, reused }   (throws on unsupported bytes)
 * get(assetId) -> Buffer | null              (null for a malformed or unknown id)
 *
 * @param {{ s3?: object | null, dir?: string }} options
 *   s3: an object from createS3Client (putObject, headObject, getObject)
 *   dir: directory for local storage, used when s3 is not given
 */
export function createAssetStore({ s3 = null, dir = '' } = {}) {
  if (!s3 && !dir) throw new Error('createAssetStore needs an s3 client or a dir');

  const keyFor = (assetId) => `assets/${assetId}`;
  const fileFor = (assetId) => path.join(dir, assetId);

  return {
    async put(buffer) {
      const ext = detectImageType(buffer);
      if (!ext) throw new Error('not a PNG, JPEG or WebP image');
      const assetId = assetIdFor(buffer, ext);
      const size = buffer.length;

      if (s3) {
        const existing = await s3.headObject(keyFor(assetId));
        if (existing) return { assetId, size, reused: true };
        await s3.putObject(keyFor(assetId), buffer, { contentType: MIME_BY_EXT[ext] });
        return { assetId, size, reused: false };
      }

      const file = fileFor(assetId);
      if (fs.existsSync(file)) return { assetId, size, reused: true };
      fs.mkdirSync(dir, { recursive: true });
      // Write under a temporary name, then rename, so a half-written file is never served.
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, file);
      return { assetId, size, reused: false };
    },

    async get(assetId) {
      if (!isValidAssetId(assetId)) return null;
      if (s3) return s3.getObject(keyFor(assetId));
      try {
        return fs.readFileSync(fileFor(assetId));
      } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}
