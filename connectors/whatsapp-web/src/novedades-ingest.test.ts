import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import {
  ingestNovedadesMessage,
  ingestNovedadesUpdate,
  type NovedadesIngestStore,
} from './novedades-ingest';

function recorder() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const record =
    (op: string) =>
    async (...args: unknown[]) => {
      calls.push({ op, args });
    };
  const store: NovedadesIngestStore = {
    post: record('post'),
    status: record('status'),
    deletePost: record('deletePost'),
    deleteStatus: record('deleteStatus'),
  };
  return { store, calls };
}

test('ordinary hearts stay in chats; channels and statuses are intercepted', async () => {
  const { store, calls } = recorder();
  assert.equal(
    await ingestNovedadesMessage(
      { key: { remoteJid: '123@s.whatsapp.net', id: 'same' }, message: { conversation: '❤️' } },
      store
    ),
    false
  );
  for (const remoteJid of ['100@newsletter', '200@newsletter']) {
    assert.equal(
      await ingestNovedadesMessage(
        {
          key: { remoteJid, id: 'same', server_id: '4' },
          message: { conversation: 'post' },
          messageTimestamp: 1000,
        },
        store
      ),
      true
    );
  }
  assert.deepEqual(
    calls.map(call => (call.args[0] as { channelJid: string }).channelJid),
    ['100@newsletter', '200@newsletter']
  );
});

test('own statuses use a fallback author while retaining the exact provider key', async () => {
  const { store, calls } = recorder();
  const key = { remoteJid: 'status@broadcast', id: 'one', fromMe: true };
  await ingestNovedadesMessage(
    { key, message: { conversation: 'status' }, messageTimestamp: 1000 },
    store,
    { ownJid: '123@s.whatsapp.net', source: 'history' }
  );
  const input = calls[0].args[0] as { key: unknown; authorJid: string; messageTimestampMs: number };
  assert.strictEqual(input.key, key);
  assert.equal(input.authorJid, '123@s.whatsapp.net');
  assert.equal(input.messageTimestampMs, 1000000);
});

test('status without a timestamp is not revived as a fresh update', async () => {
  const { store, calls } = recorder();
  await assert.rejects(
    ingestNovedadesMessage(
      { key: { remoteJid: 'status@broadcast', id: 'one' }, message: { conversation: 'old' } },
      store
    ),
    /timestamp/
  );
  assert.equal(calls.length, 0);
});

test('channel revoke targets only its own channel and never the outer event ID', async () => {
  const { store, calls } = recorder();
  const message: WAMessage = {
    key: { remoteJid: '100@newsletter', id: 'event' },
    message: {
      protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'target' } },
    },
  };
  assert.equal(await ingestNovedadesMessage(message, store), true);
  assert.deepEqual(calls[0], { op: 'deletePost', args: ['100@newsletter', 'target'] });
  message.message!.protocolMessage!.key!.remoteJid = '200@newsletter';
  await ingestNovedadesMessage(message, store);
  assert.equal(calls.length, 1);
});

test('Novedades acknowledgement/deletion events do not update ordinary messages with the same ID', async () => {
  const { store, calls } = recorder();
  assert.equal(
    await ingestNovedadesUpdate(
      { remoteJid: '100@newsletter', id: 'client', server_id: '7', fromMe: true },
      { status: 2 },
      store
    ),
    true
  );
  const input = calls[0].args[0] as { message?: unknown; key: { server_id: string } };
  assert.equal(input.message, undefined);
  assert.equal(input.key.server_id, '7');
  assert.equal(
    await ingestNovedadesUpdate(
      { remoteJid: 'status@broadcast', id: 'client', participant: '123@s.whatsapp.net' },
      { message: null },
      store
    ),
    true
  );
  assert.equal(calls[1].op, 'deleteStatus');
  assert.equal(
    await ingestNovedadesUpdate(
      { remoteJid: '123@s.whatsapp.net', id: 'client' },
      { message: null },
      store
    ),
    false
  );
});

test('a persistence failure cannot fall through to generic ingestion', async () => {
  const { store } = recorder();
  store.post = async () => {
    throw new Error('database unavailable');
  };
  await assert.rejects(
    ingestNovedadesMessage(
      { key: { remoteJid: '100@newsletter', id: 'one' }, message: { conversation: 'post' } },
      store
    ),
    /database unavailable/
  );
});

test('stub-only channel events retain their key and metadata without pretending to be a post', async () => {
  const { store, calls } = recorder();
  const key = { remoteJid: '100@newsletter', id: 'event' };
  await ingestNovedadesMessage(
    { key, messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT },
    store
  );
  const input = calls[0].args[0] as {
    key: unknown;
    message?: unknown;
    metadata: { messageStubType: number };
  };
  assert.strictEqual(input.key, key);
  assert.equal(input.message, undefined);
  assert.equal(input.metadata.messageStubType, proto.WebMessageInfo.StubType.CIPHERTEXT);
  await assert.rejects(
    ingestNovedadesMessage({ key: { remoteJid: '100@newsletter' } }, store),
    /provider ID/
  );
});

test('status revoke stubs are routed to soft deletion even without a content payload', async () => {
  const { store, calls } = recorder();
  const key = { remoteJid: 'status@broadcast', id: 'one', fromMe: true };
  assert.equal(
    await ingestNovedadesMessage(
      { key, messageStubType: proto.WebMessageInfo.StubType.REVOKE },
      store
    ),
    true
  );
  assert.deepEqual(calls, [{ op: 'deleteStatus', args: [key] }]);
});
