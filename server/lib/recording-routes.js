/**
 * HTTP routes of the recording service (P5.3). Scope stream:<name>:control
 * (admin passes). Responses never contain S3 keys' secrets, and errors never
 * contain a key: the service only puts status and short messages in them.
 */

import express from 'express';
import { requireScope } from './auth.js';
import { isValidStreamName } from './streams.js';

/**
 * @param {{ service: object, adminToken?: string, db: object }} options
 * @returns {express.Router}
 */
export function createRecordingRouter({ service, adminToken = '', db }) {
  const router = express.Router();
  const requireControl = requireScope((req) => `stream:${req.params.name}:control`, { adminToken, db });

  function checkStream(req, res, next) {
    if (!isValidStreamName(req.params.name)) {
      res.status(400).json({ error: 'invalid stream name' });
      return;
    }
    next();
  }

  /** Maps errors that carry a statusCode to that status; anything else is a 500 without details. */
  function route(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (err) {
        if (err.statusCode) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        console.error('[recordings]', err.name);
        res.status(500).json({ error: 'internal error' });
      }
    };
  }

  router.post('/api/v1/streams/:name/recordings', requireControl, checkStream, route((req, res) => {
    const recording = service.start(req.params.name);
    res.status(202).json({ recording });
  }));

  router.delete('/api/v1/streams/:name/recordings/current', requireControl, checkStream, route(async (req, res) => {
    const recording = await service.stop(req.params.name);
    res.json({ recording });
  }));

  router.get('/api/v1/streams/:name/recordings', requireControl, checkStream, route((req, res) => {
    res.json({ stream: req.params.name, recordings: service.list(req.params.name) });
  }));

  return router;
}
