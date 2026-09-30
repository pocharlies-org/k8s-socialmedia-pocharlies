/**
 * Forwarding or quoting a message that was edited shows its CURRENT text: the
 * stored copies (whatsapp_message_payloads, the in-memory one) are the
 * original, an edit only rewrites the messages row (content, is_edited,
 * metadata.edit_history). The text / caption of the copy is replaced by the
 * row's content; everything else of the copy (key, context, media keys) is
 * kept. Never edited, unknown row or an unreadable DB → the copy as it is.
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test.
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { generateForwardMessageContent } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysClient, BaileysClientOptions } from './baileys-client';
import {
  resetDurableStoreStateForTests,
  serializeDurableValue,
  toDurablePayload,
} from './durable-message-store';
import { resetChatStateForTests } from './chat-state';
import { resetDisappearingStateForTests } from './disappearing';
import { withEditedText } from './message-mutations';

process.env.WA_SEND_ERROR_ACK_WAIT_MS = '0';
process.env.WA_DIRECT_PRIVACY_PREFLIGHT = 'false';

type Rows = Record<string, unknown>[];
interface QueryCall {
  sql: string;
  params: unknown[];
}

function stubPool(route: (sql: string, params: unknown[]) => Rows): {
  calls: QueryCall[];
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    try {
      const rows = route(sql, params);
      return Promise.resolve({ rows, rowCount: rows.length });
    } catch (error) {
      return Promise.reject(error);
    }
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
  resetChatStateForTests();
  resetDisappearingStateForTests();
}

const isPayloadSelect = (sql: string): boolean =>
  /FROM whatsapp_message_payloads/i.test(sql) && /SELECT/i.test(sql);
const isEditedRead = (sql: string): boolean =>
  /SELECT content FROM messages/.test(sql) && /is_edited/.test(sql);

/** The DB of a test: the durable copy of ORIG, and the row's text when edited. */
function db(
  content: Record<string, unknown>,
  edited: string | null,
  options: { failing?: boolean } = {}
): (sql: string, params: unknown[]) => Rows {
  return (sql, params) => {
    if (isPayloadSelect(sql)) {
      return [
        {
          message_key: JSON.parse(
            serializeDurableValue({ remoteJid: '34600@s.whatsapp.net', id: 'ORIG', fromMe: false })
          ),
          message_payload: JSON.parse(serializeDurableValue(toDurablePayload(content))),
          wa_timestamp: new Date(),
          push_name: 'Ada',
        },
      ];
    }
    if (isEditedRead(sql)) {
      if (options.failing) throw new Error('connection terminated');
      assert.equal(params[0], 'professional:ORIG', 'the row by its namespaced id');
      assert.equal(params[1], 'whatsapp:professional', 'and this account');
      return edited === null ? [] : [{ content: edited }];
    }
    return [];
  };
}

interface Sent {
  jid: string;
  content: any;
  opts: any;
}

function makeClient(options: BaileysClientOptions = {}): { client: BaileysClient; sent: Sent[] } {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const sent: Sent[] = [];
  let n = 0;
  const sock = {
    ev: { on: () => {}, emit: () => {} },
    user: { id: '34600111222:5@s.whatsapp.net' },
    sendMessage: async (jid: string, content: any, opts: any) => {
      sent.push({ jid, content, opts });
      n += 1;
      return { key: { remoteJid: jid, id: `SENT${n}`, fromMe: true }, message: {} };
    },
    end: () => {},
  };
  const internals = client as any;
  internals.sock = sock;
  internals.ready = true;
  internals.lastState = 'CONNECTED';
  internals.isConnected = () => true;
  internals.waitForImmediateSendFailure = async () => undefined;
  internals.persistDurablePayload = async () => {};
  return { client, sent };
}

// ---------------------------------------------------------------------------
// withEditedText
// ---------------------------------------------------------------------------

test('withEditedText: text, extended text (context kept), captions, wrappers; nothing to change → undefined', () => {
  assert.deepEqual(withEditedText({ conversation: 'antes' }, 'después'), {
    conversation: 'después',
  });
  const ctx = { stanzaId: 'Q1', participant: '111@lid' };
  assert.deepEqual(
    withEditedText({ extendedTextMessage: { text: 'antes', contextInfo: ctx } }, 'después'),
    { extendedTextMessage: { text: 'después', contextInfo: ctx } }
  );
  const key = Buffer.alloc(32, 7);
  assert.deepEqual(
    withEditedText({ imageMessage: { caption: 'foto', mediaKey: key } }, 'foto nueva'),
    { imageMessage: { caption: 'foto nueva', mediaKey: key } }
  );
  assert.deepEqual(
    withEditedText(
      { ephemeralMessage: { message: { extendedTextMessage: { text: 'antes' } } } },
      'después'
    ),
    { ephemeralMessage: { message: { extendedTextMessage: { text: 'después' } } } }
  );
  assert.deepEqual(
    withEditedText(
      {
        documentWithCaptionMessage: {
          message: { documentMessage: { caption: 'a', fileName: 'f.pdf' } },
        },
      },
      'b'
    ),
    {
      documentWithCaptionMessage: {
        message: { documentMessage: { caption: 'b', fileName: 'f.pdf' } },
      },
    }
  );
  assert.equal(withEditedText({ conversation: 'igual' }, 'igual'), undefined);
  assert.equal(withEditedText({ stickerMessage: {} }, 'x'), undefined);
  assert.equal(withEditedText(undefined, 'x'), undefined);
});

