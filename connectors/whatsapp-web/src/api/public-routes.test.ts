/**
 * SKIRM-103 (F3, C1/C12/C13): /api/public/* sits behind the connector HMAC gate.
 *
 * Requests are signed with generateHMACSignature from @mcp-socialmedia/shared —
 * the signer mcp-server's providerGet uses — over `{}` for the GETs and the
 * query-only POST, because express.json leaves `req.body = {}` on a request
 * with no body (it is mounted first in main(), as here). The app is the same
 * composition main.ts builds: express.json, then the router at /api/public.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { createPublicRouter } from './public-routes';

const SECRET = 'test-connector-secret';
const JID = '34600111222@s.whatsapp.net';

const nowSeconds = () => Math.floor(Date.now() / 1000);

function signedHeaders(opts: { body?: unknown; secret?: string; ts?: number } = {}) {
  const ts = opts.ts ?? nowSeconds();
  return {
    'x-connector-timestamp': String(ts),
    'x-connector-signature': generateHMACSignature(opts.body ?? {}, ts, opts.secret ?? SECRET),
  };
}

async function serve(options: { log?: (line: string) => void; now?: () => number } = {}) {
  const calls: string[] = [];
  const client = {
    getChats: async () => [
      { id: { _serialized: 'a@c.us' }, name: 'A', isGroup: false, timestamp: 1 },
      { id: 'b@g.us', name: 'B', isGroup: true, timestamp: 2 },
    ],
    fetchChatHistory: async (chatId: string, limit: number) => {
      calls.push(`history:${chatId}:${limit}`);
      return [{ id: 'm1' }];
    },
    backfillRecentMedia: async (days: number, limit: number) => {
      calls.push(`backfill:${days}:${limit}`);
      return { ok: 1, unavailable: 2, total: 3 };
    },
  };
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/public', createPublicRouter(client as never, SECRET, options));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  return { base, close, calls };
}

async function withServer(
  fn: (s: Awaited<ReturnType<typeof serve>>) => Promise<void>,
  options: Parameters<typeof serve>[0] = {}
) {
  const s = await serve(options);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

// --- C1: without a signature, nothing is served ----------------------------

test('sin firma → 401 en las tres rutas y no llega al cliente', async () => {
  await withServer(async ({ base, calls }) => {
    const attempts: [string, string][] = [
      ['GET', '/api/public/chats'],
      ['GET', `/api/public/history/${JID}`],
      ['POST', '/api/public/backfill-media?days=3&limit=20'],
    ];
    for (const [method, path] of attempts) {
      const r = await fetch(`${base}${path}`, { method });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.deepEqual(await r.json(), { error: 'Missing authentication headers' });
    }
    assert.deepEqual(calls, []);
  });
});

test('una ruta desconocida bajo /api/public tampoco se revela sin firma', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/public/nope`)).status, 401);
  });
});

// --- C1/C13: with the providerGet signature, every route answers 200 --------

test('GET /chats firmado como providerGet ("{}") → 200 con el mapa de siempre', async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(`${base}/api/public/chats`, { headers: signedHeaders() });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      chats: [
        { id: 'a@c.us', name: 'A', isGroup: false, timestamp: 1 },
        { id: 'b@g.us', name: 'B', isGroup: true, timestamp: 2 },
      ],
    });
  });
});

test('GET /history/:chatId firmado → 200; el límite viaja en la query, la firma sigue siendo "{}"', async () => {
  await withServer(async ({ base, calls }) => {
    const path = `/api/public/history/${encodeURIComponent(JID)}`;
    const a = await fetch(`${base}${path}?limit=7`, { headers: signedHeaders() });
    assert.equal(a.status, 200);
    assert.deepEqual(await a.json(), { messages: [{ id: 'm1' }] });
    const b = await fetch(`${base}${path}`, { headers: signedHeaders() });
    assert.equal(b.status, 200);
    assert.deepEqual(calls, [`history:${JID}:7`, `history:${JID}:500`]);
  });
});

test('POST /backfill-media con cuerpo vacío y parámetros en la query → 200 (firma sobre "{}")', async () => {
  await withServer(async ({ base, calls }) => {
    const bare = await fetch(`${base}/api/public/backfill-media?days=3&limit=20`, {
      method: 'POST',
      headers: signedHeaders(),
    });
    assert.equal(bare.status, 200);
    assert.deepEqual(await bare.json(), { ok: 1, unavailable: 2, total: 3 });

    // The same request with a JSON content type and no body (what curl -H does).
    const typed = await fetch(`${base}/api/public/backfill-media`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signedHeaders() },
    });
    assert.equal(typed.status, 200);
    assert.deepEqual(calls, ['backfill:3:20', 'backfill:7:100']);
  });
});

// --- C1/C13: the ways a signature is wrong ----------------------------------

test('firma de otro cuerpo → 401', async () => {
  await withServer(async ({ base, calls }) => {
    const headers = signedHeaders({ body: { action: 'logout' } });
    for (const [method, path] of [
      ['GET', '/api/public/chats'],
      ['POST', '/api/public/backfill-media'],
    ]) {
      const r = await fetch(`${base}${path}`, { method, headers });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.deepEqual(await r.json(), { error: 'Invalid signature' });
    }
    assert.deepEqual(calls, []);
  });
});

test('cuerpo firmado distinto del recibido → 401; el mismo cuerpo → 200 (la puerta lee req.body)', async () => {
  await withServer(async ({ base }) => {
    const signedFor = { days: 1 };
    const mismatched = await fetch(`${base}/api/public/backfill-media`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signedHeaders({ body: signedFor }) },
      body: JSON.stringify({ days: 2 }),
    });
    assert.equal(mismatched.status, 401);
    const same = await fetch(`${base}/api/public/backfill-media`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signedHeaders({ body: signedFor }) },
      body: JSON.stringify(signedFor),
    });
    assert.equal(same.status, 200);
  });
});

test('timestamp fuera de la ventana de 5 minutos (con margen de reloj) → 401, también con la firma correcta para ese instante', async () => {
  await withServer(async ({ base, calls }) => {
    for (const ts of [nowSeconds() - 330, nowSeconds() + 330]) {
      const r = await fetch(`${base}/api/public/chats`, { headers: signedHeaders({ ts }) });
      assert.equal(r.status, 401, `ts=${ts}`);
      assert.deepEqual(await r.json(), { error: 'Request timestamp too old or too far in future' });
    }
    // Inside the window it passes.
    const ok = await fetch(`${base}/api/public/chats`, {
      headers: signedHeaders({ ts: nowSeconds() - 290 }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, []);
  });
});

test('timestamp no numérico → 401 aunque la firma sea correcta para esa cadena (no se salta la ventana)', async () => {
  await withServer(async ({ base, calls }) => {
    for (const ts of ['abc', '', 'NaN', 'Infinity']) {
      const headers = {
        'x-connector-timestamp': ts,
        'x-connector-signature': generateHMACSignature({}, ts as unknown as number, SECRET),
      };
      const r = await fetch(`${base}/api/public/chats`, { headers });
      assert.equal(r.status, 401, `ts=${JSON.stringify(ts)}`);
    }
    assert.deepEqual(calls, []);
  });
});

test('firma con otra clave (también la de ejemplo del repositorio) → 401', async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(`${base}/api/public/chats`, {
      headers: signedHeaders({ secret: 'dev-secret-change-in-production' }),
    });
    assert.equal(r.status, 401);
  });
});

// --- C12 (F3-4): the rejection log -------------------------------------------

test('cada rechazo se registra con método, ruta, IP y motivo — sin cabeceras, cuerpo, firma ni el chatId', async () => {
  const lines: string[] = [];
  let clock = 1_000_000;
  await withServer(
    async ({ base }) => {
      const bad = signedHeaders({ secret: 'wrong' });
      const r = await fetch(`${base}/api/public/history/${encodeURIComponent(JID)}?limit=3`, {
        method: 'GET',
        headers: { ...bad, 'x-probe': 'header-value-that-must-not-leak' },
      });
      assert.equal(r.status, 401);
      assert.equal(lines.length, 1);
      const [line] = lines;
      assert.match(line, /GET/);
      assert.match(line, /\/api\/public\/history/);
      assert.match(line, /ip=(::ffff:)?127\.0\.0\.1/);
      assert.match(line, /reason=invalid_signature/);
      assert.doesNotMatch(line, new RegExp(bad['x-connector-signature'].slice(10, 30)));
      assert.doesNotMatch(line, /header-value-that-must-not-leak/);
      assert.doesNotMatch(line, /34600111222/);
      assert.doesNotMatch(line, /limit=3/);
    },
    { log: l => lines.push(l), now: () => clock }
  );

  // body of a rejected POST never reaches the log either
  lines.length = 0;
  await withServer(
    async ({ base }) => {
      await fetch(`${base}/api/public/backfill-media`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secretPayload: 'body-value-that-must-not-leak' }),
      });
      assert.equal(lines.length, 1);
      assert.match(lines[0], /POST/);
      assert.match(lines[0], /reason=missing_headers/);
      assert.doesNotMatch(lines[0], /body-value-that-must-not-leak/);
    },
    { log: l => lines.push(l), now: () => clock }
  );
});

test('una línea cada 10 s por motivo: el mismo motivo se calla, otro motivo no, y la siguiente cuenta lo callado', async () => {
  const lines: string[] = [];
  let clock = 5_000_000;
  await withServer(
    async ({ base }) => {
      const hit = (headers: Record<string, string> = {}) =>
        fetch(`${base}/api/public/chats`, { headers });

      await hit(); // missing_headers → logged
      await hit(); // same reason, same instant → silent
      clock += 9_999;
      await hit(); // still inside 10 s → silent
      assert.equal(lines.length, 1);

      await hit(signedHeaders({ secret: 'wrong' })); // another reason → logged on its own clock
      assert.equal(lines.length, 2);
      assert.match(lines[1], /reason=invalid_signature/);

      clock += 1; // 10 s since the first missing_headers
      await hit();
      assert.equal(lines.length, 3);
      assert.match(lines[2], /reason=missing_headers/);
      assert.match(lines[2], /suppressed=2/);

      await hit(signedHeaders({ ts: nowSeconds() - 600 })); // third reason
      assert.equal(lines.length, 4);
      assert.match(lines[3], /reason=stale_timestamp/);
    },
    { log: l => lines.push(l), now: () => clock }
  );
});

test('una petición válida no deja rastro en el registro de rechazos', async () => {
  const lines: string[] = [];
  await withServer(
    async ({ base }) => {
      assert.equal((await fetch(`${base}/api/public/chats`, { headers: signedHeaders() })).status, 200);
      assert.deepEqual(lines, []);
    },
    { log: l => lines.push(l) }
  );
});
