/**
 * Chat lifecycle (INFRA-278): POST /chats/:id/delete and POST /chats/:id/leave
 * on the real TelegramClientWrapper over a fake mtcute client (the pattern of
 * moderation-routes.test.ts). C3's counterpart on the internal plane: the two
 * routes exist, take numeric ids only (@nombre → 400 invalid_target, never a
 * 500), carry the sending gate, and answer the moderation failureClass table.
 * C5: the e2e chain createGroup → addMembers → participants → kick → deleteChat
 * asserts at every step that the call reaches mtcute with numeric ids and that
 * deleteChat invokes channels.deleteChannel with the marked id.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import {
  connectorFixture,
  TEST_CONNECTOR_SECRET as SECRET,
  TEST_GROUP_ID as CHAT,
} from '../test-harness';

const USER = '777000123';
const CHAT_NUM = Number(CHAT);

class FakeMtcute {
  calls: Array<{ method: string; params: unknown }> = [];
  failWith: Error | null = null;
  failOn: string | null = null;

  private record(method: string, params: unknown): void {
    this.calls.push({ method, params });
    if (this.failWith && (!this.failOn || this.failOn === method)) throw this.failWith;
  }
  private rpc(code: number, text: string): Error {
    return Object.assign(new Error(`${code}: ${text}`), { code, text });
  }
  failRpc(code: number, text: string, on?: string): void {
    this.failWith = this.rpc(code, text);
    this.failOn = on ?? null;
  }

  async resolvePeer(): Promise<{ _: string }> {
    return { _: 'inputPeerChannel' };
  }
  async createSupergroup(p: {
    title: string;
  }): Promise<{ id: bigint; title: string; chatType: string }> {
    this.record('createSupergroup', p);
    return { id: BigInt(CHAT_NUM), title: p.title, chatType: 'supergroup' };
  }
  async addChatMembers(chatId: unknown, users: unknown): Promise<unknown[]> {
    this.record('addChatMembers', { chatId, users });
    return [];
  }
  async getChatMembers(chatId: unknown): Promise<unknown[]> {
    this.record('getChatMembers', { chatId });
    const members = [{ user: { id: BigInt(USER), firstName: 'Ana', isBot: false } }];
    return Object.assign(members, { total: 1 });
  }
  async banChatMember(p: unknown): Promise<void> {
    this.record('banChatMember', p);
  }
  async unbanChatMember(p: unknown): Promise<void> {
    this.record('unbanChatMember', p);
  }
  async deleteChannel(chatId: unknown): Promise<void> {
    this.record('deleteChannel', chatId);
  }
  async leaveChat(chatId: unknown): Promise<void> {
    this.record('leaveChat', chatId);
  }
}

const serveBase = connectorFixture(SECRET, afterEach);
const serve = (fake: FakeMtcute = new FakeMtcute()) => serveBase(fake);

afterEach(() => {
  delete process.env.EMERGENCY_DISABLE_SENDING;
});

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
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test('deleteChat: 200 y channels.deleteChannel con el id numérico marcado', async () => {
  const fake = new FakeMtcute();
  const base = await serve(fake);
  const r = await call(base, 'POST', `/api/v1/chats/${CHAT}/delete`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { chatId: CHAT, action: 'deleteChat' });
  const del = fake.calls.find(c => c.method === 'deleteChannel');
  assert.ok(del, 'deleteChannel invoked');
  assert.equal(del.params, CHAT_NUM, 'the marked id reaches mtcute as a number');
});

test('leaveChat: 200 y leaveChat con el id numérico marcado', async () => {
  const fake = new FakeMtcute();
  const base = await serve(fake);
  const r = await call(base, 'POST', `/api/v1/chats/${CHAT}/leave`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { chatId: CHAT, action: 'leaveChat' });
  const leave = fake.calls.find(c => c.method === 'leaveChat');
  assert.equal(leave!.params, CHAT_NUM);
});

test('ids no numéricos → 400 invalid_target antes de tocar Telegram', async () => {
  const fake = new FakeMtcute();
  const base = await serve(fake);
  for (const path of [
    '/api/v1/chats/@grupo/delete',
    '/api/v1/chats/no-es-un-id/leave',
    '/api/v1/chats/1.5/delete',
  ]) {
    const r = await call(base, 'POST', path);
    assert.equal(r.status, 400, path);
    assert.equal(r.body.failureClass, 'invalid_target', path);
  }
  assert.deepEqual(
    fake.calls.filter(c => c.method === 'deleteChannel' || c.method === 'leaveChat'),
    []
  );
});

test('EMERGENCY_DISABLE_SENDING=true → 403 disabled_sending sin tocar Telegram', async () => {
  const fake = new FakeMtcute();
  const base = await serve(fake);
  process.env.EMERGENCY_DISABLE_SENDING = 'true';
  for (const path of [`/api/v1/chats/${CHAT}/delete`, `/api/v1/chats/${CHAT}/leave`]) {
    const r = await call(base, 'POST', path);
    assert.equal(r.status, 403, path);
    assert.equal(r.body.failureClass, 'disabled_sending', path);
  }
  assert.deepEqual(fake.calls, []);
});

test('fallos de Telegram → la tabla canónica de moderation, nunca 500', async () => {
  const casos: Array<[number, string, number, string]> = [
    [403, 'CHAT_ADMIN_REQUIRED', 403, 'not_admin'],
    [400, 'CHANNEL_INVALID', 400, 'invalid_target'],
    [420, 'FLOOD_WAIT_5', 429, 'rate_limited'],
  ];
  for (const [rpcCode, rpcText, status, failureClass] of casos) {
    const fake = new FakeMtcute();
    fake.failRpc(rpcCode, rpcText, 'deleteChannel');
    const base = await serve(fake);
    const r = await call(base, 'POST', `/api/v1/chats/${CHAT}/delete`);
    assert.equal(r.status, status, `${rpcText} → ${status}`);
    assert.equal(r.body.failureClass, failureClass, rpcText);
  }
});

test('deleteChat en un grupo básico → 422 unsupported_chat_type (deleteChannel es de supergrupos)', async () => {
  const fake = new FakeMtcute();
  (fake as { resolvePeer(): Promise<unknown> }).resolvePeer = async () => ({
    _: 'inputPeerChat',
  });
  const base = await serve(fake);
  const r = await call(base, 'POST', `/api/v1/chats/${CHAT}/delete`);
  assert.equal(r.status, 422);
  assert.equal(r.body.failureClass, 'unsupported_chat_type');
});

test('C5 e2e: createGroup → addMembers → participants → kick → deleteChat, ids numéricos en cada paso', async () => {
  const fake = new FakeMtcute();
  const base = await serve(fake);

  const created = await call(base, 'POST', '/api/v1/groups', {
    title: 'INFRA-278 e2e',
    type: 'supergroup',
  });
  assert.equal(created.status, 200);
  assert.equal((created.body as { chat: { id: string } }).chat.id, String(CHAT_NUM));
  assert.equal(typeof (fake.calls[0].params as { title: string }).title, 'string');

  const added = await call(base, 'POST', `/api/v1/chats/${CHAT}/members`, {
    members: [USER],
  });
  assert.equal(added.status, 200);
  const add = fake.calls.find(c => c.method === 'addChatMembers');
  assert.equal((add!.params as { chatId: unknown }).chatId, CHAT_NUM);

  const participants = await call(base, 'GET', `/api/v1/chats/${CHAT}/participants`);
  assert.equal(participants.status, 200);
  const listed = (participants.body as { participants: Array<{ id: string }> }).participants;
  assert.deepEqual(
    listed.map(p => p.id),
    [USER]
  );

  const kicked = await call(base, 'POST', `/api/v1/chats/${CHAT}/moderation/kick`, {
    user_id: USER,
  });
  assert.equal(kicked.status, 200);
  const ban = fake.calls.find(c => c.method === 'banChatMember');
  assert.equal((ban!.params as { chatId: unknown }).chatId, CHAT_NUM);
  assert.equal((ban!.params as { participantId: unknown }).participantId, Number(USER));

  const deleted = await call(base, 'POST', `/api/v1/chats/${CHAT}/delete`);
  assert.equal(deleted.status, 200);
  const del = fake.calls.find(c => c.method === 'deleteChannel');
  assert.ok(del, 'channels.deleteChannel invoked');
  assert.equal(del.params, CHAT_NUM, 'the marked id reaches deleteChannel');
});
