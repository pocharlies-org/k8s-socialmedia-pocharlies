// Only connection-local temporary tables in a disposable QA database are written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_LIST_SQL, MESSAGE_LIST_SQL } from '../lib/chat-names.mjs';
import { connectDisposableDatabase } from './postgres-fixture.mjs';

const url = process.env.WHATSAPP_TEST_DATABASE_URL;
function nodes(plan) {
  return [plan, ...(plan.Plans || []).flatMap(nodes)];
}

for (const idType of ['uuid', 'bigint']) {
  test(`bounded sender names keep aliases and account isolation with ${idType} ids`, {skip: !url}, async () => {
    const db = await connectDisposableDatabase(url);
    try {
      await db.query('BEGIN');
      await db.query(`
        CREATE TEMP TABLE conversations(id text, wa_chat_id text, account text, name text,
          is_group boolean DEFAULT false, archived boolean DEFAULT false, avatar_url text,
          unread_count integer DEFAULT 0, last_message_at timestamptz DEFAULT now());
        CREATE TEMP TABLE participants(id text, account text, name text, push_name text);
        CREATE TEMP TABLE whatsapp_contacts(account text, jid text, name text, updated_at timestamptz);
        CREATE TEMP TABLE messages(id ${idType}, wa_message_id text, account text, conversation_id text,
          sender_wa_id text, content text, platform text DEFAULT 'whatsapp', direction text,
          wa_timestamp timestamptz, message_type text DEFAULT 'TEXT', metadata jsonb DEFAULT '{}',
          reply_to_message_id text, is_edited boolean DEFAULT false, is_deleted boolean DEFAULT false,
          status text ${idType === 'uuid' ? ', deleted_at timestamp without time zone' : ''});
        CREATE INDEX bounded_sender_recent ON messages(account, conversation_id, wa_timestamp DESC, id DESC);
        INSERT INTO conversations(id,wa_chat_id,account,name) VALUES
          ('a:123@lid','a:12025550123@s.whatsapp.net','a','123@lid'),
          ('a:12025550123@c.us',NULL,'a','12025550123@c.us');
        INSERT INTO participants VALUES
          ('a:recent','a',NULL,'Recent alias name'),
          ('a:old','a','Ancient name',NULL),
          ('a:recent','b','Private other account',NULL);
        INSERT INTO messages(id,wa_message_id,account,conversation_id,sender_wa_id,content,direction,wa_timestamp)
          SELECT ${idType === 'uuid' ? 'md5(i::text)::uuid' : 'i'}, 'wa-' || i, 'a',
            CASE WHEN i <= 5000 THEN 'a:123@lid' ELSE 'a:12025550123@c.us' END,
            CASE WHEN i <= 4990 OR i BETWEEN 5001 AND 9990 THEN 'a:old'
              WHEN i = 9999 THEN 'a:recent' ELSE 'a:unknown' END,
            'kept', 'INBOUND', '2026-10-01'::timestamptz + i * interval '1 second'
          FROM generate_series(1,10000) i;
        ANALYZE messages;
      `);
      const chats = (await db.query(CHAT_LIST_SQL, ['a'])).rows;
      assert.equal(chats.length, 1);
      assert.equal(chats[0].id, 'a:123@lid');
      assert.equal(chats[0].name, 'Recent alias name');
      assert.deepEqual((await db.query(CHAT_LIST_SQL, ['b'])).rows, []);
      const messages = (await db.query(MESSAGE_LIST_SQL.replace('ORDER BY m.wa_timestamp DESC, m.id DESC\nLIMIT 200',
        "AND m.wa_message_id = 'wa-10000'\nORDER BY m.wa_timestamp DESC, m.id DESC\nLIMIT 200"),
      ['a', ['a:12025550123@c.us']])).rows;
      assert.equal(messages.length, 1);
      assert.ok(messages.every(message => message.deletedAt === null));
      const explain = (await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${CHAT_LIST_SQL}`, ['a'])).rows[0]['QUERY PLAN'][0].Plan;
      const recentLimits = nodes(explain).filter(plan => plan['Node Type'] === 'Limit' && plan['Plan Rows'] === 10);
      assert.ok(recentLimits.length > 0, 'recent senders are bounded before participant sorting');
      for (const limit of recentLimits) {
        assert.ok(limit['Actual Rows'] <= 10);
        assert.ok(nodes(limit).some(plan => plan['Index Name'] === 'bounded_sender_recent'), 'recent lookup uses conversation index');
        const scan = nodes(limit).find(plan => plan['Relation Name'] === 'messages');
        assert.ok(scan['Actual Rows'] <= 10);
        assert.ok((scan['Rows Removed by Filter'] || 0) <= 10);
      }
      await db.query("UPDATE participants SET push_name=NULL WHERE account='a' AND id='a:recent'");
      assert.equal((await db.query(CHAT_LIST_SQL, ['a'])).rows[0].name, '123@lid', 'old names outside the bounded window stay excluded');
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
  });
}
