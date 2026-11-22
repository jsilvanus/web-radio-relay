/**
 * Minimal S3 client: AWS Signature Version 4 plus put/head/get/delete over
 * global fetch. No SDK. Path-style URLs: `<endpoint>/<bucket>/<prefix><key>`.
 *
 * signV4 is pure (the clock is passed in). createS3Client takes fetchImpl and
 * now, so tests run against a local fake server.
 *
 * Error messages carry the HTTP status and the S3 <Code> only. They never
 * contain the secret key, the signature or the Authorization header.
 */

import { createHash, createHmac } from 'node:crypto';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ALGORITHM = 'AWS4-HMAC-SHA256';

/** RFC 3986 encoding: unreserved characters stay, everything else is %XX. */
function rfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Encodes each path segment once (decodes first, so pre-encoded input is not double-encoded). */
function canonicalPath(pathname) {
  return pathname
    .split('/')
    .map((segment) => rfc3986(safeDecode(segment)))
    .join('/');
}

/** Sorted by encoded name, then encoded value. */
function canonicalQuery(searchParams) {
  const pairs = [];
  for (const [key, value] of searchParams) {
    pairs.push([rfc3986(key), rfc3986(value)]);
  }
  pairs.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

/** 20130524T000000Z from a Date. */
function amzDate(now) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Signs one S3 request with AWS Signature Version 4.
 *
 * @param {object} p
 * @param {string} p.method            HTTP method
 * @param {string} p.url               absolute URL (host, path and query are taken from it)
 * @param {Record<string,string>} [p.headers]  extra headers to sign (host is added from the URL if absent)
 * @param {string} p.payloadHash       hex sha256 of the body (EMPTY_SHA256 for no body)
 * @param {string} p.accessKeyId
 * @param {string} p.secretAccessKey
 * @param {string} p.region
 * @param {string} [p.service='s3']
 * @param {Date} p.now
 * @returns {Record<string,string>} the given headers plus authorization, x-amz-date and x-amz-content-sha256
 */
export function signV4({
  method,
  url,
  headers = {},
  payloadHash,
  accessKeyId,
  secretAccessKey,
  region,
  service = 's3',
  now,
}) {
  const target = new URL(url);
  const date = amzDate(now);
  const day = date.slice(0, 8);

  const all = {};
  for (const [name, value] of Object.entries(headers)) {
    all[name.toLowerCase()] = String(value);
  }
  if (!all.host) all.host = target.host;
  all['x-amz-date'] = date;
  all['x-amz-content-sha256'] = payloadHash;

  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath(target.pathname),
    canonicalQuery(target.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, date, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac('AWS4' + secretAccessKey, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...headers,
    'x-amz-date': date,
    'x-amz-content-sha256': payloadHash,
    authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Builds an S3 client bound to one bucket.
 *
 * putObject(key, body, { contentType }) -> { etag }
 * headObject(key) -> { size, etag } | null (404)
 * getObject(key) -> Buffer | null (404)
 * deleteObject(key) -> undefined (204 and 404 are both fine)
 */
export function createS3Client({
  endpoint,
  bucket,
  region = 'us-east-1',
  accessKeyId,
  secretAccessKey,
  prefix = '',
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  const base = String(endpoint).replace(/\/+$/, '');

  function objectUrl(key) {
    const fullKey = prefix + key;
    return `${base}/${rfc3986(bucket)}/${fullKey.split('/').map(rfc3986).join('/')}`;
  }

  async function request(method, key, body, extraHeaders = {}) {
    const hasBody = body !== undefined;
    const payloadHash = hasBody ? sha256Hex(body) : EMPTY_SHA256;
    const url = objectUrl(key);
    const headers = signV4({
      method,
      url,
      headers: extraHeaders,
      payloadHash,
      accessKeyId,
      secretAccessKey,
      region,
      now: now(),
    });
    const init = { method, headers };
    if (hasBody) init.body = body;
    return fetchImpl(url, init);
  }

  async function failure(res, operation, readBody) {
    let code = '';
    if (readBody) {
      const text = await res.text().catch(() => '');
      const match = /<Code>([^<]*)<\/Code>/.exec(text);
      if (match) code = match[1];
    }
    const error = new Error(`S3 ${operation} failed: HTTP ${res.status}${code ? ` ${code}` : ''}`);
    error.status = res.status;
    if (code) error.code = code;
    return error;
  }

  return {
    async putObject(key, body, { contentType } = {}) {
      const headers = {};
      if (contentType) headers['content-type'] = contentType;
      const res = await request('PUT', key, body, headers);
      if (!res.ok) throw await failure(res, 'PutObject', true);
      return { etag: res.headers.get('etag') ?? '' };
    },

    async headObject(key) {
      const res = await request('HEAD', key);
      if (res.status === 404) return null;
      if (!res.ok) throw await failure(res, 'HeadObject', false);
      return {
        size: Number(res.headers.get('content-length') ?? 0),
        etag: res.headers.get('etag') ?? '',
      };
    },

    async getObject(key) {
      const res = await request('GET', key);
      if (res.status === 404) return null;
      if (!res.ok) throw await failure(res, 'GetObject', true);
      return Buffer.from(await res.arrayBuffer());
    },

    async deleteObject(key) {
      const res = await request('DELETE', key);
      if (res.ok || res.status === 404) return;
      throw await failure(res, 'DeleteObject', true);
    },
  };
}

/**
 * Reads S3 settings from an environment object. Returns null when the
 * endpoint or the bucket is missing (S3 is then off).
 * S3_PREFIX defaults to `relay/` (an empty value counts as unset).
 */
export function s3ConfigFromEnv(env) {
  const endpoint = env.S3_ENDPOINT?.trim();
  const bucket = env.S3_BUCKET?.trim();
  if (!endpoint || !bucket) return null;
  return {
    endpoint,
    bucket,
    region: env.S3_REGION?.trim() || 'us-east-1',
    accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    prefix: env.S3_PREFIX?.trim() || 'relay/',
  };
}
