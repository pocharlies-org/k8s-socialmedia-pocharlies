import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { connectorFixture, TEST_CONNECTOR_SECRET as SECRET, TEST_GROUP_ID as CHAT } from '../test-harness';

/**
 * The three moderation routes of INFRA-746 (bot Sauvage verificacion):
 *   POST /chats/:id/ban            (http.telegram-connector.chats-ban.v1)
 *   POST /chats/:id/unban          (http.telegram-connector.chats-unban.v1)
 *   POST /chats/:id/invite-export  (http.telegram-connector.chats-invite-export.v1)
 *
 * Varas: validation answers 400 BEFORE the sending gate's 403 (an invalid
 * body is invalid with the door open or closed); 403 disabled_sending with
 * EMERGENCY_DISABLE_SENDING=true without touching Telegram (the pattern of
 * sending-gate.test.ts); and the happy path goes through the REAL wrapper with
 * a fake mtcute client (the pattern of controller.test.ts), which pins the
 * quirks measured in the PoC: banChatMember/unbanChatMember take an OBJECT
 * {chatId, participantId} (positional args fail with "Invalid marked peer id:
 * undefined"), and messages.exportChatInvite takes the REAL tl peer object
 * from resolvePeer.
 */

const USER = '5551234567';

class FakeMtcute {
  readonly calls: Array<[string, unknown]> = [];
  resolvePeerResult: { _: string; [k: string]: unknown } = {
    _: 'inputPeerChannel',
    channelId: 3365295248,
    accessHash: 1,
  };
  exportInviteResult: { _: string; link?: string; baseUrl?: string } = {
    _: 'chatInviteExported',
    link: 'https://t.me/+AbCdEf',
  };

  async banChatMember(params: unknown): Promise<null> {
    this.calls.push(['banChatMember', params]);
    return null;
  }
  async unbanChatMember(params: unknown): Promise<void> {
    this.calls.push(['unbanChatMember', params]);
  }
  async resolvePeer(peer: unknown): Promise<{ _: string; [k: string]: unknown }> {
    this.calls.push(['resolvePeer', peer]);
    return this.resolvePeerResult;
  }
  async call(request: unknown): Promise<{ _: string; link?: string; baseUrl?: string }> {
    this.calls.push(['call', request]);
    return this.exportInviteResult;
  }
}

const serveBase = connectorFixture(SECRET, afterEach);
const serve = (fake: FakeMtcute = new FakeMtcute()) => serveBase(fake);

afterEach(async () => {
  delete process.env.ENABLE_SENDING;
  delete process.env.EMERGENCY_DISABLE_SENDING;
});

