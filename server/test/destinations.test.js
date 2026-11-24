import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/store.js';
import {
  validateDestination, createDestination, listDestinations, getDestination, updateDestination,
  deleteDestination, loadEgressTarget, publicDestination,
} from '../lib/destinations.js';

const KEY = 'a'.repeat(64);
const SECRET = 'SECRET-STREAM-KEY-7f3';
const YT = 'rtmp://a.rtmp.example.com/live2';
const FB = 'rtmps://fb.example.com:443/rtmp/';

function fresh() {
  return openStore(':memory:').db;
}

test('validation: accepted and refused bodies', () => {
  const ok = (body) => validateDestination(body);
  const refused = (body, text) => {
    const r = ok(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(r.error, text);
  };

  // accepted, with defaults filled in for a create
  const made = ok({ name: 'main', kind: 'youtube', url: YT, key: SECRET });
  assert.equal(made.ok, true);
  assert.deepEqual(made.value, { name: 'main', kind: 'youtube', url: YT, key: SECRET, variant: 'raw', enabled: true, startWith: 'stream' });
  assert.equal(ok({ name: 'fb_1-x', kind: 'facebook', url: FB, key: SECRET, variant: 'cc', enabled: false, startWith: 'manual' }).ok, true);
  assert.equal(ok({ name: 'plain', kind: 'rtmp', url: 'rtmp://relay.example.com/app' }).ok, true, 'rtmp key is optional');
  assert.equal(ok({ name: 'with-user', kind: 'rtmp', url: 'rtmp://user:pw@relay.example.com/app' }).ok, true);

  // names
  refused({ name: 'Main', kind: 'rtmp', url: YT }, /name must match/);
  refused({ name: 'a'.repeat(33), kind: 'rtmp', url: YT }, /name must match/);
  refused({ name: 'has space', kind: 'rtmp', url: YT }, /name must match/);
  refused({ name: '', kind: 'rtmp', url: YT }, /name must match/);
  refused({ kind: 'rtmp', url: YT }, /name is required/);

  // kinds and urls
  refused({ name: 'x', kind: 'twitch', url: YT }, /kind must be/);
  refused({ name: 'x', kind: 'rtmp', url: 'http://example.com/live' }, /url must be rtmp/);
  refused({ name: 'x', kind: 'rtmp', url: 'rtmp://' }, /url must be rtmp/);
  refused({ name: 'x', kind: 'rtmp', url: 'rtmp://a b.example.com/x' }, /url must be rtmp/);
  refused({ name: 'x', kind: 'rtmp' }, /url is required/);
  refused({ name: 'x', kind: 'facebook', url: YT, key: SECRET }, /facebook url must be rtmps/);

  // youtube and facebook need a key
  refused({ name: 'x', kind: 'youtube', url: YT }, /youtube destinations need a stream key/);
  refused({ name: 'x', kind: 'facebook', url: FB, key: '' }, /facebook destinations need a stream key/);

  // keys
  refused({ name: 'x', kind: 'rtmp', url: YT, key: 'has space' }, /key must be/);
  refused({ name: 'x', kind: 'rtmp', url: YT, key: 'k'.repeat(513) }, /key must be/);
  refused({ name: 'x', kind: 'rtmp', url: YT, key: 42 }, /key must be/);
  refused({ name: 'x', kind: 'rtmp', url: `${YT}/${SECRET}`, key: SECRET }, /must not appear in the url/);

  // flags
  refused({ name: 'x', kind: 'rtmp', url: YT, variant: 'hd' }, /variant must be/);
  refused({ name: 'x', kind: 'rtmp', url: YT, enabled: 'yes' }, /enabled must be/);
  refused({ name: 'x', kind: 'rtmp', url: YT, startWith: 'auto' }, /startWith must be/);
  refused({ name: 'x', kind: 'rtmp', url: YT, id: 'dst_000000000000' }, /unknown field: id/);

  // bodies
  assert.equal(ok(null).ok, false);
  assert.equal(ok([]).ok, false);
  assert.match(ok('x').error, /JSON object/);
});

test('validation: an update checks the merged destination', () => {
  const current = { kind: 'rtmp', url: 'rtmp://relay.example.com/app', hasKey: false };
  assert.equal(validateDestination({ enabled: false }, { current }).ok, true);
  assert.equal(validateDestination({ kind: 'facebook' }, { current }).ok, false, 'rtmp url cannot become facebook');
  assert.equal(validateDestination({ kind: 'youtube' }, { current }).ok, false, 'youtube needs a key');
  assert.equal(validateDestination({ kind: 'youtube', key: SECRET }, { current }).ok, true);
  const withKey = { kind: 'youtube', url: YT, hasKey: true };
  assert.equal(validateDestination({ key: null }, { current: withKey }).ok, false, 'clearing the key of youtube is refused');
  assert.equal(validateDestination({ key: '' }, { current: { kind: 'rtmp', url: YT, hasKey: true } }).ok, true);
  assert.equal(validateDestination({}, { current }).ok, true);
});

test('public view: no key, url without user and password', () => {
  const db = fresh();
  const made = createDestination(db, 'chapel', {
    name: 'main', kind: 'rtmp', url: 'rtmp://user:pw@relay.example.com/app', key: SECRET,
  }, { secretKey: KEY });
  assert.deepEqual(Object.keys(made).sort(), ['enabled', 'hasKey', 'id', 'kind', 'name', 'startWith', 'url', 'variant'].sort());
  assert.equal(made.hasKey, true);
  assert.equal(made.url, 'rtmp://[REDACTED]@relay.example.com/app');
  assert.equal(made.variant, 'raw');
  assert.equal(made.enabled, true);
  assert.equal(made.startWith, 'stream');
  assert.equal(publicDestination({ id: 'x', name: 'x', kind: 'rtmp', url: 'rtmp://h/app/SECRETPATH', variant: 'raw', enabled: 1, start_with: 'stream', key_enc: null }).url, 'rtmp://h/app/[REDACTED]');
});

test('the key never appears in any returned value (serialized)', () => {
  const db = fresh();
  const body = { name: 'main', kind: 'youtube', url: YT, key: SECRET };
  const created = createDestination(db, 'chapel', body, { secretKey: KEY });
  const patched = updateDestination(db, 'chapel', created.id, { enabled: false, url: 'rtmp://a.rtmp.example.com/live3' }, { secretKey: KEY });
  const patchedKey = updateDestination(db, 'chapel', created.id, { key: 'OTHER-KEY-99' }, { secretKey: KEY });
  const all = listDestinations(db, 'chapel');
  const single = getDestination(db, 'chapel', created.id);
  const serialized = JSON.stringify([created, patched, patchedKey, all, single]);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes('OTHER-KEY-99'), false);
  // the stored blob is not the key either, and it does decrypt with the right key
  const raw = db.prepare('SELECT key_enc FROM destinations').all().map((r) => r.key_enc);
  assert.ok(raw.every((blob) => blob.startsWith('v1:')));
  assert.equal(loadEgressTarget(db, 'chapel', created.id, { secretKey: KEY }).key, 'OTHER-KEY-99');
});

