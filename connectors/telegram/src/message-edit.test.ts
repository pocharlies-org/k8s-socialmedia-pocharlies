import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EditDeduper,
  EditableMessage,
  MessageMutationError,
  TelegramEditApi,
  classifyEditError,
  editOwnTextMessage,
  inboundTextEdit,
  sendingDisabledReason,
} from './message-edit';

/** An RPC error as mtcute throws it (tl.RpcError: numeric code + text). */
function rpc(code: number, text: string, seconds?: number): Error {
  return Object.assign(new Error(`${code}: ${text}`), { code, text, seconds });
}

const CHAT = -1001234567890;

function message(overrides: Partial<EditableMessage> = {}): EditableMessage {
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

class FakeApi implements TelegramEditApi {
  edits: Array<{ chatId: string | number; message: number; text: string }> = [];
  stored: EditableMessage | null = message();
  getError: Error | null = null;
  editError: Error | null = null;
  editDate = new Date('2026-09-29T10:00:00Z');

  async getMessages(): Promise<(EditableMessage | null)[]> {
    if (this.getError) throw this.getError;
    return [this.stored];
  }

  async editMessage(params: { chatId: string | number; message: number; text: string }) {
    this.edits.push(params);
    if (this.editError) throw this.editError;
    return message({ ...this.stored, text: params.text, editDate: this.editDate });
  }
}

async function rejects(p: Promise<unknown>, status: number, failureClass: string, code?: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof MessageMutationError, `MessageMutationError, got ${String(e)}`);
    assert.equal(e.status, status);
    assert.equal(e.failureClass, failureClass);
    if (code) assert.equal(e.code, code);
    return true;
  });
}

