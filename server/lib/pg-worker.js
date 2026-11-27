// Worker thread that connects to PostgreSQL and runs queries synchronously for the main thread.
import { parentPort } from 'node:worker_threads';
import pg from 'pg';

// Parse int8 / BIGINT (OID 20) as JavaScript Number (safe for timestamps up to 9e15 ms)
pg.types.setTypeParser(20, (val) => (val === null ? null : Number(val)));

let client = null;

async function initClient(config) {
  if (client) {
    try { await client.end(); } catch {}
  }
  client = new pg.Client(config);
  await client.connect();
}

parentPort.on('message', async ({ port, signal, config }) => {
  try {
    await initClient(config);
    port.postMessage({ ok: true });
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0, 1);
  } catch (err) {
    port.postMessage({ ok: false, error: err.message, code: err.code });
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0, 1);
    return;
  }

  port.on('message', async (req) => {
    try {
      if (req.type === 'query') {
        const res = await client.query(req.sql, req.params);
        port.postMessage({ ok: true, rows: res.rows, rowCount: res.rowCount ?? 0 });
      } else if (req.type === 'exec') {
        await client.query(req.sql);
        port.postMessage({ ok: true });
      } else if (req.type === 'close') {
        if (client) {
          await client.end();
          client = null;
        }
        port.postMessage({ ok: true });
      } else {
        port.postMessage({ ok: false, error: `Unknown request type: ${req.type}` });
      }
    } catch (err) {
      port.postMessage({ ok: false, error: err.message, code: err.code });
    } finally {
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0, 1);
    }
  });
});
