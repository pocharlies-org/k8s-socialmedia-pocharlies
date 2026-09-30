/**
 * Stickers and GIFs (fase 3 / PR-9): a sticker is a WebP (static or
 * animated), a GIF is an MP4 sent with gifPlayback; nothing is converted, a
 * wrong type or size is 400 before the socket and before the idempotency
 * claim; they go to the chat's canonical jid; the HTTP surface (signed body,
 * sending gate, Idempotency-Key).
 *
 * Ported and adapted from the NAS fork's gif-send.test.ts ("rejects raw GIF
 * uploads with an HTTP failure before calling Baileys", "sends transcoded MP4
 * as a GIF playback payload"). No socket and no DB (pg.Pool#query stubbed).
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
import { BaileysClient, BaileysClientOptions } from './baileys-client';
import {
  fetchLimited,
  GIF_MAX_BYTES,
  isAnimatedWebp,
  parseStickerGifRequest,
  STICKER_MAX_BYTES,
  stickerGifContent,
} from './sticker-gif';
import { MessageMutationError } from './message-mutations';
import { resetChatStateForTests } from './chat-state';
import { resetDurableStoreStateForTests } from './durable-message-store';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

function stubPool(route: (sql: string, params: unknown[]) => Record<string, unknown>[] = () => []): {
  calls: Array<{ sql: string; params: unknown[] }>;
  restore: () => void;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    const rows = route(sql, params);
    return Promise.resolve({ rows, rowCount: rows.length });
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
}

const LID = '111@lid';
const PN_CUS = '34611111111@c.us';

function webp(animated = false): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(24, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write(animated ? 'VP8X' : 'VP8 ', 12, 'ascii');
  if (animated) bytes[20] = 0x02;
  return bytes;
}

function mp4(): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write('mp42', 8, 'ascii');
  return bytes;
}

const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const dataUrl = (mime: string, bytes: Buffer): string => `data:${mime};base64,${bytes.toString('base64')}`;

// ---------------------------------------------------------------------------
// Inputs and bytes
// ---------------------------------------------------------------------------

test('request: ids and fileUrl required; a data: URL of the wrong type is 400 before the gate', () => {
  assert.deepEqual(parseStickerGifRequest('sticker', { conversationId: LID, fileUrl: 'https://x/s.webp' }), {
    conversationId: LID,
    fileUrl: 'https://x/s.webp',
  });
  assert.deepEqual(
    parseStickerGifRequest('gif', { chatId: LID, fileUrl: dataUrl('video/mp4', mp4()), caption: ' jaja ', replyTo: 'Q1' }),
    { conversationId: LID, fileUrl: dataUrl('video/mp4', mp4()), caption: 'jaja', replyToMessageId: 'Q1' }
  );
  const cases: Array<[Parameters<typeof parseStickerGifRequest>[0], Record<string, unknown>, string | undefined]> = [
    ['sticker', { fileUrl: 'https://x/s.webp' }, undefined],
    ['sticker', { conversationId: LID }, undefined],
    ['sticker', { conversationId: LID, fileUrl: 'file:///etc/passwd' }, undefined],
    ['sticker', { conversationId: LID, fileUrl: dataUrl('image/png', PNG) }, 'sticker_not_webp'],
    ['sticker', { conversationId: LID, fileUrl: 'https://x/s.webp', caption: 'no' }, undefined],
    ['sticker', { conversationId: LID, fileUrl: 'https://x/s.webp', viewOnce: true }, undefined],
    ['gif', { conversationId: LID, fileUrl: dataUrl('image/gif', GIF) }, 'gif_not_mp4'],
    ['gif', { conversationId: LID, fileUrl: dataUrl('video/webm', mp4()) }, 'gif_not_mp4'],
    ['gif', { conversationId: LID, fileUrl: 'https://x/a.mp4', caption: 5 }, undefined],
    ['gif', { conversationId: LID, fileUrl: 'https://x/a.mp4', caption: 'x'.repeat(1025) }, undefined],
  ];
  for (const [kind, body, code] of cases) {
    assert.throws(
      () => parseStickerGifRequest(kind, body),
      (e: unknown) =>
        e instanceof MessageMutationError && e.status === 400 && e.failureClass === 'invalid_request' && e.code === code,
      `${kind} ${JSON.stringify(body).slice(0, 80)}`
    );
  }
});

test('bytes: WebP sticker (static / animated), MP4 GIF with gifPlayback; magic and size decide', () => {
  assert.deepEqual(stickerGifContent('sticker', webp(), 'image/webp'), {
    sticker: webp(),
    mimetype: 'image/webp',
    isAnimated: false,
  });
  assert.equal(isAnimatedWebp(webp(true)), true);
  assert.equal(
    (stickerGifContent('sticker', webp(true), 'application/octet-stream') as { isAnimated: boolean }).isAnimated,
    true,
    'object stores answer octet-stream: the magic decides'
  );
  assert.deepEqual(stickerGifContent('gif', mp4(), 'video/mp4', 'jaja'), {
    video: mp4(),
    mimetype: 'video/mp4',
    gifPlayback: true,
    caption: 'jaja',
  });
  const refused: Array<[Parameters<typeof stickerGifContent>[0], Buffer, string, string]> = [
    ['sticker', PNG, 'image/png', 'sticker_not_webp'],
    ['sticker', PNG, 'image/webp', 'sticker_not_webp'],
    ['sticker', Buffer.alloc(0), 'image/webp', undefined as unknown as string],
    ['sticker', Buffer.concat([webp(), Buffer.alloc(STICKER_MAX_BYTES)]), 'image/webp', 'sticker_too_large'],
    ['gif', GIF, 'image/gif', 'gif_not_mp4'],
    ['gif', GIF, 'video/mp4', 'gif_not_mp4'],
    ['gif', mp4(), 'image/gif', 'gif_not_mp4'],
    ['gif', webp(), 'video/mp4', 'gif_not_mp4'],
    ['gif', Buffer.concat([mp4(), Buffer.alloc(GIF_MAX_BYTES)]), 'video/mp4', 'gif_too_large'],
  ];
  for (const [kind, bytes, type, code] of refused) {
    assert.throws(
      () => stickerGifContent(kind, bytes, type),
      (e: unknown) => e instanceof MessageMutationError && e.status === 400 && e.code === code,
      `${kind} ${type} ${bytes.length}`
    );
  }
});

test('fetch: the ceiling holds while streaming and against Content-Length; a bad URL is 400', async () => {
  const big = Buffer.alloc(2048, 1);
  const streamed = (async () => new Response(new Blob([big]).stream())) as unknown as typeof fetch;
  await assert.rejects(fetchLimited('https://x/big', 1024, streamed), (e: unknown) =>
    e instanceof MessageMutationError && e.code === 'file_too_large'
  );
  const declared = (async () =>
    new Response('x', { headers: { 'content-length': '999999' } })) as unknown as typeof fetch;
  await assert.rejects(fetchLimited('https://x/big', 1024, declared), (e: unknown) =>
    e instanceof MessageMutationError && e.code === 'file_too_large'
  );
  const missing = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(fetchLimited('https://x/404', 1024, missing), (e: unknown) =>
    e instanceof MessageMutationError && e.status === 400 && e.code === 'file_unavailable'
  );
  const ok = await fetchLimited(dataUrl('image/webp', webp()), 1024);
  assert.deepEqual(ok.bytes, webp());
  assert.equal(ok.contentType, 'image/webp');
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function makeClient(options: BaileysClientOptions = {}): {
  client: BaileysClient;
  sent: Array<[string, Record<string, unknown>, unknown]>;
} {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const sent: Array<[string, Record<string, unknown>, unknown]> = [];
  const internals = client as unknown as { sock: unknown; ready: boolean };
  internals.sock = {
    ev: { on: () => {} },
    user: { id: '34600111222:5@s.whatsapp.net' },
    sendMessage: async (jid: string, content: Record<string, unknown>, opts: unknown) => {
      sent.push([jid, content, opts]);
      return { key: { id: 'ST1', remoteJid: jid, fromMe: true }, message: {} };
    },
    end: () => {},
  };
  internals.ready = true;
  return { client, sent };
}

test('client: a sticker goes to the canonical jid (merged phone chat → its LID) as a WebP payload', async () => {
  useAccount('professional');
  const { restore } = stubPool((sql, params) =>
    /WITH RECURSIVE hop/.test(sql) && (params[1] as string[]).includes(PN_CUS)
      ? [{ id: `professional:${LID}`, external_id: LID }]
      : []
  );
  const { client, sent } = makeClient();
  try {
    let claimed = 0;
    const result = await client.sendStickerOrGif(
      'sticker',
      { conversationId: `professional:${PN_CUS}`, fileUrl: dataUrl('image/webp', webp(true)) },
      { messageId: 'IDEMP1', beforeSend: async () => void claimed++ }
    );
    assert.equal(claimed, 1);
    assert.equal(result.kind, 'sticker');
    assert.equal(result.animated, true);
    assert.equal(result.conversationId, LID);
    assert.equal(sent[0][0], LID);
    assert.deepEqual(sent[0][1], { sticker: webp(true), mimetype: 'image/webp', isAnimated: true });
    assert.deepEqual(sent[0][2], { messageId: 'IDEMP1' });
  } finally {
    restore();
  }
});

test('client: an MP4 goes as a GIF (gifPlayback); a refused file never reaches the claim nor the socket', async () => {
  useAccount('personal');
  const { restore } = stubPool();
  const { client, sent } = makeClient();
  try {
    await client.sendStickerOrGif('gif', { conversationId: LID, fileUrl: dataUrl('video/mp4', mp4()), caption: 'jaja' });
    assert.deepEqual(sent[0][1], { video: mp4(), mimetype: 'video/mp4', gifPlayback: true, caption: 'jaja' });
    let claimed = 0;
    await assert.rejects(
      client.sendStickerOrGif(
        'sticker',
        { conversationId: LID, fileUrl: dataUrl('application/octet-stream', PNG) },
        { beforeSend: async () => void claimed++ }
      ),
      (e: unknown) => e instanceof MessageMutationError && e.code === 'sticker_not_webp'
    );
    assert.equal(claimed, 0);
    assert.equal(sent.length, 1);
  } finally {
    restore();
  }
});

test('client with ingest off: sends, the DB never touched', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool();
  const { client, sent } = makeClient({ ingest: false });
  try {
    await client.sendStickerOrGif('sticker', { conversationId: LID, fileUrl: dataUrl('image/webp', webp()) });
    assert.equal(sent.length, 1);
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function withRouter(
  client: Partial<BaileysClient>,
  env: Record<string, string | undefined>,
  run: (call: (path: string, body: unknown, headers?: Record<string, string>) => Promise<globalThis.Response>) => Promise<void>
): Promise<void> {
  const secret = 'gif-send-test-secret';
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/v1', createRouter(client as BaileysClient, { getCurrentQR: () => null } as never, secret));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await run((path, body, headers = {}) => {
      const ts = Math.floor(Date.now() / 1000);
      return fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-connector-timestamp': String(ts),
          'x-connector-signature': generateHMACSignature(body, ts, secret),
          ...headers,
        },
        body: JSON.stringify(body),
      });
    });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
}

const ON = { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: undefined };

test('HTTP: a raw GIF is refused 400 before Baileys (fork gif-send.test), the gate is 403, offline 503', async () => {
  useAccount('personal');
  const { restore } = stubPool();
  const { client, sent } = makeClient();
  try {
    await withRouter(client, ON, async call => {
      const raw = await call('/messages/gif', { conversationId: LID, fileUrl: dataUrl('image/gif', GIF) });
      assert.equal(raw.status, 400);
      assert.deepEqual(await raw.json(), {
        error:
          'Animated GIFs must be transcoded to MP4 before sending; the connector does not transcode GIF files',
        failureClass: 'invalid_request',
        code: 'gif_not_mp4',
      });
      // http(s) URL: the type shows after the fetch, still before the socket.
      const png = await call('/messages/sticker', { conversationId: LID, fileUrl: dataUrl('image/webp', PNG) });
      assert.equal(png.status, 400);
      const ok = await call('/messages/sticker', { conversationId: LID, fileUrl: dataUrl('image/webp', webp()) });
      assert.equal(ok.status, 200);
      const answer = (await ok.json()) as Record<string, unknown>;
      assert.equal(answer.sent, true);
      assert.equal(answer.kind, 'sticker');
      assert.equal(answer.messageId, 'ST1');
    });
    for (const env of [
      { ENABLE_SENDING: 'false', EMERGENCY_DISABLE_SENDING: undefined },
      { ENABLE_SENDING: 'true', EMERGENCY_DISABLE_SENDING: 'true' },
    ]) {
      await withRouter(client, env, async call => {
        for (const path of ['/messages/sticker', '/messages/gif']) {
          const res = await call(path, {
            conversationId: LID,
            fileUrl: dataUrl(path.endsWith('gif') ? 'video/mp4' : 'image/webp', path.endsWith('gif') ? mp4() : webp()),
          });
          assert.equal(res.status, 403, path);
          assert.equal(((await res.json()) as { failureClass: string }).failureClass, 'disabled_sending');
        }
      });
    }
    assert.equal(sent.length, 1);
  } finally {
    restore();
  }
  const offline = { isConnected: () => false, getCachedState: () => 'CLOSED', isIngestEnabled: () => true };
  await withRouter(offline as never, ON, async call => {
    const res = await call('/messages/gif', { conversationId: LID, fileUrl: dataUrl('video/mp4', mp4()) });
    assert.equal(res.status, 503);
  });
});

test('HTTP: opt-in Idempotency-Key on a sticker: claimed before the send, replay deduplicated', async () => {
  useAccount('personal');
  const attempts = new Map<string, { request_hash: string; message_id: string; status: string }>();
  const { restore } = stubPool((sql, params) => {
    const key = `${params[0]}:${params[1]}`;
    if (/INSERT INTO whatsapp_send_attempts/.test(sql)) {
      if (attempts.has(key)) return [];
      attempts.set(key, { request_hash: String(params[2]), message_id: String(params[3]), status: 'prepared' });
      return [{ message_id: params[3] }];
    }
    const row = attempts.get(key);
    if (/SELECT request_hash/.test(sql)) return row ? [{ ...row, updated_at: new Date(5) }] : [];
    if (/SET status = 'pending'/.test(sql) && row?.status === 'prepared') {
      row.status = 'pending';
      return [{ message_id: row.message_id }];
    }
    if (/SET status = 'sent'/.test(sql) && row?.status === 'pending') {
      row.status = 'sent';
      return [{ updated_at: new Date(5) }];
    }
    return [];
  });
  const { client, sent } = makeClient();
  // The fake sock echoes the reserved id, like Baileys with `messageId`.
  const internals = client as unknown as { sock: { sendMessage: unknown } };
  internals.sock.sendMessage = async (jid: string, content: Record<string, unknown>, opts: { messageId?: string }) => {
    sent.push([jid, content, opts]);
    return { key: { id: opts?.messageId || 'ST1', remoteJid: jid, fromMe: true }, message: {} };
  };
  try {
    await withRouter(client, ON, async call => {
      const body = { conversationId: LID, fileUrl: dataUrl('image/webp', webp()) };
      const headers = { 'idempotency-key': 'sticker-1' };
      const first = (await (await call('/messages/sticker', body, headers)).json()) as Record<string, unknown>;
      assert.match(String(first.messageId), /^3EB0[0-9A-F]{18}$/);
      assert.equal(first.sentAt, new Date(5).toISOString());
      const replay = (await (await call('/messages/sticker', body, headers)).json()) as Record<string, unknown>;
      assert.equal(replay.deduplicated, true);
      assert.equal(replay.messageId, first.messageId);
      const asGif = await call('/messages/gif', { conversationId: LID, fileUrl: dataUrl('video/mp4', mp4()) }, headers);
      assert.equal(asGif.status, 409, 'same key, other request');
    });
    assert.equal(sent.length, 1);
  } finally {
    restore();
  }
});
