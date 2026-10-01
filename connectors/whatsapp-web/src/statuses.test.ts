/**
 * Statuses and channel posts: request parsing, the status index on ingest
 * (live / history; protocol noise and timeless rows skipped; chats untouched),
 * the lists (author PN ↔ LID, active window, keyset cursor, table missing),
 * channel posts from messages, publishing (flag off by default, explicit
 * audience, own jid dropped, image fetched, indexed with audience + actor)
 * and the HTTP routes (flag, gate, 400s, lists ungated).
 *
 * No socket and no DB: a fake sock records what would go to WhatsApp and
 * pg.Pool#query is stubbed per test (same harness as message-stars-pins.test.ts).
 *
 * Run: pnpm --filter @mcp-socialmedia/connector test
 */
import './test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import pg from 'pg';
import type { WAMessage } from '@whiskeysockets/baileys';
import { BaileysClient, BaileysClientOptions } from './baileys-client';
import { resetDurableStoreStateForTests } from './durable-message-store';
import { MessageMutationError } from './message-mutations';
import {
  encodeTimeCursor,
  isChannelJid,
  isStatusJid,
  parseChannelPostsQuery,
  parseStatusListQuery,
  parseStatusPublishRequest,
  resetStatusStoreStateForTests,
  statusPublishEnabled,
  statusRecipientJid,
} from './statuses';
import { createRouter } from './api/controller';
import { generateHMACSignature } from './api/auth';

type Rows = Record<string, unknown>[];
interface QueryCall {
  sql: string;
  params: unknown[];
}

function stubPool(route: (sql: string, params: unknown[]) => Rows | Error = () => []): {
  calls: QueryCall[];
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  const original = pg.Pool.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    const out = route(sql, params);
    return out instanceof Error
      ? Promise.reject(out)
      : Promise.resolve({ rows: out, rowCount: out.length });
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
  resetStatusStoreStateForTests();
}

