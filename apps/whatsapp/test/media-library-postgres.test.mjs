import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readMediaLibrary } from '../lib/media-library.mjs';

const connectionString = process.env.MEDIA_LIBRARY_TEST_DATABASE_URL;
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

for (const type of ['uuid', 'bigint']) {
  test(`PostgreSQL ${type}: precise media pagination and optional duration columns`, { skip: !connectionString }, async t => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    const namespace = `media_library_${randomUUID().replaceAll('-', '')}`;
    t.after(async () => {
      await client.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await client.end();
    });
    await client.query(`CREATE SCHEMA ${namespace}`);
    await client.query(`SET search_path TO ${namespace}`);
    await client.query(`CREATE TABLE conversations (id text PRIMARY KEY, account text, name text);
      CREATE TABLE messages (id ${type} PRIMARY KEY, wa_message_id text, conversation_id text,
        account text, platform text, is_deleted boolean, content text, direction text,
        message_type text, wa_timestamp timestamptz, metadata jsonb DEFAULT '{}');
      CREATE TABLE attachments (id ${type} PRIMARY KEY, message_id ${type} REFERENCES messages(id),
        mime_type text, file_name text, file_size bigint, duration_seconds integer${type === 'uuid' ? ', duration integer' : ''});
      CREATE TABLE whatsapp_message_payloads (account text, wa_message_id text, message_payload jsonb);
      INSERT INTO conversations VALUES ('chat@g.us', 'a', 'Group'), ('other@g.us', 'b', 'Other');`);
    const ids = type === 'uuid' ? [uuid(2), uuid(10), uuid(11), uuid(12)]
      : ['2', '10', '9007199254740992', '9007199254740993'];
    const attachmentIds = type === 'uuid' ? [uuid(20), uuid(100), uuid(101), uuid(102)]
      : ['20', '100', '9007199254741092', '9007199254741093'];
    const durations = [40, 10, 90, 40];
    for (let index = 0; index < ids.length; index++) {
      await client.query(`INSERT INTO messages VALUES ($1, $2, 'chat@g.us', 'a', 'whatsapp', false,
        'https://example.com/item', 'INBOUND', 'VIDEO', '2026-10-20 12:34:56.123456+00')`, [ids[index], `wa-${index}`]);
      await client.query(`INSERT INTO attachments (id, message_id, mime_type, file_name, file_size, duration_seconds${type === 'uuid' ? ', duration' : ''})
        VALUES ($1, $2, 'video/mp4', 'clip.mp4', 1, $3${type === 'uuid' ? ', 40' : ''})`,
      [attachmentIds[index], ids[index], index === 0 && type === 'uuid' ? 0 : durations[index]]);
    }
    // Two attachments on one message exercise the final numeric tie-breaker.
    const extraAttachment = type === 'uuid' ? uuid(103) : '9007199254741094';
    await client.query(`INSERT INTO attachments (id, message_id, duration_seconds) VALUES ($1, $2, 40)`, [extraAttachment, ids.at(-1)]);
    await client.query(`INSERT INTO messages VALUES ($1, 'unavailable', 'chat@g.us', 'a', 'whatsapp', false,
      '', 'INBOUND', 'IMAGE', '2026-10-20 12:34:56.123456+00')`, [type === 'uuid' ? uuid(1) : '1']);
    await client.query(`INSERT INTO messages VALUES ($1, 'hidden', 'other@g.us', 'b', 'whatsapp', false,
      '', 'INBOUND', 'VIDEO', '2026-10-21')`, [type === 'uuid' ? uuid(99) : '99']);
    const hiddenIds = [];
    for (const [index, messageType] of ['VIDEO', 'DOCUMENT', 'TEXT'].entries()) {
      const hiddenId = type === 'uuid' ? uuid(200 + index) : String(200 + index);
      hiddenIds.push(hiddenId);
      await client.query(`INSERT INTO messages VALUES ($1, $2, 'chat@g.us', 'a', 'whatsapp', false,
        'https://hidden.example/local-delete', 'INBOUND', $3, '2026-10-20 12:34:56.123456+00', '{"deleted_for_me":true}')`,
      [hiddenId, `local-hidden-${index}`, messageType]);
      if (messageType !== 'TEXT') await client.query(`INSERT INTO attachments (id, message_id, duration_seconds)
        VALUES ($1, $2, 1000)`, [type === 'uuid' ? uuid(300 + index) : String(300 + index), hiddenId]);
    }
    const statements = [];
    const query = async (sql, args) => {
      statements.push(sql);
      return (await client.query(sql, args)).rows;
    };
    const collect = async (order, kind = 'media') => {
      let cursor;
      const items = [];
      for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams({ limit: '1', order, kind, ...(cursor ? { cursor } : {}) });
        const response = await readMediaLibrary({ account: 'a', params, query });
        items.push(...response.items);
        cursor = response.nextCursor;
        assert(response.items.every(item => !hiddenIds.includes(item.messageId)));
        if (!cursor) return items;
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        assert(!hiddenIds.includes(decoded.id));
        assert.match(decoded.timestamp, /\.123456/);
      }
      assert.fail('pagination must terminate');
    };
    const newest = await collect('newest');
    const expected = [extraAttachment, ...attachmentIds.toReversed(), type === 'uuid' ? uuid(1) : '1'];
    assert.deepEqual(newest.map(item => item.id), expected);
    assert.deepEqual((await collect('oldest')).map(item => item.id), expected.toReversed());
    const longest = await collect('longest');
    assert.deepEqual(longest.map(item => item.id), [attachmentIds[2], extraAttachment, attachmentIds[3], attachmentIds[0], attachmentIds[1], expected.at(-1)]);
    assert.deepEqual(longest.map(item => item.durationSeconds), [90, 40, 40, 40, 10, null]);
    assert.equal(newest.at(-1).url, null);
    assert.deepEqual((await collect('newest', 'links')).map(item => item.messageId), ids.toReversed());
    assert.deepEqual((await collect('oldest', 'links')).map(item => item.messageId), ids);
    assert.deepEqual((await collect('longest', 'links')).map(item => item.messageId), ids.toReversed());
    for (const order of ['newest', 'oldest', 'longest']) {
      assert.deepEqual((await collect(order, 'all')).map(item => item.id),
        order === 'oldest' ? expected.toReversed() : order === 'longest' ? longest.map(item => item.id) : expected);
      assert.deepEqual(await collect(order, 'documents'), []);
    }
    const dataQueries = statements.filter(sql => /SELECT m\.id/.test(sql));
    assert(dataQueries.every(sql => !/ORDER BY[^]*m\.id::text/.test(sql)));
    assert(dataQueries.every(sql => !/m\.wa_timestamp, m\.id::text/.test(sql)));
    if (type === 'bigint') assert(dataQueries.every(sql => !/a\.duration\b/.test(sql)));
    const first = await readMediaLibrary({ account: 'a', params: new URLSearchParams({ limit: '1' }), query });
    const cursor = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
    cursor.id = type === 'uuid' ? '2' : uuid(2);
    await assert.rejects(readMediaLibrary({ account: 'a', params: new URLSearchParams({ cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') }), query }), /cursor/);
  });
}
