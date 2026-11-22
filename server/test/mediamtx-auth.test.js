import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, ipInCidr, parseCidr } from '../lib/mediamtx-auth.js';

const NOW = 1_700_000_000_000;
const SECRET = 'internal-secret-value-0123456789';
const CIDRS = ['172.16.0.0/12', '10.0.0.0/8', '127.0.0.0/8'];

// Long, unusual values so that a reason string can never contain one by accident.
const TK = {
  good: 'tokgood-7f3a9c1e5b2d4a60',
  view: 'tokview-2c8e0d4f6a1b3c95',
  admin: 'tokadmin-9b1d3f5a7c2e4061',
  expired: 'tokexpired-4e6a8c0b2d4f6a81',
  revoked: 'tokrevoked-1a3c5e7b9d0f2b43',
  otherStream: 'tokother-5d7f9b1d3f5a7c29',
  dataOnly: 'tokdata-8a0c2e4f6b8d0a6e',
  unknown: 'tokunknown-3e5a7c9e1b3d5f77',
  guess: 'guessed-secret-6f8a0c2e4a6c8e09',
};

const TOKENS = {
  [TK.good]: { id: 'tok_good', scopes: ['stream:keskus:publish'], expiresAt: null, revokedAt: null },
  [TK.view]: { id: 'tok_view', scopes: ['stream:keskus:view'], expiresAt: null, revokedAt: null },
  [TK.admin]: { id: 'tok_admin', scopes: ['admin'], expiresAt: null, revokedAt: null },
  [TK.expired]: { id: 'tok_exp', scopes: ['stream:keskus:publish'], expiresAt: NOW - 1, revokedAt: null },
  [TK.revoked]: { id: 'tok_rev', scopes: ['stream:keskus:publish'], expiresAt: null, revokedAt: NOW - 5 },
  [TK.otherStream]: { id: 'tok_other', scopes: ['stream:other:publish'], expiresAt: null, revokedAt: null },
  [TK.dataOnly]: { id: 'tok_data', scopes: ['stream:keskus:data'], expiresAt: null, revokedAt: null },
};

const lookupToken = (t) => TOKENS[t] ?? null;
const deps = { lookupToken, internalSecret: SECRET, internalCidrs: CIDRS, nowMs: NOW };

const EXTERNAL = '203.0.113.9';
const INTERNAL = '172.17.0.4';
const q = (name) => `token=${TK[name]}`;

const cases = [
  // publish, token from the query string
  { name: 'publish with a good token', req: { action: 'publish', path: 'live/keskus', query: q('good') }, allow: true },
  // publish, token as the password field
  { name: 'publish with the token as password', req: { action: 'publish', path: 'live/keskus', password: TK.good }, allow: true },
  { name: 'publish with a token for another stream', req: { action: 'publish', path: 'live/keskus', query: q('otherStream') }, allow: false },
  { name: 'publish with a data-only token', req: { action: 'publish', path: 'live/keskus', query: q('dataOnly') }, allow: false },
  { name: 'publish with an expired token', req: { action: 'publish', path: 'live/keskus', query: q('expired') }, allow: false },
  { name: 'publish with a revoked token', req: { action: 'publish', path: 'live/keskus', query: q('revoked') }, allow: false },
  { name: 'publish with an admin-scope token', req: { action: 'publish', path: 'live/keskus', query: q('admin') }, allow: true },
  { name: 'publish with no token', req: { action: 'publish', path: 'live/keskus', query: '' }, allow: false },
  { name: 'publish with an unknown token', req: { action: 'publish', path: 'live/keskus', query: q('unknown') }, allow: false },
  // captioner path (-cc) needs the internal secret, not a token
  { name: '-cc publish with the internal secret', req: { action: 'publish', path: 'live/keskus-cc', query: `secret=${SECRET}` }, allow: true },
  { name: '-cc publish without the secret', req: { action: 'publish', path: 'live/keskus-cc', query: '' }, allow: false },
  { name: '-cc publish with a wrong secret', req: { action: 'publish', path: 'live/keskus-cc', query: `secret=${TK.guess}` }, allow: false },
  { name: '-cc publish with a good token but no secret', req: { action: 'publish', path: 'live/keskus-cc', query: q('good') }, allow: false },
  // read and playback
  { name: 'read from an internal address without a token', req: { action: 'read', path: 'live/keskus', ip: INTERNAL }, allow: true },
  { name: 'read from an external address without a token', req: { action: 'read', path: 'live/keskus', ip: EXTERNAL }, allow: false },
  { name: 'read from outside with a view token', req: { action: 'read', path: 'live/keskus', ip: EXTERNAL, query: q('view') }, allow: true },
  { name: 'read from outside with a publish-only token', req: { action: 'read', path: 'live/keskus', ip: EXTERNAL, query: q('good') }, allow: false },
  { name: 'read from an IPv6-mapped internal address', req: { action: 'read', path: 'live/keskus', ip: '::ffff:10.1.2.3' }, allow: true },
  { name: 'read from an address just outside 172.16/12', req: { action: 'read', path: 'live/keskus', ip: '172.32.0.1' }, allow: false },
  { name: 'playback from an internal address', req: { action: 'playback', path: 'live/keskus', ip: INTERNAL }, allow: true },
  // other actions are never allowed, even for admin tokens
  { name: 'api action with the admin token', req: { action: 'api', path: 'live/keskus', query: q('admin'), ip: INTERNAL }, allow: false },
  { name: 'metrics action from an internal address', req: { action: 'metrics', path: 'live/keskus', ip: INTERNAL }, allow: false },
  // path shape
  { name: 'bad path: upper case', req: { action: 'publish', path: 'live/Keskus', query: q('good') }, allow: false },
  { name: 'bad path: no live prefix', req: { action: 'publish', path: 'keskus', query: q('good') }, allow: false },
  { name: 'bad path: nested segment', req: { action: 'publish', path: 'live/a/b', query: q('good') }, allow: false },
  { name: 'bad path: 33 characters', req: { action: 'read', path: `live/${'a'.repeat(33)}`, ip: INTERNAL }, allow: false },
];

