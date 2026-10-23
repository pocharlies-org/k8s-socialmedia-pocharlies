/**
 * DGX-1235 B2 (i), C6: a Telegram send carrying an Idempotency-Key goes out
 * once, also after a restart, and fails closed.
 *
 * The routes are the real ones (createRouter / createPublicRouter) over the real
 * TelegramClientWrapper with a fake mtcute behind it. The store is the real
 * table of migration 040 on an ephemeral Postgres (TELEGRAM_TEST_DATABASE_URL:
 * a fresh database is created per run, the migration applied by hand). Without
 * that variable only the cases that need no table run (no key, store down).
 *
 * Run: TELEGRAM_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *        pnpm --filter @mcp-socialmedia/telegram-connector test
 */
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import pg from 'pg';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { createRouter } from './api/controller';
import { createPublicRouter } from './api/public-routes';
import { TelegramClientWrapper } from './telegram-client';
import { closePool } from './db-pool';
import { idempotentRandomId, readIdempotencyKey } from './send-idempotency';

const SECRET = 'test-connector-secret';
const CHAT = '777000111';
const ADMIN_URL = process.env.TELEGRAM_TEST_DATABASE_URL;
const MIGRATION = join(
  __dirname,
  '..',
  '..',
  '..',
  'mcp-server/src/infrastructure/database/migrations/040_telegram_send_attempts.sql'
);

let dbReady: Promise<string> | null = null;

/** A fresh database with migration 040 applied; DATABASE_URL points at it. */
function database(): Promise<string> {
  dbReady ??= (async () => {
    const url = new URL(ADMIN_URL as string);
    const admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const name = `tg_send_idem_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    url.pathname = `/${name}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(readFileSync(MIGRATION, 'utf8'));
    // The migration is idempotent: applying it twice changes nothing.
    await client.query(readFileSync(MIGRATION, 'utf8'));
    await client.end();
    return url.toString();
  })();
  return dbReady;
}

async function rows(): Promise<Array<Record<string, unknown>>> {
  const client = new pg.Client({ connectionString: await database() });
  await client.connect();
  try {
    return (await client.query('SELECT * FROM telegram_send_attempts ORDER BY created_at')).rows;
  } finally {
    await client.end();
  }
}

interface SendCall {
  peer: unknown;
  text: string;
  params: Record<string, any> | undefined;
}

class FakeMtcute {
  sends: SendCall[] = [];
  nextId = 4242;
  /** Throw this on the next sendText (once). */
  failNext: Error | null = null;
  /** Resolve sendText only when released (to hold two requests in flight). */
  gate: Promise<void> | null = null;
  onEditMessage = { add: () => undefined };

  async sendText(peer: unknown, text: string, params?: Record<string, any>) {
    this.sends.push({ peer, text, params });
    if (this.gate) await this.gate;
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    return { id: this.nextId++ };
  }
}

function wrapperWith(fake: FakeMtcute): TelegramClientWrapper {
  const wrapper = new TelegramClientWrapper({ apiId: 1, apiHash: 'x', sessionString: 's' });
  const internals = wrapper as unknown as { client: unknown; connected: boolean };
  internals.client = fake;
  internals.connected = true;
  return wrapper;
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  delete process.env.ENABLE_SENDING;
});
after(async () => {
  await closePool();
});

/** One connector process: its own wrapper and routers over the shared store. */
async function connector(fake = new FakeMtcute()) {
  const wrapper = wrapperWith(fake);
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/v1', createRouter(wrapper, SECRET));
  app.use('/api/public', createPublicRouter(wrapper, SECRET));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  open.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, fake, wrapper };
}

