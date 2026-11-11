/**
 * Reader tests for the read-only Novedades view.
 *
 * The fake store reproduces the SQL contract that matters here: the same
 * account scoping, the same filters, and the same keyset ordering
 * (`timestamp DESC NULLS LAST, id DESC`). That is what lets these tests prove
 * a page really advances when hundreds of items share one exact timestamp,
 * which no stub that returns rows in insertion order could show.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable, PassThrough } from 'node:stream';
import { createCipheriv } from 'node:crypto';
import express from 'express';
import pg from 'pg';
import { jidNormalizedUser, getMediaKeys, proto } from '@whiskeysockets/baileys';
import { BaileysClient } from './baileys-client';
import { createRouter, fetchNovedadesAvatar } from './api/controller';
import { generateHMACSignature } from './api/auth';
import {
  NOVEDADES_MEDIA_MAX_BYTES,
  NOVEDADES_PAGE_MAX,
  NovedadesReaderError,
  avatarHostAllowed,
  createNovedadesReader,
  encodeNovedadesCursor,
  novedadesErrorBody,
  parseByteRange,
  readNovedadesMediaStream,
  subscribedFromRole,
  type NovedadesReader,
  type NovedadesStoreReads,
} from './novedades-reader';
import type {
  StoredNovedadesChannel,
  StoredNovedadesMessage,
  StoredNovedadesStatus,
} from './novedades-store';

const CHANNEL_A = '120363111111111111@newsletter';
const CHANNEL_B = '120363222222222222@newsletter';
const AUTHOR = '34600123456@s.whatsapp.net';
const OTHER = '34600999999@s.whatsapp.net';
const T = 1_700_000_000_000;

function channelRow(
  jid: string,
  name: string,
  overrides: Partial<StoredNovedadesChannel> = {}
): StoredNovedadesChannel {
  return {
    account: 'personal',
    jid,
    name,
    description: null,
    ownerJid: null,
    role: null,
    verification: null,
    avatarUrl: null,
    inviteCode: null,
    subscriberCount: null,
    creationTimestampMs: null,
    muteState: null,
    rawMetadata: null,
    ...overrides,
  };
}

function statusRow(
  authorJid: string,
  messageId: string,
  timestampMs: number | null,
  overrides: Partial<StoredNovedadesStatus> = {}
): StoredNovedadesStatus {
  return {
    account: 'personal',
    authorJid,
    messageId,
    fromMe: false,
    key: { id: messageId, remoteJid: 'status@broadcast', participant: authorJid },
    payload: { conversation: `hola ${messageId}` },
    timestampMs,
    messageType: 'conversation',
    visibility: 'visible',
    metadata: {},
    postedAt: timestampMs === null ? null : new Date(timestampMs).toISOString(),
    expiresAt: timestampMs === null ? null : new Date(timestampMs + 86_400_000).toISOString(),
    seenAt: null,
    ttlRemainingMs: 3_600_000,
    active: true,
    freshnessUnknown: timestampMs === null,
    isDeleted: false,
    ...overrides,
  };
}

function postRow(
  channelJid: string,
  messageId: string,
  timestampMs: number | null,
  overrides: Partial<StoredNovedadesMessage> = {}
): StoredNovedadesMessage {
  return {
    account: 'personal',
    channelJid,
    messageId,
    serverId: messageId,
    clientId: null,
    supersededBy: null,
    fromMe: false,
    key: { id: messageId, remoteJid: channelJid },
    payload: { conversation: `post ${messageId}` },
    timestampMs,
    messageType: 'conversation',
    visibility: 'visible',
    authorJid: AUTHOR,
    metadata: {},
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date(T).toISOString(),
    updatedAt: new Date(T).toISOString(),
    ...overrides,
  };
}

type Record_ = Array<{ read: string; args: unknown[] }>;

function fakeStore(data: {
  channels?: StoredNovedadesChannel[];
  statuses?: StoredNovedadesStatus[];
  messages?: StoredNovedadesMessage[];
}): { store: NovedadesStoreReads; calls: Record_ } {
  const calls: Record_ = [];
  const keyOf = (row: { timestampMs: number | null; messageId: string }) => ({
    ts: row.timestampMs,
    id: row.messageId,
  });
  const afterCursor = (
    row: { ts: number | null; id: string },
    after: { timestampMs: number | null; id: string } | null | undefined
  ): boolean => {
    if (!after) return true;
    if (after.timestampMs === null) return row.ts === null && row.id < after.id;
    if (row.ts === null) return true;
    if (row.ts !== after.timestampMs) return row.ts < after.timestampMs;
    return row.id < after.id;
  };
  const descNullsLast = (
    a: { ts: number | null; id: string },
    b: { ts: number | null; id: string }
  ): number => {
    if (a.ts === null && b.ts === null) return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
    if (a.ts === null) return 1;
    if (b.ts === null) return -1;
    if (a.ts !== b.ts) return b.ts - a.ts;
    return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
  };
  const window = (limit?: number) => (limit === undefined ? 2000 : limit);

  // Mirror of the store's newest-status order: posting time, then arrival at the
  // store, then message id. The array index stands in for `created_at`, which the
  // stored row does not carry, and the fake watermark keeps the six fractional
  // digits the real SQL renders.
  const idDesc = (
    a: { row: StoredNovedadesStatus },
    b: { row: StoredNovedadesStatus }
  ): number => (a.row.messageId === b.row.messageId ? 0 : a.row.messageId > b.row.messageId ? -1 : 1);
  const newestStatusFirst = (
    a: { row: StoredNovedadesStatus; arrived: number },
    b: { row: StoredNovedadesStatus; arrived: number }
  ): number => {
    const [pa, pb] = [a.row.postedAt, b.row.postedAt];
    if (pa === null || pb === null) return pa === pb ? idDesc(a, b) : pa === null ? 1 : -1;
    if (pa !== pb) return pa < pb ? 1 : -1;
    if (a.arrived !== b.arrived) return b.arrived - a.arrived;
    return idDesc(a, b);
  };
  const arrivalWatermark = (postedAt: string | null, arrived: number): string =>
    `${(postedAt ?? '1970-01-01T00:00:00.000Z').slice(0, -5)}.${String(arrived).padStart(6, '0')}Z`;

  const store: NovedadesStoreReads = {
    statusAuthors: async () => {
      calls.push({ read: 'statusAuthors', args: [] });
      const grouped = new Map<string, Array<{ row: StoredNovedadesStatus; arrived: number }>>();
      (data.statuses ?? []).forEach((row, arrived) =>
        grouped.set(row.authorJid, [...(grouped.get(row.authorJid) ?? []), { row, arrived }])
      );
      return [...grouped.entries()]
        .map(([authorJid, entries]) => {
          const newest = [...entries].sort(newestStatusFirst)[0]!;
          const rows = entries.map(entry => entry.row);
          return {
            authorJid,
            total: rows.length,
            active: rows.filter(row => row.active).length,
            unseen: rows.filter(row => row.active && row.seenAt === null).length,
            latestPostedAt: newest.row.postedAt,
            latestStatusId: newest.row.messageId,
            latestReceivedAt: arrivalWatermark(newest.row.postedAt, newest.arrived),
          };
        })
        .filter(summary => summary.active > 0);
    },
    statuses: async options => {
      calls.push({ read: 'statuses', args: [options] });
      const authors = options?.authorJids?.map(author => jidNormalizedUser(author));
      const rows = (data.statuses ?? [])
        .filter(
          row =>
            (!authors?.length || authors.includes(row.authorJid)) &&
            (options?.includeExpired === true || row.active) &&
            (options?.unreadOnly !== true || row.seenAt === null) &&
            (options?.includeDeleted === true || !row.isDeleted) &&
            (!options?.visibility ||
              options.visibility === 'all' ||
              row.visibility === options.visibility)
        )
        .filter(row => afterCursor(keyOf(row), options?.after))
        .sort((a, b) => descNullsLast(keyOf(a), keyOf(b)));
      return rows.slice(0, window(options?.limit));
    },
    status: async (authorJid, messageId) => {
      calls.push({ read: 'status', args: [authorJid, messageId] });
      const author = jidNormalizedUser(authorJid);
      return (
        (data.statuses ?? []).find(
          row => row.authorJid === author && row.messageId === messageId && row.active
        ) ?? undefined
      );
    },
    channels: async options => {
      calls.push({ read: 'channels', args: [options] });
      const rows = (data.channels ?? [])
        .filter(channel => {
          if (!options?.after) return true;
          const name = channel.name.toLowerCase();
          const after = options.after.name.toLowerCase();
          return name > after || (name === after && channel.jid > options.after!.jid);
        })
        .sort((a, b) =>
          a.name.toLowerCase() === b.name.toLowerCase()
            ? a.jid === b.jid
              ? 0
              : a.jid < b.jid
                ? -1
                : 1
            : a.name.toLowerCase() < b.name.toLowerCase()
              ? -1
              : 1
        );
      return rows.slice(0, window(options?.limit));
    },
    channel: async channelJid => {
      calls.push({ read: 'channel', args: [channelJid] });
      return (data.channels ?? []).find(channel => channel.jid === channelJid) ?? undefined;
    },
    messages: async (channelJid, options) => {
      calls.push({ read: 'messages', args: [channelJid, options] });
      const rows = (data.messages ?? [])
        .filter(
          row =>
            row.channelJid === channelJid &&
            (options?.includeDeleted === true || !row.isDeleted) &&
            (options?.includeSuperseded === true || row.supersededBy === null) &&
            (!options?.visibility ||
              options.visibility === 'all' ||
              row.visibility === options.visibility)
        )
        .filter(row => afterCursor(keyOf(row), options?.after))
        .sort((a, b) => descNullsLast(keyOf(a), keyOf(b)));
      return rows.slice(0, window(options?.limit));
    },
    message: async (channelJid, messageId, options) => {
      calls.push({ read: 'message', args: [channelJid, messageId, options] });
      return (
        (data.messages ?? []).find(
          row =>
            row.channelJid === channelJid &&
            row.messageId === messageId &&
            (options?.includeSuperseded === true || row.supersededBy === null)
        ) ?? undefined
      );
    },
  };
  return { store, calls };
}

function readerFor(
  data: Parameters<typeof fakeStore>[0],
  ports: Parameters<typeof createNovedadesReader>[0] extends { ports?: infer P } ? P : never
): { reader: NovedadesReader; calls: Record_ } {
  const { store, calls } = fakeStore(data);
  return { reader: createNovedadesReader({ store, ports }), calls };
}

async function readAllPages(
  first: (
    cursor?: string
  ) => Promise<{ items: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null }>,
  maxPages = 20
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const page1 = await first(cursor);
    ids.push(...page1.items.map(item => item.id));
    if (!page1.hasMore) {
      assert.equal(page1.nextCursor, null, 'the last page must not hand back a cursor');
      return ids;
    }
    assert.ok(page1.nextCursor, 'hasMore requires a cursor');
    cursor = page1.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

test('a tied-timestamp status page still advances: 200 identical stamps at limit 50', async () => {
  const statuses = Array.from({ length: 200 }, (_, index) =>
    statusRow(AUTHOR, `S${String(index).padStart(3, '0')}`, T)
  );
  const { reader, calls } = readerFor({ statuses }, {});
  const seen = await readAllPages(cursor => reader.statuses({ author: AUTHOR, limit: 50, cursor }));
  assert.equal(seen.length, 200);
  assert.equal(new Set(seen).size, 200);
  assert.equal(seen[0], 'S199');
  assert.equal(seen[199], 'S000');
  assert.ok(calls.every(call => call.read !== 'status' && call.read !== 'channel'));
});

test('a tied-timestamp post page still advances: 120 identical stamps at limit 50', async () => {
  const messages = Array.from({ length: 120 }, (_, index) =>
    postRow(CHANNEL_A, `P${String(index).padStart(3, '0')}`, T)
  );
  const { reader } = readerFor({ messages, channels: [channelRow(CHANNEL_A, 'Canal A')] }, {});
  const seen = await readAllPages(cursor =>
    reader.posts({ channelJid: CHANNEL_A, limit: 50, cursor })
  );
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120);
});

test('statuses without a posting timestamp form a reachable tail, not a hole', async () => {
  const statuses = [
    statusRow(AUTHOR, 'WITH-1', T),
    statusRow(AUTHOR, 'NO-1', null),
    statusRow(AUTHOR, 'NO-2', null),
    statusRow(AUTHOR, 'WITH-2', T - 1000),
  ];
  const { reader } = readerFor({ statuses }, {});
  const seen = await readAllPages(cursor => reader.statuses({ author: AUTHOR, limit: 1, cursor }));
  assert.deepEqual(seen, ['WITH-1', 'WITH-2', 'NO-2', 'NO-1']);
});

test('channel paging advances across duplicated names', async () => {
  const channels = [
    channelRow(CHANNEL_A, 'Canal'),
    channelRow(CHANNEL_B, 'Canal'),
    channelRow('120363333333333333@newsletter', 'canal'),
  ];
  const { reader } = readerFor({ channels }, {});
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 6; page++) {
    const result = await reader.channels({ limit: 1, cursor });
    names.push(...result.channels.map(channel => channel.id));
    if (!result.hasMore) break;
    cursor = result.nextCursor ?? undefined;
  }
  assert.deepEqual(names, [CHANNEL_A, CHANNEL_B, '120363333333333333@newsletter']);
});

test('no field outside the whitelist reaches the JSON view', async () => {
  const statuses = [
    statusRow(AUTHOR, 'ST-MEDIA', T, {
      payload: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/netflow/SECRET-DIRECT-PATH',
          directPath: '/v2/t0/SECRET-DIRECT-PATH',
          mediaKey: 'SECRET-MEDIA-KEY',
          fileSha256: 'SECRET-SHA-256',
          mimetype: 'image/jpeg',
          caption: 'visible caption',
          fileLength: '1234',
        },
      },
      messageType: 'imageMessage',
    }),
  ];
  const messages = [
    postRow(CHANNEL_A, 'POST-MEDIA', T, {
      payload: {
        videoMessage: {
          url: 'https://mmg.whatsapp.net/netflow/SECRET-DIRECT-PATH',
          mediaKey: 'SECRET-MEDIA-KEY',
          mimetype: 'video/mp4',
          caption: 'post caption',
          seconds: 12,
        },
      },
      messageType: 'videoMessage',
    }),
  ];
  const channels = [
    channelRow(CHANNEL_A, 'Canal A', {
      avatarUrl: 'https://pps.whatsapp.net/v/t6 avatar.jpg',
      inviteCode: 'SECRETCODE',
      role: 'owner',
      rawMetadata: { invite_code: 'SECRETCODE' },
    }),
  ];
  const { reader } = readerFor({ statuses, messages, channels }, {});
  const [statusPage, postPage, channelPage] = await Promise.all([
    reader.statuses({ author: AUTHOR }),
    reader.posts({ channelJid: CHANNEL_A }),
    reader.channels({}),
  ]);
  const json = JSON.stringify({ statusPage, postPage, channelPage });
  assert.match(json, /visible caption/);
  assert.match(json, /post caption/);
  assert.match(json, /image\/jpeg/);
  for (const leaked of [
    'SECRET-MEDIA-KEY',
    'SECRET-DIRECT-PATH',
    'SECRET-SHA-256',
    'SECRETCODE',
    'mmg.whatsapp.net',
    'mediaKey',
    'directPath',
    'fileSha256',
    'inviteCode',
    'payload',
    'rawMetadata',
  ])
    assert.ok(!json.includes(leaked), `JSON must not carry ${leaked}`);
  assert.match(
    String(statusPage.items[0]?.mediaUrl),
    new RegExp(
      `^/api/v1/novedades/media\\?kind=status&jid=${AUTHOR.replace('@', '%40')}&messageId=ST-MEDIA$`
    )
  );
  assert.equal(statusPage.items[0]?.mediaSizeBytes, 1234);
  assert.equal(postPage.items[0]?.mediaKind, 'video');
  assert.equal(channelPage.channels[0]?.avatarAvailable, true);
  assert.equal(
    channelPage.channels[0]?.avatarUrl,
    `/api/v1/novedades/media?kind=avatar&jid=${CHANNEL_A.replace('@', '%40')}`
  );
});

test('channel roles decide `subscribed` and unknown roles stay unknown', () => {
  assert.equal(subscribedFromRole('owner'), true);
  assert.equal(subscribedFromRole('ADMIN'), true);
  assert.equal(subscribedFromRole(' subscriber '), true);
  assert.equal(subscribedFromRole('guest'), false);
  assert.equal(subscribedFromRole('eligible'), false);
  for (const unknown of [null, '', 'undefined', 'promoter', '42'])
    assert.equal(subscribedFromRole(unknown), null);
});

test('the account is recognized from a device JID including its realm', async () => {
  const statuses = [statusRow(AUTHOR, 'OWN-1', T), statusRow(OTHER, 'OTHER-1', T)];
  const { reader } = readerFor({ statuses }, { ownJid: () => '34600123456:7@s.whatsapp.net' });
  const result = await reader.statusAuthors();
  const own = result.authors.find(author => author.id === AUTHOR);
  const other = result.authors.find(author => author.id === OTHER);
  assert.equal(own?.own, true);
  assert.equal(other?.own, false);
  assert.equal(own?.count, 1);
  assert.equal(own?.total, 1);
  assert.equal(own?.unseen, 1);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, null);
  assert.equal(result.account, 'personal');
});

test('two statuses in the same second stay distinguishable when ids arrive reversed', async () => {
  const before = await readerFor({ statuses: [statusRow(AUTHOR, 'ZZZ-FIRST', T)] }, {}).reader.statusAuthors();
  const first = before.authors.find(author => author.id === AUTHOR);
  assert.equal(first?.latestTimestamp, new Date(T).toISOString());
  assert.equal(first?.latestStatusId, 'ZZZ-FIRST');

  // Same posting second, provider id that sorts BEFORE the one already seen.
  const after = await readerFor(
    { statuses: [statusRow(AUTHOR, 'ZZZ-FIRST', T), statusRow(AUTHOR, 'AAA-SECOND', T)] },
    {}
  ).reader.statusAuthors();
  const second = after.authors.find(author => author.id === AUTHOR);
  assert.equal(second?.latestTimestamp, first?.latestTimestamp, 'the posting second did not move');
  assert.equal(second?.latestStatusId, 'AAA-SECOND', 'arrival beats a backwards-sorting id');
  assert.equal(second?.unseen, 2);
  assert.match(String(first?.latestReceivedAt), /\.\d{6}Z$/, 'watermark keeps microseconds');
  assert.notEqual(second?.latestReceivedAt, first?.latestReceivedAt);

  // What a client has to compare: the tuple grows when the new post landed.
  const tuple = (a: typeof first) => JSON.stringify([a?.latestTimestamp, a?.latestReceivedAt, a?.latestStatusId]);
  assert.ok(tuple(second) > tuple(first), 'the author signals a new status');
});

test('an injected store without the identity columns reads as null instead of crashing', async () => {
  const legacy = {
    statusAuthors: async () => [
      {
        authorJid: AUTHOR,
        total: 1,
        active: 1,
        unseen: 1,
        latestPostedAt: new Date(T).toISOString(),
      },
    ],
  } as unknown as NovedadesStoreReads;
  const [author] = (await createNovedadesReader({ store: legacy }).statusAuthors()).authors;
  assert.equal(author?.latestTimestamp, new Date(T).toISOString());
  assert.equal(author?.latestStatusId, null);
  assert.equal(author?.latestReceivedAt, null);
});

test('author summaries declare what the store cannot know', async () => {
  const { reader } = readerFor({ statuses: [statusRow(AUTHOR, 'OWN-1', T)] }, {});
  const result = await reader.statusAuthors();
  assert.equal(result.authors[0]?.name, null);
  assert.equal(result.coverage.authorNames, false);
  const channels = await reader.channels({});
  assert.equal(channels.coverage.channelLatestPost, false);
  assert.equal(channels.coverage.remoteListing, false);
  assert.equal(channels.coverage.backfilled, false);
  assert.equal(channels.coverage.syncedAt, null);
  assert.equal(channels.coverage.mediaDownloadsWired, false);
  assert.equal(channels.coverage.avatarDownloadsWired, false);
  assert.deepEqual(channels.coverage.reasons, [
    'session-scoped-history',
    'no-remote-subscription-listing',
    'no-history-backfill',
    'avatar-not-refreshed-on-read',
  ]);
});

test('avatar hosts are matched dot-bounded so look-alikes fail', () => {
  const allowed = [
    'https://pps.whatsapp.net/avatar.jpg',
    'https://example.whatsapp.com/x.png',
    'https://lookaside.fbsbx.com/x',
    'https://scontent-mad1-1.xx.fbcdn.net/x.jpg',
  ];
  for (const url of allowed) assert.equal(avatarHostAllowed(new URL(url)), true, url);
  for (const url of [
    'https://evilwhatsapp.net/avatar.jpg',
    'https://whatsapp.net.evil.com/x',
    'https://fbcdn.net.attacker.example/x',
    'https://notwa.me/x',
    'http://pps.whatsapp.net/x',
  ])
    assert.equal(avatarHostAllowed(new URL(url)), false, url);
});

test('cursors are opaque, scoped, and refused when tampered with', async () => {
  const statuses = [
    statusRow(AUTHOR, 'A-1', T),
    statusRow(AUTHOR, 'A-2', T - 1),
    statusRow(OTHER, 'B-1', T),
  ];
  // The sentinel post and channel keep `posts`/`channels` from yielding a
  // non-null nextCursor: the cross-listing cases below can only prove the
  // kind check if the cursors they hand over are real issued cursors.
  const messages = [
    postRow(CHANNEL_A, 'PA-1', T),
    postRow(CHANNEL_A, 'PA-0', T - 1),
    postRow(CHANNEL_B, 'PB-1', T),
  ];
  const { reader } = readerFor(
    {
      statuses,
      messages,
      channels: [channelRow(CHANNEL_A, 'Canal A'), channelRow(CHANNEL_B, 'Canal B')],
    },
    {}
  );
  const statusPage = await reader.statuses({ author: AUTHOR, limit: 1 });
  assert.ok(statusPage.nextCursor);
  assert.match(String(statusPage.nextCursor), /^[A-Za-z0-9_-]+$/);
  const postPage = await reader.posts({ channelJid: CHANNEL_A, limit: 1 });
  const channelPage = await reader.channels({ limit: 1 });
  const cases: Array<() => Promise<unknown>> = [
    () => reader.statuses({ author: OTHER, limit: 1, cursor: statusPage.nextCursor }),
    () => reader.statuses({ limit: 1, cursor: statusPage.nextCursor }),
    () => reader.posts({ channelJid: CHANNEL_B, limit: 1, cursor: statusPage.nextCursor }),
    () => reader.posts({ channelJid: CHANNEL_A, limit: 1, cursor: channelPage.nextCursor }),
    () => reader.channels({ limit: 1, cursor: postPage.nextCursor }),
    () => reader.statuses({ author: AUTHOR, limit: 1, cursor: 'not-base64!!' }),
    () => reader.statuses({ author: AUTHOR, limit: 1, cursor: 'e30=' }),
    () =>
      reader.statuses({
        author: AUTHOR,
        limit: 1,
        cursor: encodeNovedadesCursor({ k: 's', s: AUTHOR, t: 'soon', i: 'A-1' }),
      }),
    () =>
      reader.statuses({
        author: AUTHOR,
        limit: 1,
        cursor: encodeNovedadesCursor({ k: 's', s: AUTHOR, t: '-5', i: 'A-1' }),
      }),
    () =>
      reader.statuses({
        author: AUTHOR,
        limit: 1,
        cursor: encodeNovedadesCursor({ k: 's', s: AUTHOR, t: '12345678901234567', i: 'A-1' }),
      }),
    () =>
      reader.statuses({
        author: AUTHOR,
        limit: 1,
        cursor: encodeNovedadesCursor({ k: 's', s: AUTHOR, t: String(T), i: '' }),
      }),
    () =>
      reader.statuses({
        author: AUTHOR,
        limit: 1,
        cursor: encodeNovedadesCursor({
          k: 's',
          s: `${AUTHOR} padded ${'x'.repeat(300)}`,
          t: String(T),
          i: 'A-1',
        }),
      }),
    () =>
      reader.statuses({
        author: AUTHOR,
        limit: 1,
        cursor: `${statusPage.nextCursor}${'A'.repeat(8192)}`,
      }),
  ];
  for (const run of cases)
    await assert.rejects(
      run,
      (error: unknown) =>
        error instanceof NovedadesReaderError && error.code === 'NOVEDADES_CURSOR_INVALID',
      'cursor must be rejected'
    );
  const reused = await reader.statuses({ author: AUTHOR, limit: 1, cursor: statusPage.nextCursor });
  assert.deepEqual(
    reused.items.map(item => item.id),
    ['A-2']
  );
});

test('input validation fails before the store is asked', async () => {
  const { reader, calls } = readerFor({ statuses: [statusRow(AUTHOR, 'A-1', T)] }, {});
  const bad: Array<() => Promise<unknown>> = [
    () => reader.statuses({ limit: 0 }),
    () => reader.statuses({ limit: NOVEDADES_PAGE_MAX + 1 }),
    () => reader.statuses({ limit: '1.5' }),
    () => reader.statuses({ includeExpired: 'maybe' }),
    () => reader.statuses({ visibility: 'everything' }),
    () => reader.statuses({ author: ' ' }),
    () => reader.posts({ channelJid: '34600123456@s.whatsapp.net' }),
    () => reader.posts({ channelJid: '' }),
    () => reader.post({ channelJid: CHANNEL_A, messageId: ' ' }),
    () => reader.media({ kind: 'sticker', jid: CHANNEL_A, messageId: 'P-1' }),
    () => reader.media({ kind: 'channel', jid: CHANNEL_A }),
  ];
  for (const run of bad)
    await assert.rejects(
      run,
      (error: unknown) =>
        error instanceof NovedadesReaderError && error.status === 400 && Boolean(error.code)
    );
  assert.equal(calls.length, 0);
});

test('listing pages report the real window instead of hiding a truncation', async () => {
  const statuses = Array.from({ length: 3 }, (_, index) =>
    statusRow(AUTHOR, `S${index}`, T - index)
  );
  const { reader } = readerFor({ statuses }, {});
  const page = await reader.statuses({ author: AUTHOR, limit: 2 });
  assert.equal(page.limit, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.overlapPossible, false);
  assert.equal(page.truncated, false);
  assert.equal(page.items.length, 2);
  assert.equal(page.account, 'personal');
  assert.ok(page.serverTime);
});

test('an exactly-full final page reports no next page', async () => {
  // Pin the probe-row contract against a future "full page always has more"
  // rewrite: the store saw limit+1 rows on page one, so only page one may
  // claim another page; the exactly-full final page must not.
  const statuses = [statusRow(AUTHOR, 'F-1', T), statusRow(AUTHOR, 'F-0', T - 1)];
  const { reader } = readerFor({ statuses }, {});
  const first = await reader.statuses({ author: AUTHOR, limit: 1 });
  assert.equal(first.hasMore, true);
  const last = await reader.statuses({ author: AUTHOR, limit: 1, cursor: first.nextCursor });
  assert.equal(last.items.length, 1);
  assert.equal(last.hasMore, false, 'an exactly-full final page must not claim another page');
  assert.equal(last.nextCursor, null);
});

test('post pages carry the stored channel as an object, or null when unknown', async () => {
  const messages = [postRow(CHANNEL_A, 'P-1', T)];
  const withChannel = readerFor(
    { messages, channels: [channelRow(CHANNEL_A, 'Canal A', { role: 'subscriber' })] },
    {}
  );
  const page = await withChannel.reader.posts({ channelJid: CHANNEL_A });
  assert.equal(page.channel?.id, CHANNEL_A);
  assert.equal(page.channel?.name, 'Canal A');
  assert.equal(page.channel?.subscribed, true);
  assert.equal(page.channel?.latestTimestamp, null);
  const withoutChannel = readerFor({ messages }, {});
  const bare = await withoutChannel.reader.posts({ channelJid: CHANNEL_A });
  assert.equal(bare.channel, null);
  assert.equal(bare.items.length, 1);
});

test('media reads exactly one row and never scans a listing', async () => {
  const bytes = Buffer.from('status-bytes');
  const messages = [postRow(CHANNEL_A, 'P-1', T, { payload: mediaPayload('image/jpeg') })];
  const statuses = [
    statusRow(AUTHOR, 'ST-1', T, {
      payload: mediaPayload('video/mp4'),
      messageType: 'videoMessage',
    }),
  ];
  let downloads = 0;
  const { reader, calls } = readerFor(
    { messages, statuses },
    {
      downloadMedia: async request => {
        downloads++;
        assert.ok(request.key, 'the stored key must reach the downloader');
        assert.ok(request.message, 'the stored payload must reach the downloader');
        return { buffer: bytes, mimeType: 'video/mp4', fileName: 'status.mp4' };
      },
    }
  );
  const statusMedia = await reader.media({ kind: 'status', jid: AUTHOR, messageId: 'ST-1' });
  assert.deepEqual(statusMedia.bytes, bytes);
  assert.equal(statusMedia.mimeType, 'video/mp4');
  assert.equal(statusMedia.fileName, 'status.mp4');
  const postMedia = await reader.media({ kind: 'channel', jid: CHANNEL_A, messageId: 'P-1' });
  assert.deepEqual(postMedia.bytes, bytes);
  assert.equal(downloads, 2);
  assert.deepEqual(
    calls.map(call => call.read),
    ['status', 'message']
  );
  assert.ok(!calls.some(call => call.read === 'statuses' || call.read === 'messages'));
});

function mediaPayload(mimeType: string): Record<string, unknown> {
  const kind = mimeType.startsWith('image/') ? 'imageMessage' : 'videoMessage';
  return {
    [kind]: {
      url: 'https://mmg.whatsapp.net/netflow/path',
      mediaKey: 'KEY',
      directPath: '/v2/path',
      mimetype: mimeType,
      fileLength: '10',
    },
  };
}

test('media says honestly when it cannot deliver instead of inventing bytes', async () => {
  const statuses = [
    statusRow(AUTHOR, 'ST-1', T, {
      payload: mediaPayload('image/jpeg'),
      messageType: 'imageMessage',
    }),
  ];
  const channels = [channelRow(CHANNEL_A, 'Canal A')];
  const expect = async (
    run: () => Promise<unknown>,
    code: string,
    status: number,
    label: string
  ): Promise<void> => {
    await assert.rejects(
      run,
      (error: unknown) =>
        error instanceof NovedadesReaderError && error.code === code && error.status === status,
      label
    );
  };
  const unwired = readerFor({ statuses, channels }, {});
  await expect(
    () => unwired.reader.media({ kind: 'status', jid: AUTHOR, messageId: 'ST-1' }),
    'NOVEDADES_MEDIA_UNSUPPORTED',
    501,
    'unwired downloader'
  );
  await expect(
    () => unwired.reader.media({ kind: 'avatar', jid: CHANNEL_A }),
    'NOVEDADES_AVATAR_UNSUPPORTED',
    501,
    'unwired avatar fetcher'
  );
  const noBytes = readerFor({ statuses, channels }, { downloadMedia: async () => null });
  await expect(
    () => noBytes.reader.media({ kind: 'status', jid: AUTHOR, messageId: 'ST-1' }),
    'NOVEDADES_MEDIA_UNAVAILABLE',
    404,
    'provider returned no bytes'
  );
  const broken = readerFor(
    { statuses, channels },
    {
      downloadMedia: async () => {
        throw new Error('socket closed');
      },
    }
  );
  await expect(
    () => broken.reader.media({ kind: 'status', jid: AUTHOR, messageId: 'ST-1' }),
    'NOVEDADES_MEDIA_FAILED',
    502,
    'download failure'
  );
  const tooBig = readerFor(
    { statuses, channels },
    {
      downloadMedia: async () => ({
        buffer: Buffer.alloc(NOVEDADES_MEDIA_MAX_BYTES + 1, 7),
        mimeType: 'video/mp4',
      }),
    }
  );
  await expect(
    () => tooBig.reader.media({ kind: 'status', jid: AUTHOR, messageId: 'ST-1' }),
    'NOVEDADES_MEDIA_TOO_LARGE',
    413,
    'cap'
  );
  const missing = readerFor({ statuses, channels }, { downloadMedia: async () => null });
  await expect(
    () => missing.reader.media({ kind: 'status', jid: AUTHOR, messageId: 'NOPE' }),
    'NOVEDADES_MEDIA_NOT_FOUND',
    404,
    'unknown status id'
  );
  await expect(
    () => missing.reader.media({ kind: 'channel', jid: CHANNEL_A, messageId: 'NOPE' }),
    'NOVEDADES_MEDIA_NOT_FOUND',
    404,
    'unknown post id'
  );
  const textOnly = readerFor(
    { statuses: [statusRow(AUTHOR, 'ST-TEXT', T)], channels },
    { downloadMedia: async () => null }
  );
  await expect(
    () => textOnly.reader.media({ kind: 'status', jid: AUTHOR, messageId: 'ST-TEXT' }),
    'NOVEDADES_MEDIA_UNAVAILABLE',
    404,
    'no media in that row'
  );
});

test('avatar bytes come from the stored reference only, with the size cap applied', async () => {
  const channels = [
    channelRow(CHANNEL_A, 'Canal A', { avatarUrl: 'https://pps.whatsapp.net/v/t6/a.jpg' }),
    channelRow(CHANNEL_B, 'Canal B', { avatarUrl: 'https://insecure.example/a.jpg' }),
    channelRow('120363333333333333@newsletter', 'Canal C', { avatarUrl: 'not a url' }),
  ];
  let fetched: string[] = [];
  const { reader, calls } = readerFor(
    { channels },
    {
      fetchAvatar: async url => {
        fetched.push(url);
        return Buffer.from('avatar');
      },
    }
  );
  const avatar = await reader.media({ kind: 'avatar', jid: CHANNEL_A });
  assert.equal(avatar.mimeType, 'image/jpeg');
  assert.deepEqual(fetched, ['https://pps.whatsapp.net/v/t6/a.jpg']);
  assert.deepEqual(
    calls.map(call => call.read),
    ['channel']
  );
  fetched = [];
  for (const [jid, code] of [
    [CHANNEL_B, 'NOVEDADES_AVATAR_UNAVAILABLE'],
    ['120363333333333333@newsletter', 'NOVEDADES_AVATAR_UNAVAILABLE'],
    ['120363444444444444@newsletter', 'NOVEDADES_AVATAR_UNAVAILABLE'],
  ] as Array<[string, string]>) {
    await assert.rejects(
      () => reader.media({ kind: 'avatar', jid }),
      (error: unknown) =>
        error instanceof NovedadesReaderError && error.code === code && error.status === 404,
      jid
    );
  }
  assert.deepEqual(fetched, []);
  const oversized = readerFor(
    { channels },
    {
      fetchAvatar: async () => Buffer.alloc(NOVEDADES_MEDIA_MAX_BYTES + 1, 9),
    }
  );
  await assert.rejects(
    () => oversized.reader.media({ kind: 'avatar', jid: CHANNEL_A }),
    (error: unknown) =>
      error instanceof NovedadesReaderError &&
      error.code === 'NOVEDADES_MEDIA_TOO_LARGE' &&
      error.status === 413
  );
  const emptyAvatar = readerFor({ channels }, { fetchAvatar: async () => Buffer.alloc(0) });
  await assert.rejects(
    () => emptyAvatar.reader.media({ kind: 'avatar', jid: CHANNEL_A }),
    (error: unknown) =>
      error instanceof NovedadesReaderError &&
      error.code === 'NOVEDADES_AVATAR_UNAVAILABLE' &&
      error.status === 404
  );
});

test('the reader only ever calls reads and leaves stored rows untouched', async () => {
  const statuses = [
    statusRow(AUTHOR, 'ST-1', T, {
      payload: mediaPayload('image/jpeg'),
      messageType: 'imageMessage',
    }),
  ];
  const messages = [postRow(CHANNEL_A, 'P-1', T, { payload: mediaPayload('image/jpeg') })];
  const channels = [
    channelRow(CHANNEL_A, 'Canal A', { avatarUrl: 'https://pps.whatsapp.net/a.jpg' }),
  ];
  const before = JSON.stringify({ statuses, messages, channels });
  const { reader, calls } = readerFor(
    { statuses, messages, channels },
    {
      downloadMedia: async () => ({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
      fetchAvatar: async () => Buffer.from('x'),
      ownJid: () => '34600123456:2@s.whatsapp.net',
    }
  );
  await reader.statusAuthors();
  await reader.statuses({ author: AUTHOR });
  await reader.channels({});
  await reader.posts({ channelJid: CHANNEL_A });
  await reader.post({ channelJid: CHANNEL_A, messageId: 'P-1' });
  await reader.media({ kind: 'status', jid: AUTHOR, messageId: 'ST-1' });
  await reader.media({ kind: 'channel', jid: CHANNEL_A, messageId: 'P-1' });
  await reader.media({ kind: 'avatar', jid: CHANNEL_A });
  assert.equal(JSON.stringify({ statuses, messages, channels }), before);
  const writes = ['store', 'save', 'delete', 'mark', 'upsert', 'insert', 'reconcile'];
  for (const call of calls)
    assert.ok(
      !writes.some(write => call.read.includes(write)),
      `${call.read} is not a read-only call`
    );
});

test('errors become a bounded envelope with the code the caller can act on', () => {
  assert.deepEqual(novedadesErrorBody(new NovedadesReaderError('CODE_A', 'msg', 409)), {
    status: 409,
    body: { ok: false, error: { code: 'CODE_A', message: 'msg' } },
  });
  const generic = novedadesErrorBody(new Error('private provider URL and message ID'));
  assert.equal(generic.status, 500);
  assert.equal(generic.body.error.code, 'NOVEDADES_READER_ERROR');
  assert.equal(generic.body.error.message, 'Novedades could not complete the request');
});

test('Range parsing covers single, suffix, open and rejected ranges', () => {
  assert.deepEqual(parseByteRange('bytes=0-1', 10), { start: 0, end: 1 });
  assert.deepEqual(parseByteRange('bytes=9-', 10), { start: 9, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange('bytes=0-999', 10), { start: 0, end: 9 });
  assert.equal(parseByteRange('bytes=10-20', 10), undefined);
  assert.equal(parseByteRange('bytes=5-2', 10), undefined);
  assert.equal(parseByteRange('bytes=0-1,4-5', 10), undefined);
  assert.equal(parseByteRange('items=0-1', 10), undefined);
  assert.equal(parseByteRange(undefined, 10), undefined);
  assert.equal(parseByteRange('bytes=-0', 10), undefined);
  assert.equal(parseByteRange('bytes=0-1', 0), undefined);
});

/* --------------------------------------------------------------------------
 * HTTP surface
 * ------------------------------------------------------------------------ */

