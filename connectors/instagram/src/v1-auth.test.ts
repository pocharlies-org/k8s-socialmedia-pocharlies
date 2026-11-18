/**
 * SKIRM-112 — /api/v1 of the Instagram connector answers only to a caller that
 * signs with the connector key: HMAC-SHA256 of "<ts>:<JSON body>", the scheme the
 * WhatsApp connector enforces and mcp-server signs. A GET has no body, so it
 * signs "{}". /health, /webhook and /oauth/instagram/callback stay outside.
 *
 * The app is the real createInstagramApp; requests go through fetch. The sweep
 * walks the route table, so a route mounted later without the gate fails here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { CONNECTOR_SECRET_PLACEHOLDER, generateHMACSignature } from '@mcp-socialmedia/shared';
import { AccountEntry, createInstagramApp } from './main';
import type { InstagramAPI } from './instagram-api';
import type { WebhookLog } from './webhook';

const SECRET = 'connector-key-under-test';
const VERIFY_TOKEN = 'verify-token-under-test';

/** Reachable without the connector signature on purpose; the webhook is a router, not listed here. */
const OPEN = new Set(['GET /health', 'GET /oauth/instagram/callback']);

interface Booted {
  base: string;
  /** Methods of the Instagram client that a request reached. */
  reached: string[];
  logs: string[];
  app: Awaited<ReturnType<typeof createInstagramApp>>;
  close(): Promise<void>;
}