async function call(base: string, path: string, body?: unknown) {
  const ts = Math.floor(Date.now() / 1000);
  const signedBody = body ?? {};
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-connector-timestamp': String(ts),
      'x-connector-signature': generateHMACSignature(signedBody, ts, SECRET),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test('validacion 400 ANTES del gate: cuerpo invalido con la puerta cerrada sigue siendo 400', async () => {
  const fake = new FakeMtcute();
  const base = await serve(fake);
  process.env.EMERGENCY_DISABLE_SENDING = 'true';
  for (const path of [`/api/v1/chats/${CHAT}/ban`, `/api/v1/chats/${CHAT}/unban`]) {
    for (const body of [
      {}, // userId ausente
      { userId: '' }, // vacio
      { userId: 'no-numerico' }, // no id
      { userId: '@usuario' }, // username: el bot solo usa ids numericos
      { userId: '1.5' }, // no entero
      { userId: '123456789012345678901234' }, // mas de 20 digitos
    ]) {
      const r = await call(base, path, body);
      assert.equal(r.status, 400, `${path} ${JSON.stringify(body)}`);
    }
  }
  for (const path of [
    '/api/v1/chats/no-es-un-id/ban',
    '/api/v1/chats/no-es-un-id/unban',
    '/api/v1/chats/no-es-un-id/invite-export',
  ]) {
    const r = await call(base, path, { userId: USER });
    assert.equal(r.status, 400, path);
  }
  assert.deepEqual(fake.calls, [], 'la validacion no toca Telegram');
});

test('EMERGENCY_DISABLE_SENDING=true con cuerpo valido → 403 disabled_sending sin tocar Telegram', async () => {
  const fake = new FakeMtcute();
  const base = await serve(fake);
  process.env.EMERGENCY_DISABLE_SENDING = 'true';
  const casos: Array<[string, unknown]> = [
    [`/api/v1/chats/${CHAT}/ban`, { userId: USER }],
    [`/api/v1/chats/${CHAT}/unban`, { userId: USER }],
    [`/api/v1/chats/${CHAT}/invite-export`, {}],
  ];
  for (const [path, body] of casos) {
    const r = await call(base, path, body);
    assert.equal(r.status, 403, path);
    assert.equal(r.body.failureClass, 'disabled_sending', path);
  }
  assert.deepEqual(fake.calls, []);
});

test('sin firma → 401 (auth heredada de router.use(authMiddleware))', async () => {
  const base = await serve();
  const res = await fetch(`${base}/api/v1/chats/${CHAT}/ban`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: USER }),
  });
  assert.equal(res.status, 401);
});

test('ban responde el contrato y llama a mtcute con OBJETO {chatId, participantId} (quirk 0.29.7)', async () => {
  const fake = new FakeMtcute();
  const base = await serve(fake);
  const r = await call(base, `/api/v1/chats/${CHAT}/ban`, { userId: USER });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { chatId: CHAT, userId: USER, banned: true });
  assert.deepEqual(fake.calls, [
    ['banChatMember', { chatId: Number(CHAT), participantId: Number(USER) }],
  ]);
});

test('unban responde el contrato y llama a mtcute con OBJETO (acepta userId numero en el cuerpo)', async () => {
  const fake = new FakeMtcute();
  const base = await serve(fake);
  const r = await call(base, `/api/v1/chats/${CHAT}/unban`, { userId: 987 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { chatId: CHAT, userId: '987', unbanned: true });
  assert.deepEqual(fake.calls, [['unbanChatMember', { chatId: Number(CHAT), participantId: 987 }]]);
});

test('invite-export resuelve el peer real y responde {chatId, link} con el objeto tl en la peticion', async () => {
  const fake = new FakeMtcute();
  const base = await serve(fake);
  const r = await call(base, `/api/v1/chats/${CHAT}/invite-export`, {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { chatId: CHAT, link: 'https://t.me/+AbCdEf' });
  assert.deepEqual(fake.calls, [
    ['resolvePeer', Number(CHAT)],
    [
      'call',
      {
        _: 'messages.exportChatInvite',
        peer: { _: 'inputPeerChannel', channelId: 3365295248, accessHash: 1 },
      },
    ],
  ]);
});

test('invite-export sobre un peer que no es canal → 500 (no se inventa un link)', async () => {
  const fake = new FakeMtcute();
  fake.resolvePeerResult = { _: 'inputPeerUser', userId: 1, accessHash: 1 };
  const base = await serve(fake);
  const r = await call(base, `/api/v1/chats/${CHAT}/invite-export`, {});
  assert.equal(r.status, 500);
  assert.match(String(r.body.error), /inputPeerUser/);
});

test('fallo de Telegram en el ban → 500 con el error (el bot lo registra y no reintenta a ciegas)', async () => {
  const fake = new FakeMtcute();
  fake.banChatMember = async () => {
    throw new Error('PEER_ID_INVALID');
  };
  const base = await serve(fake);
  const r = await call(base, `/api/v1/chats/${CHAT}/ban`, { userId: USER });
  assert.equal(r.status, 500);
  assert.match(String(r.body.error), /PEER_ID_INVALID/);
});
