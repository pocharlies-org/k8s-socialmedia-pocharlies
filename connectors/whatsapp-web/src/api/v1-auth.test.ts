/**
 * SKIRM-120: every /api/v1 route answers to the connector HMAC gate except the
 * few that are unsigned on purpose. History sync and chat history are checked
 * one by one (401 without a signature, 200 with the signer mcp-server uses, and
 * the client is never reached without it); the sweep walks the router's route
 * table so a future route cannot be mounted without `auth` unnoticed.
 */
import '../test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { BaileysClient } from '../baileys-client';
import { createRouter } from './controller';
import { generateHMACSignature } from './auth';

const SECRET = 'test-connector-secret';
const JID = '34600111222@s.whatsapp.net';

/** Unsigned on purpose: liveness, the static manual-open page and the frozen v1 QR. */
const UNSIGNED = new Set(['GET /health', 'GET /manual-open/page', 'GET /auth/qr']);

async function withRouter(
  run: (ctx: {
    base: string;
    router: express.Router;
    calls: string[];
    signed: (ts?: number, secret?: string) => Record<string, string>;
  }) => Promise<void>
): Promise<void> {
  const calls: string[] = [];
  const client = {
    isConnected: () => true,
    fetchChatHistory: async (chatId: string, limit: number) => {
      calls.push(`history:${chatId}:${limit}`);
      return [{ id: 'm1' }];
    },
    getAllChatsWithHistory: async (limit: number) => {
      calls.push(`sync:${limit}`);
      return [];
    },
  };
  const router = createRouter(
    client as unknown as BaileysClient,
    { getCurrentQR: () => null } as never,
    SECRET
  );
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/v1', router);
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  // A request with no body leaves req.body = {} (express.json), so the signature covers `{}`.
  const signed = (ts = Math.floor(Date.now() / 1000), secret = SECRET) => ({
    'x-connector-timestamp': String(ts),
    'x-connector-signature': generateHMACSignature({}, ts, secret),
  });
  try {
    await run({ base, router, calls, signed });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('GET /history/:chatId: sin firma 401, firma de otra clave 401, firmada 200', async () => {
  await withRouter(async ({ base, calls, signed }) => {
    const url = `${base}/history/${encodeURIComponent(JID)}?limit=7`;

    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: signed(undefined, 'otra-clave') })).status, 401);
    assert.deepEqual(calls, []);

    const ok = await fetch(url, { headers: signed() });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { chatId: JID, count: 1, messages: [{ id: 'm1' }] });
    assert.deepEqual(calls, [`history:${JID}:7`]);
  });
});

test('POST /history/sync: sin firma 401 y no lanza la descarga, firmada 200', async () => {
  await withRouter(async ({ base, calls, signed }) => {
    const url = `${base}/history/sync?limit=3`;

    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal(
      (await fetch(url, { method: 'POST', headers: signed(undefined, 'otra-clave') })).status,
      401
    );
    assert.deepEqual(calls, []);

    const ok = await fetch(url, { method: 'POST', headers: signed() });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { status: string }).status, 'started');
    for (let i = 0; i < 5 && calls.length === 0; i++) await new Promise(r => setImmediate(r));
    assert.deepEqual(calls, ['sync:3']);
  });
});

test('todas las rutas de /api/v1 piden firma salvo las sin firma a propósito', async () => {
  await withRouter(async ({ base, router }) => {
    const routes = (router.stack as unknown as Array<{ route?: { path: string; methods: object } }>)
      .map(layer => layer.route)
      .filter((route): route is { path: string; methods: object } => !!route);
    assert.ok(routes.length > 50, `expected the whole route table, got ${routes.length}`);

    const open: string[] = [];
    for (const route of routes) {
      for (const method of Object.keys(route.methods).map(m => m.toUpperCase())) {
        if (UNSIGNED.has(`${method} ${route.path}`)) continue;
        const path = route.path.replace(/:[A-Za-z]+/g, 'x');
        const res = await fetch(`${base}${path}`, { method });
        if (res.status !== 401) open.push(`${method} ${route.path} → ${res.status}`);
      }
    }
    assert.deepEqual(open, []);
  });
});