const secret = 'novedades-reader-test-secret';

test('connector uses rc13 fileLength number/Long and refuses disconnected media before fetch', async () => {
  const client = Object.create(BaileysClient.prototype) as BaileysClient;
  Object.assign(client, { ready: false });
  const key = { id: 'fixture-media', remoteJid: CHANNEL_A };
  await assert.rejects(
    () => client.downloadNovedadesMedia({ key }),
    (error: unknown) => error instanceof NovedadesReaderError && error.status === 503
  );
  Object.assign(client, { ready: true });
  for (const field of [
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'documentMessage',
    'stickerMessage',
  ]) {
    for (const representation of ['number', 'Long', 'JSONB']) {
      const content = { [field]: { fileLength: NOVEDADES_MEDIA_MAX_BYTES + 1 } };
      const long = proto.Message.fromObject(content);
      const message =
        representation === 'number'
          ? content
          : representation === 'Long'
            ? long
            : {
                [field]: {
                  fileLength: { low: NOVEDADES_MEDIA_MAX_BYTES + 1, high: 0, unsigned: true },
                },
              };
      await assert.rejects(
        () => client.downloadNovedadesMedia({ key, message }),
        (error: unknown) => error instanceof NovedadesReaderError && error.status === 413
      );
    }
  }
});

