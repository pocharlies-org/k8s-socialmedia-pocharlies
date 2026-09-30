import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { createRouter, requireSending } from './controller';
import type { TelegramClientWrapper } from '../telegram-client';

/**
 * The sending gate of the house Telegram connector: every outward route
 * answers 403 disabled_sending (without touching Telegram) when
 * ENABLE_SENDING is set to anything but "true" or EMERGENCY_DISABLE_SENDING
 * is "true"; reads and mark-as-read stay open; unset ENABLE_SENDING = on.
 */

const SECRET = 'test-connector-secret';
const CHAT = '-1001234567890';

/** Fake wrapper: any method is an async call recorded by name. */
function fakeClient(): { client: TelegramClientWrapper; calls: string[] } {
  const calls: string[] = [];
  const results: Record<string, unknown> = {
    isClientConnected: true,
    sendImageGroup: [1, 2],
    getMessages: [],
    searchMessages: [],
    reactToMessage: true,
    sendMessage: 7,
  };
  const client = new Proxy(
    {},
    {
      get: (_t, name: string) => {
        if (name === 'isClientConnected') return () => true;
        return async () => {
          calls.push(name);
          return name in results ? results[name] : {};
        };
      },
    }
  ) as unknown as TelegramClientWrapper;
  return { client, calls };
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  delete process.env.ENABLE_SENDING;
  delete process.env.EMERGENCY_DISABLE_SENDING;
});

async function serve() {
  const { client, calls } = fakeClient();
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(client, SECRET));
  app.post('/api/public/send/:chatId', requireSending, (_req, res) => {
    calls.push('publicSend');
    res.json({ success: true });
  });
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  open.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, calls };
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const ts = Math.floor(Date.now() / 1000);
  const signedBody = body ?? {};
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-connector-timestamp': String(ts),
      'x-connector-signature': generateHMACSignature(signedBody, ts, SECRET),
    },
    ...(method === 'GET' || body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const OUTWARD: Array<[string, string, unknown?]> = [
  ['POST', `/api/v1/messages/${CHAT}`, { text: 'hola' }],
  ['POST', '/api/v1/messages/media/send', { chatId: CHAT, filePath: '/tmp/a.jpg' }],
  [
    'POST',
    '/api/v1/messages/media/group',
    { chatId: CHAT, attachments: [{ filePath: '/tmp/a.jpg' }, { filePath: '/tmp/b.jpg' }] },
  ],
  ['POST', '/api/v1/messages/voice', { chatId: CHAT, audioBase64: 'AAAA' }],
  ['POST', '/api/v1/messages/react', { chatId: CHAT, messageId: 42, emoji: '👍' }],
  ['POST', '/api/v1/messages/edit', { chatId: CHAT, messageId: 42, content: 'x' }],
  ['POST', '/api/v1/messages/forward', { fromChatId: CHAT, messageId: 42, toChatId: '123' }],
  ['POST', '/api/v1/messages/callback', { chatId: CHAT, messageId: 42, data: 'ok' }],
  ['DELETE', `/api/v1/messages/${CHAT}/42`],
  ['POST', '/api/v1/groups', { title: 'g', type: 'group' }],
  ['POST', `/api/v1/chats/${CHAT}/members`, { members: ['123'] }],
  ['PUT', `/api/v1/chats/${CHAT}/admins/123`, { rights: { pinMessages: true } }],
  ['POST', `/api/v1/chats/${CHAT}/topics`, { title: 't' }],
  ['PATCH', `/api/v1/chats/${CHAT}/topics/5`, { title: 't2' }],
  ['POST', `/api/v1/chats/${CHAT}/topics/5/closed`, { closed: true }],
  ['POST', `/api/v1/chats/${CHAT}/topics/5/pinned`, { pinned: true }],
  ['DELETE', `/api/v1/chats/${CHAT}/topics/5`],
  ['POST', `/api/v1/chats/${CHAT}/forum-settings`, { isForum: true }],
  ['PATCH', `/api/v1/chats/${CHAT}/title`, { title: 't' }],
  ['PATCH', `/api/v1/chats/${CHAT}/description`, { description: 'd' }],
  ['PATCH', `/api/v1/chats/${CHAT}/photo`, { filePath: '/tmp/a.jpg' }],
  ['POST', `/api/public/send/${CHAT}`, { text: 'hola' }],
];

const READS: Array<[string, string, unknown?]> = [
  ['GET', `/api/v1/messages/${CHAT}`],
  ['POST', '/api/v1/messages/search', { query: 'x' }],
  ['POST', `/api/v1/messages/read/${CHAT}`, {}],
  ['GET', `/api/v1/chats/${CHAT}/topics`],
  ['GET', '/api/v1/dialogs'],
];

for (const [env, value] of [
  ['ENABLE_SENDING', 'false'],
  ['ENABLE_SENDING', '0'],
  ['EMERGENCY_DISABLE_SENDING', 'true'],
] as const) {
  test(`${env}=${value} → 403 disabled_sending en toda ruta saliente, sin tocar Telegram`, async () => {
    const { base, calls } = await serve();
    process.env[env] = value;
    for (const [method, path, body] of OUTWARD) {
      const r = await call(base, method, path, body);
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.body.failureClass, 'disabled_sending', `${method} ${path}`);
    }
    assert.deepEqual(calls, []);
  });
}

test('con la puerta cerrada las lecturas y el marcar leído siguen abiertos', async () => {
  const { base, calls } = await serve();
  process.env.ENABLE_SENDING = 'false';
  process.env.EMERGENCY_DISABLE_SENDING = 'true';
  for (const [method, path, body] of READS) {
    const r = await call(base, method, path, body);
    assert.equal(r.status, 200, `${method} ${path}`);
  }
  assert.deepEqual(calls, [
    'getMessages',
    'searchMessages',
    'markAsRead',
    'getForumTopics',
    'getDialogs',
  ]);
});

test('ENABLE_SENDING sin definir (o "true") → las rutas salientes pasan', async () => {
  const { base, calls } = await serve();
  for (const flag of [undefined, 'true']) {
    if (flag === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = flag;
    calls.length = 0;
    for (const [method, path, body] of OUTWARD.filter(([, p]) => !p.endsWith('/edit'))) {
      const r = await call(base, method, path, body);
      assert.equal(r.status, 200, `${method} ${path} ${JSON.stringify(r.body)}`);
    }
    assert.equal(calls.length, OUTWARD.length - 1);
  }
});