function withEnv(env: Record<string, string | undefined>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

const isStatusInsert = (sql: string): boolean => /INSERT INTO whatsapp_statuses/i.test(sql);
const isMessageInsert = (sql: string): boolean => /INSERT INTO messages/i.test(sql);
const isStatusSelect = (sql: string): boolean => /FROM whatsapp_statuses s/i.test(sql);
const isAliasSelect = (sql: string): boolean => /FROM social_contact_aliases a/i.test(sql);

function missingTable(name: string): Error {
  return Object.assign(new Error(`relation "${name}" does not exist`), { code: '42P01' });
}

const NOW_MS = 1_790_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ME_PN = '34999@s.whatsapp.net';

interface Sent {
  jid: string;
  content: any;
  options: any;
}

function makeClient(options: BaileysClientOptions = {}): { client: BaileysClient; sent: Sent[] } {
  const client = new BaileysClient('/tmp/unused-session', 'k'.repeat(16), options);
  const sent: Sent[] = [];
  const sock = {
    ev: { on: () => {} },
    user: { id: '34999:3@s.whatsapp.net', lid: '9999:3@lid' },
    sendMessage: async (jid: string, content: any, opts: any) => {
      sent.push({ jid, content, options: opts });
      return {
        key: { remoteJid: jid, id: opts?.messageId || 'ST1', fromMe: true },
        message: content.text ? { extendedTextMessage: { text: content.text } } : {},
        messageTimestamp: NOW_MS / 1000,
      } as unknown as WAMessage;
    },
    profilePictureUrl: async () => undefined,
    signalRepository: { lidMapping: { getLIDForPN: async () => null } },
    end: () => {},
  };
  const internals = client as unknown as { sock: unknown; ready: boolean; meJid: string };
  internals.sock = sock;
  internals.ready = true;
  internals.meJid = ME_PN;
  return { client, sent };
}

function priv(client: BaileysClient): any {
  return client as any;
}

function statusMessage(overrides: Record<string, any> = {}): WAMessage {
  return {
    key: {
      remoteJid: 'status@broadcast',
      id: 'S1',
      fromMe: false,
      participant: '2222@lid',
    },
    message: { imageMessage: { caption: 'en la playa', mimetype: 'image/jpeg' } },
    messageTimestamp: NOW_MS / 1000,
    pushName: 'Ana',
    ...overrides,
  } as unknown as WAMessage;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('jid kinds and the publish flag (off unless exactly "true")', () => {
  assert.ok(isStatusJid('status@broadcast'));
  assert.ok(!isStatusJid('123@broadcast'));
  assert.ok(isChannelJid('120363400253693272@newsletter'));
  assert.ok(!isChannelJid('120363@g.us'));
  const undo = withEnv({ WA_STATUS_PUBLISH_ENABLED: undefined });
  try {
    assert.equal(statusPublishEnabled(), false);
    process.env.WA_STATUS_PUBLISH_ENABLED = '1';
    assert.equal(statusPublishEnabled(), false);
    process.env.WA_STATUS_PUBLISH_ENABLED = 'true';
    assert.equal(statusPublishEnabled(), true);
  } finally {
    undo();
  }
});

test('list queries: defaults, flags, limits, cursors; channel ids only @newsletter', () => {
  assert.deepEqual(parseStatusListQuery({}), {
    includeExpired: false,
    includeOwn: true,
    limit: 50,
  });
  const cursor = encodeTimeCursor({ at: '2026-10-01T10:00:00.000Z', messageId: 'S9' });
  assert.deepEqual(
    parseStatusListQuery({
      contact: ' +34 600 ',
      includeExpired: true,
      includeOwn: false,
      limit: 5,
      cursor,
    }),
    {
      contact: '+34 600',
      includeExpired: true,
      includeOwn: false,
      limit: 5,
      cursor: { at: '2026-10-01T10:00:00.000Z', messageId: 'S9' },
    }
  );
  for (const body of [
    { limit: 0 },
    { limit: 201 },
    { includeExpired: 'yes' },
    { cursor: 'nope' },
    { contact: 7 },
  ]) {
    assert.throws(
      () => parseStatusListQuery(body),
      (e: unknown) =>
        e instanceof MessageMutationError &&
        e.status === 400 &&
        e.failureClass === 'invalid_request'
    );
  }
  assert.deepEqual(parseChannelPostsQuery({}), { limit: 50 });
  assert.deepEqual(parseChannelPostsQuery({ channelId: '120363@newsletter', limit: 3 }), {
    channelId: '120363@newsletter',
    limit: 3,
  });
  for (const body of [{ channelId: '120363@g.us' }, { channelId: 'status@broadcast' }]) {
    assert.throws(() => parseChannelPostsQuery(body), MessageMutationError);
  }
});

test('publish request: confirm, explicit audience normalised + deduplicated, per-type fields', () => {
  assert.equal(statusRecipientJid('+34 600 111 222'), '34600111222@s.whatsapp.net');
  assert.equal(statusRecipientJid('34600111222@c.us'), '34600111222@s.whatsapp.net');
  assert.equal(statusRecipientJid('2222:4@lid'), '2222@lid');
  for (const bad of ['120363@g.us', 'status@broadcast', '1203@newsletter', '', 'abc', 7]) {
    assert.throws(() => statusRecipientJid(bad), MessageMutationError);
  }
  assert.deepEqual(
    parseStatusPublishRequest({
      confirm: true,
      type: 'text',
      text: 'Abrimos el sábado',
      recipients: ['+34600111222', '34600111222@s.whatsapp.net', '2222@lid'],
      backgroundColor: 'ff0000',
      font: 2,
    }),
    {
      type: 'text',
      text: 'Abrimos el sábado',
      recipients: ['34600111222@s.whatsapp.net', '2222@lid'],
      backgroundColor: '#ff0000',
      font: 2,
    }
  );
  assert.deepEqual(
    parseStatusPublishRequest({
      confirm: true,
      type: 'image',
      url: 'https://cdn.example/x.png',
      recipients: ['2222@lid'],
    }),
    { type: 'image', url: 'https://cdn.example/x.png', recipients: ['2222@lid'] }
  );
  const base = { confirm: true, type: 'text', text: 'hola', recipients: ['2222@lid'] };
  for (const body of [
    { ...base, confirm: undefined },
    { ...base, confirm: 'true' },
    { ...base, type: 'video' },
    { ...base, recipients: [] },
    { ...base, recipients: undefined },
    { ...base, recipients: Array.from({ length: 257 }, (_, i) => `${1000 + i}@lid`) },
    { ...base, recipients: ['120363@g.us'] },
    { ...base, text: '   ' },
    { ...base, text: 'x'.repeat(4097) },
    { ...base, url: 'https://cdn.example/x.png' },
    { ...base, font: 9 },
    { ...base, backgroundColor: 'red' },
    { confirm: true, type: 'image', recipients: ['2222@lid'] },
    { confirm: true, type: 'image', url: 'file:///etc/passwd', recipients: ['2222@lid'] },
    { confirm: true, type: 'image', url: 'https://x/y.png', recipients: ['2222@lid'], font: 1 },
    {
      confirm: true,
      type: 'image',
      url: 'https://x/y.png',
      recipients: ['2222@lid'],
      text: 'x'.repeat(1025),
    },
  ]) {
    assert.throws(
      () => parseStatusPublishRequest(body as Record<string, unknown>),
      (e: unknown) => e instanceof MessageMutationError && e.status === 400,
      JSON.stringify(body).slice(0, 120)
    );
  }
});

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

test('a contact status lands in messages as before and is indexed: author, +24 h, live/history', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient();
    await priv(client).ingestMessage(statusMessage(), { source: 'live', publishEvent: false });
    assert.ok(
      calls.some(c => isMessageInsert(c.sql)),
      'still a messages row'
    );
    const [index] = calls.filter(c => isStatusInsert(c.sql));
    assert.deepEqual(index.params, [
      'professional',
      'professional:S1',
      'professional:2222@lid',
      false,
      'IMAGE',
      new Date(NOW_MS),
      new Date(NOW_MS + DAY_MS),
      null,
      'live',
      null,
    ]);
    assert.match(index.sql, /WHERE EXCLUDED\.source = 'connector'/, 'a replay never rewrites it');

    calls.length = 0;
    await priv(client).ingestMessage(
      statusMessage({
        key: { remoteJid: 'status@broadcast', id: 'S2', fromMe: true },
        message: { conversation: 'mi estado' },
      }),
      { source: 'baileys_history_sync', publishEvent: false }
    );
    const [own] = calls.filter(c => isStatusInsert(c.sql));
    assert.deepEqual(own.params.slice(1, 5), [
      'professional:S2',
      'professional:34999@c.us',
      true,
      'TEXT',
    ]);
    assert.equal(own.params[8], 'history');
  } finally {
    restore();
  }
});

