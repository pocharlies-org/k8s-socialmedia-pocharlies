import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { createRouter } from './api/controller';
import { TelegramClientWrapper } from './telegram-client';
import { RESTRICTIONS } from './moderation';

/**
 * INFRA-218 / INFRA-344: the Telegram moderation routes, end to end through the
 * real TelegramClientWrapper with a fake mtcute client behind it.
 */

const SECRET = 'test-connector-secret';
const CHAT = -1001234567890;
const USER = 777000123;

function rpc(code: number, text: string): Error {
  return Object.assign(new Error(`${code}: ${text}`), { code, text });
}

class FakeMtcute {
  peerKind = 'inputPeerChannel';
  calls: Array<{ method: string; params: any }> = [];
  failWith: Error | null = null;
  failOn: string | null = null; // only this method fails (default: all)
  member: any = { status: 'admin', permissions: { banUsers: true, deleteMessages: true } };

  private record(method: string, params: any) {
    this.calls.push({ method, params });
    if (this.failWith && (!this.failOn || this.failOn === method)) throw this.failWith;
  }

  async resolvePeer() {
    return { _: this.peerKind };
  }
  async banChatMember(p: any) {
    this.record('banChatMember', p);
    return null;
  }
  async unbanChatMember(p: any) {
    this.record('unbanChatMember', p);
  }
  async kickChatMember(p: any) {
    this.record('kickChatMember', p);
    return null;
  }
  async restrictChatMember(p: any) {
    this.record('restrictChatMember', p);
  }
  async unrestrictChatMember(p: any) {
    this.record('unrestrictChatMember', p);
  }
  async getChatMember(p: any) {
    this.record('getChatMember', p);
    return this.member;
  }
  get methods() {
    return this.calls.map(c => c.method);
  }
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function serve(fake = new FakeMtcute()) {
  const wrapper = new TelegramClientWrapper({ apiId: 1, apiHash: 'x', sessionString: 's' });
  const internals = wrapper as unknown as { client: unknown; connected: boolean };
  internals.client = fake;
  internals.connected = true;
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(wrapper, SECRET));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  open.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  return { base, fake };
}

function headers(body: unknown) {
  const ts = Math.floor(Date.now() / 1000);
  return {
    'content-type': 'application/json',
    'x-connector-timestamp': String(ts),
    'x-connector-signature': generateHMACSignature(body, ts, SECRET),
  };
}

