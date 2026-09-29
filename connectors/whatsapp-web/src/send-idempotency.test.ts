/**
 * Opt-in send idempotency (fase 3 / PR-2) — the store, the three send routes
 * and the BaileysClient hooks.
 *
 * Ported from the NAS fork's send-idempotency.test.ts and adapted to prod: the
 * key is an explicit Idempotency-Key (header or body field), NEVER sendToken —
 * prod callers reuse a constant one — so the no-key path must stay exactly as
 * it was. The table comes from mcp-server migration 010 (no runtime DDL) and a
 * missing table fails soft. No real DB: pg.Pool#query is stubbed with an
 * in-memory whatsapp_send_attempts.
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
import { BaileysClient } from './baileys-client';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';
import {
  claimSendAttempt,
  confirmSend,
  idempotencyKeyHash,
  idempotentMessageId,
  mediaRequestHash,
  readIdempotencyKey,
  recordSendFailure,
  reserveSend,
  resetSendIdempotencyStateForTests,
  SendAlreadyClaimedError,
  textRequestHash,
  voiceRequestHash,
} from './send-idempotency';

process.env.WA_SEND_ERROR_ACK_WAIT_MS = '0';
process.env.WA_DIRECT_PRIVACY_PREFLIGHT = 'false';

const SECRET = 'idem-secret';

interface QueryCall {
  sql: string;
  params: unknown[];
}

interface AttemptRow {
  account: string;
  key_hash: string;
  request_hash: string;
  message_id: string | null;
  status: 'prepared' | 'pending' | 'sent' | 'failed';
  error: string | null;
  updated_at: Date;
}

/**
 * In-memory whatsapp_send_attempts behind a stubbed pg.Pool#query. Every call
 * is captured; `missing` answers 42P01 like a DB without migration 010.
 */
function stubAttempts(options: { missing?: boolean } = {}): {
  calls: QueryCall[];
  rows: Map<string, AttemptRow>;
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const rows = new Map<string, AttemptRow>();
  let tick = Date.parse('2026-09-29T10:00:00.000Z');
  const now = (): Date => new Date((tick += 1000));
  const original = pg.Pool.prototype.query;
  const respond = async (sql: string, params: any[]) => {
    calls.push({ sql, params });
    if (!/whatsapp_send_attempts/.test(sql)) return { rows: [], rowCount: 0 };
    if (options.missing) {
      throw Object.assign(new Error('relation "whatsapp_send_attempts" does not exist'), {
        code: '42P01',
      });
    }
    const id = `${params[0]}|${params[1]}`;
    const row = rows.get(id);
    const done = (list: unknown[]) => ({ rows: list, rowCount: list.length });
    if (/INSERT INTO whatsapp_send_attempts/.test(sql)) {
      if (row) return done([]);
      rows.set(id, {
        account: params[0],
        key_hash: params[1],
        request_hash: params[2],
        message_id: params[3],
        status: 'prepared',
        error: null,
        updated_at: now(),
      });
      return done([{ message_id: params[3] }]);
    }
    if (/SELECT request_hash/.test(sql)) return done(row ? [{ ...row }] : []);
    if (/SET status = 'pending'/.test(sql)) {
      if (!row || row.request_hash !== params[2] || !['prepared', 'failed'].includes(row.status)) {
        return done([]);
      }
      Object.assign(row, { status: 'pending', error: null, updated_at: now() });
      return done([{ message_id: row.message_id }]);
    }
    if (/SET status = 'sent'/.test(sql)) {
      if (!row || row.status !== 'pending') return done([]);
      Object.assign(row, {
        status: 'sent',
        message_id: params[2] ?? row.message_id,
        error: null,
        updated_at: now(),
      });
      return done([{ updated_at: row.updated_at }]);
    }
    if (/SET status = 'failed'/.test(sql)) {
      if (!row || row.status !== 'prepared') return done([]);
      Object.assign(row, { status: 'failed', error: params[2], updated_at: now() });
      return done([]);
    }
    if (/SET error = \$3/.test(sql)) {
      if (!row || row.status !== 'pending') return done([]);
      Object.assign(row, { error: params[2], updated_at: now() });
      return done([]);
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    return respond(sql, params as any[]);
  };
  return {
    calls,
    rows,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg.Pool.prototype as any).query = original;
    },
  };
}