test('not indexed: sender-key noise, a status without time, chats and channel posts', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient();
    await priv(client).ingestMessage(
      statusMessage({
        message: { senderKeyDistributionMessage: { groupId: 'status@broadcast' } },
      }),
      { source: 'live', publishEvent: false }
    );
    await priv(client).ingestMessage(statusMessage({ messageTimestamp: 0 }), {
      source: 'baileys_history_sync',
      publishEvent: false,
    });
    await priv(client).ingestMessage(
      statusMessage({
        key: { remoteJid: '34600@s.whatsapp.net', id: 'C1', fromMe: false },
        message: { conversation: 'hola' },
      }),
      { source: 'live', publishEvent: false }
    );
    await priv(client).ingestMessage(
      statusMessage({
        key: { remoteJid: '120363400253693272@newsletter', id: 'N1', fromMe: false },
        message: { conversation: 'novedad del canal' },
      }),
      { source: 'live', publishEvent: false }
    );
    assert.equal(calls.filter(c => isStatusInsert(c.sql)).length, 0);
    const posts = calls.filter(c => isMessageInsert(c.sql));
    assert.ok(
      posts.some(c => c.params.includes('120363400253693272@newsletter')),
      'a channel post stays a messages row of its channel conversation'
    );
  } finally {
    restore();
  }
});