async function act(base: string, action: string, body: Record<string, unknown>, chat = CHAT) {
  const res = await fetch(`${base}/chats/${chat}/moderation/${action}`, {
    method: 'POST',
    headers: headers(body),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function rights(base: string, chat: string | number = CHAT) {
  const res = await fetch(`${base}/chats/${chat}/moderation/admin-rights`, {
    headers: headers({}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const TARGET = { chatId: CHAT, participantId: USER };

test('ban / unban / unrestrict llaman al método mtcute con sus argumentos', async () => {
  const { base, fake } = await serve();
  assert.equal((await act(base, 'ban', { user_id: String(USER) })).status, 200);
  assert.deepEqual(fake.calls.pop(), { method: 'banChatMember', params: TARGET });

  const until = '2026-12-01T10:00:00Z';
  assert.equal((await act(base, 'ban', { user_id: String(USER), until })).status, 200);
  assert.deepEqual(fake.calls.pop(), {
    method: 'banChatMember',
    params: { ...TARGET, untilDate: new Date(until) },
  });

  assert.equal((await act(base, 'unban', { user_id: String(USER) })).status, 200);
  assert.deepEqual(fake.calls.pop(), { method: 'unbanChatMember', params: TARGET });

  assert.equal((await act(base, 'unrestrict', { user_id: String(USER) })).status, 200);
  assert.deepEqual(fake.calls.pop(), { method: 'unrestrictChatMember', params: TARGET });
});

test('restrict: los cuatro valores mapean a los derechos exactos; un quinto → 400', async () => {
  const MUTE = {
    sendMessages: true,
    sendMedia: true,
    sendStickers: true,
    sendGifs: true,
    sendGames: true,
    sendInline: true,
    sendPolls: true,
    embedLinks: true,
  };
  const { sendMessages: _drop, ...NO_MEDIA } = MUTE;
  const expected = {
    mute: MUTE,
    no_media: NO_MEDIA,
    no_invite: { inviteUsers: true },
    read_only: { ...MUTE, inviteUsers: true, pinMessages: true, changeInfo: true },
  };
  assert.deepEqual(RESTRICTIONS, expected);

  const { base, fake } = await serve();
  for (const [restriction, restrictions] of Object.entries(expected)) {
    const r = await act(base, 'restrict', { user_id: String(USER), restriction });
    assert.equal(r.status, 200, restriction);
    assert.deepEqual(fake.calls.pop(), {
      method: 'restrictChatMember',
      params: { chatId: CHAT, userId: USER, restrictions },
    });
  }

  const until = '2026-12-01T10:00:00Z';
  await act(base, 'restrict', { user_id: String(USER), restriction: 'mute', until });
  assert.deepEqual(fake.calls.pop()?.params.until, new Date(until));

  const bad = await act(base, 'restrict', { user_id: String(USER), restriction: 'shadowban' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.failureClass, 'invalid_request');
  assert.deepEqual(fake.calls, [], 'a fifth value never reaches Telegram');
});

test('kick en supergrupo = ban y luego unban (en ese orden); en grupo básico, kickChatMember', async () => {
  const { base, fake } = await serve();
  assert.equal((await act(base, 'kick', { user_id: String(USER) })).status, 200);
  assert.deepEqual(fake.methods, ['banChatMember', 'unbanChatMember']);
  assert.deepEqual(fake.calls[0].params, TARGET);
  assert.deepEqual(fake.calls[1].params, TARGET);

  const basic = new FakeMtcute();
  basic.peerKind = 'inputPeerChat';
  const s2 = await serve(basic);
  assert.equal((await act(s2.base, 'kick', { user_id: String(USER) }, -12345)).status, 200);
  assert.deepEqual(basic.methods, ['kickChatMember']);
  assert.deepEqual(basic.calls[0].params, { chatId: -12345, userId: USER });
});

test('kick: si el unban posterior falla, lo dice (sigue baneado) y no finge éxito', async () => {
  const fake = new FakeMtcute();
  fake.failWith = rpc(420, 'FLOOD_WAIT_9');
  fake.failOn = 'unbanChatMember';
  const { base } = await serve(fake);
  const r = await act(base, 'kick', { user_id: String(USER) });
  assert.equal(r.status, 429);
  assert.equal(r.body.failureClass, 'rate_limited');
  assert.match(r.body.error, /sigue baneado/);
  assert.equal(r.body.retry_after_s, 9);
});

test('grupo básico + ban / unban / restrict / unrestrict → unsupported_chat_type sin tocar Telegram', async () => {
  const fake = new FakeMtcute();
  fake.peerKind = 'inputPeerChat';
  const { base } = await serve(fake);
  for (const action of ['ban', 'unban', 'restrict', 'unrestrict']) {
    const r = await act(base, action, { user_id: String(USER), restriction: 'mute' }, -12345);
    assert.equal(r.status, 422, action);
    assert.equal(r.body.failureClass, 'unsupported_chat_type', action);
  }
  assert.deepEqual(fake.calls, []);
});

test('user_id / chat_id no numérico (@nombre) → invalid_target sin llamar a Telegram', async () => {
  const { base, fake } = await serve();
  for (const body of [{ user_id: '@dani' }, {}, { user_id: '12x' }, { user_id: 5.5 }]) {
    const r = await act(base, 'ban', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.failureClass, 'invalid_target');
    assert.match(r.body.error, /id numérico/);
  }
  const chat = await act(base, 'ban', { user_id: String(USER) }, '@grupo' as unknown as number);
  assert.equal(chat.body.failureClass, 'invalid_target');
  assert.equal((await rights(base, '@grupo')).body.failureClass, 'invalid_target');
  assert.deepEqual(fake.calls, []);
});

// fixture moderation-errors: TL code → canonical answer
const moderationErrors: Array<{
  error: Error;
  status: number;
  failureClass: string;
  code: string;
  retry_after_s?: number;
}> = [
  {
    error: rpc(400, 'CHAT_ADMIN_REQUIRED'),
    status: 403,
    failureClass: 'not_admin',
    code: 'CHAT_ADMIN_REQUIRED',
  },
  {
    error: rpc(403, 'RIGHT_FORBIDDEN'),
    status: 403,
    failureClass: 'not_admin',
    code: 'RIGHT_FORBIDDEN',
  },
  {
    error: rpc(400, 'USER_ADMIN_INVALID'),
    status: 403,
    failureClass: 'not_admin',
    code: 'USER_ADMIN_INVALID',
  },
  {
    error: rpc(420, 'FLOOD_WAIT_30'),
    status: 429,
    failureClass: 'rate_limited',
    code: 'FLOOD_WAIT_30',
    retry_after_s: 30,
  },
  {
    error: rpc(400, 'USER_NOT_PARTICIPANT'),
    status: 404,
    failureClass: 'user_not_participant',
    code: 'USER_NOT_PARTICIPANT',
  },
  {
    error: rpc(400, 'PEER_ID_INVALID'),
    status: 400,
    failureClass: 'invalid_target',
    code: 'PEER_ID_INVALID',
  },
  { error: rpc(400, 'FOO_BAR'), status: 502, failureClass: 'telegram_error', code: 'FOO_BAR' },
];

test('tabla moderation-errors: cada código TL → su error canónico, nunca 500 ni outcome_unknown', async () => {
  for (const action of ['ban', 'unban', 'kick', 'restrict', 'unrestrict']) {
    for (const row of moderationErrors) {
      const fake = new FakeMtcute();
      fake.failWith = row.error;
      const { base } = await serve(fake);
      const r = await act(base, action, { user_id: String(USER), restriction: 'mute' });
      const label = `${action} ${row.code}`;
      assert.equal(r.status, row.status, label);
      assert.notEqual(r.status, 500, label);
      assert.equal(r.body.failureClass, row.failureClass, label);
      assert.equal(r.body.code, row.code, label);
      assert.notEqual(r.body.failureClass, 'outcome_unknown', label);
      assert.equal(r.body.retry_after_s, row.retry_after_s, label);
      if (row.failureClass === 'not_admin') assert.equal(r.body.missing_right, 'banUsers', label);
    }
  }
  // the same table on the read route
  const fake = new FakeMtcute();
  fake.failWith = rpc(400, 'CHAT_ADMIN_REQUIRED');
  const { base } = await serve(fake);
  assert.equal((await rights(base)).body.failureClass, 'not_admin');
});

test('un error que no es RPC tampoco es un 500 opaco', async () => {
  const fake = new FakeMtcute();
  fake.failWith = new Error('socket hang up');
  const { base } = await serve(fake);
  const r = await act(base, 'ban', { user_id: String(USER) });
  assert.equal(r.status, 502);
  assert.equal(r.body.failureClass, 'telegram_error');
});

test('get_admin_rights: admin → derechos del participante real', async () => {
  const fake = new FakeMtcute();
  fake.member = { status: 'creator', permissions: { banUsers: true, inviteUsers: true } };
  const { base } = await serve(fake);
  const r = await rights(base);
  assert.equal(r.status, 200);
  assert.deepEqual(fake.calls[0], {
    method: 'getChatMember',
    params: { chatId: CHAT, userId: 'me' },
  });
  assert.equal(r.body.is_admin, true);
  assert.equal(r.body.is_creator, true);
  assert.equal(r.body.rights.banUsers, true);
  assert.equal(r.body.rights.inviteUsers, true);
  assert.equal(r.body.rights.deleteMessages, false);
});

test('get_admin_rights: no admin → is_admin false con todos los derechos reales en false', async () => {
  const fake = new FakeMtcute();
  fake.member = { status: 'member', permissions: null };
  const { base } = await serve(fake);
  const r = await rights(base);
  assert.equal(r.status, 200);
  assert.equal(r.body.is_admin, false);
  assert.equal(r.body.is_creator, false);
  assert.equal(r.body.status, 'member');
  assert.equal(r.body.rights.banUsers, false);
  assert.ok(Object.values(r.body.rights).every(v => v === false));
});

test('get_admin_rights: la cuenta no está en el chat → user_not_participant', async () => {
  const fake = new FakeMtcute();
  fake.member = null;
  const { base } = await serve(fake);
  const r = await rights(base);
  assert.equal(r.status, 404);
  assert.equal(r.body.failureClass, 'user_not_participant');
});
