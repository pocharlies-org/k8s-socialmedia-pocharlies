import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import express from 'express';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { BaileysClient } from './baileys-client';
import { storeMessage } from './db-writer';
import {
  toDurablePayload,
  resetDurableStoreStateForTests,
  markMessageDeletedForMe,
} from './durable-message-store';
import { isViewOnceContent, RECOVERABLE_MESSAGE_TYPES, UNAVAILABLE_MESSAGE_TYPES } from './message-preservation';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

type Row = Record<string, any>;
function stubPool(route: (sql: string, params: unknown[]) => Row[] = () => []) {
  const original = pg.Pool.prototype.query;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  (pg.Pool.prototype as any).query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return { rows: route(sql, params) };
  };
  return {
    calls,
    restore: () => {
      pg.Pool.prototype.query = original;
    },
  };
}

function harness() {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  resetDurableStoreStateForTests();
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16));
  client.setMaxListeners(20);
  const internals = client as any;
  const history: unknown[][] = [];
  const resends: unknown[] = [];
  internals.ready = true;
  internals.sock = {
    fetchMessageHistory: async (...args: unknown[]) => {
      history.push(args);
      return 'request';
    },
    requestPlaceholderResend: async (key: unknown) => {
      resends.push(key);
      return 'request';
    },
  };
  return { client, internals, history, resends };
}

const timestamp = 1789250000000;
const message = (content: proto.IMessage, id = 'REAL'): WAMessage =>
  ({
    key: { id, remoteJid: '123@lid', fromMe: false },
    message: content,
    messageTimestamp: timestamp / 1000,
  }) as WAMessage;