test('ingest off (pairing pool): the lists answer empty without touching the DB', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool();
  try {
    const { client } = makeClient({ ingest: false });
    assert.deepEqual(
      await client.listStatuses({ includeExpired: false, includeOwn: true, limit: 10 }),
      { statuses: [], nextCursor: null, persisted: false }
    );
    assert.deepEqual(await client.listChannelPosts({ limit: 10 }), {
      posts: [],
      nextCursor: null,
      channels: 0,
    });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function statusRow(id: string, ms: number, overrides: Record<string, unknown> = {}) {
  return {
    wa_message_id: `professional:${id}`,
    author_id: 'professional:2222@lid',
    from_me: false,
    posted_at: new Date(ms),
    expires_at: new Date(ms + DAY_MS),
    audience_size: null,
    source: 'live',
    message_type: 'IMAGE',
    content: 'en la playa',
    author_name: 'Ana',
    mime_type: 'image/jpeg',
    has_media: true,
    ...overrides,
  };
}

test('statuses of one contact: PN + LID through the aliases, active only, keyset cursor', async () => {
  useAccount('professional');
  const T = Date.now(); // `active` is judged against the real clock
  const { calls, restore } = stubPool(sql => {
    if (isAliasSelect(sql)) return [{ id: '2222@lid' }, { id: '34600111222@s.whatsapp.net' }];
    if (isStatusSelect(sql)) {
      return [statusRow('S3', T - 1000), statusRow('S2', T - 2000), statusRow('S1', T - 3000)];
    }
    return [];
  });
  try {
    const { client } = makeClient();
    const list = await client.listStatuses({
      contact: '+34600111222',
      includeExpired: false,
      includeOwn: true,
      limit: 2,
    });
    const alias = calls.find(c => isAliasSelect(c.sql))!;
    assert.deepEqual(alias.params, [
      'whatsapp:professional',
      ['34600111222@c.us', '34600111222@s.whatsapp.net'],
    ]);
    const query = calls.find(c => isStatusSelect(c.sql))!;
    assert.equal(query.params[0], 'professional');
    assert.deepEqual(
      new Set(query.params[1] as string[]),
      new Set([
        'professional:34600111222@c.us',
        'professional:34600111222@s.whatsapp.net',
        'professional:2222@lid',
      ])
    );
    assert.match(query.sql, /s\.expires_at > \$3/);
    assert.match(query.sql, /NOT COALESCE\(m\.is_deleted, FALSE\)/, 'a revoked status is gone');
    assert.equal(query.params[query.params.length - 1], 3, 'limit + 1');
    assert.equal(list.contact, '34600111222@c.us');
    assert.equal(list.persisted, true);
    assert.equal(list.statuses.length, 2);
    assert.deepEqual(list.statuses[0], {
      messageId: 'S3',
      conversationId: 'status@broadcast',
      authorId: '2222@lid',
      authorName: 'Ana',
      fromMe: false,
      messageType: 'IMAGE',
      text: 'en la playa',
      hasMedia: true,
      mimeType: 'image/jpeg',
      postedAt: new Date(T - 1000).toISOString(),
      expiresAt: new Date(T - 1000 + DAY_MS).toISOString(),
      active: true,
      audienceSize: null,
      source: 'live',
    });
    assert.deepEqual(JSON.parse(Buffer.from(list.nextCursor!, 'base64url').toString('utf8')), {
      t: new Date(T - 2000).toISOString(),
      id: 'S2',
    });

    calls.length = 0;
    await client.listStatuses({
      includeExpired: true,
      includeOwn: false,
      limit: 10,
      cursor: { at: new Date(T).toISOString(), messageId: 'S2' },
    });
    const page = calls.find(c => isStatusSelect(c.sql))!;
    assert.doesNotMatch(page.sql, /expires_at >/);
    assert.match(page.sql, /NOT s\.from_me/);
    assert.match(page.sql, /\(s\.posted_at, s\.wa_message_id\) < \(\$2::timestamptz, \$3::text\)/);
    assert.deepEqual(page.params, [
      'professional',
      new Date(T).toISOString(),
      'professional:S2',
      11,
    ]);
    assert.equal(calls.filter(c => isAliasSelect(c.sql)).length, 0, 'no contact, no alias read');

    await assert.rejects(
      client.listStatuses({
        contact: '120363@g.us',
        includeExpired: false,
        includeOwn: true,
        limit: 5,
      }),
      (e: unknown) => e instanceof MessageMutationError && e.status === 400
    );
  } finally {
    restore();
  }
});

test('status index missing (42P01): empty list, persisted false, writes false, re-probed later', async () => {
  useAccount('personal');
  const { calls, restore } = stubPool(sql =>
    isStatusSelect(sql) || isStatusInsert(sql) ? missingTable('whatsapp_statuses') : []
  );
  try {
    const { client } = makeClient();
    assert.deepEqual(
      await client.listStatuses({ includeExpired: false, includeOwn: true, limit: 5 }),
      { statuses: [], nextCursor: null, persisted: false }
    );
    calls.length = 0;
    await priv(client).ingestMessage(statusMessage(), { source: 'live', publishEvent: false });
    assert.ok(
      calls.some(c => isMessageInsert(c.sql)),
      'the status still lands in messages'
    );
    assert.equal(calls.filter(c => isStatusInsert(c.sql)).length, 0, 'known missing: skipped');
  } finally {
    restore();
  }
});

test('channel posts: channels from conversations, posts from messages, names only when real', async () => {
  useAccount('professional');
  const { calls, restore } = stubPool(sql => {
    if (/FROM conversations\s+WHERE account_id/.test(sql)) {
      return [{ id: 'professional:111@newsletter' }, { id: 'professional:222@newsletter' }];
    }
    if (/FROM messages m\s+JOIN conversations c/.test(sql)) {
      return [
        {
          wa_message_id: 'professional:P2',
          conversation_id: 'professional:111@newsletter',
          external_id: '111@newsletter',
          channel_name: 'Tomorrowland',
          message_type: 'TEXT',
          content: 'Line-up',
          wa_timestamp: new Date(NOW_MS),
          poll: null,
          event: null,
          mime_type: null,
          has_media: false,
        },
        {
          wa_message_id: 'professional:P1',
          conversation_id: 'professional:222@newsletter',
          external_id: '222@newsletter',
          channel_name: '222@newsletter',
          message_type: 'POLL',
          content: '¿Qué día?',
          wa_timestamp: new Date(NOW_MS - 5000),
          poll: { name: '¿Qué día?' },
          event: null,
          mime_type: null,
          has_media: false,
        },
      ];
    }
    return [];
  });
  try {
    const { client } = makeClient();
    const list = await client.listChannelPosts({ limit: 1 });
    const channels = calls[0];
    assert.match(channels.sql, /external_id LIKE '%@newsletter'/);
    assert.match(channels.sql, /merged_into IS NULL/);
    assert.deepEqual(channels.params, ['whatsapp:professional']);
    const posts = calls[1];
    assert.deepEqual(posts.params, [
      ['professional:111@newsletter', 'professional:222@newsletter'],
      2,
    ]);
    assert.match(posts.sql, /ORDER BY m\.wa_timestamp DESC, m\.wa_message_id DESC/);
    assert.equal(list.channels, 2);
    assert.deepEqual(list.posts, [
      {
        messageId: 'P2',
        channelId: '111@newsletter',
        channelName: 'Tomorrowland',
        messageType: 'TEXT',
        text: 'Line-up',
        hasMedia: false,
        mimeType: null,
        postedAt: new Date(NOW_MS).toISOString(),
      },
    ]);
    assert.ok(list.nextCursor);

    calls.length = 0;
    const one = await client.listChannelPosts({ channelId: '222@newsletter', limit: 5 });
    assert.deepEqual(calls[0].params, ['whatsapp:professional', '222@newsletter']);
    assert.equal(one.posts[1].channelName, null, 'a channel named by its jid has no name');
    assert.deepEqual(one.posts[1].structured, { poll: { name: '¿Qué día?' } });
    assert.equal(one.nextCursor, null);
  } finally {
    restore();
  }

  const none = stubPool(() => []);
  try {
    const { client } = makeClient();
    assert.deepEqual(await client.listChannelPosts({ limit: 5 }), {
      posts: [],
      nextCursor: null,
      channels: 0,
    });
    assert.equal(none.calls.length, 1, 'no channel, no messages query');
  } finally {
    none.restore();
  }
});

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

async function withImageServer(
  body: Buffer,
  contentType: string,
  run: (url: string) => Promise<void>
): Promise<void> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': contentType });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/x.png`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('publish is refused while WA_STATUS_PUBLISH_ENABLED is off, before the socket', async () => {
  useAccount('personal');
  const undo = withEnv({ WA_STATUS_PUBLISH_ENABLED: undefined });
  const { calls, restore } = stubPool();
  try {
    const { client, sent } = makeClient();
    await assert.rejects(
      client.publishStatus({ type: 'text', text: 'hola', recipients: ['2222@lid'] }),
      (e: unknown) =>
        e instanceof MessageMutationError &&
        e.status === 403 &&
        e.failureClass === 'status_publish_disabled'
    );
    assert.equal(sent.length, 0);
    assert.equal(calls.length, 0);
  } finally {
    restore();
    undo();
  }
});