async function boot(env: Record<string, string>): Promise<Booted> {
  const reached: string[] = [];
  const logs: string[] = [];
  const api = new Proxy(
    {},
    {
      get: (_target, name) => async () => {
        reached.push(String(name));
        return { ok: true };
      },
    }
  ) as unknown as InstagramAPI;
  const accounts = new Map<string, AccountEntry>([
    ['acct', { name: 'acct', api, config: { accessToken: 'tok', businessAccountId: 'biz' } }],
  ]);
  const log: WebhookLog = { warn: (_obj, msg) => logs.push(msg) };

  // registerInstagramIds asks graph.instagram.com once per account at boot; a 500 keeps the env id.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
  let app: Booted['app'];
  try {
    app = await createInstagramApp({
      env: { WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN, ...env } as NodeJS.ProcessEnv,
      accounts,
      credentialStore: null,
      publisher: { publish: () => {} },
      log,
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    reached,
    logs,
    app,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** The signer mcp-server uses; a request with no body signs `{}` (express.json leaves req.body = {}). */
const signed = (body: unknown = {}, { ts = Math.floor(Date.now() / 1000), key = SECRET } = {}) => ({
  'x-connector-timestamp': String(ts),
  'x-connector-signature': generateHMACSignature(body, ts, key),
});

const SEND = { recipient_id: 'user-1', message: 'hola' };
const send = (base: string, headers: Record<string, string>, body: unknown = SEND) =>
  fetch(`${base}/api/v1/acct/messages/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('C1/C2: GET /api/v1/accounts — sin firma, otra clave, otro cuerpo o fuera de ventana → 401; firmada → 200', async t => {
  const app = await boot({ CONNECTOR_SHARED_SECRET: SECRET });
  t.after(() => app.close());
  const url = `${app.base}/api/v1/accounts`;
  const now = Math.floor(Date.now() / 1000);

  assert.equal((await fetch(url)).status, 401, 'sin firma');
  assert.equal((await fetch(url, { headers: signed({}, { key: 'otra-clave' }) })).status, 401);
  assert.equal((await fetch(url, { headers: signed({ otro: 'cuerpo' }) })).status, 401);
  assert.equal((await fetch(url, { headers: signed({}, { ts: now - 400 }) })).status, 401);
  assert.equal((await fetch(url, { headers: signed({}, { ts: now + 400 }) })).status, 401);
  const nonNumeric = { ...signed(), 'x-connector-timestamp': 'abc' };
  assert.equal((await fetch(url, { headers: nonNumeric })).status, 401, 'timestamp no numérico');

  const ok = await fetch(url, { headers: signed() });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { accounts: [{ name: 'acct', businessAccountId: 'biz' }] });
});

test('C1: ruta de escritura — sin firma 401 y no llega al cliente de Instagram; firmada pasa; otro cuerpo 401', async t => {
  const app = await boot({ CONNECTOR_SHARED_SECRET: SECRET });
  t.after(() => app.close());

  assert.equal((await send(app.base, {})).status, 401);
  assert.equal((await send(app.base, signed(SEND, { key: 'otra-clave' }))).status, 401);
  // Firmado para un mensaje y enviado otro: la firma cubre el cuerpo.
  assert.equal((await send(app.base, signed(SEND), { ...SEND, message: 'otro' })).status, 401);
  assert.deepEqual(app.reached, []);

  const ok = await send(app.base, signed(SEND));
  assert.equal(ok.status, 200);
  assert.deepEqual(app.reached, ['sendMessage']);
});

test('C1: /health, GET /webhook y /oauth/instagram/callback siguen sin la puerta', async t => {
  const app = await boot({ CONNECTOR_SHARED_SECRET: SECRET });
  t.after(() => app.close());

  assert.equal((await fetch(`${app.base}/health`)).status, 200);

  const verify = await fetch(
    `${app.base}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=abc123`
  );
  assert.equal(verify.status, 200);
  assert.equal(await verify.text(), 'abc123');

  // Sin code ni state el callback responde él mismo (400), no la puerta (401).
  assert.equal((await fetch(`${app.base}/oauth/instagram/callback`)).status, 400);
});

test('barrido: toda ruta de /api/v1 pide firma y ninguna ruta nueva fuera de /api/v1 queda sin clasificar', async t => {
  const app = await boot({ CONNECTOR_SHARED_SECRET: SECRET });
  t.after(() => app.close());

  const layers = (
    app.app as unknown as {
      _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
    }
  )._router.stack;
  const routes = layers.map(layer => layer.route).filter(route => !!route) as Array<{
    path: string;
    methods: Record<string, boolean>;
  }>;
  const gated = routes.filter(route => route.path.startsWith('/api/v1'));
  assert.ok(gated.length > 20, `expected the whole route table, got ${gated.length}`);

  const open: string[] = [];
  const unclassified: string[] = [];
  for (const route of routes) {
    for (const method of Object.keys(route.methods).map(m => m.toUpperCase())) {
      const key = `${method} ${route.path}`;
      if (!route.path.startsWith('/api/v1')) {
        if (!OPEN.has(key)) unclassified.push(key);
        continue;
      }
      const res = await fetch(`${app.base}${route.path.replace(/:[A-Za-z]+/g, 'x')}`, { method });
      if (res.status !== 401) open.push(`${key} → ${res.status}`);
    }
  }
  assert.deepEqual(open, []);
  assert.deepEqual(unclassified, []);
  // A path no route serves is refused by the gate, not leaked as a 404.
  assert.equal((await fetch(`${app.base}/api/v1/acct/nope`)).status, 401);
  assert.deepEqual(app.reached, []);
});

test('C4: sin clave, con la clave vacía o con el valor del repositorio bajo el interruptor estricto → 503 y aviso; el resto sigue', async t => {
  const cases: Array<[string, Record<string, string>]> = [
    ['ausente', {}],
    ['vacía', { CONNECTOR_SHARED_SECRET: '   ' }],
    [
      'valor del repositorio + CONNECTOR_SECRET_STRICT=true',
      { CONNECTOR_SHARED_SECRET: CONNECTOR_SECRET_PLACEHOLDER, CONNECTOR_SECRET_STRICT: 'true' },
    ],
  ];
  for (const [label, env] of cases) {
    const app = await boot(env);
    t.after(() => app.close());
    const url = `${app.base}/api/v1/accounts`;
    // Neither an unsigned request nor one signed with the repository value gets in.
    assert.equal((await fetch(url)).status, 503, label);
    const headers = signed({}, { key: CONNECTOR_SECRET_PLACEHOLDER });
    assert.equal((await fetch(url, { headers })).status, 503, label);
    assert.equal((await send(app.base, headers)).status, 503, label);
    assert.deepEqual(app.reached, [], label);
    assert.ok(
      app.logs.some(line => line.includes('CONNECTOR_SHARED_SECRET')),
      `aviso al arrancar (${label}): ${JSON.stringify(app.logs)}`
    );
    assert.equal((await fetch(`${app.base}/health`)).status, 200, `${label}: /health`);
  }
});

test('C4: con una clave propia funciona; el valor del repositorio sin el interruptor avisa y arranca', async t => {
  const own = await boot({ CONNECTOR_SHARED_SECRET: SECRET });
  t.after(() => own.close());
  assert.equal((await fetch(`${own.base}/api/v1/accounts`, { headers: signed() })).status, 200);
  assert.ok(!own.logs.some(line => line.includes('CONNECTOR_SHARED_SECRET')), 'una clave propia no avisa');

  const placeholder = await boot({ CONNECTOR_SHARED_SECRET: CONNECTOR_SECRET_PLACEHOLDER });
  t.after(() => placeholder.close());
  const key = CONNECTOR_SECRET_PLACEHOLDER;
  assert.equal(
    (await fetch(`${placeholder.base}/api/v1/accounts`, { headers: signed({}, { key }) })).status,
    200
  );
  assert.ok(placeholder.logs.some(line => line.includes('placeholder')), JSON.stringify(placeholder.logs));
});

test('registro de rechazos: una línea por motivo, con método, ruta y motivo, sin firma, cuerpo ni query', async t => {
  const app = await boot({ CONNECTOR_SHARED_SECRET: SECRET });
  t.after(() => app.close());

  for (let i = 0; i < 3; i++) await fetch(`${app.base}/api/v1/accounts?token=query-secret`);
  const forged = { 'x-connector-timestamp': String(Math.floor(Date.now() / 1000)) };
  await fetch(`${app.base}/api/v1/acct/messages/send`, {
    method: 'POST',
    headers: { ...forged, 'x-connector-signature': 'sha256=' + 'ab'.repeat(32), 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'body-secret' }),
  });

  const rejected = app.logs.filter(line => line.includes('rejected'));
  assert.equal(rejected.length, 2, JSON.stringify(rejected));
  assert.match(rejected[0], /GET \/api\/v1\/accounts .*reason=missing_headers/);
  assert.match(rejected[1], /POST \/api\/v1\/acct .*reason=invalid_signature/);
  for (const line of app.logs) {
    for (const leak of ['query-secret', 'body-secret', 'abababab', SECRET]) {
      assert.ok(!line.includes(leak), `${leak} en el registro: ${line}`);
    }
  }
});
