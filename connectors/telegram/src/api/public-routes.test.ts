/**
 * SKIRM-111 (C1): /api/public/* of the Telegram connector sits behind the connector HMAC.
 *
 * Requests are signed with generateHMACSignature from @mcp-socialmedia/shared, the
 * signer mcp-server's providerGet uses, over `{}` for the GETs (express.json leaves
 * req.body = {} on a request with no body) and over the JSON body for the send. The
 * app is the composition main.ts builds: express.json, then the router at /api/public.
 * The same literal vectors are asserted by telegram-sync's Python signer
 * (connectors/telegram-sync/tests/test_connector_signing.py).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { createPublicRouter } from './public-routes';

const SECRET = 'test-connector-secret';
const CHAT = '-1001234567890';
const PLACEHOLDER = 'dev-secret-change-in-production';

const nowSeconds = () => Math.floor(Date.now() / 1000);

function signed(opts: { body?: unknown; secret?: string; ts?: number } = {}) {
  const ts = opts.ts ?? nowSeconds();
  return {
    'x-connector-timestamp': String(ts),
    'x-connector-signature': generateHMACSignature(opts.body ?? {}, ts, opts.secret ?? SECRET),
  };
}

const json = { 'content-type': 'application/json' };
const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  delete process.env.ENABLE_SENDING;
});

async function serve(options: { log?: (line: string) => void; now?: () => number } = {}) {
  const calls: string[] = [];
  const client = {
    isClientConnected: () => true,
    getDialogs: async () => {
      calls.push('dialogs');
      return [{ id: '1', name: 'A', type: 'private', unreadCount: 0 }];
    },
    getMessages: async (chatId: string, limit: number) => {
      calls.push(`messages:${chatId}:${limit}`);
      return [{ telegramMessageId: 1 }];
    },
    sendMessage: async (chatId: string, text: string, topicId?: number) => {
      calls.push(`send:${chatId}:${text}:${topicId}`);
      return '7';
    },
  };
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/public', createPublicRouter(client as never, SECRET, options));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  open.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/api/public/dialogs'],
  ['GET', `/api/public/messages/${CHAT}?limit=5`],
  ['POST', `/api/public/send/${CHAT}`, { text: 'hola' }],
];

function request(base: string, [method, path, body]: [string, string, unknown?], headers = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : json), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('sin firma → 401 en las tres rutas y no llega a Telegram; ni el cuerpo vacío de un envío llega a "Missing text"', async () => {
  const { base, calls } = await serve();
  for (const route of [...ROUTES, ['POST', `/api/public/send/0`] as [string, string]]) {
    const r = await request(base, route);
    assert.equal(r.status, 401, `${route[0]} ${route[1]}`);
    assert.deepEqual(await r.json(), { error: 'Missing authentication headers' });
  }
  assert.equal((await fetch(`${base}/api/public/nope`)).status, 401);
  assert.deepEqual(calls, []);
});

test('firmadas como providerGet ("{}") las lecturas dan 200; el límite viaja en la query sin firmarse', async () => {
  const { base, calls } = await serve();
  const dialogs = await request(base, ROUTES[0], signed());
  assert.equal(dialogs.status, 200);
  assert.deepEqual(await dialogs.json(), {
    dialogs: [{ id: '1', name: 'A', type: 'private', unreadCount: 0 }],
  });
  const withLimit = await request(base, ROUTES[1], signed());
  assert.equal(withLimit.status, 200);
  assert.deepEqual(await withLimit.json(), { messages: [{ telegramMessageId: 1 }] });
  await request(base, ['GET', `/api/public/messages/${CHAT}`], signed());
  assert.deepEqual(calls, ['dialogs', `messages:${CHAT}:5`, `messages:${CHAT}:50`]);
});

test('POST /send/:chatId firmado sobre su cuerpo → 200 y llega tal cual; con topicId también', async () => {
  const { base, calls } = await serve();
  const plain = { text: 'hola ñandú ☃' };
  assert.equal((await request(base, ROUTES[2], signed({ body: plain }))).status, 401);
  const send = (body: object) =>
    request(base, ['POST', `/api/public/send/${CHAT}`, body], signed({ body }));
  const ok = await send(plain);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { success: true });
  assert.equal((await send({ text: 'en el hilo', topicId: 9 })).status, 200);
  assert.equal((await send({ text: '' })).status, 400); // firmado y válido para la puerta: lo rechaza el handler
  assert.equal((await send({ text: 'x', topicId: -1 })).status, 400);
  assert.deepEqual(calls, [`send:${CHAT}:hola ñandú ☃:undefined`, `send:${CHAT}:en el hilo:9`]);
});

test('firma de otro cuerpo, de otra clave (también el placeholder) o con la ventana vencida → 401', async () => {
  const { base, calls } = await serve();
  const bodySigned = { text: 'hola' };
  const wrongs: Array<[string, Record<string, string>]> = [
    ['otro cuerpo', signed({ body: { text: 'otro' } })],
    ['otra clave', signed({ body: bodySigned, secret: 'otra-clave' })],
    ['placeholder', signed({ body: bodySigned, secret: PLACEHOLDER })],
    ['futuro', signed({ body: bodySigned, ts: nowSeconds() + 330 })],
    ['pasado', signed({ body: bodySigned, ts: nowSeconds() - 330 })],
    ['timestamp NaN', { ...signed({ body: bodySigned }), 'x-connector-timestamp': 'abc' }],
  ];
  for (const [what, headers] of wrongs) {
    const r = await request(base, ROUTES[2], headers);
    assert.equal(r.status, 401, what);
  }
  assert.equal((await request(base, ROUTES[0], signed({ body: { a: 1 } }))).status, 401);
  assert.equal(
    (await request(base, ROUTES[2], signed({ body: bodySigned, ts: nowSeconds() - 290 }))).status,
    200
  );
  assert.deepEqual(calls, [`send:${CHAT}:hola:undefined`]);
});

test('con el envío cerrado, quien no firma sigue viendo 401 (no se entera del interruptor) y quien firma 403', async () => {
  const { base, calls } = await serve();
  process.env.ENABLE_SENDING = 'false';
  assert.equal((await request(base, ROUTES[2])).status, 401);
  const r = await request(base, ROUTES[2], signed({ body: { text: 'hola' } }));
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { failureClass: string }).failureClass, 'disabled_sending');
  assert.deepEqual(calls, []);
});

test('cada rechazo deja una línea con método, ruta, IP y motivo: sin cabeceras, cuerpo, firma, chatId ni query; una por motivo cada 10 s', async () => {
  const lines: string[] = [];
  let clock = 5_000_000;
  const { base } = await serve({ log: l => lines.push(l), now: () => clock });
  const bad = signed({ secret: 'wrong' });
  await request(base, ['GET', `/api/public/messages/${CHAT}?limit=3`], {
    ...bad,
    'x-probe': 'header-value-that-must-not-leak',
  });
  await request(base, [
    'POST',
    `/api/public/send/${CHAT}`,
    { text: 'body-value-that-must-not-leak' },
  ]);
  assert.equal(lines.length, 2);
  assert.match(
    lines[0],
    /\[public-api\] rejected GET \/api\/public\/messages ip=(::ffff:)?127\.0\.0\.1 reason=invalid_signature/
  );
  assert.match(lines[1], /rejected POST \/api\/public\/send .*reason=missing_headers/);
  for (const leak of [
    bad['x-connector-signature'].slice(10, 30),
    'must-not-leak',
    CHAT,
    'limit=3',
  ]) {
    assert.ok(
      lines.every(l => !l.includes(leak)),
      leak
    );
  }

  await request(base, ROUTES[2]); // same reason, same instant: quiet
  clock += 9_999;
  await request(base, ROUTES[2]); // still inside 10 s
  assert.equal(lines.length, 2);
  clock += 1;
  await request(base, ROUTES[2]);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /reason=missing_headers suppressed=2/);

  await request(base, ROUTES[0], signed()); // a valid call leaves no trace
  assert.equal(lines.length, 3);
});

test('vectores fijos: el firmador del conector da las firmas que telegram-sync (Python) debe dar', () => {
  const secret = 'vector-secret-not-a-real-key';
  const vectors: Array<[unknown, string]> = [
    [{}, 'sha256=9c13b5d911180ca8afe1a2f4e6d7da93068aca9168ddb0d0e66781915f2a76af'],
    [{ text: 'hola' }, 'sha256=afcb691954c420b230066c0959302dd152b62921ec75013c6811b19b6f7f6ddc'],
    [
      { text: 'ñandú ☃ "q" \\ \n\t línea', topicId: 42 },
      'sha256=c92ca6dc3907aaa9cd70640b6a66253bde649d6476b9deadcb017a628e0fc44d',
    ],
    [
      { text: 'hola 👍🏽' },
      'sha256=267114fcccf55614d21e00f4b3b58281f134a9310c6179435a700740a03d56d6',
    ],
  ];
  for (const [body, expected] of vectors) {
    assert.equal(generateHMACSignature(body, 1760000000, secret), expected, JSON.stringify(body));
  }
});