// ---------------------------------------------------------------------------
// Forward
// ---------------------------------------------------------------------------

test('forward of an edited message sends its current text (durable copy is the original)', async () => {
  useAccount('professional');
  const pool = stubPool(db({ conversation: 'nos vemos a las 8' }, 'nos vemos a las 9'));
  try {
    const { client, sent } = makeClient();
    await client.forwardMessage('34600@c.us', 'professional:ORIG', '34611@c.us');
    const original = sent[0].content.forward as WAMessage;
    assert.equal(original.key.id, 'ORIG', 'still a real forward of that message');
    assert.equal(original.message?.conversation, 'nos vemos a las 9');
    const built = generateForwardMessageContent(original, false);
    assert.equal(built.extendedTextMessage?.text, 'nos vemos a las 9');
    assert.equal(built.extendedTextMessage?.contextInfo?.isForwarded, true);
  } finally {
    pool.restore();
  }
});

test('forward from the in-memory copy (an edited caption) uses the current text too', async () => {
  useAccount('professional');
  const pool = stubPool(db({}, 'la buena'));
  try {
    const { client, sent } = makeClient();
    const key = { remoteJid: '34600@s.whatsapp.net', id: 'ORIG', fromMe: true };
    (client as any).rememberKey('ORIG', key, key.remoteJid);
    (client as any).rememberMessageForRetry(key, {
      imageMessage: { caption: 'la mala', mediaKey: Buffer.alloc(32, 1) },
    });
    await client.forwardMessage('34600@c.us', 'ORIG', '34611@c.us');
    assert.equal(sent[0].content.forward.message.imageMessage.caption, 'la buena');
    assert.ok(sent[0].content.forward.message.imageMessage.mediaKey, 'media keys kept');
    assert.equal(pool.calls.filter(c => isPayloadSelect(c.sql)).length, 0, 'memory first');
  } finally {
    pool.restore();
  }
});

test('never edited, or the row unreadable: the stored copy goes as it is', async () => {
  for (const [label, route] of [
    ['never edited', db({ conversation: 'original' }, null)],
    ['DB failing', db({ conversation: 'original' }, 'x', { failing: true })],
  ] as const) {
    useAccount('professional');
    const pool = stubPool(route);
    try {
      const { client, sent } = makeClient();
      await client.forwardMessage('34600@c.us', 'ORIG', '34611@c.us');
      assert.equal(sent[0].content.forward.message.conversation, 'original', label);
    } finally {
      pool.restore();
    }
  }
});

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

test('a reply quotes the current text of an edited message', async () => {
  useAccount('professional');
  const pool = stubPool(db({ extendedTextMessage: { text: 'precio: 10 €' } }, 'precio: 12 €'));
  try {
    const { client, sent } = makeClient();
    await client.sendMessage('34600@c.us', 'vale', { replyToMessageId: 'professional:ORIG' });
    const quoted = sent[0].opts.quoted as WAMessage;
    assert.equal(quoted.key.id, 'ORIG');
    assert.equal(quoted.key.remoteJid, '34600@s.whatsapp.net');
    assert.equal(quoted.message?.extendedTextMessage?.text, 'precio: 12 €');
  } finally {
    pool.restore();
  }
});

test('ingest off (the pairing pool): no messages row is read', async () => {
  useAccount('professional');
  const pool = stubPool(db({ conversation: 'original' }, 'editado'));
  try {
    const { client, sent } = makeClient({ ingest: false });
    const key = { remoteJid: '34600@s.whatsapp.net', id: 'ORIG', fromMe: false };
    (client as any).rememberKey('ORIG', key, key.remoteJid);
    (client as any).rememberMessageForRetry(key, { conversation: 'original' });
    await client.forwardMessage('34600@c.us', 'ORIG', '34611@c.us');
    assert.equal(sent[0].content.forward.message.conversation, 'original');
    assert.equal(pool.calls.length, 0);
  } finally {
    pool.restore();
  }
});
