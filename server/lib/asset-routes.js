/**
 * HTTP routes for image assets (P7.3):
 *   POST /api/v1/streams/:name/assets   upload one image (scope stream:<name>:data)
 *   GET  /api/assets/:assetId           serve an image (public, immutable)
 *
 * The routes take the store and the upload guard as arguments, so index.js
 * wires the real ones and the tests mount them on a small app.
 */

import express from 'express';
import { detectImageType, assetContentType, MAX_ASSET_BYTES } from './assets.js';
import { isValidStreamName } from './streams.js';

const EXT_BY_MEDIA = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const IMAGE_TYPES = Object.keys(EXT_BY_MEDIA);

/** Media type of a Content-Type header, without parameters, lower-cased. */
function mediaTypeOf(header) {
  return String(header || '').split(';')[0].trim().toLowerCase();
}

/** Raw body parser for image uploads; answers 413 or 400 itself instead of Express's HTML page. */
const parseImageBody = express.raw({ type: IMAGE_TYPES, limit: MAX_ASSET_BYTES });
function readImageBody(req, res, next) {
  // The parser waits for the body when Content-Length is over the limit, so refuse from the header.
  const declaredBytes = Number(req.headers['content-length']);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_ASSET_BYTES) {
    res.set('Connection', 'close');
    res.status(413).json({ error: 'image is larger than 10 MB' });
    return;
  }
  parseImageBody(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large' || err.status === 413) {
      return res.status(413).json({ error: 'image is larger than 10 MB' });
    }
    return res.status(400).json({ error: 'could not read the request body' });
  });
}

/**
 * Registers the asset routes on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{ store: { put(buffer): Promise<object>, get(assetId): Promise<Buffer|null> },
 *           requireUpload: import('express').RequestHandler }} deps
 *   requireUpload: the scope check for `stream:<name>:data` (requireScope), run before the body is read
 */
export function registerAssetRoutes(app, { store, requireUpload }) {
  app.post(
    '/api/v1/streams/:name/assets',
    requireUpload,
    (req, res, next) => {
      if (!isValidStreamName(req.params.name)) {
        res.status(400).json({ error: 'invalid stream name' });
        return;
      }
      next();
    },
    readImageBody,
    async (req, res) => {
      const declared = mediaTypeOf(req.headers['content-type']);
      if (!EXT_BY_MEDIA[declared]) {
        res.status(415).json({ error: 'Content-Type must be image/png, image/jpeg or image/webp' });
        return;
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'empty body' });
        return;
      }
      const detected = detectImageType(body);
      if (!detected || EXT_BY_MEDIA[declared] !== detected) {
        res.status(415).json({ error: 'the body is not an image of the declared Content-Type' });
        return;
      }
      try {
        const { assetId, size, reused } = await store.put(body);
        res.status(201).json({ assetId, size, reused });
      } catch (err) {
        console.error(`[assets] store failed: ${err.message}`);
        res.status(500).json({ error: 'could not store the image' });
      }
    },
  );

  app.get('/api/assets/:assetId', async (req, res) => {
    const type = assetContentType(req.params.assetId);
    if (!type) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    try {
      const bytes = await store.get(req.params.assetId);
      if (!bytes) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.set({
        'Content-Type': type,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(bytes);
    } catch (err) {
      console.error(`[assets] read failed: ${err.message}`);
      res.status(500).json({ error: 'could not read the image' });
    }
  });
}
