/**
 * Durable WhatsApp message payloads (fase 3 / PR-1) — the BaileysClient paths
 * that use them: forward, reply quoting, the Baileys retry callback, ingest,
 * markAsRead, and the HTTP mapping of "message unavailable".
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import pg from 'pg';
import { generateForwardMessageContent } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysClient, BaileysClientOptions } from './baileys-client';
import {
  MessageUnavailableError,
  resetDurableStoreStateForTests,
  serializeDurableValue,
  toDurablePayload,
} from './durable-message-store';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

process.env.WA_SEND_ERROR_ACK_WAIT_MS = '0';
process.env.WA_DIRECT_PRIVACY_PREFLIGHT = 'false';

interface QueryCall {
  sql: string;
  params: unknown[];
}

type Rows = Record<string, unknown>[];

/** Stub pg.Pool#query: `route` picks the rows by SQL; every call is captured. */
function stubPool(route: (sql: string, params: unknown[]) => Rows = () => []): {
  calls: QueryCall[];
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    return Promise.resolve({ rows: route(sql, params) });
  };
  return {
    calls,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg.Pool.prototype as any).query = original;
    },
  };
}

function useAccount(account: string): void {
  process.env.CONNECTOR_ACCOUNT = account;
  resetDurableStoreStateForTests();
}

const isPayloadSelect = (sql: string): boolean =>
  /FROM whatsapp_message_payloads/i.test(sql) && /SELECT/i.test(sql);
const payloadInserts = (calls: QueryCall[]): QueryCall[] =>
  calls.filter(c => /INSERT INTO whatsapp_message_payloads/i.test(c.sql));

/** A durable row as pg returns it (JSONB already parsed). */
function durableRow(id: string, remoteJid: string, content: Record<string, unknown>): Rows {
  return [
    {
      message_key: JSON.parse(serializeDurableValue({ remoteJid, id, fromMe: false })),
      message_payload: JSON.parse(serializeDurableValue(toDurablePayload(content))),
      wa_timestamp: new Date(),
      push_name: 'Ada',
    },
  ];
}

interface SentCall {
  jid: string;
  content: any;
  opts: any;
}

function makeClient(options: BaileysClientOptions = {}): {
  client: BaileysClient;
  sent: SentCall[];
  reads: any[][];
} {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const sent: SentCall[] = [];
  const reads: any[][] = [];
  let n = 0;
  const sock = {
    sendMessage: async (jid: string, content: any, opts: any) => {
      sent.push({ jid, content, opts });
      n += 1;
      const message = content.forward
        ? generateForwardMessageContent(content.forward, false)
        : content.text
          ? { extendedTextMessage: { text: content.text } }
          : { audioMessage: { mimetype: 'audio/ogg', mediaKey: Buffer.alloc(32, 1) } };
      return {
        key: { remoteJid: jid, id: `SENT${n}`, fromMe: true },
        message,
        messageTimestamp: Math.floor(Date.now() / 1000),
      };
    },
    readMessages: async (keys: any[]) => {
      reads.push(keys);
    },
    end: () => {},
  };
  const internals = client as unknown as { sock: unknown; ready: boolean };
  internals.sock = sock;
  internals.ready = true;
  return { client, sent, reads };
}

function priv(client: BaileysClient): any {
  return client as any;
}

// ---------------------------------------------------------------------------
// Forward
// ---------------------------------------------------------------------------