function setEnv(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

/** Account + sending on, idempotency state reset; returns the undo. */
function useAccount(account: string): () => void {
  const undo = [setEnv('CONNECTOR_ACCOUNT', account), setEnv('ENABLE_SENDING', 'true')];
  resetSendIdempotencyStateForTests();
  return () => undo.reverse().forEach(fn => fn());
}

interface FakeCalls {
  text: Array<{ chat: string; text: string; options: any }>;
  media: Array<{ chat: string; url: string; caption?: string; options: any }>;
  voice: Array<{ chat: string; mime: string; options: any; argc: number }>;
}

/**
 * A client whose sends behave by content: `preflight-fail` throws before the
 * claim (nothing reached WhatsApp), `timeout` throws after it (outcome unknown).
 */
function fakeClient(options: { ingest?: boolean } = {}): { client: any; calls: FakeCalls } {
  const calls: FakeCalls = { text: [], media: [], voice: [] };
  let n = 0;
  const outcome = async (marker: string, opts: any): Promise<void> => {
    if (marker.includes('preflight-fail')) throw new Error('group metadata unavailable');
    await opts?.beforeSend?.();
    if (marker.includes('timeout')) throw new Error('sendMessage timeout after 45000ms');
  };
  const client = {
    isConnected: () => true,
    getCachedState: () => 'open',
    isIngestEnabled: () => options.ingest !== false,
    sendMessage: async (chat: string, text: string, opts: any) => {
      calls.text.push({ chat, text, options: opts });
      await outcome(text, opts);
      return opts?.messageId || `LEGACY${++n}`;
    },
    sendFile: async (chat: string, url: string, caption: string | undefined, opts: any) => {
      calls.media.push({ chat, url, caption, options: opts });
      await outcome(url, opts);
      return opts?.messageId || `MEDIA${++n}`;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    sendVoice: async function (chat: string, _audio: Buffer, mime: string, opts?: any) {
      calls.voice.push({ chat, mime, options: opts, argc: arguments.length });
      await outcome(_audio.toString(), opts);
      return opts?.messageId || `VOICE${++n}`;
    },
  };
  return { client, calls };
}

async function withRouter(
  client: unknown,
  run: (
    post: (
      path: string,
      body: Record<string, unknown>,
      headers?: Record<string, string>
    ) => Promise<{
      status: number;
      body: any;
    }>
  ) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createRouter(client as BaileysClient, { getCurrentQR: () => null } as any, SECRET)
  );
  const server = await new Promise<Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const post = async (
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {}
  ) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(timestamp),
        'x-connector-signature': generateHMACSignature(body, timestamp, SECRET),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await run(post);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
}

const CHAT = '34600000000@s.whatsapp.net';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const attemptQueries = (calls: QueryCall[]) =>
  calls.filter(c => /whatsapp_send_attempts/.test(c.sql));

// ---------------------------------------------------------------------------
// Key parsing, ids, hashes
// ---------------------------------------------------------------------------

test('readIdempotencyKey: header or body field, opt-in, validated', () => {
  assert.deepEqual(readIdempotencyKey({}, { sendToken: 'synapse-messaging' }), {});
  assert.deepEqual(readIdempotencyKey({ 'idempotency-key': '   ' }, {}), {});
  assert.deepEqual(readIdempotencyKey({}, { idempotencyKey: '' }), {});
  assert.deepEqual(readIdempotencyKey({}, { idempotencyKey: null }), {});
  assert.deepEqual(readIdempotencyKey({ 'idempotency-key': ' k1 ' }, {}), { key: 'k1' });
  assert.deepEqual(readIdempotencyKey({}, { idempotencyKey: 'k2' }), { key: 'k2' });
  assert.deepEqual(readIdempotencyKey({ 'idempotency-key': 'k3' }, { idempotencyKey: 'k3' }), {
    key: 'k3',
  });
  assert.match(
    readIdempotencyKey({ 'idempotency-key': 'a' }, { idempotencyKey: 'b' }).error || '',
    /differ/
  );
  assert.match(readIdempotencyKey({ 'idempotency-key': ['a', 'b'] }, {}).error || '', /single/);
  assert.match(readIdempotencyKey({}, { idempotencyKey: 42 }).error || '', /string/);
  assert.match(readIdempotencyKey({ 'idempotency-key': 'x'.repeat(201) }, {}).error || '', /200/);
  assert.deepEqual(readIdempotencyKey({ 'idempotency-key': 'x'.repeat(200) }, {}), {
    key: 'x'.repeat(200),
  });
});

test('message id is Baileys-shaped and deterministic per (account, key)', () => {
  const id = idempotentMessageId('op-1', 'personal');
  assert.match(id, /^3EB0[0-9A-F]{18}$/);
  assert.equal(idempotentMessageId('op-1', 'personal'), id);
  assert.notEqual(idempotentMessageId('op-1', 'professional'), id);
  assert.notEqual(idempotentMessageId('op-2', 'personal'), id);
  assert.equal(idempotencyKeyHash('op-1').length, 64);
  assert.notEqual(idempotencyKeyHash('op-1'), 'op-1');
});

test('request hashes change with every field that makes a different message', () => {
  const text = { conversationId: CHAT, content: 'hola' };
  const base = textRequestHash(text);
  assert.equal(textRequestHash({ ...text }), base);
  for (const change of [
    { content: 'adios' },
    { conversationId: 'x@g.us' },
    { replyToMessageId: 'Q' },
  ]) {
    assert.notEqual(textRequestHash({ ...text, ...change }), base);
  }
  const media = {
    conversationId: CHAT,
    fileUrl: 'https://f/a.jpg',
    caption: 'c',
    asSticker: false,
  };
  const mediaBase = mediaRequestHash(media);
  for (const change of [
    { fileUrl: 'https://f/b.jpg' },
    { caption: 'd' },
    { asSticker: true },
    { replyToMessageId: 'Q' },
    { conversationId: 'x@g.us' },
  ]) {
    assert.notEqual(mediaRequestHash({ ...media, ...change }), mediaBase);
  }
  const voice = { conversationId: CHAT, audioBase64: 'YQ==', mimeType: 'audio/ogg; codecs=opus' };
  const voiceBase = voiceRequestHash(voice);
  assert.equal(voiceRequestHash({ ...voice, mimeType: 'AUDIO/OGG; codecs=opus' }), voiceBase);
  assert.notEqual(voiceRequestHash({ ...voice, audioBase64: 'Yg==' }), voiceBase);
  assert.notEqual(voiceRequestHash({ ...voice, mimeType: 'audio/mp4' }), voiceBase);
});

// ---------------------------------------------------------------------------
// Store state machine
// ---------------------------------------------------------------------------

test('reserve → claim → confirm, replays, conflicts and account scope', async () => {
  const undo = useAccount('personal');
  const { rows, restore } = stubAttempts();
  try {
    const hash = textRequestHash({ conversationId: CHAT, content: 'hola' });
    const first = await reserveSend('op-1', hash);
    assert.equal(first.state, 'claimed');
    assert.equal(first.messageId, idempotentMessageId('op-1', 'personal'));
    // Never the raw key: only its sha256.
    assert.ok([...rows.values()].every(r => r.key_hash === idempotencyKeyHash('op-1')));
    assert.ok(![...rows.keys()].some(k => k.includes('op-1')));

    // prepared (nothing sent yet) → a retry may send.
    assert.equal((await reserveSend('op-1', hash)).state, 'retry');
    assert.equal((await reserveSend('op-1', 'other-hash')).state, 'conflict');

    await claimSendAttempt('op-1', hash);
    assert.deepEqual(await reserveSend('op-1', hash), {
      state: 'pending',
      messageId: first.messageId,
    });
    await assert.rejects(claimSendAttempt('op-1', hash), SendAlreadyClaimedError);

    const sentAt = await confirmSend('op-1', first.messageId);
    assert.match(sentAt, ISO);
    assert.deepEqual(await reserveSend('op-1', hash), {
      state: 'sent',
      messageId: first.messageId,
      sentAt,
    });
    assert.equal((await reserveSend('op-1', 'other-hash')).state, 'conflict');

    // Same key on another account: its own row and its own message id.
    process.env.CONNECTOR_ACCOUNT = 'professional';
    const other = await reserveSend('op-1', hash);
    assert.equal(other.state, 'claimed');
    assert.notEqual(other.messageId, first.messageId);
  } finally {
    restore();
    undo();
  }
});

test('a failure before the claim is retryable; after it the row stays pending', async () => {
  const undo = useAccount('personal');
  const { rows, restore } = stubAttempts();
  try {
    await reserveSend('pre', 'h');
    await recordSendFailure('pre', false, new Error('disconnected'));
    const row = rows.get(`personal|${idempotencyKeyHash('pre')}`)!;
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'disconnected');
    assert.equal((await reserveSend('pre', 'h')).state, 'retry');
    await claimSendAttempt('pre', 'h'); // failed → pending is allowed
    assert.equal(row.status, 'pending');

    await reserveSend('post', 'h');
    await claimSendAttempt('post', 'h');
    await recordSendFailure('post', true, new Error('sendMessage timeout after 45000ms'));
    const post = rows.get(`personal|${idempotencyKeyHash('post')}`)!;
    assert.equal(post.status, 'pending');
    assert.match(post.error || '', /timeout/);
    assert.equal((await reserveSend('post', 'h')).state, 'pending');
  } finally {
    restore();
    undo();
  }
});