test('empty chat without a real provider key reports no_anchor and makes no request', async () => {
  const db = stubPool();
  try {
    const { client, history, resends } = harness();
    const result = await client.recoverChatHistory('123@lid');
    assert.deepEqual(result, {
      chatId: '123@lid',
      status: 'no_anchor',
      requested: 0,
      placeholderRequests: 0,
      recovered: 0,
    });
    assert.equal(history.length + resends.length, 0);
    assert.equal((await client.recoverChatHistory('123@lid')).status, 'cooldown');
    for (const call of db.calls.filter(
      call => /SELECT/.test(call.sql) && /ANY\(\$2/.test(call.sql)
    )) {
      assert.equal(call.params[0], 'professional');
      assert.ok((call.params[1] as string[]).every(id => id.startsWith('professional:')));
    }
  } finally {
    db.restore();
  }
});

test('empty chat recovers a real message carried in a chat snapshot and requests older history in milliseconds', async () => {
  const db = stubPool();
  try {
    const { client, internals, history } = harness();
    internals.rememberHistorySnapshotMessages([{ message: message({ conversation: 'captured' }) }]);
    const ingested: WAMessage[] = [];
    internals.ingestMessage = async (msg: WAMessage, options: any) => {
      ingested.push(msg);
      assert.equal(options.storeMedia, true);
      assert.equal(options.publishEvent, false);
      return { inserted: true };
    };
    const result = await client.recoverChatHistory('123@lid');
    assert.equal(result.recovered, 1);
    assert.equal(result.status, 'requested');
    assert.equal(ingested[0].message?.conversation, 'captured');
    assert.deepEqual(history, [
      [50, { id: 'REAL', remoteJid: '123@lid', fromMe: false }, timestamp],
    ]);
  } finally {
    db.restore();
  }
});

test('persisted placeholders request the exact provider key and scope history to the current account', async () => {
  const anchor = {
    wa_message_id: 'professional:MISSING',
    remote_jid: '123@lid',
    from_me: false,
    participant_jid: null,
    message_timestamp_ms: String(timestamp),
  };
  const db = stubPool(sql =>
    /SELECT m\.wa_message_id, k\./.test(sql) ||
    /ORDER BY k.message_timestamp_ms ASC LIMIT 1/.test(sql)
      ? [anchor]
      : []
  );
  try {
    const { client, history, resends } = harness();
    const result = await client.recoverChatHistory('123@lid');
    assert.equal(result.placeholderRequests, 1);
    assert.equal(result.recovered, 0);
    assert.equal(result.requested, 1);
    assert.deepEqual(resends, [
      { id: 'MISSING', remoteJid: '123@lid', fromMe: false, participant: undefined },
    ]);
    assert.equal(history[0][2], timestamp);
  } finally {
    db.restore();
  }
});

test('recovery restores a locally captured payload instead of asking the phone to resend it', async () => {
  const db = stubPool(sql => {
    if (/SELECT p.wa_message_id/.test(sql)) return [{ wa_message_id: 'professional:LOCAL' }];
    if (/SELECT message_key, message_payload/.test(sql))
      return [
        {
          message_key: { id: 'LOCAL', remoteJid: '123@lid', fromMe: false },
          message_payload: { conversation: 'saved before revoke' },
          message_timestamp_ms: String(timestamp),
        },
      ];
    return [];
  });
  try {
    const { client, internals, resends } = harness();
    const recovered: WAMessage[] = [];
    internals.ingestMessage = async (msg: WAMessage) => {
      recovered.push(msg);
      return { inserted: true };
    };
    const result = await client.recoverChatHistory('123@lid');
    assert.equal(result.recovered, 1);
    assert.equal(recovered[0].message?.conversation, 'saved before revoke');
    assert.equal(resends.length, 0);
  } finally {
    db.restore();
  }
});

test('concurrent recovery calls share a single phone request', async () => {
  const db = stubPool();
  try {
    const { client, internals, history } = harness();
    internals.rememberHistoryRecoveryAnchor(message({ secretEncryptedMessage: {} }));
    const results = await Promise.all([
      client.recoverChatHistory('123@lid'),
      client.recoverChatHistory('123@lid'),
    ]);
    assert.equal(history.length, 1);
    assert.deepEqual(results[0], results[1]);
  } finally {
    db.restore();
  }
});

test('captured genuine placeholder remains eligible for provider resend instead of false recovery', async () => {
  const anchor = { wa_message_id: 'professional:MISSING', remote_jid: '123@lid', from_me: false,
    participant_jid: null, message_timestamp_ms: String(timestamp) };
  const db = stubPool(sql => {
    if (/SELECT m\.wa_message_id, k\./.test(sql)) return [anchor];
    if (/SELECT message_key, message_payload/.test(sql)) return [{
      message_key: { id: 'MISSING', remoteJid: '123@lid', fromMe: false },
      message_payload: { placeholderMessage: { type: 0 } }, message_timestamp_ms: String(timestamp),
    }];
    return [];
  });
  try {
    const { client, internals, resends } = harness();
    internals.ingestMessage = async () => { assert.fail('placeholder cannot be counted as restored'); };
    const result = await client.recoverChatHistory('123@lid');
    assert.equal(result.recovered, 0);
    assert.equal(result.placeholderRequests, 1);
    assert.equal(resends.length, 1);
  } finally { db.restore(); }
});

test('empty legacy business row reprojects its local payload without placeholder resend', async () => {
  const db = stubPool(sql => {
    if (/SELECT p.wa_message_id/.test(sql)) return [{ wa_message_id: 'professional:BUSINESS' }];
    if (/SELECT message_key, message_payload/.test(sql)) return [{
      message_key: { id: 'BUSINESS', remoteJid: '123@lid', fromMe: false },
      message_payload: { templateMessage: { hydratedTemplate: { hydratedContentText: 'Please confirm' } } },
      message_timestamp_ms: String(timestamp),
    }];
    return [];
  });
  try {
    const { client, internals, resends } = harness();
    internals.ingestMessage = async (msg: WAMessage) => {
      assert.equal(internals.convertMessage(msg).content, 'Please confirm');
      return { inserted: true };
    };
    const result = await client.recoverChatHistory('123@lid');
    assert.equal(result.recovered, 1);
    assert.equal(resends.length, 0);
    const scan = db.calls.find(call => /SELECT p.wa_message_id/.test(call.sql))!;
    const requestable = db.calls.find(call => /SELECT m\.wa_message_id, k\./.test(call.sql))!;
    assert.deepEqual(scan.params[2], RECOVERABLE_MESSAGE_TYPES);
    assert.deepEqual(requestable.params[2], UNAVAILABLE_MESSAGE_TYPES);
    assert.ok((scan.params[2] as string[]).includes('TEMPLATEMESSAGE'));
    assert.ok(!(requestable.params[2] as string[]).includes('TEMPLATEMESSAGE'));
  } finally { db.restore(); }
});

test('foreign namespaces and disconnected sockets cannot trigger recovery', async () => {
  const { client, internals, history } = harness();
  await assert.rejects(client.recoverChatHistory('personal:123@lid'), /Invalid chatId/);
  internals.ready = false;
  await assert.rejects(client.recoverChatHistory('123@lid'), /not connected/);
  assert.equal(history.length, 0);
});

test('a failed request can be retried rather than entering the cooldown', async () => {
  const db = stubPool();
  try {
    const { client, internals, history } = harness();
    internals.rememberHistoryRecoveryAnchor(message({ secretEncryptedMessage: {} }));
    internals.sock.fetchMessageHistory = async () => {
      throw new Error('provider offline');
    };
    await assert.rejects(client.recoverChatHistory('123@lid'), /provider offline/);
    internals.sock.fetchMessageHistory = async (...args: unknown[]) => {
      history.push(args);
    };
    assert.equal((await client.recoverChatHistory('123@lid')).status, 'requested');
    assert.equal(history.length, 1);
  } finally {
    db.restore();
  }
});

test('encrypted and undecryptable payloads stay honest placeholders; pure control messages create no bubble', () => {
  const { internals } = harness();
  const encrypted = internals.convertMessage(message({ secretEncryptedMessage: {} }));
  assert.equal(encrypted.messageType, 'UNAVAILABLE');
  assert.equal(encrypted.content, null);
  assert.equal(encrypted.metadata.contentUnavailable, true);
  const ciphertext = internals.convertMessage({
    ...message({}),
    message: undefined,
    messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
  });
  assert.equal(ciphertext.messageType, 'UNAVAILABLE');
  for (const content of [
    { senderKeyDistributionMessage: {} },
    { messageContextInfo: {} },
    { encReactionMessage: {} },
  ])
    assert.equal(internals.convertMessage(message(content)), null);
});

test('view-once image/video/audio wrappers retain the marker and their actual media kind', () => {
  const { internals } = harness();
  for (const wrapper of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']) {
    for (const type of ['imageMessage', 'videoMessage', 'audioMessage']) {
      const wrapped = {
        [wrapper]: { message: { [type]: { viewOnce: true, mimetype: 'video/mp4' } } },
      };
      assert.equal(isViewOnceContent(wrapped), true);
      const converted = internals.convertMessage(message(wrapped));
      assert.equal(converted.messageType, type.replace('Message', '').toUpperCase());
      assert.equal(converted.metadata.viewOnce, true);
      assert.equal(internals.mediaMetaFromMessage(message(wrapped)).mimeType, 'video/mp4');
      assert.ok(toDurablePayload(wrapped));
    }
  }
  assert.equal(
    isViewOnceContent({ ephemeralMessage: { message: { imageMessage: { viewOnce: true } } } }),
    true
  );
  assert.equal(isViewOnceContent({ imageMessage: {} }), false);
});

test('an encrypted/control replay cannot overwrite an already captured durable payload', () => {
  for (const content of [
    { secretEncryptedMessage: {} },
    { messageContextInfo: {} },
    { senderKeyDistributionMessage: {} },
    { encReactionMessage: {} },
  ])
    assert.equal(toDurablePayload(content), null);
  assert.ok(toDurablePayload({ pinInChatMessage: { type: 1 } }));
  assert.ok(toDurablePayload({ pollUpdateMessage: { pollCreationMessageKey: { id: 'poll' } } }));
});

test('view-once history captures available media before publishing the message', async () => {
  const db = stubPool(sql => (/INSERT INTO messages/.test(sql) ? [{ id: 'saved-id' }] : []));
  try {
    const { client, internals } = harness();
    internals.persistDurablePayload = async () => true;
    internals.ensureConversationAvatarIfMissing = async () => {};
    internals.ensureParticipantAvatarIfMissing = async () => {};
    let captured = false;
    internals.downloadAndStoreMedia = async (_msg: WAMessage, id: string, type: string) => {
      assert.equal(id, 'saved-id');
      assert.equal(type, 'IMAGE');
      await Promise.resolve();
      captured = true;
      return { storageKey: 'saved-image', fileSize: 10 };
    };
    client.on('message', msg => {
      assert.equal(captured, true);
      assert.equal(msg.metadata.viewOnce, true);
    });
    const result = await internals.ingestMessage(
      message({
        viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } },
      }),
      { source: 'baileys_history_sync', storeMedia: false }
    );
    assert.equal(result.inserted, true);
    assert.equal(captured, true);
    const saved = db.calls.find(call => /INSERT INTO messages/.test(call.sql))!;
    assert.equal(JSON.parse(String(saved.params[10])).viewOnce, true);
  } finally {
    db.restore();
  }
});