test('publish a text status: statusJidList without our own ids, style, indexed with audience + actor', async () => {
  useAccount('professional');
  const undo = withEnv({ WA_STATUS_PUBLISH_ENABLED: 'true' });
  const { calls, restore } = stubPool();
  try {
    const { client, sent } = makeClient();
    let claimed = false;
    const result = await client.publishStatus(
      {
        type: 'text',
        text: 'Abrimos el sábado',
        recipients: ['34600@s.whatsapp.net', '34999@s.whatsapp.net', '9999@lid'],
        backgroundColor: '#ff0000',
        font: 2,
      },
      {
        messageId: 'IDEM1',
        actor: 'mcp:agent',
        beforeSend: async () => {
          claimed = true;
        },
      }
    );
    assert.ok(claimed);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, 'status@broadcast');
    assert.deepEqual(sent[0].content, { text: 'Abrimos el sábado' });
    assert.deepEqual(sent[0].options, {
      statusJidList: ['34600@s.whatsapp.net'],
      broadcast: true,
      messageId: 'IDEM1',
      backgroundColor: '#ff0000',
      font: 2,
    });
    assert.deepEqual(result, {
      published: true,
      messageId: 'IDEM1',
      conversationId: 'status@broadcast',
      type: 'text',
      audienceSize: 1,
      postedAt: new Date(NOW_MS).toISOString(),
      expiresAt: new Date(NOW_MS + DAY_MS).toISOString(),
      persisted: true,
    });
    const [index] = calls.filter(c => isStatusInsert(c.sql));
    assert.deepEqual(index.params, [
      'professional',
      'professional:IDEM1',
      'professional:34999@c.us',
      true,
      'TEXT',
      new Date(NOW_MS),
      new Date(NOW_MS + DAY_MS),
      1,
      'connector',
      'mcp:agent',
    ]);

    await assert.rejects(
      client.publishStatus({ type: 'text', text: 'solo yo', recipients: ['9999@lid'] }),
      (e: unknown) => e instanceof MessageMutationError && e.status === 400
    );
    assert.equal(sent.length, 1, 'only ourselves: nothing sent');
  } finally {
    restore();
    undo();
  }
});