test('avatar redirects validate the next host before fetching and cap actual bytes', async () => {
  const original = globalThis.fetch;
  const targets: string[] = [];
  let cancelled = 0;
  try {
    globalThis.fetch = async (input, options) => {
      targets.push(String(input));
      assert.equal(options?.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    };
    await assert.rejects(
      () => fetchNovedadesAvatar('https://pps.whatsapp.net/avatar'),
      (error: unknown) => error instanceof NovedadesReaderError && error.status === 404
    );
    assert.deepEqual(targets, ['https://pps.whatsapp.net/avatar']);
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(NOVEDADES_MEDIA_MAX_BYTES + 1));
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { 'content-length': '1' } }
      );
    await assert.rejects(
      () => fetchNovedadesAvatar('https://pps.whatsapp.net/avatar'),
      (error: unknown) => error instanceof NovedadesReaderError && error.status === 413
    );
    assert.equal(cancelled, 1);
    globalThis.fetch = async () => new Response('avatar');
    assert.equal(
      (await fetchNovedadesAvatar('https://pps.whatsapp.net/avatar'))?.toString(),
      'avatar'
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('connector decrypts rc13 media fixtures and rejects actual bytes beyond a false declared length', async () => {
  const client = Object.create(BaileysClient.prototype) as BaileysClient;
  const warnings: string[] = [];
  let writes = 0;
  Object.assign(client, {
    ready: true,
    logger: { warn: (message: string) => warnings.push(message) },
    sock: {
      updateMediaMessage: () => {
        writes++;
        throw new Error('unexpected reupload');
      },
    },
  });
  const mediaKey = Buffer.alloc(32, 7);
  const { cipherKey, iv } = await getMediaKeys(mediaKey, 'image');
  const original = globalThis.fetch;
  const message = {
    key: { id: 'private-id', remoteJid: CHANNEL_A },
    message: {
      imageMessage: {
        url: 'https://mmg.whatsapp.net/private-fixture',
        mediaKey,
        fileLength: 1,
        mimetype: 'image/jpeg',
      },
    },
  };
  try {
    for (const size of [13, NOVEDADES_MEDIA_MAX_BYTES + 1]) {
      const plain = Buffer.alloc(size, 4);
      const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      globalThis.fetch = async () => new Response(encrypted);
      if (size === 13) {
        const result = await client.downloadNovedadesMedia(message);
        assert.deepEqual(result?.buffer, plain);
        assert.equal(result?.mimeType, 'image/jpeg');
      } else {
        await assert.rejects(
          () => client.downloadNovedadesMedia(message),
          (error: unknown) => error instanceof NovedadesReaderError && error.status === 413
        );
      }
    }
    globalThis.fetch = async () => {
      throw new Error('provider private URL and ID');
    };
    await assert.rejects(
      () => client.downloadNovedadesMedia(message),
      (error: unknown) => error instanceof NovedadesReaderError && error.status === 502
    );
    assert.deepEqual(warnings, ['Novedades media download failed']);
    assert.equal(writes, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('stream download accepts the exact cap and destroys on actual byte overflow', async () => {
  const exact = Readable.from([Buffer.from('123'), Buffer.from('45')]);
  assert.equal((await readNovedadesMediaStream(async () => exact, 1000, 5)).toString(), '12345');
  assert.equal(exact.destroyed, true);
  const oversized = Readable.from([Buffer.from('123'), Buffer.from('456')]);
  await assert.rejects(
    () => readNovedadesMediaStream(async () => oversized, 1000, 5),
    (error: unknown) => error instanceof NovedadesReaderError && error.status === 413
  );
  assert.equal(oversized.destroyed, true);
});

test('stream deadline destroys an active stream and a stream returned after expiry', async () => {
  const active = new PassThrough();
  await assert.rejects(
    () => readNovedadesMediaStream(async () => active, 10),
    (error: unknown) => error instanceof NovedadesReaderError && error.status === 504
  );
  assert.equal(active.destroyed, true);
  let deliver!: (stream: Readable) => void;
  const late = new PassThrough();
  await assert.rejects(
    () =>
      readNovedadesMediaStream(
        () =>
          new Promise(resolve => {
            deliver = resolve;
          }),
        10
      ),
    (error: unknown) => error instanceof NovedadesReaderError && error.status === 504
  );
  deliver(late);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(late.destroyed, true);
});

test('stream provider errors clean up without returning partial bytes', async () => {
  const broken = new PassThrough();
  const result = readNovedadesMediaStream(async () => broken, 1000);
  broken.write('partial');
  setImmediate(() => broken.destroy(new Error('fixture provider failure')));
  await assert.rejects(result, /fixture provider failure/);
  assert.equal(broken.destroyed, true);
});

async function appFor(client: Record<string, unknown>, reader?: NovedadesReader) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createRouter(client as never, {} as never, secret, reader));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  return { base, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function headers() {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'x-connector-timestamp': String(timestamp),
    'x-connector-signature': generateHMACSignature({}, timestamp, secret),
  };
}

function stubPool(rows: unknown[]): () => void {
  const original = pg.Pool.prototype.query as unknown;
  pg.Pool.prototype.query = (() => Promise.resolve({ rows, rowCount: rows.length })) as never;
  return () => {
    pg.Pool.prototype.query = original as never;
  };
}

const ROUTES = [
  '/novedades/status/authors',
  '/novedades/status',
  '/novedades/channels',
  `/novedades/channels/${encodeURIComponent(CHANNEL_A)}/posts`,
  '/novedades/media?kind=avatar&jid=120363111111111111%40newsletter',
];

test('every Novedades read route requires HMAC before touching the store', async () => {
  let queries = 0;
  const original = pg.Pool.prototype.query as unknown;
  pg.Pool.prototype.query = (() => {
    queries++;
    return Promise.resolve({ rows: [], rowCount: 0 });
  }) as never;
  const app = await appFor({ isConnected: () => true });
  try {
    for (const route of ROUTES) {
      const response = await fetch(app.base + route);
      assert.equal(response.status, 401, route);
    }
    assert.equal(queries, 0);
  } finally {
    pg.Pool.prototype.query = original as never;
    await app.close();
  }
});

test('the live wiring reports media as unwired until the connector can download', async () => {
  const restore = stubPool([]);
  const without = await appFor({ isConnected: () => true });
  const withMedia = await appFor({
    isConnected: () => true,
    downloadNovedadesMedia: async () => ({ buffer: Buffer.from('x') }),
  });
  try {
    const before = await fetch(`${without.base}/novedades/status/authors`, { headers: headers() });
    assert.equal(before.status, 200);
    const beforeBody = await before.json();
    assert.equal(beforeBody.ok, true);
    assert.equal(beforeBody.account, 'personal');
    assert.equal(beforeBody.coverage.mediaDownloadsWired, false);
    assert.equal(beforeBody.coverage.avatarDownloadsWired, true);
    assert.deepEqual(beforeBody.authors, []);
    const after = await fetch(`${withMedia.base}/novedades/status/authors`, { headers: headers() });
    assert.equal((await after.json()).coverage.mediaDownloadsWired, true);
  } finally {
    restore();
    await without.close();
    await withMedia.close();
  }
});

function httpReaderData() {
  return {
    // ST-0 is the row past the limit=1 page: it is what makes the envelope
    // assertion `hasMore: true` a measured fact rather than a guess.
    statuses: [
      statusRow(AUTHOR, 'ST-1', T, {
        payload: mediaPayload('image/jpeg'),
        messageType: 'imageMessage',
      }),
      statusRow(AUTHOR, 'ST-0', T - 1),
    ],
    messages: [postRow(CHANNEL_A, 'P-1', T, { payload: mediaPayload('image/jpeg') })],
    channels: [
      channelRow(CHANNEL_A, 'Canal A', {
        role: 'owner',
        avatarUrl: 'https://pps.whatsapp.net/a.jpg',
      }),
    ],
  };
}

test('list routes return the documented success envelope', async () => {
  const { reader } = readerFor(httpReaderData(), {});
  const app = await appFor({ isConnected: () => true }, reader);
  try {
    const statuses = await fetch(
      `${app.base}/novedades/status?author=${encodeURIComponent(AUTHOR)}&limit=1`,
      { headers: headers() }
    );
    assert.equal(statuses.status, 200);
    const statusBody = await statuses.json();
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.account, 'personal');
    assert.equal(statusBody.items.length, 1);
    assert.equal(statusBody.items[0].author, AUTHOR);
    assert.equal(statusBody.hasMore, true);
    assert.equal(statusBody.overlapPossible, false);
    assert.equal(typeof statusBody.serverTime, 'string');
    assert.equal(statusBody.coverage.source, 'local-store');

    const channels = await fetch(`${app.base}/novedades/channels`, { headers: headers() });
    const channelBody = await channels.json();
    assert.equal(channelBody.channels[0].id, CHANNEL_A);
    assert.equal(channelBody.channels[0].subscribed, true);

    const posts = await fetch(
      `${app.base}/novedades/channels/${encodeURIComponent(CHANNEL_A)}/posts`,
      { headers: headers() }
    );
    const postBody = await posts.json();
    assert.equal(postBody.channel.id, CHANNEL_A);
    assert.equal(postBody.channel.name, 'Canal A');
    assert.equal(postBody.items[0].id, 'P-1');

    const one = await fetch(
      `${app.base}/novedades/channels/${encodeURIComponent(CHANNEL_A)}/posts/P-1`,
      { headers: headers() }
    );
    const oneBody = await one.json();
    assert.equal(oneBody.ok, true);
    assert.equal(oneBody.item.id, 'P-1');
    const missing = await fetch(
      `${app.base}/novedades/channels/${encodeURIComponent(CHANNEL_A)}/posts/NOPE`,
      { headers: headers() }
    );
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'NOVEDADES_POST_NOT_FOUND');

    const badLimit = await fetch(`${app.base}/novedades/channels?limit=900`, {
      headers: headers(),
    });
    assert.equal(badLimit.status, 400);
    assert.equal((await badLimit.json()).error.code, 'NOVEDADES_LIMIT_INVALID');
  } finally {
    await app.close();
  }
});

test('media answers JSON by default and binary with ranges on request', async () => {
  const bytes = Buffer.from('0123456789');
  const { reader } = readerFor(httpReaderData(), {
    downloadMedia: async () => ({ buffer: bytes, mimeType: 'image/jpeg', fileName: 'foto.jpg' }),
    fetchAvatar: async () => bytes,
  });
  const app = await appFor({ isConnected: () => true }, reader);
  const target = `/novedades/media?kind=channel&jid=${encodeURIComponent(CHANNEL_A)}&messageId=P-1`;
  try {
    const json = await fetch(app.base + target, { headers: headers() });
    assert.equal(json.status, 200);
    const body = await json.json();
    assert.equal(body.ok, true);
    assert.equal(body.account, 'personal');
    assert.equal(body.data.size, bytes.length);
    assert.equal(body.data.mimeType, 'image/jpeg');
    assert.equal(body.data.fileName, 'foto.jpg');
    assert.equal(Buffer.from(body.data.base64, 'base64').toString('utf8'), '0123456789');
    assert.equal(Buffer.from(body.data.base64, 'base64').toString('base64'), body.data.base64);

    const full = await fetch(`${app.base}${target}&raw=1`, { headers: headers() });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('content-type'), 'image/jpeg');
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(full.headers.get('cache-control'), 'private, no-store');
    assert.equal(Buffer.from(await full.arrayBuffer()).equals(bytes), true);

    const slice = await fetch(`${app.base}${target}&raw=1`, {
      headers: { ...headers(), range: 'bytes=2-4' },
    });
    assert.equal(slice.status, 206);
    assert.equal(slice.headers.get('content-range'), 'bytes 2-4/10');
    assert.equal(await slice.text(), '234');

    const suffix = await fetch(`${app.base}${target}&raw=1`, {
      headers: { ...headers(), range: 'bytes=-3' },
    });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get('content-range'), 'bytes 7-9/10');

    const unsatisfiable = await fetch(`${app.base}${target}&raw=1`, {
      headers: { ...headers(), range: 'bytes=100-120' },
    });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */10');

    const multi = await fetch(`${app.base}${target}&raw=1`, {
      headers: { ...headers(), range: 'bytes=0-1,4-5' },
    });
    assert.equal(multi.status, 200);
    assert.equal(Buffer.from(await multi.arrayBuffer()).equals(bytes), true);

    const avatar = await fetch(
      `${app.base}/novedades/media?kind=avatar&jid=${encodeURIComponent(CHANNEL_A)}`,
      { headers: headers() }
    );
    assert.equal(avatar.status, 200);
    assert.equal((await avatar.json()).data.size, bytes.length);
  } finally {
    await app.close();
  }
});

test('a connector that cannot download answers 501 instead of an empty body', async () => {
  const { reader } = readerFor(httpReaderData(), {});
  const app = await appFor({ isConnected: () => true }, reader);
  try {
    const response = await fetch(
      `${app.base}/novedades/media?kind=status&jid=${encodeURIComponent(AUTHOR)}&messageId=ST-1`,
      { headers: headers() }
    );
    assert.equal(response.status, 501);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'NOVEDADES_MEDIA_UNSUPPORTED');
    const avatar = await fetch(
      `${app.base}/novedades/media?kind=avatar&jid=${encodeURIComponent(CHANNEL_A)}`,
      { headers: headers() }
    );
    assert.equal(avatar.status, 501);
    assert.equal((await avatar.json()).error.code, 'NOVEDADES_AVATAR_UNSUPPORTED');
  } finally {
    await app.close();
  }
});

test('a disconnected session reports 503 and never calls the downloader', async () => {
  let downloads = 0;
  const app = await appFor({
    isConnected: () => false,
    downloadNovedadesMedia: async () => {
      downloads++;
      return { buffer: Buffer.from('x') };
    },
  });
  try {
    const response = await fetch(
      `${app.base}/novedades/media?kind=channel&jid=${encodeURIComponent(CHANNEL_A)}&messageId=P-1`,
      { headers: headers() }
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'NOVEDADES_SESSION_DOWN');
    assert.equal(downloads, 0);
  } finally {
    await app.close();
  }
});
