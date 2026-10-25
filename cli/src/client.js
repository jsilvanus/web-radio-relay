/**
 * HTTP side of the CLI: turns one operation and its arguments into a request.
 * No dependencies; uses the global fetch (Node 24).
 */

/**
 * @param {object} op an entry of operations.generated.js
 * @param {{ server: string, token?: string, params?: Record<string, string>,
 *   body?: unknown, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ status: number, ok: boolean, body: unknown }>}
 */
export async function callOperation(op, { server, token, params = {}, body, fetchImpl = fetch }) {
  const base = server.replace(/\/+$/, '');
  let route = op.path;
  const query = new URLSearchParams();

  for (const p of op.parameters) {
    const value = params[p.name];
    if (value === undefined) {
      if (p.required) throw new Error(`missing --${p.name}`);
      continue;
    }
    if (p.in === 'path') route = route.replace(`{${p.name}}`, encodeURIComponent(value));
    else if (p.in === 'query') query.set(p.name, value);
  }

  const headers = {};
  if (op.bearer) {
    if (!token) throw new Error(`${op.operationId} needs a token: set RELAY_TOKEN or --token`);
    headers.Authorization = `Bearer ${token}`;
  }
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const qs = query.toString();
  const res = await fetchImpl(`${base}${route}${qs ? `?${qs}` : ''}`, {
    method: op.method,
    headers,
    body: payload,
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON (for example the playlist): keep the text
  }
  return { status: res.status, ok: res.ok, body: parsed };
}
