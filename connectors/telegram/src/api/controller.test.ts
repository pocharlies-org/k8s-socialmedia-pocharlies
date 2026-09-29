import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { createRouter } from './controller';
import { TelegramClientWrapper, TelegramMessageEdit } from '../telegram-client';
import type { EditableMessage } from '../message-edit';

/**
 * POST /api/v1/messages/edit of the house Telegram connector, end to end
 * through the real TelegramClientWrapper with a fake mtcute client behind it
 * (the wrapper is what dedupes our edit against Telegram's echo).
 */

const SECRET = 'test-connector-secret';
const CHAT = -1001234567890;

function rpc(code: number, text: string): Error {
  return Object.assign(new Error(`${code}: ${text}`), { code, text });
}

function stored(overrides: Partial<EditableMessage> = {}): EditableMessage {
  return {
    id: 42,
    chat: { id: CHAT },
    isOutgoing: true,
    isService: false,
    text: 'texto viejo',
    media: null,
    editDate: null,
    ...overrides,
  };
}

class FakeMtcute {
  message: EditableMessage | null = stored();
  editError: Error | null = null;
  edits: Array<{ chatId: unknown; message: number; text: string }> = [];
  sends = 0;
  editHandlers: Array<(m: EditableMessage) => unknown> = [];
  onEditMessage = { add: (fn: (m: EditableMessage) => unknown) => this.editHandlers.push(fn) };

  async getMessages() {
    return [this.message];
  }

  async editMessage(params: { chatId: unknown; message: number; text: string }) {
    this.edits.push(params);
    if (this.editError) throw this.editError;
    const edited = stored({
      ...this.message,
      text: params.text,
      editDate: new Date('2026-09-29T10:00:00Z'),
    });
    // mtcute dispatches our own edit back (updates.disableNoDispatch): the echo.
    for (const fn of this.editHandlers) await fn(edited);
    return edited;
  }

  async sendText() {
    this.sends += 1;
    return { id: 1 };
  }
}

function wrapperWith(fake: FakeMtcute, connected = true): TelegramClientWrapper {
  const wrapper = new TelegramClientWrapper({ apiId: 1, apiHash: 'x', sessionString: 's' });
  const internals = wrapper as unknown as { client: unknown; connected: boolean };
  internals.client = fake;
  internals.connected = connected;
  // The inbound-edit handler connect() registers, without connecting.
  fake.onEditMessage.add(async m => {
    const edit = (wrapper as unknown as { inboundEdit(m: unknown): unknown }).inboundEdit(m);
    if (edit) wrapper.emit('messageEdited', edit);
  });
  return wrapper;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  delete process.env.ENABLE_SENDING;
  delete process.env.EMERGENCY_DISABLE_SENDING;
});

async function serve(fake = new FakeMtcute(), options: { connected?: boolean } = {}) {
  const wrapper = wrapperWith(fake, options.connected ?? true);
  const published: TelegramMessageEdit[] = [];
  const inbound: TelegramMessageEdit[] = [];
  wrapper.on('messageEdited', (e: TelegramMessageEdit) => inbound.push(e));
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createRouter(wrapper, SECRET, {
      publishMessageEdited: edit => {
        published.push(edit);
        return true;
      },
    })
  );
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  open.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  return { base, fake, published, inbound };
}

function signed(body: unknown): RequestInit {
  const ts = Math.floor(Date.now() / 1000);
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-connector-timestamp': String(ts),
      'x-connector-signature': generateHMACSignature(body, ts, SECRET),
    },
    body: JSON.stringify(body),
  };
}

async function post(base: string, body: unknown) {
  const res = await fetch(`${base}/messages/edit`, signed(body));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const EDIT = { chatId: String(CHAT), messageId: 42, content: 'texto nuevo', actor: 'dani' };

test('edita, publica una sola vez (con actor) y responde el contrato', async () => {
  const { base, fake, published, inbound } = await serve();
  const r = await post(base, EDIT);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    edited: true,
    messageId: 42,
    chatId: String(CHAT),
    editedAt: '2026-09-29T10:00:00.000Z',
    unchanged: false,
    published: true,
  });
  assert.deepEqual(fake.edits, [{ chatId: CHAT, message: 42, text: 'texto nuevo' }]);
  assert.deepEqual(published, [
    {
      conversationId: String(CHAT),
      telegramMessageId: '42',
      content: 'texto nuevo',
      editedAt: new Date('2026-09-29T10:00:00Z'),
      isOutbound: true,
      source: 'connector',
      actor: 'dani',
    },
  ]);
  assert.deepEqual(inbound, [], "Telegram's echo of our own edit is not published again");
  assert.equal(fake.sends, 0, '/messages/edit is not swallowed by POST /messages/:chatId');
});