test('the egress target carries the decrypted key only through loadEgressTarget', () => {
  const db = fresh();
  const created = createDestination(db, 'chapel', { name: 'main', kind: 'youtube', url: YT, key: SECRET }, { secretKey: KEY });
  const target = loadEgressTarget(db, 'chapel', created.id, { secretKey: KEY });
  assert.equal(target.key, SECRET);
  assert.equal(target.url, YT);
  assert.equal(target.variant, 'raw');
  assert.throws(() => loadEgressTarget(db, 'chapel', created.id, {}), (err) => err.statusCode === 503 && !String(err.message).includes(SECRET));
  assert.throws(() => loadEgressTarget(db, 'chapel', 'dst_000000000000', { secretKey: KEY }), (err) => err.statusCode === 404);
});

test('a key needs RELAY_SECRET_KEY: 503 without it, and the key is not in the message', () => {
  const db = fresh();
  assert.throws(
    () => createDestination(db, 'chapel', { name: 'main', kind: 'rtmp', url: YT, key: SECRET }, {}),
    (err) => err.statusCode === 503 && /RELAY_SECRET_KEY is not set/.test(err.message) && !err.message.includes(SECRET),
  );
  assert.equal(listDestinations(db, 'chapel').length, 0, 'nothing is stored');
  // a destination without a key needs no secret key
  assert.equal(createDestination(db, 'chapel', { name: 'plain', kind: 'rtmp', url: YT }, {}).hasKey, false);
  assert.throws(
    () => createDestination(db, 'chapel', { name: 'bad', kind: 'rtmp', url: YT, key: SECRET }, { secretKey: 'short' }),
    (err) => err.statusCode === 503 && /64 hex/.test(err.message),
  );
});

