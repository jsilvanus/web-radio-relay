import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { requireScope, requireBearer } from '../lib/auth.js';
import { openStore } from '../lib/store.js';
import { createToken, revokeToken } from '../lib/tokens.js';

const NOW = 1_700_000_000_000;
const ENV_TOKEN = 'env-admin-token';

/** A tiny app with one scoped route per test; returns { base, close, db, setNow }. */
async function app(adminToken) {
  const { db, close: closeStore } = openStore(':memory:');
  let now = NOW;
  const a = express();
  a.get(
    '/s/:name/data',
    requireScope((req) => `stream:${req.params.name}:data`, { adminToken, db, nowMs: () => now }),
    (req, res) => res.json({ ok: true, auth: req.auth }),
  );
  a.get('/admin', requireScope(() => 'admin', { adminToken, db, nowMs: () => now }), (_req, res) =>
    res.json({ ok: true }),
  );
  const server = await new Promise((resolve) => {
    const s = a.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    db,
    setNow(ms) {
      now = ms;
    },
    close() {
      server.close();
      closeStore();
    },
  };
}

function get(base, path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return fetch(`${base}${path}`, { headers });
}

test('requireScope: 503 when no env token and no stored token', async () => {
  const t = await app('');
  try {
    const res = await get(t.base, '/s/keskus/data', 'anything');
    assert.equal(res.status, 503);
  } finally {
    t.close();
  }
});

test('requireScope: a stored token makes the API usable without the env token', async () => {
  const t = await app('');
  try {
    const made = createToken(t.db, { scopes: ['stream:keskus:data'] }, NOW);
    assert.equal((await get(t.base, '/s/keskus/data', made.token)).status, 200);
    assert.equal((await get(t.base, '/s/keskus/data', 'nope')).status, 401);
  } finally {
    t.close();
  }
});

test('requireScope: 401 without a header or with an unknown token', async () => {
  const t = await app(ENV_TOKEN);
  try {
    const none = await get(t.base, '/s/keskus/data');
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate'), /Bearer/);
    assert.equal((await get(t.base, '/s/keskus/data', 'unknown')).status, 401);
  } finally {
    t.close();
  }
});

test('requireScope: the env token passes every scope as admin', async () => {
  const t = await app(ENV_TOKEN);
  try {
    const res = await get(t.base, '/s/keskus/data', ENV_TOKEN);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).auth, { kind: 'env', scopes: ['admin'] });
    assert.equal((await get(t.base, '/admin', ENV_TOKEN)).status, 200);
  } finally {
    t.close();
  }
});

test('requireScope: a stored stream token passes its own scope only', async () => {
  const t = await app(ENV_TOKEN);
  try {
    const made = createToken(t.db, { scopes: ['stream:keskus:data'] }, NOW);
    const ok = await get(t.base, '/s/keskus/data', made.token);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).auth.kind, 'token');
    assert.equal((await get(t.base, '/s/other/data', made.token)).status, 403);
    assert.equal((await get(t.base, '/admin', made.token)).status, 403);
  } finally {
    t.close();
  }
});

test('requireScope: a stored admin token passes admin routes', async () => {
  const t = await app(ENV_TOKEN);
  try {
    const made = createToken(t.db, { scopes: ['admin'] }, NOW);
    assert.equal((await get(t.base, '/admin', made.token)).status, 200);
    assert.equal((await get(t.base, '/s/anything/data', made.token)).status, 200);
  } finally {
    t.close();
  }
});

test('requireScope: a revoked token is 401', async () => {
  const t = await app(ENV_TOKEN);
  try {
    const made = createToken(t.db, { scopes: ['admin'] }, NOW);
    assert.equal((await get(t.base, '/admin', made.token)).status, 200);
    revokeToken(t.db, made.id, NOW);
    assert.equal((await get(t.base, '/admin', made.token)).status, 401);
  } finally {
    t.close();
  }
});

test('requireScope: an expired token is 401 once the clock passes expiresAt', async () => {
  const t = await app(ENV_TOKEN);
  try {
    const made = createToken(t.db, { scopes: ['admin'], expiresInSeconds: 60 }, NOW);
    t.setNow(NOW + 59_000);
    assert.equal((await get(t.base, '/admin', made.token)).status, 200);
    t.setNow(NOW + 60_000);
    assert.equal((await get(t.base, '/admin', made.token)).status, 401);
  } finally {
    t.close();
  }
});

test('requireScope: env token is compared in constant time (wrong env-like value is 401)', async () => {
  const t = await app(ENV_TOKEN);
  try {
    assert.equal((await get(t.base, '/admin', ENV_TOKEN + 'x')).status, 401);
  } finally {
    t.close();
  }
});

test('requireBearer (legacy) still answers 503 with no token configured', async () => {
  const a = express();
  a.get('/legacy', requireBearer(''), (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const s = a.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/legacy`, {
      headers: { Authorization: 'Bearer x' },
    });
    assert.equal(res.status, 503);
  } finally {
    server.close();
  }
});