async function send(
  base: string,
  body: Record<string, unknown>,
  key?: string,
  path = `/api/v1/messages/${CHAT}`
): Promise<{ status: number; body: Record<string, any> }> {
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-connector-timestamp': String(ts),
      'x-connector-signature': generateHMACSignature(body, ts, SECRET),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const withDb = { skip: ADMIN_URL ? false : 'TELEGRAM_TEST_DATABASE_URL is not set' };

async function useDb(): Promise<void> {
  process.env.DATABASE_URL = await database();
  process.env.CONNECTOR_ACCOUNT = 'professional';
}

const uniq = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// ── without a table ────────────────────────────────────────────────────────

test('C6: without a key the route behaves as today: one send, {success, messageId}, no store', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { base, fake } = await connector();
    const r = await send(base, { text: 'hola' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, messageId: '4242' });
    assert.equal(fake.sends.length, 1);
    assert.equal(fake.sends[0].params?.randomId, undefined);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

test('C6: with a key and the store down → 503 and mtcute is never called', async () => {
  const saved = process.env.DATABASE_URL;
  await closePool();
  process.env.DATABASE_URL = 'postgresql://nadie@127.0.0.1:1/ninguna';
  try {
    const { base, fake } = await connector();
    const r = await send(base, { text: 'hola' }, uniq('caido'));
    assert.equal(r.status, 503);
    assert.equal(r.body.failureClass, 'idempotency_unavailable');
    assert.equal(fake.sends.length, 0);
    const p = await send(base, { text: 'hola' }, uniq('caido'), `/api/public/send/${CHAT}`);
    assert.equal(p.status, 503);
    assert.equal(fake.sends.length, 0);
  } finally {
    await closePool();
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
});

test('C6: with a key and no DATABASE_URL at all → 503, nothing sent', async () => {
  const saved = process.env.DATABASE_URL;
  await closePool();
  delete process.env.DATABASE_URL;
  try {
    const { base, fake } = await connector();
    const r = await send(base, { text: 'hola' }, uniq('sin-bd'));
    assert.equal(r.status, 503);
    assert.equal(fake.sends.length, 0);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

test('the key comes from the header or the body field idempotencyKey, at most 200 characters', () => {
  assert.deepEqual(readIdempotencyKey({ 'idempotency-key': 'a' }, {}), { key: 'a' });
  assert.deepEqual(readIdempotencyKey({}, { idempotencyKey: 'b' }), { key: 'b' });
  assert.deepEqual(readIdempotencyKey({}, { text: 'x' }), {});
  assert.ok(readIdempotencyKey({ 'idempotency-key': 'a' }, { idempotencyKey: 'b' }).error);
  assert.ok(readIdempotencyKey({ 'idempotency-key': 'x'.repeat(201) }, {}).error);
  assert.ok(readIdempotencyKey({}, { idempotencyKey: 7 }).error);
});

test('the random_id of a key is fixed by (account, key): a retry asks Telegram for the same message', () => {
  const a = idempotentRandomId('resp-41', 'professional');
  assert.equal(a.toString(), idempotentRandomId('resp-41', 'professional').toString());
  assert.notEqual(a.toString(), idempotentRandomId('resp-42', 'professional').toString());
  assert.notEqual(a.toString(), idempotentRandomId('resp-41', 'personal').toString());
});

// ── on the ephemeral Postgres ──────────────────────────────────────────────

test(
  'C6: the same key twice → one send; the second answers the record with deduplicated: true',
  withDb,
  async () => {
    await useDb();
    const key = uniq('dos-veces');
    const { base, fake } = await connector();
    const a = await send(base, { text: 'Te lo enviamos mañana' }, key);
    assert.equal(a.status, 200);
    assert.equal(a.body.success, true);
    assert.equal(a.body.deduplicated, false);
    assert.match(a.body.sentAt, /^\d{4}-\d{2}-\d{2}T/);
    const b = await send(base, { text: 'Te lo enviamos mañana' }, key);
    assert.equal(b.status, 200);
    assert.equal(b.body.deduplicated, true);
    assert.equal(b.body.messageId, a.body.messageId);
    assert.equal(fake.sends.length, 1);
    // The random_id handed to mtcute is the one derived from (account, key).
    assert.equal(
      String(fake.sends[0].params?.randomId),
      idempotentRandomId(key, 'professional').toString()
    );
    // The raw key is never stored.
    const stored = (await rows()).filter(r => r.message_id === a.body.messageId);
    assert.equal(stored.length, 1);
    assert.ok(!JSON.stringify(stored).includes(key));
    assert.equal(stored[0].status, 'sent');
  }
);

test('C6: a new connector on the same store (a restart) still sends once', withDb, async () => {
  await useDb();
  const key = uniq('reinicio');
  const first = await connector();
  const a = await send(first.base, { text: 'una vez' }, key);
  assert.equal(a.status, 200);
  await closePool();
  const second = await connector();
  const b = await send(second.base, { text: 'una vez' }, key);
  assert.equal(b.status, 200);
  assert.equal(b.body.deduplicated, true);
  assert.equal(b.body.messageId, a.body.messageId);
  assert.equal(first.fake.sends.length + second.fake.sends.length, 1);
});

test(
  'C6: an attempt saved without an outcome → 409 send_outcome_uncertain and no resend',
  withDb,
  async () => {
    await useDb();
    const key = uniq('incierto');
    const { base, fake } = await connector();
    // A timeout after the request left: nobody knows whether Telegram has it.
    fake.failNext = new Error('Request timed out');
    const a = await send(base, { text: 'quizá' }, key);
    assert.equal(a.status, 500);
    const b = await send(base, { text: 'quizá' }, key);
    assert.equal(b.status, 409);
    assert.equal(b.body.failureClass, 'send_outcome_uncertain');
    assert.equal(fake.sends.length, 1);
  }
);

test(
  'C6: Telegram refused the send (an RPC error) → nothing went out: the same key sends again, same random_id',
  withDb,
  async () => {
    await useDb();
    const key = uniq('rechazo');
    const { base, fake } = await connector();
    fake.failNext = Object.assign(new Error('400: PEER_ID_INVALID'), {
      code: 400,
      text: 'PEER_ID_INVALID',
    });
    const a = await send(base, { text: 'otra vez' }, key);
    assert.equal(a.status, 500);
    const b = await send(base, { text: 'otra vez' }, key);
    assert.equal(b.status, 200);
    assert.equal(b.body.deduplicated, false);
    assert.equal(fake.sends.length, 2);
    assert.equal(String(fake.sends[0].params?.randomId), String(fake.sends[1].params?.randomId));
  }
);

test(
  'C6: the key with another body → 409 idempotency_key_reused, nothing sent',
  withDb,
  async () => {
    await useDb();
    const key = uniq('otro-cuerpo');
    const { base, fake } = await connector();
    assert.equal((await send(base, { text: 'primero' }, key)).status, 200);
    const r = await send(base, { text: 'segundo' }, key);
    assert.equal(r.status, 409);
    assert.equal(r.body.failureClass, 'idempotency_key_reused');
    assert.equal(fake.sends.length, 1);
  }
);

test('C6: two requests with the same key at once → exactly one send', withDb, async () => {
  await useDb();
  const key = uniq('a-la-vez');
  const { base, fake } = await connector();
  let release!: () => void;
  fake.gate = new Promise<void>(resolve => (release = resolve));
  const both = Promise.all([
    send(base, { text: 'a la vez' }, key),
    send(base, { text: 'a la vez' }, key),
  ]);
  await new Promise(resolve => setTimeout(resolve, 300));
  release();
  const [a, b] = await both;
  assert.equal(fake.sends.length, 1);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.body.failureClass, 'send_outcome_uncertain');
});

test('C6: the public send route honours the same key', withDb, async () => {
  await useDb();
  const key = uniq('publica');
  const { base, fake } = await connector();
  const path = `/api/public/send/${CHAT}`;
  const a = await send(base, { text: 'por la pública' }, key, path);
  assert.equal(a.status, 200);
  assert.equal(a.body.success, true);
  const b = await send(base, { text: 'por la pública' }, key, path);
  assert.equal(b.body.deduplicated, true);
  assert.equal(fake.sends.length, 1);
});

test('C6: the isOutbound echo carries the same ref the send returned', withDb, async () => {
  await useDb();
  const { base, fake, wrapper } = await connector();
  const r = await send(base, { text: 'eco' }, uniq('eco'));
  assert.equal(r.status, 200);
  // What mtcute dispatches back for our own message: same id, isOutgoing.
  const echo = {
    id: Number(r.body.messageId),
    chat: { id: Number(CHAT), type: 'user', firstName: 'Cliente' },
    sender: { id: 555000999, type: 'user', firstName: 'Tienda' },
    media: null,
    date: new Date(),
    isOutgoing: true,
    text: 'eco',
    forward: null,
    replyToMessage: null,
    markup: null,
  };
  const parsed = await (
    wrapper as unknown as { parseMessage(m: unknown): Promise<any> }
  ).parseMessage(echo);
  assert.equal(parsed.isOutbound, true);
  assert.equal(`tg:${parsed.telegramMessageId}`, `tg:${r.body.messageId}`);
  assert.equal(fake.sends.length, 1);
});