test('a missing table (42P01) is "unavailable", logged once and not re-queried for a while', async () => {
  const undo = useAccount('personal');
  const { calls, restore } = stubAttempts({ missing: true });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(String(message));
  try {
    assert.deepEqual(await reserveSend('k', 'h'), { state: 'unavailable' });
    assert.deepEqual(await reserveSend('k', 'h'), { state: 'unavailable' });
    assert.equal(attemptQueries(calls).length, 1, 're-probed only after the recheck window');
    assert.equal(warnings.filter(w => /whatsapp_send_attempts does not exist/.test(w)).length, 1);
  } finally {
    console.warn = warn;
    restore();
    undo();
  }
});

test('any other DB error degrades to a send without idempotency, never throws', async () => {
  const undo = useAccount('personal');
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = async () => {
    throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await reserveSend('k', 'h'), { state: 'unavailable' });
    assert.match(await confirmSend('k', 'ID'), ISO);
    await recordSendFailure('k', true, new Error('x'));
    await assert.rejects(claimSendAttempt('k', 'h'), /connection refused/);
  } finally {
    console.warn = warn;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pg.Pool.prototype as any).query = original;
    undo();
  }
});

// ---------------------------------------------------------------------------
// HTTP routes — the no-key path is the legacy one, byte for byte
// ---------------------------------------------------------------------------