test('message recovery upsert only fills incomplete content and keeps deleted/edit flags and attachments', async () => {
  const db = stubPool(() => [{ id: 'saved-id' }]);
  try {
    harness();
    await storeMessage({
      waMessageId: 'OLD',
      conversationId: '123@lid',
      senderWaId: '123@lid',
      waTimestamp: new Date(timestamp),
      direction: 'INBOUND',
      content: 'recovered text',
      messageType: 'TEXT',
      isForwarded: false,
    });
    const query = db.calls.find(call => /INSERT INTO messages/.test(call.sql))!;
    assert.match(query.sql, /ON CONFLICT \(wa_message_id\) DO UPDATE/);
    assert.match(query.sql, /NOT COALESCE\(messages.is_edited, false\)/);
    assert.match(query.sql, /NULLIF\(messages.content, ''\) IS NULL/);
    assert.match(query.sql, /EXCLUDED.metadata \|\| COALESCE\(messages.metadata/);
    assert.doesNotMatch(query.sql, /(?:is_deleted|deleted_at|status|is_edited)\s*=/);
    assert.equal(
      db.calls.some(call => /(?:UPDATE|DELETE FROM) attachments/.test(call.sql)),
      false
    );
  } finally {
    db.restore();
  }
});

test('capability delete-for-me remains hidden while keeping the saved message and media', async () => {
  const db = stubPool();
  try {
    harness();
    await markMessageDeletedForMe('OLD', '123@lid');
    const query = db.calls.find(call => /UPDATE messages/.test(call.sql))!;
    assert.match(query.sql, /'deleted_for_me', TRUE/);
    assert.match(query.sql, /'deleted_for_me_at'/);
    assert.match(
      query.sql,
      /WHERE wa_message_id = \$1 AND account = \$2 AND conversation_id = \$3/
    );
    assert.deepEqual(query.params, ['professional:OLD', 'professional', 'professional:123@lid']);
    assert.doesNotMatch(query.sql, /content\s*=|DELETE FROM/);
  } finally {
    db.restore();
  }
});

test('history recovery HTTP requires authentication and a chat, and returns the actual result', async () => {
  const secret = 'history-controller-test-secret';
  const calls: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createRouter(
      {
        getCachedState: () => 'open',
        isConnected: () => true,
        recoverChatHistory: async (chatId: string) => {
          calls.push(chatId);
          return {
            chatId,
            status: 'no_anchor',
            requested: 0,
            placeholderRequests: 0,
            recovered: 0,
          };
        },
      } as any,
      { getCurrentQR: () => null } as any,
      secret
    )
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/history/recover`;
  const request = (body: unknown, authenticated: boolean) => {
    const timestamp = Math.floor(Date.now() / 1000);
    return fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        ...(authenticated
          ? {
              'x-connector-timestamp': String(timestamp),
              'x-connector-signature': generateHMACSignature(body, timestamp, secret),
            }
          : {}),
      },
    });
  };
  try {
    assert.equal((await request({ chatId: '123@lid' }, false)).status, 401);
    assert.equal((await request({}, true)).status, 400);
    assert.equal(calls.length, 0);
    const response = await request({ chatId: '123@lid' }, true);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'no_anchor');
    assert.deepEqual(calls, ['123@lid']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