test('forward sends a real { forward: WAMessage } built from the durable original', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(sql =>
    isPayloadSelect(sql) ? durableRow('ORIG', '34600@s.whatsapp.net', { conversation: 'hola' }) : []
  );
  try {
    const { client, sent } = makeClient();
    const id = await client.forwardMessage('34600@c.us', 'professional:ORIG', '34611@c.us');

    assert.equal(id, 'SENT1');
    const select = calls.find(c => isPayloadSelect(c.sql))!;
    assert.equal(select.params[0], 'professional:ORIG', 'lookup by the namespaced id');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, '34611@s.whatsapp.net');
    const original = sent[0].content.forward as WAMessage;
    assert.equal(original.key.id, 'ORIG', 'the key handed to WhatsApp is bare');
    assert.equal(original.message?.conversation, 'hola');
    // What Baileys builds from it is a forwarded text.
    const built = generateForwardMessageContent(original, false);
    assert.equal(built.extendedTextMessage?.text, 'hola');
    assert.equal(built.extendedTextMessage?.contextInfo?.isForwarded, true);
    // The forwarded copy is itself stored, under the target chat.
    const insert = payloadInserts(calls)[0];
    assert.equal(insert.params[0], 'professional:SENT1');
    assert.equal(insert.params[2], 'professional:34611@c.us');
  } finally {
    restore();
  }
});

test('forward prefers the in-memory original (no DB read)', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client, sent } = makeClient();
    const key = { remoteJid: '34600@s.whatsapp.net', id: 'MEM', fromMe: false };
    priv(client).rememberKey('MEM', key, key.remoteJid);
    priv(client).rememberMessageForRetry(key, { conversation: 'desde memoria' });
    await client.forwardMessage('34600@c.us', 'MEM', '34611@c.us');
    assert.equal(sent[0].content.forward.message.conversation, 'desde memoria');
    assert.equal(calls.filter(c => isPayloadSelect(c.sql)).length, 0);
  } finally {
    restore();
  }
});

