/**
 * QA audit 02-10-2026 (console + MCP), connector side:
 *
 * - media WE send comes back as an `append` upsert and is stored like live
 *   media (MinIO + attachments), a history replay is not;
 * - a sent document keeps its name (fileName in the body, else the URL path
 *   without the presigned query);
 * - a reply stores its quote (text or a label, author id and name);
 * - a 1:1 chat never links our own participant (the console named those
 *   chats after the account); a group still does;
 * - WhatsApp's own account `0@s.whatsapp.net` is named "WhatsApp";
 * - a profile picture hidden by privacy (Boom data 401 not-authorized) is a
 *   404 "No photo", not a 500.
 *
 * No socket and no DB: a fake sock captures the handlers and pg.Pool#query
 * is stubbed (same harness as reconnect-backfill.test.ts).
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
import { Boom } from '@hapi/boom';
import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysClient, isUnavailableProfilePicture } from './baileys-client';
import { resetDurableStoreStateForTests } from './durable-message-store';
import {
  appendMediaEligible,
  cleanFileName,
  documentFileName,
  isOfficialWhatsAppJid,
  linksSenderToChat,
  quotedReply,
} from './ingest-extras';
import { mediaRequestHash } from './send-idempotency';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

process.env.WA_DIRECT_PRIVACY_PREFLIGHT = 'false';

type Rows = Record<string, unknown>[];
interface QueryCall {
  sql: string;
  params: unknown[];
}

function stubPool(route: (sql: string, params: unknown[]) => Rows = () => []): {
  calls: QueryCall[];
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    return Promise.resolve({ rows: route(sql, params), rowCount: 0 });
  };
  return {
    calls,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg.Pool.prototype as any).query = original;
    },
  };
}

/** messages INSERT … RETURNING id answers an id, so the media path runs. */
const route = (sql: string): Rows => (/INSERT INTO messages/i.test(sql) ? [{ id: '77' }] : []);
const isLink = (sql: string): boolean => /INSERT INTO conversation_participants/i.test(sql);
const isMessageInsert = (sql: string): boolean => /INSERT INTO messages/i.test(sql);

function priv(client: BaileysClient): any {
  return client as any;
}

const ME_PN = '34999@s.whatsapp.net';

function makeClient(): {
  client: BaileysClient;
  handlers: Record<string, (update: any) => unknown>;
  media: Array<{ id: string; type: string }>;
  sent: Array<{ jid: string; content: any }>;
} {
  process.env.CONNECTOR_ACCOUNT = 'professional';
  resetDurableStoreStateForTests();
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16));
  const handlers: Record<string, (update: any) => unknown> = {};
  const sent: Array<{ jid: string; content: any }> = [];
  const sock = {
    ev: {
      on: (event: string, fn: (update: any) => unknown) => {
        handlers[event] = fn;
      },
    },
    user: { id: '34999:3@s.whatsapp.net', lid: '9999:3@lid' },
    profilePictureUrl: async () => undefined,
    groupMetadata: async () => ({ id: 'G@g.us', subject: 'G', participants: [] }),
    signalRepository: { lidMapping: { getLIDForPN: async () => null } },
    sendMessage: async (jid: string, content: any) => {
      sent.push({ jid, content });
      return {
        key: { remoteJid: jid, id: 'SENT1', fromMe: true },
        message: {},
        messageTimestamp: Math.floor(Date.now() / 1000),
      } as unknown as WAMessage;
    },
    end: () => {},
  };
  const internals = client as unknown as { sock: unknown; ready: boolean; meJid: string };
  internals.sock = sock;
  internals.ready = true;
  internals.meJid = ME_PN;
  const media: Array<{ id: string; type: string }> = [];
  priv(client).downloadAndStoreMedia = async (msg: WAMessage, _id: bigint, type: string) => {
    media.push({ id: String(msg.key.id), type });
    return null;
  };
  priv(client).bindSocketEvents(async () => {});
  return { client, handlers, media, sent };
}

function waMessage(overrides: Record<string, any> = {}): WAMessage {
  return {
    key: { remoteJid: '2222@lid', id: 'M1', fromMe: true },
    message: { imageMessage: { caption: 'foto', mimetype: 'image/png' } },
    messageTimestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  } as unknown as WAMessage;
}

