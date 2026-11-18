import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import express from 'express';
import { BaileysClient } from './baileys-client';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';
import { mergeReceiptRows, mergeStatus, receiptTime, MessageInfoError } from './message-receipts';

test('receipt timestamps support rc13 seconds and history Long, reject invented values', () => {
  assert.equal(receiptTime(1700000000), '2023-11-14T22:13:20.000Z');
  assert.equal(receiptTime({ toNumber: () => 1700000000 }), receiptTime(1700000000));
  for (const invalid of [0, -1, NaN, Infinity, '1700000000', null])
    assert.equal(receiptTime(invalid), null);
});
test('PN/LID and replay receipts merge once with earliest evidence and monotonic fields', () => {
  const base = { name: null, deliveredAt: null, readAt: null, playedAt: null };
  const identities = [
    {
      participantId: '123@s.whatsapp.net',
      aliases: ['123@s.whatsapp.net', '456@lid'],
      name: 'Ada',
    },
  ];
  const rows = mergeReceiptRows(
    [
      {
        ...base,
        participantId: '456@lid',
        aliases: ['456@lid'],
        readAt: '2026-01-01T00:02:00.000Z',
      },
      {
        ...base,
        participantId: '123@s.whatsapp.net',
        aliases: ['123@s.whatsapp.net'],
        deliveredAt: '2026-01-01T00:01:00.000Z',
      },
      {
        ...base,
        participantId: '456@lid',
        aliases: ['456@lid'],
        readAt: '2026-01-01T00:03:00.000Z',
      },
    ],
    identities
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].readAt, '2026-01-01T00:02:00.000Z');
  assert.equal(rows[0].deliveredAt, '2026-01-01T00:01:00.000Z');
  assert.equal(rows[0].name, 'Ada');
  assert.equal(rows[0].participantId, '123@s.whatsapp.net');
  assert.equal(mergeStatus('read', 'sent'), 'read');
  assert.equal(mergeStatus('deleted', 'sent'), 'deleted');
  assert.equal(mergeStatus('failed', 'sent'), 'failed');
});
test('send captures real membership before transport and excludes owner aliases; historical read never queries groups', async () => {
  const original = pg.Pool.prototype.query;
  const originalConnect = pg.Pool.prototype.connect;
  const calls: any[] = [];
  (pg.Pool.prototype as any).query = async (sql: string, args: unknown[]) => {
    calls.push({ sql, args });
    return { rows: [] };
  };
  (pg.Pool.prototype as any).connect = async () => ({
    query: (sql: string, args: unknown[]) => (pg.Pool.prototype.query as any)(sql, args),
    release: () => {},
  });
  try {
    const client: any = new BaileysClient('/tmp/unused', 'key');
    client.ingest = true;
    const order: string[] = [];
    client.sock = {
      user: { id: '100:2@s.whatsapp.net', lid: 'owner@lid' },
      groupMetadata: async () => {
        order.push('members');
        return {
          participants: [
            { id: 'owner@lid', phoneNumber: '100@s.whatsapp.net' },
            { id: '456@lid', phoneNumber: '123@s.whatsapp.net', name: 'Ada' },
          ],
        };
      },
      sendMessage: async () => {
        order.push('send');
        return {
          key: { id: 'CAPTURE1', fromMe: true, remoteJid: '1@g.us' },
          message: { conversation: 'hi' },
        };
      },
    };
    await client.sendWithReceiptSnapshot(client.sock, '1@g.us', { text: 'hi' });
    await new Promise(r => setImmediate(r));
    assert.deepEqual(order, ['members', 'send']);
    const inserted = calls.find(c => c.sql.includes('INSERT INTO whatsapp_message_receipt_state'));
    const snapshot = JSON.parse(inserted.args[3]);
    snapshot[0].aliases.sort();
    assert.deepEqual(snapshot, [
      {
        participantId: '123@s.whatsapp.net',
        aliases: ['123@s.whatsapp.net', '456@lid'],
        name: 'Ada',
      },
    ]);
    calls.length = 0;
    await client.sendWithReceiptSnapshot(client.sock, '1@g.us', {
      react: { text: '👍', key: { id: 'old' } },
    });
    assert.equal(calls.length, 0);
  } finally {
    pg.Pool.prototype.query = original;
    pg.Pool.prototype.connect = originalConnect;
  }
});
test('snapshot database latency cannot time out an accepted group transport', async () => {
  const client: any = new BaileysClient('/tmp/unused', 'key');
  client.ingest = true;
  client.captureSendRecipients = async () => [
    { participantId: '123@s.whatsapp.net', aliases: ['123@s.whatsapp.net'], name: null },
  ];
  client.sock = {
    sendMessage: async () => ({ key: { id: 'ACCEPTED', fromMe: true, remoteJid: '1@g.us' } }),
  };
  const prior = pg.Pool.prototype.connect;
  (pg.Pool.prototype as any).connect = () => new Promise(() => {});
  try {
    assert.equal((await client.sendTextWithTimeout('1@g.us', 'hi', 25)).key.id, 'ACCEPTED');
    await new Promise(r => setImmediate(r));
  } finally {
    pg.Pool.prototype.connect = prior;
  }
});
test('message info is authenticated read access, independent of connection and sending gate', async () => {
  const secret = 'receipts-controller-test-secret';
  const client: any = {
    getMessageInfo: async (chatId: string, messageId: string) => {
      if (messageId === 'inbound') throw new MessageInfoError('outbound only', 400);
      return {
        account: 'personal',
        chatId,
        messageId,
        fromMe: true,
        status: 'sent',
        recipientCount: null,
        completeRecipients: false,
        receipts: [],
        observedAt: null,
      };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(client, { getCurrentQR: () => null } as any, secret));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1/messages/info`;
  const prior = process.env.ENABLE_SENDING;
  process.env.ENABLE_SENDING = 'false';
  try {
    for (const [messageId, status] of [
      ['ok', 200],
      ['inbound', 400],
    ]) {
      const body = { chatId: '1@g.us', messageId };
      const timestamp = Math.floor(Date.now() / 1000);
      const response = await fetch(base, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-connector-timestamp': String(timestamp),
          'x-connector-signature': generateHMACSignature(body, timestamp, secret),
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, status);
    }
    assert.equal(
      (
        await fetch(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      401
    );
  } finally {
    if (prior === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = prior;
    await new Promise<void>(r => server.close(() => r()));
  }
});