test('no key: a constant sendToken sends twice, same shapes as before, zero DB queries', async () => {
  const undo = useAccount('personal');
  const { calls: db, restore } = stubAttempts();
  const { client, calls } = fakeClient();
  try {
    await withRouter(client, async post => {
      const text = { sendToken: 'synapse-messaging', conversationId: CHAT, content: 'hola' };
      const a = await post('/messages/send', text);
      const b = await post('/messages/send', text);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.deepEqual(Object.keys(a.body), ['messageId', 'sentAt']);
      assert.equal(a.body.messageId, 'LEGACY1');
      assert.equal(b.body.messageId, 'LEGACY2');
      assert.match(a.body.sentAt, ISO);
      assert.equal(calls.text.length, 2, 'the same text twice is two messages');
      // The exact legacy call: no messageId, no beforeSend.
      assert.deepEqual(calls.text[0].options, { replyToMessageId: undefined });

      // Two DIFFERENT messages sharing the constant token: both go out.
      const other = await post('/messages/send', { ...text, content: 'otra cosa' });
      assert.equal(other.status, 200);
      assert.equal(calls.text.length, 3);

      const media = { conversationId: CHAT, fileUrl: 'https://f/a.jpg', caption: 'c' };
      const m1 = await post('/messages/media/send', media);
      const m2 = await post('/messages/media/send', media);
      assert.deepEqual(Object.keys(m1.body), ['sent', 'sentAt']);
      assert.equal(m1.body.sent, true);
      assert.equal(m2.status, 200);
      assert.equal(calls.media.length, 2);
      assert.deepEqual(calls.media[0].options, { asSticker: false, replyToMessageId: undefined });

      const voice = { conversationId: CHAT, audioBase64: Buffer.from('audio').toString('base64') };
      const v1 = await post('/messages/audio', voice);
      const v2 = await post('/messages/audio', voice);
      assert.deepEqual(Object.keys(v1.body), ['messageId', 'sentAt']);
      assert.equal(v2.status, 200);
      assert.equal(calls.voice.length, 2);
      assert.equal(calls.voice[0].argc, 3, 'sendVoice keeps its three-argument call');
      assert.equal(calls.voice[0].mime, 'audio/ogg; codecs=opus');
    });
    assert.equal(attemptQueries(db).length, 0, 'no key → the table is never touched');
  } finally {
    restore();
    undo();
  }
});

