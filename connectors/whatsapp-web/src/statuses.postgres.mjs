// DATABASE_URL must name a disposable scratch database. All fixtures roll back.
// Run with pnpm exec tsx src/statuses.postgres.mjs from the connector directory.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (scratch database only)');
process.env.CONNECTOR_ACCOUNT = 'professional';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const originalQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = async function (sql, params = []) {
  // Production queries run in autocommit; recover a failed statement here so
  // the rollback-only fixture transaction can exercise the 42P01 fallback.
  await client.query('SAVEPOINT application_query');
  try {
    const result = await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT application_query');
    return result;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT application_query');
    await client.query('RELEASE SAVEPOINT application_query');
    throw error;
  }
};
const { listChannelPosts, parseChannelPostsQuery } = await import('./statuses.ts');
const { setConversationState } = await import('./db-writer.ts');
const A = '1203630000000000001@newsletter';
const B = '1203630000000000002@newsletter';
const C = '1203630000000000003@newsletter';
const T = 1_790_000_000_000;
const checks = [];

async function check(name, body) {
  await client.query('SAVEPOINT fixture');
  try {
    await body();
    checks.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, passed: false });
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT fixture');
    await client.query('RELEASE SAVEPOINT fixture');
  }
}

async function conversation(channel, account = 'professional', id = `${account}:${channel}`) {
  await client.query(
    `INSERT INTO conversations (id, account, account_id, external_id, name)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
    [id, account, `whatsapp:${account}`, channel, `name:${channel}`]
  );
  return id;
}

async function legacy(channel, messageId, ms, text, account = 'professional', id) {
  const conversationId = await conversation(channel, account, id);
  await client.query(
    `INSERT INTO messages (conversation_id,wa_message_id,wa_timestamp,content)
     VALUES ($1,$2,$3,$4)`,
    [conversationId, account === 'personal' ? messageId : `${account}:${messageId}`, new Date(ms), text]
  );
}

async function isolated(channel, messageId, ms, text, options = {}) {
  await client.query(
    `INSERT INTO whatsapp_novedades_messages
     (account,channel_jid,message_id,message_key,message_payload,message_timestamp_ms,
      visibility,is_deleted,superseded_by,client_id,server_id)
     VALUES ($1,$2,$3,'{}',$4,$5,$6,$7,$8,$9,$10)`,
    [options.account ?? 'professional', channel, messageId,
      text === null ? null : { conversation: text }, ms,
      options.visibility ?? 'visible', options.deleted ?? false,
      options.supersededBy ?? null, options.clientId ?? null, options.serverId ?? null]
  );
}

const page = query => listChannelPosts(parseChannelPostsQuery(query));
const keys = posts => posts.map(post => `${post.channelId}/${post.messageId}`);
async function allPages(query, maxPages = 20) {
  const posts = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const result = await page({ ...query, ...(cursor ? { cursor } : {}) });
    posts.push(...result.posts);
    if (!result.nextCursor) return posts;
    assert.notEqual(result.nextCursor, cursor, 'cursor must advance');
    cursor = result.nextCursor;
  }
  assert.fail('paging did not terminate');
}

try {
  await client.query('BEGIN');
  await client.query(`
    CREATE TEMP TABLE conversations (
      id text PRIMARY KEY, account text, account_id text, external_id text, name text,
      merged_into text, wa_chat_id text, is_group boolean DEFAULT false,
      unread_count integer DEFAULT 0, archived boolean DEFAULT false,
      updated_at timestamptz DEFAULT now()
    );
    CREATE TEMP TABLE messages (
      id bigserial PRIMARY KEY, conversation_id text, wa_message_id text,
      platform text DEFAULT 'whatsapp', wa_timestamp timestamptz, message_type text DEFAULT 'TEXT',
      content text, metadata jsonb DEFAULT '{}', is_deleted boolean DEFAULT false
    );
    CREATE TEMP TABLE attachments (id bigserial, message_id bigint, mime_type text);
  `);
  await client.query(readFileSync(new URL('../migrations/002_novedades_persistence.sql', import.meta.url), 'utf8'));

  await check('legacy and isolated union with account/channel isolation', async () => {
    await legacy(A, 'OLD', T, 'legacy only');
    await legacy(B, 'KEEP', T - 1000, 'other channel same id');
    await isolated(A, 'NEW', T + 1000, 'isolated only');
    await isolated(A, 'KEEP', T - 1000, 'only other channel suppresses');
    await isolated(A, 'OLD', T, 'other account tombstone', { account: 'personal', deleted: true });
    await legacy(C, 'PRIVATE', T + 10_000, 'other account', 'personal');
    const result = await page({ limit: 20 });
    assert.deepEqual(keys(result.posts), [`${A}/NEW`, `${A}/OLD`, `${B}/KEEP`, `${A}/KEEP`]);
    assert.equal(result.channels, 2);
    assert.deepEqual(keys((await page({ channelId: A, limit: 20 })).posts), [`${A}/NEW`, `${A}/OLD`, `${A}/KEEP`]);
  });

  await check('isolated visible row overrides historical duplicate', async () => {
    await legacy(A, 'DUP', T, 'historical');
    await isolated(A, 'DUP', T, 'authoritative');
    const result = await page({ limit: 20 });
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].text, 'authoritative');
  });

  await check('deleted hidden and superseded isolated state suppresses legacy', async () => {
    for (const [id, options] of [
      ['DELETED', { deleted: true }], ['HIDDEN', { visibility: 'hidden' }],
      ['SUPERSEDED', { supersededBy: 'CANONICAL' }],
    ]) {
      await legacy(A, id, T, `legacy ${id}`);
      await isolated(A, id, T, `isolated ${id}`, options);
    }
    assert.deepEqual((await page({ limit: 20 })).posts, []);
  });

  await check('client and server aliases suppress historical duplicates and tombstones', async () => {
    await legacy(A, 'CLIENT', T, 'legacy client copy');
    await isolated(A, 'CANONICAL', T, 'deleted canonical', { clientId: 'CLIENT', deleted: true });
    await legacy(B, 'SERVER', T, 'legacy server copy');
    await isolated(B, 'OTHER', T, 'visible canonical', { serverId: 'SERVER' });
    const result = await page({ limit: 20 });
    assert.deepEqual(keys(result.posts), [`${B}/OTHER`]);
  });

  await check('same post id across channels paginates every row once', async () => {
    await legacy(A, 'SAME', T, 'legacy A');
    await isolated(B, 'SAME', T, 'isolated B');
    await isolated(C, 'SAME', T, 'isolated C');
    await legacy(A, 'OLDER', T - 1000, 'legacy older');
    await isolated(B, 'NEWER', T + 1000, 'isolated newer');
    assert.deepEqual(keys(await allPages({ limit: 1 })),
      [`${B}/NEWER`, `${C}/SAME`, `${B}/SAME`, `${A}/SAME`, `${A}/OLDER`]);
  });

  await check('mixed case post ids use the same order in SQL and cursor merger', async () => {
    for (const id of ['Z', 'z', 'A', 'a']) await isolated(A, id, T, id);
    const expected = keys((await page({ limit: 20 })).posts);
    assert.deepEqual(keys(await allPages({ limit: 1 })), expected);
  });

  await check('historical mixed case ids use the same order in SQL and cursor merger', async () => {
    for (const id of ['Z', 'z', 'A', 'a']) await legacy(A, id, T, id);
    const expected = keys((await page({ limit: 20 })).posts);
    assert.deepEqual(keys(await allPages({ limit: 1 })), expected);
  });

  await check('channel count uses external identity for UUID conversations', async () => {
    await legacy(A, 'OLD', T, 'legacy UUID', 'professional', '1e3b11d0-eae8-4253-a7d7-390941049592');
    await isolated(A, 'NEW', T + 1000, 'isolated same channel');
    assert.equal((await page({ limit: 20 })).channels, 1);
  });

  await check('missing isolated tables falls back to historical channel feed', async () => {
    await legacy(A, 'OLD', T, 'old feed');
    await client.query('ALTER TABLE whatsapp_novedades_messages RENAME TO scratch_hidden_messages');
    const result = await page({ limit: 20 });
    assert.deepEqual(keys(result.posts), [`${A}/OLD`]);
    assert.equal(result.channels, 1);
  });

  await check('negative unread marks canonical only and preserves undefined counts', async () => {
    await client.query(`INSERT INTO conversations (id,account,wa_chat_id,unread_count,archived) VALUES
      ('professional:777@lid','professional','professional:34600123456@s.whatsapp.net',0,true),
      ('professional:34600123456@c.us','professional',NULL,3,true),
      ('professional:34600123456@s.whatsapp.net','professional',NULL,4,true),
      ('personal:34600123456@c.us','personal',NULL,9,true);`);
    const state = async id => (await client.query('SELECT unread_count, archived FROM conversations WHERE id=$1', [id])).rows[0];
    await setConversationState('34600123456@c.us', -1, false);
    assert.deepEqual(await state('professional:777@lid'), { unread_count: 1, archived: false });
    for (const id of ['professional:34600123456@c.us', 'professional:34600123456@s.whatsapp.net'])
      assert.deepEqual(await state(id), { unread_count: 0, archived: false });
    assert.deepEqual(await state('personal:34600123456@c.us'), { unread_count: 9, archived: true });
    await client.query(`UPDATE conversations SET unread_count=5 WHERE id='professional:777@lid';
      UPDATE conversations SET unread_count=3 WHERE id='professional:34600123456@c.us';`);
    await setConversationState('777@lid', undefined, true);
    assert.deepEqual(await state('professional:777@lid'), { unread_count: 5, archived: true });
    assert.deepEqual(await state('professional:34600123456@c.us'), { unread_count: 3, archived: true });
    await setConversationState('777@lid', -1);
    assert.equal((await state('professional:777@lid')).unread_count, 5);
  });
} finally {
  pg.Pool.prototype.query = originalQuery;
  await client.query('ROLLBACK');
  await client.end();
}

const failures = checks.filter(result => !result.passed);
console.log(`PostgreSQL channel feed/state integration: ${checks.length - failures.length}/${checks.length} passed`);
if (failures.length) process.exitCode = 1;