test('texto sin cambios / MESSAGE_NOT_MODIFIED → 200 idempotente, nada que registrar', async () => {
  const { base, fake, published } = await serve();
  const same = await post(base, { ...EDIT, content: 'texto viejo' });
  assert.equal(same.status, 200);
  assert.equal(same.body.unchanged, true);
  assert.equal(same.body.published, false);
  assert.equal(fake.edits.length, 0);

  fake.editError = rpc(400, 'MESSAGE_NOT_MODIFIED');
  const notModified = await post(base, EDIT);
  assert.equal(notModified.status, 200);
  assert.equal(notModified.body.unchanged, true);
  assert.deepEqual(published, []);
});

test('puerta de envío → 403 disabled_sending sin tocar Telegram', async () => {
  const { base, fake } = await serve();
  process.env.ENABLE_SENDING = 'false';
  let r = await post(base, EDIT);
  assert.equal(r.status, 403);
  assert.equal(r.body.failureClass, 'disabled_sending');
  delete process.env.ENABLE_SENDING;
  process.env.EMERGENCY_DISABLE_SENDING = 'true';
  r = await post(base, EDIT);
  assert.equal(r.status, 403);
  assert.equal(r.body.failureClass, 'disabled_sending');
  assert.equal(fake.edits.length, 0);
});

test('cuerpo inválido → 400 invalid_request; sin firma → 401', async () => {
  const { base, fake } = await serve();
  for (const body of [
    { messageId: 42, content: 'x' },
    { chatId: String(CHAT), content: 'x' },
    { chatId: String(CHAT), messageId: 'tg_1_42', content: 'x' },
    { chatId: String(CHAT), messageId: -3, content: 'x' },
    { chatId: String(CHAT), messageId: 42, content: '   ' },
    { chatId: 'tg_-1001', messageId: 42, content: 'x' },
    { chatId: '../../x', messageId: 42, content: 'x' },
  ]) {
    const r = await post(base, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.failureClass, 'invalid_request');
  }
  const unsigned = await fetch(`${base}/messages/edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(EDIT),
  });
  assert.equal(unsigned.status, 401);
  assert.equal(fake.edits.length, 0);
});

test('desconectado → 503 disconnected', async () => {
  const { base } = await serve(new FakeMtcute(), { connected: false });
  const r = await post(base, EDIT);
  assert.equal(r.status, 503);
  assert.equal(r.body.failureClass, 'disconnected');
});

test('mensaje desconocido → 404; ajeno → 422 not_own_message; plazo vencido → 422 rejected_by_telegram', async () => {
  const fake = new FakeMtcute();
  const { base, published } = await serve(fake);
  fake.message = null;
  let r = await post(base, EDIT);
  assert.equal(r.status, 404);
  assert.equal(r.body.failureClass, 'message_unavailable');

  fake.message = stored({ isOutgoing: false });
  r = await post(base, EDIT);
  assert.equal(r.status, 422);
  assert.equal(r.body.failureClass, 'not_own_message');

  fake.message = stored();
  fake.editError = rpc(400, 'MESSAGE_AUTHOR_REQUIRED');
  r = await post(base, EDIT);
  assert.equal(r.status, 422);
  assert.deepEqual(
    { failureClass: r.body.failureClass, code: r.body.code },
    { failureClass: 'not_own_message', code: 'MESSAGE_AUTHOR_REQUIRED' }
  );

  fake.editError = rpc(400, 'MESSAGE_EDIT_TIME_EXPIRED');
  r = await post(base, EDIT);
  assert.equal(r.status, 422);
  assert.deepEqual(
    { failureClass: r.body.failureClass, code: r.body.code },
    { failureClass: 'rejected_by_telegram', code: 'MESSAGE_EDIT_TIME_EXPIRED' }
  );
  assert.deepEqual(published, [], 'nothing is recorded for a refused edit');
});

test('una edición fallida no silencia la misma edición hecha luego desde el móvil', async () => {
  const fake = new FakeMtcute();
  const { base, inbound } = await serve(fake);
  fake.editError = rpc(400, 'MESSAGE_EDIT_TIME_EXPIRED');
  assert.equal((await post(base, EDIT)).status, 422);
  for (const fn of fake.editHandlers) {
    await fn(stored({ text: 'texto nuevo', editDate: new Date('2026-09-29T12:00:00Z') }));
  }
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].source, 'telegram');
  assert.equal(inbound[0].content, 'texto nuevo');
});