test('no key: failures answer exactly what they answered before', async () => {
  const undo = useAccount('personal');
  const { calls: db, restore } = stubAttempts();
  const { client } = fakeClient();
  try {
    await withRouter(client, async post => {
      const timeout = await post('/messages/send', {
        sendToken: 't',
        conversationId: CHAT,
        content: 'timeout',
      });
      assert.equal(timeout.status, 504);
      assert.equal(timeout.body.failureClass, 'timeout');
      // A retry without a key is simply sent again (today's behaviour).
      const again = await post('/messages/send', {
        sendToken: 't',
        conversationId: CHAT,
        content: 'timeout',
      });
      assert.equal(again.status, 504);
      const missing = await post('/messages/send', { conversationId: CHAT, content: 'x' });
      assert.equal(missing.status, 400);
      assert.deepEqual(missing.body, {
        error: 'Missing required fields',
        failureClass: 'invalid_request',
      });
    });
    assert.equal(attemptQueries(db).length, 0);
  } finally {
    restore();
    undo();
  }
});

// ---------------------------------------------------------------------------
// HTTP routes — with a key
// ---------------------------------------------------------------------------

test('text with a key: replay answers the recorded outcome without a second send', async () => {
  const undo = useAccount('personal');
  const { rows, restore } = stubAttempts();
  const { client, calls } = fakeClient();
  try {
    await withRouter(client, async post => {
      const body = { sendToken: 'synapse-messaging', conversationId: CHAT, content: 'hola' };
      const headers = { 'Idempotency-Key': 'op-text-1' };
      const first = await post('/messages/send', body, headers);
      assert.equal(first.status, 200);
      assert.deepEqual(Object.keys(first.body), ['messageId', 'sentAt']);
      assert.equal(first.body.messageId, idempotentMessageId('op-text-1', 'personal'));
      assert.equal(calls.text[0].options.messageId, first.body.messageId);

      const replay = await post('/messages/send', body, headers);
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.body, { ...first.body, deduplicated: true });
      assert.equal(calls.text.length, 1, 'no second send');
      assert.equal(rows.get(`personal|${idempotencyKeyHash('op-text-1')}`)?.status, 'sent');

      // The body field works too, and the sendToken is irrelevant to the key.
      const viaBody = await post('/messages/send', {
        ...body,
        sendToken: 'another-token',
        idempotencyKey: 'op-text-1',
      });
      assert.equal(viaBody.status, 200);
      assert.equal(viaBody.body.deduplicated, true);
      assert.equal(calls.text.length, 1);
    });
  } finally {
    restore();
    undo();
  }
});

test('text with a key: same key, different request → 409 idempotency_key_reused', async () => {
  const undo = useAccount('personal');
  const { restore } = stubAttempts();
  const { client, calls } = fakeClient();
  try {
    await withRouter(client, async post => {
      const headers = { 'Idempotency-Key': 'op-reuse' };
      const base = { sendToken: 's', conversationId: CHAT, content: 'hola' };
      assert.equal((await post('/messages/send', base, headers)).status, 200);
      for (const change of [
        { content: 'adios' },
        { conversationId: '34611111111@s.whatsapp.net' },
        { replyToMessageId: 'QUOTED' },
      ]) {
        const conflict = await post('/messages/send', { ...base, ...change }, headers);
        assert.equal(conflict.status, 409);
        assert.equal(conflict.body.failureClass, 'idempotency_key_reused');
      }
      assert.equal(calls.text.length, 1);
      // A key reused across routes is a different request too.
      const media = await post(
        '/messages/media/send',
        { conversationId: CHAT, fileUrl: 'https://f/a.jpg' },
        headers
      );
      assert.equal(media.status, 409);
      assert.equal(calls.media.length, 0);
    });
  } finally {
    restore();
    undo();
  }
});

test('text with a key: an outcome lost after the send → 409 send_outcome_uncertain', async () => {
  const undo = useAccount('personal');
  const { rows, restore } = stubAttempts();
  const { client, calls } = fakeClient();
  try {
    await withRouter(client, async post => {
      const headers = { 'Idempotency-Key': 'op-timeout' };
      const body = { sendToken: 's', conversationId: CHAT, content: 'timeout' };
      const first = await post('/messages/send', body, headers);
      assert.equal(first.status, 504, 'the first answer is the real failure, as before');
      const row = rows.get(`personal|${idempotencyKeyHash('op-timeout')}`)!;
      assert.equal(row.status, 'pending');
      assert.match(row.error || '', /timeout/);

      const replay = await post('/messages/send', body, headers);
      assert.equal(replay.status, 409);
      assert.equal(replay.body.failureClass, 'send_outcome_uncertain');
      assert.equal(replay.body.messageId, idempotentMessageId('op-timeout', 'personal'));
      assert.equal(calls.text.length, 1, 'never re-sent while uncertain');
    });
  } finally {
    restore();
    undo();
  }
});