for (const c of cases) {
  test(`decide: ${c.name}`, () => {
    const result = decide(c.req, deps);
    assert.equal(result.allow, c.allow, result.reason);
    assert.equal(typeof result.reason, 'string');
  });
}

test('decide: reasons never contain a token or the secret', () => {
  const secrets = [...Object.values(TK), SECRET];
  for (const c of cases) {
    const { reason } = decide(c.req, deps);
    for (const s of secrets) {
      assert.ok(!reason.includes(s), `${c.name}: reason leaks a secret: ${reason}`);
    }
  }
});

test('decide: an empty internal secret denies every -cc publish', () => {
  const result = decide(
    { action: 'publish', path: 'live/keskus-cc', query: 'secret=' },
    { ...deps, internalSecret: '' },
  );
  assert.equal(result.allow, false);
});

test('decide: with no internal CIDRs, reads need a token', () => {
  const result = decide({ action: 'read', path: 'live/keskus', ip: INTERNAL }, { ...deps, internalCidrs: [] });
  assert.equal(result.allow, false);
});

test('parseCidr: network base and mask', () => {
  assert.deepEqual(parseCidr('10.0.0.0/8'), { base: 0x0a000000, mask: 0xff000000 });
  assert.deepEqual(parseCidr('0.0.0.0/0'), { base: 0, mask: 0 });
  assert.equal(parseCidr('10.0.0.0/33'), null);
  assert.equal(parseCidr('10.0.0/8'), null);
  assert.equal(parseCidr('300.0.0.0/8'), null);
});

test('ipInCidr: table of addresses', () => {
  const table = [
    ['172.16.0.1', '172.16.0.0/12', true],
    ['172.31.255.254', '172.16.0.0/12', true],
    ['172.32.0.0', '172.16.0.0/12', false],
    ['172.15.255.255', '172.16.0.0/12', false],
    ['10.200.1.1', '10.0.0.0/8', true],
    ['11.0.0.1', '10.0.0.0/8', false],
    ['127.0.0.1', '127.0.0.0/8', true],
    ['::ffff:127.0.0.1', '127.0.0.0/8', true],
    ['::1', '127.0.0.0/8', false],
    ['203.0.113.9', '0.0.0.0/0', true],
    ['not-an-ip', '10.0.0.0/8', false],
    ['10.1.1.1', 'bogus', false],
    [undefined, '10.0.0.0/8', false],
  ];
  for (const [ip, cidr, expected] of table) {
    assert.equal(ipInCidr(ip, cidr), expected, `${ip} in ${cidr}`);
  }
});