test('puerta de envío: sin ENABLE_SENDING = activo; "false" o EMERGENCY_DISABLE_SENDING=true → desactivado', () => {
  assert.equal(sendingDisabledReason({}), null);
  assert.equal(sendingDisabledReason({ ENABLE_SENDING: 'true' }), null);
  assert.equal(sendingDisabledReason({ ENABLE_SENDING: '' }), null);
  assert.match(String(sendingDisabledReason({ ENABLE_SENDING: 'false' })), /disabled/);
  assert.match(
    String(sendingDisabledReason({ ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' })),
    /emergency/
  );
});

test('edición propia: edita, devuelve editDate de Telegram y el chat marcado', async () => {
  const api = new FakeApi();
  const seen: EditableMessage[] = [];
  const result = await editOwnTextMessage(api, CHAT, 42, 'texto nuevo', {
    beforeEdit: m => seen.push(m),
  });
  assert.deepEqual(api.edits, [{ chatId: CHAT, message: 42, text: 'texto nuevo' }]);
  assert.equal(seen.length, 1, 'beforeEdit runs right before the edit');
  assert.deepEqual(result, {
    messageId: 42,
    conversationId: String(CHAT),
    editedAt: api.editDate,
    unchanged: false,
  });
});

test('mensaje desconocido → 404 message_unavailable (también chat inaccesible)', async () => {
  const api = new FakeApi();
  api.stored = null;
  await rejects(editOwnTextMessage(api, CHAT, 42, 'x'), 404, 'message_unavailable');
  class MtPeerNotFoundError extends Error {}
  api.getError = new MtPeerNotFoundError('Peer @nadie is not found');
  await rejects(editOwnTextMessage(api, '@nadie', 42, 'x'), 404, 'message_unavailable');
  api.getError = rpc(400, 'CHANNEL_INVALID');
  await rejects(
    editOwnTextMessage(api, CHAT, 42, 'x'),
    404,
    'message_unavailable',
    'CHANNEL_INVALID'
  );
  assert.equal(api.edits.length, 0);
});

test('mensaje ajeno → 422 not_own_message sin llamar a Telegram', async () => {
  const api = new FakeApi();
  api.stored = message({ isOutgoing: false });
  await rejects(editOwnTextMessage(api, CHAT, 42, 'x'), 422, 'not_own_message');
  assert.equal(api.edits.length, 0);
});

test('solo texto: media → 422 not_editable; texto con vista previa (webpage) sí se edita', async () => {
  const api = new FakeApi();
  api.stored = message({ media: { type: 'photo' } });
  await rejects(editOwnTextMessage(api, CHAT, 42, 'x'), 422, 'not_editable');
  api.stored = message({ isService: true });
  await rejects(editOwnTextMessage(api, CHAT, 42, 'x'), 422, 'not_editable');
  assert.equal(api.edits.length, 0);
  api.stored = message({ media: { type: 'webpage' } });
  assert.equal((await editOwnTextMessage(api, CHAT, 42, 'x')).unchanged, false);
});

test('texto idéntico → éxito idempotente (unchanged), por pre-chequeo o por MESSAGE_NOT_MODIFIED', async () => {
  const api = new FakeApi();
  const same = await editOwnTextMessage(api, CHAT, 42, 'texto viejo');
  assert.equal(same.unchanged, true);
  assert.equal(api.edits.length, 0, 'no RPC for a text that is already there');

  api.editError = rpc(400, 'MESSAGE_NOT_MODIFIED');
  const notModified = await editOwnTextMessage(api, CHAT, 42, 'otro');
  assert.equal(notModified.unchanged, true);
  assert.equal(api.edits.length, 1);
});

test('errores de Telegram → failureClass', async () => {
  const api = new FakeApi();
  for (const [error, status, failureClass, code] of [
    [rpc(400, 'MESSAGE_ID_INVALID'), 422, 'not_own_message', 'MESSAGE_ID_INVALID'],
    [rpc(403, 'MESSAGE_AUTHOR_REQUIRED'), 422, 'not_own_message', 'MESSAGE_AUTHOR_REQUIRED'],
    [
      rpc(400, 'MESSAGE_EDIT_TIME_EXPIRED'),
      422,
      'rejected_by_telegram',
      'MESSAGE_EDIT_TIME_EXPIRED',
    ],
    [rpc(400, 'MESSAGE_TOO_LONG'), 422, 'rejected_by_telegram', 'MESSAGE_TOO_LONG'],
    [rpc(403, 'CHAT_WRITE_FORBIDDEN'), 422, 'rejected_by_telegram', 'CHAT_WRITE_FORBIDDEN'],
    [rpc(400, 'MESSAGE_EMPTY'), 400, 'invalid_request', 'MESSAGE_EMPTY'],
    [rpc(401, 'AUTH_KEY_UNREGISTERED'), 401, 'auth', 'AUTH_KEY_UNREGISTERED'],
    [rpc(500, 'INTERNAL'), 502, 'unknown', 'INTERNAL'],
  ] as const) {
    api.editError = error;
    await rejects(editOwnTextMessage(api, CHAT, 42, 'nuevo'), status, failureClass, code);
  }
  const flood = classifyEditError(rpc(420, 'FLOOD_WAIT_%d', 30));
  assert.equal(flood.status, 429);
  assert.equal(flood.failureClass, 'rate_limited');
  assert.equal(flood.retryAfterSeconds, 30);
  assert.equal(classifyEditError(new Error('request timed out')).failureClass, 'timeout');
  assert.equal(classifyEditError(new Error('socket hang up')).failureClass, 'unknown');
});

test('texto vacío → 400 invalid_request antes de mirar el mensaje', async () => {
  const api = new FakeApi();
  api.getError = new Error('must not be called');
  await rejects(editOwnTextMessage(api, CHAT, 42, '   '), 400, 'invalid_request');
});

test('ediciones entrantes: solo texto editado y nuevo; eco propio y reacciones no se publican', () => {
  const dedupe = new EditDeduper();
  const editDate = new Date('2026-09-29T11:00:00Z');

  // Never edited (a reaction on an unedited message) → nothing.
  assert.equal(inboundTextEdit(message({ isOutgoing: false }), dedupe), null);
  // Media caption edits are not recorded.
  assert.equal(inboundTextEdit(message({ media: { type: 'voice' }, editDate }), dedupe), null);

  const edit = inboundTextEdit(message({ isOutgoing: false, text: 'corregido', editDate }), dedupe);
  assert.deepEqual(edit, {
    conversationId: String(CHAT),
    telegramMessageId: '42',
    content: 'corregido',
    editedAt: editDate,
    isOutbound: false,
  });
  // The same text again (a reaction on the edited message) → skipped.
  assert.equal(inboundTextEdit(message({ text: 'corregido', editDate }), dedupe), null);

  // Our own edit: remembered before the RPC, its echo is skipped…
  const key = EditDeduper.key(String(CHAT), 43);
  const previous = dedupe.remember(key, 'desde el conector');
  assert.equal(
    inboundTextEdit(message({ id: 43, text: 'desde el conector', editDate }), dedupe),
    null
  );
  // …and a failed edit restores what was known before it.
  dedupe.restore(key, 'desde el conector', previous);
  assert.notEqual(
    inboundTextEdit(message({ id: 43, text: 'desde el conector', editDate }), dedupe),
    null
  );
});

test('EditDeduper acotado: se olvidan las claves más antiguas', () => {
  const dedupe = new EditDeduper(2);
  dedupe.remember('a', '1');
  dedupe.remember('b', '2');
  dedupe.remember('c', '3');
  assert.equal(dedupe.isKnown('a', '1'), false);
  assert.equal(dedupe.isKnown('b', '2'), true);
  assert.equal(dedupe.isKnown('c', '3'), true);
});