test('text with a key: a crash between send and confirm (pending row) → 409 uncertain', async () => {
  const undo = useAccount('personal');
  const { restore } = stubAttempts();
  const { client, calls } = fakeClient();
  try {
    const hash = textRequestHash({ conversationId: CHAT, content: 'hola' });
    await reserveSend('op-crash', hash);
    await claimSendAttempt('op-crash', hash); // the process died right after this
    await withRouter(client, async post => {
      const replay = await post(
        '/messages/send',
        { sendToken: 's', conversationId: CHAT, content: 'hola' },
        { 'Idempotency-Key': 'op-crash' }
      );
      assert.equal(replay.status, 409);
      assert.deepEqual(Object.keys(replay.body).sort(), ['error', 'failureClass', 'messageId']);
      assert.equal(replay.body.messageId, idempotentMessageId('op-crash', 'personal'));
    });
    assert.equal(calls.text.length, 0);
  } finally {
    restore();
    undo();
  }
});

test('text with a key: a failure before the network send is retried under the same id', async () => {
  const undo = useAccount('personal');
  const { rows, restore } = stubAttempts();
  const { client, calls } = fakeClient();
  try {
    await withRouter(client, async post => {
      const headers = { 'Idempotency-Key': 'op-preflight' };
      const body = { sendToken: 's', conversationId: CHAT, content: 'preflight-fail' };
      const first = await post('/messages/send', body, headers);
      assert.equal(first.status, 424);
      assert.equal(first.body.failureClass, 'group_metadata');
      assert.equal(rows.get(`personal|${idempotencyKeyHash('op-preflight')}`)?.status, 'failed');
      const retry = await post('/messages/send', body, headers);
      assert.equal(retry.status, 424);
      assert.equal(calls.text.length, 2, 'nothing went out, so the retry tries again');
      assert.equal(calls.text[1].options.messageId, calls.text[0].options.messageId);
    });
  } finally {
    restore();
    undo();
  }
});

test('text with a key: a claim lost to a concurrent request → 409 uncertain, no send', async () => {
  const undo = useAccount('personal');
  const { rows, restore } = stubAttempts();
  const { client, calls } = fakeClient();
  // The concurrent twin claims the row between our reserve and our claim.
  const sendMessage = client.sendMessage;
  client.sendMessage = async (chat: string, text: string, opts: any) => {
    const row = rows.get(`personal|${idempotencyKeyHash('op-race')}`)!;
    row.status = 'pending';
    return sendMessage(chat, text, opts);
  };
  try {
    await withRouter(client, async post => {
      const response = await post(
        '/messages/send',
        { sendToken: 's', conversationId: CHAT, content: 'hola' },
        { 'Idempotency-Key': 'op-race' }
      );
      assert.equal(response.status, 409);
      assert.equal(response.body.failureClass, 'send_outcome_uncertain');
      assert.equal(response.body.messageId, idempotentMessageId('op-race', 'personal'));
    });
    assert.equal(calls.text.length, 1);
    const row = rows.get(`personal|${idempotencyKeyHash('op-race')}`)!;
    assert.equal(row.status, 'pending', "the twin's claim is left alone");
    assert.equal(row.error, null);
  } finally {
    restore();
    undo();
  }
});

test('an invalid key is a 400 before anything is sent', async () => {
  const undo = useAccount('personal');
  const { calls: db, restore } = stubAttempts();
  const { client, calls } = fakeClient();
  try {
    await withRouter(client, async post => {
      const response = await post(
        '/messages/send',
        { sendToken: 's', conversationId: CHAT, content: 'hola', idempotencyKey: 'b' },
        { 'Idempotency-Key': 'a' }
      );
      assert.equal(response.status, 400);
      assert.equal(response.body.failureClass, 'invalid_request');
    });
    assert.equal(calls.text.length, 0);
    assert.equal(attemptQueries(db).length, 0);
  } finally {
    restore();
    undo();
  }
});