function storedMetadata(calls: QueryCall[]): Record<string, unknown> {
  const insert = calls.find(c => isMessageInsert(c.sql));
  assert.ok(insert, 'a messages row');
  return JSON.parse(String(insert.params[10])) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('appendMediaEligible: recent append yes, old or timeless no; env window', () => {
  const now = 1_790_000_000_000;
  assert.equal(appendMediaEligible({ messageTimestamp: now / 1000 - 60 }, now), true);
  assert.equal(appendMediaEligible({ messageTimestamp: now / 1000 - 2 * 86400 }, now), false);
  assert.equal(appendMediaEligible({ messageTimestamp: 0 }, now), false);
  assert.equal(appendMediaEligible({ messageTimestamp: undefined }, now), false);
  const saved = process.env.WA_APPEND_MEDIA_MAX_AGE_HOURS;
  process.env.WA_APPEND_MEDIA_MAX_AGE_HOURS = '72';
  try {
    assert.equal(appendMediaEligible({ messageTimestamp: now / 1000 - 2 * 86400 }, now), true);
  } finally {
    if (saved === undefined) delete process.env.WA_APPEND_MEDIA_MAX_AGE_HOURS;
    else process.env.WA_APPEND_MEDIA_MAX_AGE_HOURS = saved;
  }
});

test('documentFileName: explicit name wins; URL path without the presigned query', () => {
  assert.equal(
    documentFileName('http://minio:9000/b/outgoing/ab12.pdf?X-Amz-Signature=zz', 'qa-doc.pdf'),
    'qa-doc.pdf'
  );
  assert.equal(
    documentFileName('http://minio:9000/b/outgoing/ab12.pdf?X-Amz-Signature=zz'),
    'ab12.pdf'
  );
  assert.equal(documentFileName('https://x/Informe%20final.pdf'), 'Informe final.pdf');
  assert.equal(documentFileName('https://x/'), 'attachment');
  assert.equal(documentFileName('https://x/a.pdf', '  '), 'a.pdf');
  assert.equal(cleanFileName('../etc/passwd\u0000'), 'passwd');
  assert.equal(cleanFileName('a'.repeat(300)).length, 200);
  assert.equal(documentFileName('https://x/..%2Freport.pdf'), 'report.pdf');
  assert.equal(documentFileName('data:application/pdf;base64,YQ=='), 'attachment');
});

test('quotedReply: any message kind, text or a label, author; never for a reaction', () => {
  assert.deepEqual(
    quotedReply({
      extendedTextMessage: {
        text: 'sí',
        contextInfo: {
          stanzaId: 'Q1',
          participant: '2222@lid',
          quotedMessage: { conversation: 'hola' },
        },
      },
    }),
    { stanzaId: 'Q1', participant: '2222@lid', preview: { text: 'hola', type: 'TEXT' } }
  );
  assert.deepEqual(
    quotedReply({
      imageMessage: {
        caption: 'mira',
        contextInfo: { stanzaId: 'Q2', quotedMessage: { imageMessage: {} } },
      },
    }),
    { stanzaId: 'Q2', preview: { text: '📷 Foto', type: 'IMAGE' } }
  );
  assert.equal(
    quotedReply({
      conversation: 'x',
      extendedTextMessage: {
        contextInfo: {
          stanzaId: 'Q3',
          quotedMessage: { documentMessage: { fileName: 'factura.pdf' } },
        },
      },
    })?.preview?.text,
    '📄 factura.pdf'
  );
  assert.equal(
    quotedReply({
      extendedTextMessage: {
        contextInfo: {
          stanzaId: 'Q4',
          quotedMessage: { pollCreationMessageV3: { name: '¿Cenamos?' } },
        },
      },
    })?.preview?.text,
    '📊 ¿Cenamos?'
  );
  assert.equal(
    quotedReply({ reactionMessage: { text: '👍', key: { id: 'T' } } } as any),
    null
  );
  assert.equal(quotedReply({ conversation: 'plain' }), null);
  assert.equal(
    quotedReply({ extendedTextMessage: { text: 'fwd', contextInfo: { isForwarded: true } } }),
    null
  );
});

test('linksSenderToChat and the official WhatsApp jid', () => {
  assert.equal(linksSenderToChat({ isGroup: false, fromMe: true }), false);
  assert.equal(linksSenderToChat({ isGroup: false, fromMe: false }), true);
  assert.equal(linksSenderToChat({ isGroup: true, fromMe: true }), true);
  assert.equal(linksSenderToChat({ isGroup: false, fromMe: true, chatJid: '2222@lid' }), false);
  assert.equal(
    linksSenderToChat({ isGroup: false, fromMe: true, chatJid: '34600@s.whatsapp.net' }),
    false
  );
  assert.equal(
    linksSenderToChat({ isGroup: false, fromMe: true, chatJid: 'status@broadcast' }),
    true
  );
  assert.equal(linksSenderToChat({ isGroup: false, fromMe: true, chatJid: '1@newsletter' }), true);
  assert.ok(isOfficialWhatsAppJid('0@s.whatsapp.net'));
  assert.ok(isOfficialWhatsAppJid('professional:0@c.us'));
  assert.ok(!isOfficialWhatsAppJid('10@s.whatsapp.net'));
  assert.ok(!isOfficialWhatsAppJid('0-123@g.us'));
});

test('isUnavailableProfilePicture: 401 not-authorized (Boom 500 data 401), 403, 404; not others', () => {
  assert.ok(isUnavailableProfilePicture(new Boom('not-authorized', { data: 401 })));
  assert.ok(isUnavailableProfilePicture(new Boom('item-not-found', { data: 404 })));
  assert.ok(isUnavailableProfilePicture(new Boom('x', { statusCode: 403 })));
  assert.ok(!isUnavailableProfilePicture(new Boom('internal-server-error', { data: 500 })));
  assert.ok(!isUnavailableProfilePicture(new Boom('Timed Out', { statusCode: 408 })));
  assert.ok(!isUnavailableProfilePicture(new Error('not-authorized')));
});

test('media request hash: fileName only when set (old keys replay the same send)', () => {
  const base = {
    conversationId: 'c',
    fileUrl: 'u',
    caption: 'x',
    asSticker: false,
  };
  assert.equal(mediaRequestHash(base), mediaRequestHash({ ...base, fileName: undefined }));
  assert.notEqual(mediaRequestHash(base), mediaRequestHash({ ...base, fileName: 'a.pdf' }));
});

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

test('our own media send (append upsert) is stored like live media; history and old appends are not', async () => {
  const { calls, restore } = stubPool(route);
  try {
    const { handlers, media } = makeClient();
    await handlers['messages.upsert']({ type: 'append', messages: [waMessage()] });
    assert.deepEqual(media, [{ id: 'M1', type: 'IMAGE' }]);
    assert.ok(calls.some(c => isMessageInsert(c.sql)));

    media.length = 0;
    await handlers['messages.upsert']({
      type: 'append',
      messages: [
        waMessage({
          key: { remoteJid: '2222@lid', id: 'OLD', fromMe: true },
          messageTimestamp: Math.floor(Date.now() / 1000) - 3 * 86400,
        }),
      ],
    });
    assert.deepEqual(media, [], 'a stale append is history');

    await handlers['messaging-history.set']({
      chats: [],
      messages: [waMessage({ key: { remoteJid: '2222@lid', id: 'H1', fromMe: true } })],
      isLatest: false,
    });
    assert.deepEqual(media, [], 'history sync never downloads');

    await handlers['messages.upsert']({
      type: 'notify',
      messages: [
        waMessage({
          key: { remoteJid: '2222@lid', id: 'IN1', fromMe: false },
          message: { documentMessage: { fileName: 'a.pdf', mimetype: 'application/pdf' } },
        }),
      ],
    });
    assert.deepEqual(media, [{ id: 'IN1', type: 'DOCUMENT' }], 'live inbound as before');
  } finally {
    restore();
  }
});

test('a 1:1 chat links only the other side; a group links us too', async () => {
  const { calls, restore } = stubPool(route);
  try {
    const { client } = makeClient();
    await priv(client).ingestMessage(
      waMessage({ message: { conversation: 'hola' } }),
      { source: 'live', publishEvent: false }
    );
    assert.equal(calls.filter(c => isLink(c.sql)).length, 0, 'own send in a 1:1: no link');

    calls.length = 0;
    await priv(client).ingestMessage(
      waMessage({
        key: { remoteJid: '2222@lid', id: 'M2', fromMe: false },
        message: { conversation: 'hola' },
        pushName: 'Ana',
      }),
      { source: 'live', publishEvent: false }
    );
    const [inbound] = calls.filter(c => isLink(c.sql));
    assert.deepEqual(inbound.params, ['professional:2222@lid', 'professional:2222@lid']);

    calls.length = 0;
    await priv(client).ingestMessage(
      waMessage({
        key: { remoteJid: '1203@g.us', id: 'M3', fromMe: true },
        message: { conversation: 'hola grupo' },
      }),
      { source: 'live', publishEvent: false }
    );
    const [group] = calls.filter(c => isLink(c.sql));
    assert.deepEqual(group.params, ['professional:1203@g.us', 'professional:34999@c.us']);
  } finally {
    restore();
  }
});

test('a reply stores its quote: preview, type, author id and name ("Tú" for us, DB name otherwise)', async () => {
  const { calls, restore } = stubPool((sql, params) => {
    if (/FROM participants/i.test(sql) && params[0] === 'professional:2222@lid')
      return [{ name: 'Daniel' }];
    return route(sql);
  });
  try {
    const { client } = makeClient();
    await priv(client).ingestMessage(
      waMessage({
        key: { remoteJid: '2222@lid', id: 'R1', fromMe: true },
        message: {
          extendedTextMessage: {
            text: 'respuesta',
            contextInfo: {
              stanzaId: 'Q1',
              participant: '2222@lid',
              quotedMessage: { conversation: 'pregunta' },
            },
          },
        },
      }),
      { source: 'live', publishEvent: false }
    );
    const insert = calls.find(c => isMessageInsert(c.sql))!;
    assert.equal(insert.params[8], 'professional:Q1', 'reply_to_message_id as before');
    const meta = storedMetadata(calls);
    assert.equal(meta.reply_preview, 'pregunta');
    assert.equal(meta.reply_type, 'TEXT');
    assert.equal(meta.reply_from_id, 'professional:2222@lid');
    assert.equal(meta.reply_from, 'Daniel');

    calls.length = 0;
    await priv(client).ingestMessage(
      waMessage({
        key: { remoteJid: '2222@lid', id: 'R2', fromMe: false },
        message: {
          imageMessage: {
            caption: 'mira',
            contextInfo: {
              stanzaId: 'Q2',
              participant: ME_PN,
              quotedMessage: { stickerMessage: {} },
            },
          },
        },
      }),
      { source: 'live', publishEvent: false }
    );
    const insert2 = calls.find(c => isMessageInsert(c.sql))!;
    assert.equal(insert2.params[8], 'professional:Q2', 'a media reply keeps its quoted id now');
    const meta2 = storedMetadata(calls);
    assert.equal(meta2.reply_preview, '🏷️ Sticker');
    assert.equal(meta2.reply_from, 'Tú');
    assert.equal(meta2.reply_from_id, 'professional:34999@c.us');

    calls.length = 0;
    await priv(client).ingestMessage(waMessage({ key: { remoteJid: '2222@lid', id: 'P1' }, message: { conversation: 'no reply' } }), {
      source: 'live',
      publishEvent: false,
    });
    assert.equal(storedMetadata(calls).reply_preview, undefined);
  } finally {
    restore();
  }
});

test('WhatsApp own account 0@s.whatsapp.net is named "WhatsApp"', async () => {
  const { calls, restore } = stubPool(route);
  try {
    const { client } = makeClient();
    await priv(client).ingestMessage(
      waMessage({
        key: { remoteJid: '0@s.whatsapp.net', id: 'W1', fromMe: false },
        message: { conversation: 'Te damos la bienvenida' },
      }),
      { source: 'baileys_history_sync', publishEvent: false }
    );
    const conv = calls.find(c => /INSERT INTO conversations/i.test(c.sql))!;
    assert.equal(conv.params[1], 'WhatsApp');
    const part = calls.find(c => /INSERT INTO participants/i.test(c.sql))!;
    assert.equal(part.params[2], 'WhatsApp');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// HTTP: media send fileName and the profile picture 404
// ---------------------------------------------------------------------------

async function withServer(
  client: BaileysClient,
  fn: (base: string) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(client, { getCurrentQR: () => null } as never, 'secret'));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function signed(body: unknown): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    'content-type': 'application/json',
    'x-connector-timestamp': String(ts),
    'x-connector-signature': generateHMACSignature(body, ts, 'secret'),
  };
}

test('POST /messages/media/send: fileName names the document; a non-string is 400', async () => {
  const saved = { send: process.env.ENABLE_SENDING, fetch: globalThis.fetch };
  process.env.ENABLE_SENDING = 'true';
  const { restore } = stubPool(route);
  try {
    const { client, sent } = makeClient();
    await withServer(client, async base => {
      const realFetch = saved.fetch;
      globalThis.fetch = (async (url: any, init?: any) => {
        if (String(url).startsWith('http://minio')) {
          return new Response(Buffer.from('%PDF-1.4'), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          });
        }
        return realFetch(url, init);
      }) as typeof fetch;
      const fileUrl = 'http://minio/b/outgoing/ab12.pdf?X-Amz-Signature=zz';
      const body = { conversationId: '2222@lid', fileUrl, caption: 'doc', fileName: 'qa-doc.pdf' };
      const ok = await realFetch(`${base}/messages/media/send`, {
        method: 'POST',
        headers: signed(body),
        body: JSON.stringify(body),
      });
      assert.equal(ok.status, 200, await ok.clone().text());
      assert.equal(sent[0].content.fileName, 'qa-doc.pdf');

      const plain = { conversationId: '2222@lid', fileUrl };
      await realFetch(`${base}/messages/media/send`, {
        method: 'POST',
        headers: signed(plain),
        body: JSON.stringify(plain),
      });
      assert.equal(sent[1].content.fileName, 'ab12.pdf', 'no presigned query in the name');

      const bad = { conversationId: '2222@lid', fileUrl, fileName: 7 };
      const refused = await realFetch(`${base}/messages/media/send`, {
        method: 'POST',
        headers: signed(bad),
        body: JSON.stringify(bad),
      });
      assert.equal(refused.status, 400);
      assert.equal((await refused.json()).failureClass, 'invalid_file_name');
      assert.equal(sent.length, 2, 'nothing sent for the 400');
    });
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.send === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = saved.send;
    restore();
  }
});

// SKIRM-129 (F4d). Scenarios adapted from the NAS fork's media-send.test.ts (Jordi Ibáñez); the fork
// drives BaileysClient.sendFile, these go through the route. `data:` URLs need no fetch stub.
async function postMedia(body: Record<string, unknown>) {
  const saved = process.env.ENABLE_SENDING;
  process.env.ENABLE_SENDING = 'true';
  const { restore } = stubPool(route);
  try {
    const { client, sent } = makeClient();
    let status = 0;
    let json: any;
    await withServer(client, async base => {
      const res = await fetch(`${base}/messages/media/send`, {
        method: 'POST',
        headers: signed(body),
        body: JSON.stringify(body),
      });
      status = res.status;
      json = await res.json();
    });
    return { status, json, sent };
  } finally {
    if (saved === undefined) delete process.env.ENABLE_SENDING;
    else process.env.ENABLE_SENDING = saved;
    restore();
  }
}

test('POST /messages/media/send: an image, video, audio and document keep their payload and answer {sent, sentAt}', async () => {
  const cases: Array<[string, string, string]> = [
    ['data:image/png;base64,YQ==', 'image', 'photo'],
    ['data:video/mp4;base64,YQ==', 'video', 'clip'],
    ['data:audio/ogg;base64,YQ==', 'audio', ''],
    ['data:application/pdf;base64,YQ==', 'document', 'doc'],
  ];
  for (const [fileUrl, key, caption] of cases) {
    const { status, json, sent } = await postMedia({
      conversationId: '2222@lid',
      fileUrl,
      caption,
    });
    assert.equal(status, 200, key);
    assert.deepEqual(
      Object.keys(json).sort(),
      ['sent', 'sentAt'],
      `${key}: no messageId without an Idempotency-Key`
    );
    assert.equal(json.sent, true);
    assert.ok(key in sent[0].content, `${key} payload`);
  }
});

test('POST /messages/media/send: a document name is its last path segment, never glued across directories', async () => {
  const named = await postMedia({
    conversationId: '2222@lid',
    fileUrl: 'data:application/pdf;base64,YQ==',
    fileName: '../report\n.pdf',
  });
  assert.equal(named.sent[0].content.fileName, 'report.pdf');
  const unnamed = await postMedia({
    conversationId: '2222@lid',
    fileUrl: 'data:application/pdf;base64,YQ==',
  });
  assert.equal(
    unnamed.sent[0].content.fileName,
    'attachment',
    'a data: URL has no name of its own'
  );
});

test('GET /chats/:jid/photo: a picture hidden by privacy (not-authorized) is 404 No photo', async () => {
  const { restore } = stubPool(route);
  try {
    const { client } = makeClient();
    priv(client).sock.profilePictureUrl = async () => {
      throw new Boom('not-authorized', { data: 401 });
    };
    await withServer(client, async base => {
      const r = await fetch(`${base}/chats/${encodeURIComponent('2222@lid')}/photo`, {
        headers: signed({}),
      });
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: 'No photo' });
    });
    priv(client).sock.profilePictureUrl = async () => {
      throw new Boom('internal-server-error', { data: 500 });
    };
    await withServer(client, async base => {
      const r = await fetch(`${base}/chats/${encodeURIComponent('2222@lid')}/photo`, {
        headers: signed({}),
      });
      assert.equal(r.status, 500, 'a real failure is still not "no photo"');
    });
  } finally {
    restore();
  }
});