test('the stream limit: MAX_DESTINATIONS_PER_STREAM is enforced per stream', () => {
  const db = fresh();
  for (let i = 1; i <= 2; i++) {
    createDestination(db, 'chapel', { name: `d${i}`, kind: 'rtmp', url: YT }, { maxPerStream: 2 });
  }
  assert.throws(
    () => createDestination(db, 'chapel', { name: 'd3', kind: 'rtmp', url: YT }, { maxPerStream: 2 }),
    (err) => err.statusCode === 409 && /at most 2 destinations/.test(err.message),
  );
  // another stream has its own count
  assert.equal(createDestination(db, 'other', { name: 'd1', kind: 'rtmp', url: YT }, { maxPerStream: 2 }).name, 'd1');
  // the default limit is 6
  const db6 = fresh();
  for (let i = 1; i <= 6; i++) createDestination(db6, 's', { name: `n${i}`, kind: 'rtmp', url: YT });
  assert.throws(() => createDestination(db6, 's', { name: 'n7', kind: 'rtmp', url: YT }), (err) => err.statusCode === 409);
});

test('names are unique per stream; a rename onto a taken name is 409', () => {
  const db = fresh();
  const a = createDestination(db, 'chapel', { name: 'main', kind: 'rtmp', url: YT });
  createDestination(db, 'chapel', { name: 'backup', kind: 'rtmp', url: YT });
  assert.throws(() => createDestination(db, 'chapel', { name: 'main', kind: 'rtmp', url: YT }), (err) => err.statusCode === 409);
  assert.throws(() => updateDestination(db, 'chapel', a.id, { name: 'backup' }), (err) => err.statusCode === 409);
  assert.equal(updateDestination(db, 'chapel', a.id, { name: 'main' }).destination.name, 'main', 'keeping the own name is fine');
  assert.equal(createDestination(db, 'other', { name: 'main', kind: 'rtmp', url: YT }).name, 'main', 'same name on another stream is fine');
});

test('update: targetChanged tells the caller to stop a running child', () => {
  const db = fresh();
  const created = createDestination(db, 'chapel', { name: 'main', kind: 'rtmp', url: YT, key: SECRET }, { secretKey: KEY });
  assert.equal(updateDestination(db, 'chapel', created.id, { name: 'renamed' }, { secretKey: KEY }).targetChanged, false);
  assert.equal(updateDestination(db, 'chapel', created.id, { url: 'rtmp://b.example.com/app' }, { secretKey: KEY }).targetChanged, true);
  assert.equal(updateDestination(db, 'chapel', created.id, { enabled: false }, { secretKey: KEY }).targetChanged, true);
  assert.equal(updateDestination(db, 'chapel', created.id, { variant: 'cc' }, { secretKey: KEY }).destination.variant, 'cc');
  const cleared = updateDestination(db, 'chapel', created.id, { key: null }, { secretKey: KEY });
  assert.equal(cleared.destination.hasKey, false);
});

test('update and delete of an unknown id are 404; delete removes the row', () => {
  const db = fresh();
  assert.throws(() => updateDestination(db, 'chapel', 'dst_000000000000', { enabled: false }), (err) => err.statusCode === 404);
  assert.throws(() => updateDestination(db, 'chapel', 'not-an-id', { enabled: false }), (err) => err.statusCode === 404);
  const created = createDestination(db, 'chapel', { name: 'main', kind: 'rtmp', url: YT });
  assert.equal(deleteDestination(db, 'chapel', created.id), true);
  assert.equal(deleteDestination(db, 'chapel', created.id), false);
  assert.equal(getDestination(db, 'chapel', created.id), null);
});

test('loadEgressTarget of a plain rtmp destination needs no key; a bad body is 400', () => {
  const db = fresh();
  const created = createDestination(db, 'chapel', { name: 'main', kind: 'rtmp', url: YT });
  assert.equal(loadEgressTarget(db, 'chapel', created.id, {}).enabled, true);
  assert.throws(() => createDestination(db, 'chapel', { name: 'x', kind: 'rtmp' }), (err) => err.statusCode === 400);
  assert.throws(() => createDestination(db, 'chapel', null), (err) => err.statusCode === 400);
});