test('media and audio with a key: replay, conflict, message id', async () => {
  const undo = useAccount('professional');
  const { restore } = stubAttempts();
  const { client, calls } = fakeClient();
  try {
    await withRouter(client, async post => {
      const media = { conversationId: CHAT, fileUrl: 'https://f/a.jpg', caption: 'c' };
      const mh = { 'Idempotency-Key': 'op-media' };
      const m1 = await post('/messages/media/send', media, mh);
      assert.equal(m1.status, 200);
      assert.deepEqual(Object.keys(m1.body), ['sent', 'sentAt', 'messageId']);
      assert.equal(m1.body.messageId, idempotentMessageId('op-media', 'professional'));
      assert.equal(calls.media[0].options.messageId, m1.body.messageId);
      const m2 = await post('/messages/media/send', media, mh);
      assert.deepEqual(m2.body, { ...m1.body, deduplicated: true });
      assert.equal(
        (await post('/messages/media/send', { ...media, caption: 'd' }, mh)).status,
        409
      );
      assert.equal(
        (await post('/messages/media/send', { ...media, kind: 'sticker' }, mh)).status,
        409
      );
      assert.equal(calls.media.length, 1);

      const voice = { conversationId: CHAT, audioBase64: Buffer.from('audio').toString('base64') };
      const vh = { 'Idempotency-Key': 'op-voice' };
      const v1 = await post('/messages/audio', voice, vh);
      assert.equal(v1.status, 200);
      assert.deepEqual(Object.keys(v1.body), ['messageId', 'sentAt']);
      assert.equal(calls.voice[0].options.messageId, v1.body.messageId);
      const v2 = await post('/messages/audio', voice, vh);
      assert.deepEqual(v2.body, { ...v1.body, deduplicated: true });
      const changed = await post(
        '/messages/audio',
        { ...voice, audioBase64: Buffer.from('other').toString('base64') },
        vh
      );
      assert.equal(changed.status, 409);
      assert.equal(changed.body.failureClass, 'idempotency_key_reused');
      assert.equal(calls.voice.length, 1);

      const lost = await post(
        '/messages/audio',
        { conversationId: CHAT, audioBase64: Buffer.from('timeout').toString('base64') },
        { 'Idempotency-Key': 'op-voice-timeout' }
      );
      assert.equal(lost.status, 504);
      const lostReplay = await post(
        '/messages/audio',
        { conversationId: CHAT, audioBase64: Buffer.from('timeout').toString('base64') },
        { 'Idempotency-Key': 'op-voice-timeout' }
      );
      assert.equal(lostReplay.status, 409);
      assert.equal(lostReplay.body.failureClass, 'send_outcome_uncertain');
    });
  } finally {
    restore();
    undo();
  }
});

test('table missing: a keyed send still goes out, on the legacy path', async () => {
  const undo = useAccount('personal');
  const { restore } = stubAttempts({ missing: true });
  const { client, calls } = fakeClient();
  const warn = console.warn;
  console.warn = () => {};
  try {
    await withRouter(client, async post => {
      const body = { sendToken: 's', conversationId: CHAT, content: 'hola' };
      const headers = { 'Idempotency-Key': 'op-missing' };
      const a = await post('/messages/send', body, headers);
      const b = await post('/messages/send', body, headers);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.deepEqual(Object.keys(a.body), ['messageId', 'sentAt']);
      assert.deepEqual(calls.text[0].options, { replyToMessageId: undefined });
      assert.equal(calls.text.length, 2, 'without the table there is no idempotency');
      const media = await post(
        '/messages/media/send',
        { conversationId: CHAT, fileUrl: 'https://f/a.jpg' },
        headers
      );
      assert.deepEqual(Object.keys(media.body), ['sent', 'sentAt']);
    });
  } finally {
    console.warn = warn;
    restore();
    undo();
  }
});

test('ingest off (pairing pool): a key never touches the table', async () => {
  const undo = useAccount('personal');
  const { calls: db, restore } = stubAttempts();
  const { client, calls } = fakeClient({ ingest: false });
  try {
    await withRouter(client, async post => {
      const body = { sendToken: 's', conversationId: CHAT, content: 'hola' };
      const response = await post('/messages/send', body, { 'Idempotency-Key': 'op-pairing' });
      assert.equal(response.status, 200);
      assert.deepEqual(calls.text[0].options, { replyToMessageId: undefined });
    });
    assert.equal(attemptQueries(db).length, 0);
  } finally {
    restore();
    undo();
  }
});

// ---------------------------------------------------------------------------
// BaileysClient hooks
// ---------------------------------------------------------------------------

interface SockCall {
  jid: string;
  content: any;
  opts: any;
  order: number;
}

function realClient(ingest = true): {
  client: BaileysClient;
  sent: SockCall[];
  order: () => number;
} {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), { ingest });
  const sent: SockCall[] = [];
  let order = 0;
  const sock = {
    sendMessage: async (jid: string, content: any, opts: any) => {
      sent.push({ jid, content, opts, order: ++order });
      return {
        key: { remoteJid: jid, id: opts?.messageId || `RANDOM${order}`, fromMe: true },
        message: content.text ? { extendedTextMessage: { text: content.text } } : {},
        messageTimestamp: Math.floor(Date.now() / 1000),
      };
    },
    end: () => {},
  };
  const internals = client as unknown as { sock: unknown; ready: boolean };
  internals.sock = sock;
  internals.ready = true;
  return { client, sent, order: () => ++order };
}