test('publish an image status: fetched, JPEG / PNG only, a failed fetch is 422', async () => {
  useAccount('personal');
  const undo = withEnv({ WA_STATUS_PUBLISH_ENABLED: 'true' });
  const { restore } = stubPool();
  try {
    const { client, sent } = makeClient();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await withImageServer(png, 'image/png', async url => {
      const result = await client.publishStatus({
        type: 'image',
        url,
        text: 'nuevo',
        recipients: ['2222@lid'],
      });
      assert.equal(result.type, 'image');
      assert.deepEqual(sent[0].content, { image: png, mimetype: 'image/png', caption: 'nuevo' });
      assert.deepEqual(sent[0].options, { statusJidList: ['2222@lid'], broadcast: true });
    });
    await withImageServer(Buffer.from('GIF89a'), 'image/gif', async url => {
      await assert.rejects(
        client.publishStatus({ type: 'image', url, recipients: ['2222@lid'] }),
        (e: unknown) => e instanceof MessageMutationError && e.status === 400
      );
    });
    await assert.rejects(
      client.publishStatus({
        type: 'image',
        url: 'http://127.0.0.1:1/none.png',
        recipients: ['2222@lid'],
      }),
      (e: unknown) =>
        e instanceof MessageMutationError &&
        e.status === 422 &&
        e.failureClass === 'media_unavailable'
    );
    assert.equal(sent.length, 1);
  } finally {
    restore();
    undo();
  }
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

async function withRouter(
  client: Partial<BaileysClient>,
  env: Record<string, string | undefined>,
  run: (call: Call) => Promise<void>
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
  const call: Call = (method, path, body) => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': String(ts),
        'x-connector-signature': generateHMACSignature(body ?? {}, ts, secret),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const undo = withEnv(env);
  try {
    await run(call);
  } finally {
    undo();
    await new Promise(resolve => server.close(resolve));
  }
}

function recordingClient(connected = true): { client: Partial<BaileysClient>; seen: unknown[] } {
  const seen: unknown[] = [];
  const client = {
    isConnected: () => connected,
    getCachedState: () => (connected ? 'CONNECTED' : 'DISCONNECTED'),
    isIngestEnabled: () => true,
    listStatuses: async (query: any) => {
      seen.push(['statuses', query]);
      return { statuses: [], nextCursor: null, persisted: true };
    },
    listChannelPosts: async (query: any) => {
      seen.push(['posts', query]);
      return { posts: [], nextCursor: null, channels: 0 };
    },
    publishStatus: async (request: any, options: any) => {
      seen.push(['publish', request, options?.actor]);
      return {
        published: true,
        messageId: 'ST9',
        conversationId: 'status@broadcast',
        type: request.type,
        audienceSize: request.recipients.length,
        postedAt: 'T',
        expiresAt: 'T+24h',
        persisted: true,
      };
    },
  };
  return { client: client as unknown as Partial<BaileysClient>, seen };
}

const PUBLISH = {
  type: 'text',
  text: 'hola',
  recipients: ['+34600111222'],
  confirm: true,
  actor: 'dani',
};

test('HTTP: publish needs the flag (403 status_publish_disabled), then the send gate; lists ungated', async () => {
  const { client, seen } = recordingClient();
  await withRouter(
    client,
    { WA_STATUS_PUBLISH_ENABLED: undefined, ENABLE_SENDING: 'true' },
    async call => {
      const off = await call('POST', '/statuses/publish', PUBLISH);
      assert.equal(off.status, 403);
      assert.equal((await off.json()).failureClass, 'status_publish_disabled');
      const invalid = await call('POST', '/statuses/publish', { ...PUBLISH, confirm: false });
      assert.equal(invalid.status, 400, 'validated before the flag');
      assert.equal((await call('POST', '/statuses', {})).status, 200);
      assert.equal((await call('POST', '/channels/posts', {})).status, 200);
    }
  );
  await withRouter(
    client,
    { WA_STATUS_PUBLISH_ENABLED: 'true', ENABLE_SENDING: undefined },
    async call => {
      const gated = await call('POST', '/statuses/publish', PUBLISH);
      assert.equal(gated.status, 403);
      assert.equal((await gated.json()).failureClass, 'disabled_sending');
    }
  );
  await withRouter(
    client,
    {
      WA_STATUS_PUBLISH_ENABLED: 'true',
      ENABLE_SENDING: 'true',
      EMERGENCY_DISABLE_SENDING: 'true',
    },
    async call => {
      assert.equal((await call('POST', '/statuses/publish', PUBLISH)).status, 403);
    }
  );
  assert.deepEqual(seen, [
    ['statuses', { includeExpired: false, includeOwn: true, limit: 50 }],
    ['posts', { limit: 50 }],
  ]);
});

test('HTTP: 200 shapes, 400s, 503 disconnected for publish only', async () => {
  const { client, seen } = recordingClient();
  const ON = {
    WA_STATUS_PUBLISH_ENABLED: 'true',
    ENABLE_SENDING: 'true',
    EMERGENCY_DISABLE_SENDING: undefined,
  };
  await withRouter(client, ON, async call => {
    const published = await call('POST', '/statuses/publish', PUBLISH);
    assert.equal(published.status, 200);
    assert.equal((await published.json()).messageId, 'ST9');
    const list = await call('POST', '/statuses', { contact: '34600@c.us', limit: 5 });
    assert.equal(list.status, 200);
    const posts = await call('POST', '/channels/posts', { channelId: '111@newsletter' });
    assert.equal(posts.status, 200);
    for (const [path, body] of [
      ['/statuses', { limit: 500 }],
      ['/statuses', { cursor: 'x' }],
      ['/channels/posts', { channelId: '111@g.us' }],
      ['/statuses/publish', { ...PUBLISH, recipients: [] }],
      ['/statuses/publish', { ...PUBLISH, type: 'video' }],
    ] as const) {
      const res = await call('POST', path, body);
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
      assert.equal((await res.json()).failureClass, 'invalid_request');
    }
  });
  assert.deepEqual(seen, [
    ['publish', { type: 'text', text: 'hola', recipients: ['34600111222@s.whatsapp.net'] }, 'dani'],
    ['statuses', { contact: '34600@c.us', includeExpired: false, includeOwn: true, limit: 5 }],
    ['posts', { channelId: '111@newsletter', limit: 50 }],
  ]);
  await withRouter(recordingClient(false).client, ON, async call => {
    const res = await call('POST', '/statuses/publish', PUBLISH);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).failureClass, 'disconnected');
    assert.equal((await call('POST', '/statuses', {})).status, 200);
  });
});