test('forward of an unknown original is a 404 MessageUnavailableError and sends nothing', async () => {
  useAccount('personal');
  const { restore } = stubPool();
  try {
    const { client, sent } = makeClient();
    await assert.rejects(
      client.forwardMessage('34600@c.us', 'NOPE', '34611@c.us'),
      (e: unknown) =>
        e instanceof MessageUnavailableError &&
        e.status === 404 &&
        e.failureClass === 'message_unavailable'
    );
    assert.equal(sent.length, 0);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Reply quoting
// ---------------------------------------------------------------------------

test('text reply quotes the durable original (restart-proof) with the target chat jid', async () => {
  useAccount('personal');
  const { restore } = stubPool(sql =>
    isPayloadSelect(sql) ? durableRow('Q1', '34600@lid', { conversation: 'pregunta' }) : []
  );
  try {
    const { client, sent } = makeClient();
    await client.sendMessage('34600@c.us', 'respuesta', { replyToMessageId: 'Q1' });
    const quoted = sent[0].opts.quoted as WAMessage;
    assert.equal(quoted.key.id, 'Q1');
    assert.equal(quoted.key.remoteJid, '34600@s.whatsapp.net', 'remoteJid is the target chat');
    assert.equal(quoted.message?.conversation, 'pregunta');
  } finally {
    restore();
  }
});

test('text reply whose quote is unknown still sends, unquoted (unchanged behaviour)', async () => {
  useAccount('personal');
  const { restore } = stubPool();
  try {
    const { client, sent } = makeClient();
    const id = await client.sendMessage('34600@c.us', 'hola', { replyToMessageId: 'GONE' });
    assert.equal(id, 'SENT1');
    assert.equal(sent[0].opts.quoted, undefined);
  } finally {
    restore();
  }
});

test('media reply whose quote is unknown is a 422, rejected before the file is fetched', async () => {
  useAccount('personal');
  const { restore } = stubPool();
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response(Buffer.from('x'), { headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;
  try {
    const { client, sent } = makeClient();
    await assert.rejects(
      client.sendFile('34600@c.us', 'http://files/x.jpg', 'pie', { replyToMessageId: 'GONE' }),
      (e: unknown) =>
        e instanceof MessageUnavailableError &&
        e.status === 422 &&
        e.failureClass === 'quoted_message_unavailable'
    );
    assert.equal(fetched, 0);
    assert.equal(sent.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test('media reply with a durable quote sends quoted and stores the sent payload', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(sql =>
    isPayloadSelect(sql) ? durableRow('Q2', '34600@s.whatsapp.net', { conversation: 'foto?' }) : []
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(Buffer.from('jpeg'), {
      headers: { 'content-type': 'image/jpeg' },
    })) as typeof fetch;
  try {
    const { client, sent } = makeClient();
    await client.sendFile('34600@c.us', 'http://files/x.jpg', 'aquí', { replyToMessageId: 'Q2' });
    assert.equal(sent[0].opts.quoted.key.id, 'Q2');
    assert.equal(payloadInserts(calls)[0].params[0], 'SENT1');
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

// ---------------------------------------------------------------------------
// Baileys retry callback
// ---------------------------------------------------------------------------

test('getMessage retry uses the durable copy when memory is cold', async () => {
  useAccount('professional');
  const { restore } = stubPool(sql =>
    isPayloadSelect(sql)
      ? durableRow('R1', '34600@s.whatsapp.net', { conversation: 'reintento' })
      : []
  );
  try {
    const { client } = makeClient();
    const msg = await priv(client).getMessageForRetry({
      id: 'R1',
      remoteJid: '34600@s.whatsapp.net',
    });
    assert.equal(msg?.conversation, 'reintento');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Ingest: live vs history window
// ---------------------------------------------------------------------------

function incoming(id: string, ageSeconds: number): WAMessage {
  return {
    key: { remoteJid: '34600@s.whatsapp.net', id, fromMe: false },
    message: { conversation: 'entrante' },
    messageTimestamp: Math.floor(Date.now() / 1000) - ageSeconds,
    pushName: 'Ada',
  } as WAMessage;
}

test('ingest stores live payloads and only recent history payloads', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(sql =>
    /INSERT INTO messages/i.test(sql) ? [{ id: 1 }] : []
  );
  try {
    const { client } = makeClient();
    await priv(client).ingestMessage(incoming('LIVE', 60), { source: 'live', publishEvent: false });
    await priv(client).ingestMessage(incoming('OLD', 30 * 24 * 60 * 60), {
      source: 'baileys_history_sync',
      publishEvent: false,
    });
    await priv(client).ingestMessage(incoming('RECENT', 60 * 60), {
      source: 'baileys_history_sync',
      publishEvent: false,
    });
    const ids = payloadInserts(calls).map(c => c.params[0]);
    assert.deepEqual(ids, ['professional:LIVE', 'professional:RECENT']);
    assert.equal(payloadInserts(calls)[0].params[2], 'professional:34600@c.us');
    // the messages rows are written for all three, as before
    assert.equal(calls.filter(c => /INSERT INTO messages/i.test(c.sql)).length, 3);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Pairing-only sockets (ingest off) never touch the table
// ---------------------------------------------------------------------------

test('with ingest off nothing is written or read from whatsapp_message_payloads', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(sql =>
    isPayloadSelect(sql) ? durableRow('ORIG', '34600@s.whatsapp.net', { conversation: 'x' }) : []
  );
  try {
    const { client, sent } = makeClient({ ingest: false });
    await client.sendVoice('34600@c.us', Buffer.from('ogg'));
    await client.sendMessage('34600@c.us', 'hola', { replyToMessageId: 'ORIG' });
    await priv(client).getMessageForRetry({ id: 'ORIG', remoteJid: '34600@s.whatsapp.net' });
    await assert.rejects(client.forwardMessage('34600@c.us', 'ORIG', '34611@c.us'));
    assert.equal(sent[1].opts.quoted, undefined, 'no durable quote either');
    assert.equal(
      calls.filter(c => /whatsapp_message_payloads/i.test(c.sql)).length,
      0,
      'the pairing pool never reads or writes durable payloads'
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// markAsRead
// ---------------------------------------------------------------------------

test('markAsRead sends receipts for every unread key and records them as read', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(sql =>
    /FROM conv/i.test(sql)
      ? [
          {
            wa_message_id: 'professional:U2',
            remote_jid: '120363@g.us',
            from_me: false,
            participant_jid: '34600@s.whatsapp.net',
          },
          {
            wa_message_id: 'professional:U1',
            remote_jid: '120363@g.us',
            from_me: false,
            participant_jid: '34611@s.whatsapp.net',
          },
        ]
      : []
  );
  try {
    const { client, reads } = makeClient();
    await client.markAsRead('120363@g.us');
    const unreadQuery = calls.find(c => /FROM conv/i.test(c.sql))!;
    assert.equal(unreadQuery.params[0], 'professional:120363@g.us');
    assert.equal(unreadQuery.params[1], 'professional');
    assert.match(unreadQuery.sql, /m\.direction = 'INBOUND'/);
    assert.match(unreadQuery.sql, /m\.wa_timestamp > mark\.ts/, 'bounded by the read watermark');
    assert.equal(reads.length, 1);
    assert.deepEqual(
      reads[0].map((k: any) => [k.id, k.participant]),
      [
        ['U2', '34600@s.whatsapp.net'],
        ['U1', '34611@s.whatsapp.net'],
      ]
    );
    const update = calls.find(c => /UPDATE messages SET status = 'read'/i.test(c.sql))!;
    assert.deepEqual(update.params[0], ['professional:U2', 'professional:U1']);
    assert.ok(calls.some(c => /UPDATE conversations SET unread_count/i.test(c.sql)));
  } finally {
    restore();
  }
});

test('markAsRead with nothing pending falls back to the latest message key', async () => {
  useAccount('personal');
  const { restore } = stubPool(sql =>
    /ORDER BY wa_timestamp DESC LIMIT 1/i.test(sql) ? [{ wa_message_id: 'LAST' }] : []
  );
  try {
    const { client, reads } = makeClient();
    await client.markAsRead('34600@c.us');
    assert.equal(reads.length, 1);
    assert.equal(reads[0][0].id, 'LAST');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// HTTP: /messages/forward and /messages/media/send
// ---------------------------------------------------------------------------

async function withRouter(
  client: Partial<BaileysClient>,
  run: (post: (path: string, body: unknown) => Promise<Response>) => Promise<void>
): Promise<void> {
  const secret = 'test-secret';
  const app = express();
  app.use(express.json());
  const qr = { getCurrentQR: () => null, clearQR: () => {} };
  app.use('/api/v1', createRouter(client as BaileysClient, qr as never, secret));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const post = (path: string, body: unknown): Promise<Response> => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(ts),
        'x-connector-signature': generateHMACSignature(body, ts, secret),
      },
      body: JSON.stringify(body),
    });
  };
  const previous = process.env.ENABLE_SENDING;
  process.env.ENABLE_SENDING = 'true';
  try {
    await run(post);
  } finally {
    if (previous === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = previous;
    await new Promise(resolve => server.close(resolve));
  }
}

test('POST /messages/forward: 200 with the new messageId, 404 when the original is unknown', async () => {
  let known = true;
  const client = {
    forwardMessage: async () => {
      if (known) return 'NEWID';
      throw new MessageUnavailableError(
        'forwardMessage: message X is unavailable',
        404,
        'message_unavailable'
      );
    },
  };
  await withRouter(client as Partial<BaileysClient>, async post => {
    const body = { chatId: '34600@c.us', messageId: 'X', toChatId: '34611@c.us' };
    const ok = await post('/messages/forward', body);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { forwarded: true, messageId: 'NEWID' });

    known = false;
    const missing = await post('/messages/forward', body);
    assert.equal(missing.status, 404);
    const json = (await missing.json()) as { failureClass: string; error: string };
    assert.equal(json.failureClass, 'message_unavailable');
    assert.match(json.error, /unavailable/);
  });
});

test('POST /messages/media/send maps an unknown quoted message to 422', async () => {
  const client = {
    sendFile: async () => {
      throw new MessageUnavailableError(
        'Quoted message Q is unavailable',
        422,
        'quoted_message_unavailable'
      );
    },
  };
  await withRouter(client as Partial<BaileysClient>, async post => {
    const res = await post('/messages/media/send', {
      conversationId: '34600@c.us',
      fileUrl: 'http://files/x.jpg',
      replyTo: 'Q',
    });
    assert.equal(res.status, 422);
    assert.equal(
      ((await res.json()) as { failureClass: string }).failureClass,
      'quoted_message_unavailable'
    );
  });
});