test('BaileysClient: isIngestEnabled mirrors the ingest option', () => {
  assert.equal(realClient(true).client.isIngestEnabled(), true);
  assert.equal(realClient(false).client.isIngestEnabled(), false);
  assert.equal(new BaileysClient('/tmp/unused', 'k'.repeat(16)).isIngestEnabled(), true);
});

test('BaileysClient: messageId reaches Baileys and beforeSend runs right before the send', async () => {
  const undo = useAccount('personal');
  const { restore } = stubAttempts();
  try {
    const { client, sent, order } = realClient(false);
    let claimedAt = 0;
    const id = await client.sendMessage(CHAT, 'hola', {
      messageId: '3EB0AAAAAAAAAAAAAAAAAA',
      beforeSend: async () => {
        claimedAt = order();
      },
    });
    assert.equal(id, '3EB0AAAAAAAAAAAAAAAAAA');
    assert.equal(sent[0].opts.messageId, '3EB0AAAAAAAAAAAAAAAAAA');
    assert.ok(claimedAt > 0 && claimedAt < sent[0].order, 'claim, then send');

    // Legacy call: Baileys picks the id, no messageId option.
    const legacy = await client.sendMessage(CHAT, 'hola');
    assert.match(legacy || '', /^RANDOM/);
    assert.equal('messageId' in sent[1].opts, false);

    // A beforeSend that refuses stops the send.
    await assert.rejects(
      client.sendMessage(CHAT, 'hola', {
        messageId: '3EB0BBBBBBBBBBBBBBBBBB',
        beforeSend: async () => {
          throw new SendAlreadyClaimedError();
        },
      }),
      SendAlreadyClaimedError
    );
    assert.equal(sent.length, 2);

    const voiceId = await client.sendVoice(CHAT, Buffer.from('a'), 'audio/ogg; codecs=opus', {
      messageId: '3EB0CCCCCCCCCCCCCCCCCC',
    });
    assert.equal(voiceId, '3EB0CCCCCCCCCCCCCCCCCC');
    assert.deepEqual(sent[2].opts, { messageId: '3EB0CCCCCCCCCCCCCCCCCC' });
    await client.sendVoice(CHAT, Buffer.from('a'));
    assert.equal(sent[3].opts, undefined, 'legacy voice call keeps two arguments');
  } finally {
    restore();
    undo();
  }
});

test('BaileysClient.sendFile: claims after fetching the file and returns the id', async () => {
  const undo = useAccount('personal');
  const { restore } = stubAttempts();
  const originalFetch = globalThis.fetch;
  const steps: string[] = [];
  globalThis.fetch = (async () => {
    steps.push('fetch');
    return new Response(Buffer.from('png'), { headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  try {
    const { client, sent } = realClient(false);
    const id = await client.sendFile(CHAT, 'https://f/a.png', 'c', {
      messageId: '3EB0DDDDDDDDDDDDDDDDDD',
      beforeSend: async () => {
        steps.push('claim');
      },
    });
    steps.push('sent');
    assert.deepEqual(steps, ['fetch', 'claim', 'sent']);
    assert.equal(id, '3EB0DDDDDDDDDDDDDDDDDD');
    assert.deepEqual(sent[0].opts, { messageId: '3EB0DDDDDDDDDDDDDDDDDD' });

    await client.sendFile(CHAT, 'https://f/a.png', 'c');
    assert.equal(sent[1].opts, undefined, 'legacy media call: no options object');
  } finally {
    globalThis.fetch = originalFetch;
    restore();
    undo();
  }
});

test('a real ingest-off client behind the router ignores the key and never queries', async () => {
  const undo = useAccount('personal');
  const { calls: db, restore } = stubAttempts();
  try {
    const { client, sent } = realClient(false);
    await withRouter(client, async post => {
      const response = await post(
        '/messages/send',
        { sendToken: 's', conversationId: CHAT, content: 'hola' },
        { 'Idempotency-Key': 'op-real-pairing' }
      );
      assert.equal(response.status, 200);
      assert.match(response.body.messageId, /^RANDOM/);
    });
    assert.equal('messageId' in sent[0].opts, false);
    assert.equal(db.length, 0, 'ingest off: no query at all');
  } finally {
    restore();
    undo();
  }
});
