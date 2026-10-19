// Run against PostgreSQL with DATABASE_URL. Fixtures shadow real tables only
// within this connection and the transaction always rolls back.
import assert from 'node:assert/strict';
import pg from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { CHAT_LIST_ACTIVE_SQL, CHAT_LIST_ARCHIVED_SQL, CHAT_LIST_SQL, MESSAGE_LIST_SQL } from '../lib/chat-names.mjs';
import { readContactDirectory } from '../lib/contact-directory.mjs';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`
    CREATE TEMP TABLE conversations (id text, wa_chat_id text, account text, name text,
      is_group boolean, archived boolean DEFAULT false, avatar_url text,
      unread_count integer DEFAULT 0, last_message_at timestamptz DEFAULT now());
    CREATE TEMP TABLE participants (id text, account text, name text, push_name text, profile_pic_url text);
    CREATE TEMP TABLE whatsapp_contacts (account text, jid text, name text, push_name text,
      updated_at timestamptz DEFAULT now());
    CREATE TEMP TABLE messages (id text, wa_message_id text, account text, conversation_id text,
      sender_wa_id text, content text, platform text DEFAULT 'whatsapp',
      is_deleted boolean DEFAULT false, direction text, wa_timestamp timestamptz DEFAULT now(),
      message_type text DEFAULT 'TEXT', metadata jsonb DEFAULT '{}'::jsonb,
      reply_to_message_id text, is_edited boolean DEFAULT false, status text);
    INSERT INTO conversations (id,wa_chat_id,account,name,is_group,archived,avatar_url) VALUES
      ('a:123@lid','a:123@lid','a','123@lid',false,false,NULL),
      ('b:123@lid','b:123@lid','b','123@lid',false,false,NULL),
      ('a:456@g.us','a:456@g.us','a','456@g.us',true,false,'s3://socialmedia-media/avatars/group.jpg'),
      ('a:789@c.us','a:789@c.us','a','Saved friend',false,false,NULL),
      ('a:out@lid','a:out@lid','a','out@lid',false,true,NULL),
      ('a:new@c.us','a:new@c.us','a','+123456789',false,false,NULL),
      ('a:news@newsletter','a:news@newsletter','a','News',false,false,NULL),
      ('a:old@newsletter','a:old@newsletter','a','Old channel',false,true,NULL),
      ('a:status@broadcast','a:status@broadcast','a','Updates',false,false,NULL),
      ('status@broadcast','status@broadcast','a','Archived status',false,true,NULL),
      ('a:1234567890@broadcast','a:1234567890@broadcast','a','Family broadcast',false,false,NULL),
      ('tg_direct','tg_direct','a','Telegram contact',false,false,NULL),
      ('tg_group','tg_group','a','Telegram group',true,false,NULL),
      ('tg_archived','tg_archived','a','Archived Telegram',true,true,NULL);
    INSERT INTO participants VALUES
      ('a:123@lid','a','Friend A','Remote A'),
      ('b:123@lid','b','Friend B','Remote B'),
      ('a:self','a','Owner','Owner');
    INSERT INTO messages (id,wa_message_id,account,conversation_id,sender_wa_id,content,direction) VALUES
      ('one','wa-one','a','a:123@lid','a:123@lid','hello','INBOUND'),
      ('two','wa-two','b','b:123@lid','b:123@lid','hello','INBOUND'),
      ('three','wa-three','a','a:456@g.us','a:123@lid','group','INBOUND'),
      ('four','wa-four','a','a:789@c.us','a:123@lid','hello','INBOUND'),
      ('five','wa-five','a','a:out@lid','a:self','sent','OUTBOUND');
  `);
  await client.query(`INSERT INTO messages (id,wa_message_id,account,conversation_id,content,platform,direction)
    VALUES ('tg_one','tg_one','a','tg_direct','Telegram text','telegram','INBOUND'),
           ('tg_two','tg_two','a','tg_group','Telegram group text','telegram','INBOUND');`);
  const a = (await client.query(CHAT_LIST_SQL, ['a'])).rows;
  const b = (await client.query(CHAT_LIST_SQL, ['b'])).rows;
  assert.equal(a.length, 6);
  assert.equal(a.find(x => x.id === 'a:1234567890@broadcast').name, 'Family broadcast');
  assert.deepEqual((await client.query(CHAT_LIST_ACTIVE_SQL, ['a'])).rows.map(x => x.id).sort(),
    ['a:123@lid', 'a:456@g.us', 'a:789@c.us', 'a:new@c.us', 'a:1234567890@broadcast'].sort());
  assert.deepEqual((await client.query(CHAT_LIST_ARCHIVED_SQL, ['a'])).rows.map(x => x.id), ['a:out@lid']);
  assert.deepEqual(b.map(x => x.name), ['Friend B']);
  assert.equal(a.find(x => x.id === 'a:123@lid').name, 'Friend A');
  assert.equal(a.find(x => x.id === 'a:456@g.us').name, '456@g.us');
  assert.equal(a.find(x => x.id === 'a:789@c.us').name, 'Saved friend');
  assert.equal(a.find(x => x.id === 'a:out@lid').name, 'out@lid');
  assert.equal(a.find(x => x.id === 'a:new@c.us').name, '+123456789');
  assert.equal(a.find(x => x.id === 'a:new@c.us').preview, '');
  assert.equal(a.find(x => x.id === 'a:new@c.us').timestamp, null);
  assert.equal(a.find(x => x.id === 'a:456@g.us').isGroup, true);
  assert.equal(a.find(x => x.id === 'a:456@g.us').avatarUrl, 's3://socialmedia-media/avatars/group.jpg');
  assert.equal(a.find(x => x.id === 'a:out@lid').archived, true);
  assert.equal(a.find(x => x.id === 'a:123@lid').isGroup, false);
  assert.equal(a.find(x => x.id === 'a:out@lid').fromMe, true);
  assert.equal(a.find(x => x.id === 'a:123@lid').fromMe, false);
  assert.ok(a.filter(x => !['a:new@c.us', 'a:1234567890@broadcast'].includes(x.id)).every(x => x.timestamp instanceof Date));
  await client.query(`
    UPDATE conversations SET wa_chat_id='12025550123@s.whatsapp.net' WHERE id='a:123@lid';
    INSERT INTO whatsapp_contacts (account,jid,name,push_name) VALUES
      ('a','12025550123@s.whatsapp.net','Ada ❤️💍','Ada profile'),
      ('a','789@s.whatsapp.net','Saved ❤️','Saved profile'),
      ('b','12025550123@s.whatsapp.net',NULL,'Other profile');
  `);
  const namedA = (await client.query(CHAT_LIST_SQL, ['a'])).rows;
  assert.equal(namedA.find(x => x.id === 'a:123@lid').name, 'Ada ❤️💍');
  assert.equal(namedA.find(x => x.id === 'a:789@c.us').name, 'Saved ❤️');
  assert.equal((await client.query(CHAT_LIST_SQL, ['b'])).rows[0].name, 'Friend B');
  await client.query(`UPDATE whatsapp_contacts SET name='Ada renamed 💍' WHERE account='a' AND jid='12025550123@s.whatsapp.net'`);
  assert.equal((await client.query(CHAT_LIST_SQL, ['a'])).rows.find(x => x.id === 'a:123@lid').name, 'Ada renamed 💍');
  await client.query(`
    INSERT INTO whatsapp_contacts (account,jid,name,push_name,updated_at)
    VALUES ('a','123@lid','Old saved name',NULL,'2026-09-01');
  `);
  assert.equal((await client.query(CHAT_LIST_SQL, ['a'])).rows.find(x => x.id === 'a:123@lid').name, 'Ada renamed 💍');
  const directory = await readContactDirectory({
    account: 'a', params: new URLSearchParams({ q: 'Ada renamed' }),
    query: async (sql, args) => (await client.query(sql, args)).rows,
  });
  assert.equal(directory.contacts.length, 1);
  assert.equal(directory.contacts[0].label, 'Ada renamed 💍');
  assert.equal(directory.contacts[0].chatId, 'a:123@lid');
  const otherDirectory = await readContactDirectory({
    account: 'b', params: new URLSearchParams({ q: 'Ada renamed' }),
    query: async (sql, args) => (await client.query(sql, args)).rows,
  });
  assert.equal(otherDirectory.contacts.length, 0);
  assert.equal((await client.query(MESSAGE_LIST_SQL, ['a', ['a:123@lid']])).rows[0].senderName, 'Friend A');
  assert.equal((await client.query(MESSAGE_LIST_SQL, ['b', ['a:123@lid']])).rows.length, 0);
  assert.equal((await client.query(MESSAGE_LIST_SQL, ['a', ['a:out@lid']])).rows[0].senderName, null);
  await client.query(`
    INSERT INTO messages (id,wa_message_id,account,conversation_id,sender_wa_id,content,direction,message_type,wa_timestamp) VALUES
      ('poll','wa-poll','a','a:456@g.us','a:123@lid','Taxi hoy','INBOUND','POLL',now() + interval '1 hour'),
      ('vote','wa-vote','a','a:456@g.us','a:123@lid',NULL,'INBOUND','POLL_VOTE',now() + interval '2 hours'),
      ('result','wa-result','a','a:456@g.us','a:123@lid',NULL,'INBOUND','POLL_RESULT',now() + interval '3 hours'),
      ('reaction','wa-reaction','a','a:456@g.us','a:123@lid','❤️','INBOUND','REACTION',now() + interval '4 hours'),
      ('heart-text','wa-heart-text','a','a:456@g.us','a:123@lid','❤️','INBOUND','TEXT',now() + interval '5 hours');
  `);
  assert.deepEqual((await client.query(MESSAGE_LIST_SQL, ['a', ['a:456@g.us']])).rows.map(row => row.id), ['heart-text', 'poll', 'three']);
  assert.equal((await client.query(CHAT_LIST_SQL, ['a'])).rows.find(row => row.id === 'a:456@g.us').preview, '❤️');
  await client.query(`INSERT INTO messages (id,wa_message_id,account,conversation_id,sender_wa_id,content,direction,message_type,wa_timestamp)
    VALUES ('only-reaction','wa-only-reaction','a','a:789@c.us','a:123@lid','❤️','INBOUND','REACTION',now() + interval '6 hours')`);
  assert.equal((await client.query(CHAT_LIST_SQL, ['a'])).rows.find(row => row.id === 'a:789@c.us').preview, 'hello');
  await client.query(`
    INSERT INTO messages (id,wa_message_id,account,conversation_id,sender_wa_id,content,direction,message_type,reply_to_message_id,wa_timestamp) VALUES
      ('control','wa-control','a','a:123@lid','a:123@lid',NULL,'INBOUND','MESSAGECONTEXTINFO',NULL,now() + interval '5 hours'),
      ('answer','wa-answer','a','a:123@lid','a:123@lid','Reply','INBOUND','TEXT','wa-one',now() + interval '2 hours'),
      ('legacy','wa-legacy','a','a:123@lid','a:123@lid','Old','INBOUND','TEXT',NULL,now() + interval '3 hours'),
      ('legacy-answer','wa-legacy-answer','a','a:123@lid','a:123@lid','Old reply','INBOUND','TEXT','a:wa-legacy',now() + interval '3 hours'),
      ('cross','wa-cross','b','b:123@lid','b:123@lid','Private','INBOUND','TEXT','wa-one',now() + interval '3 hours'),
      ('missing','wa-missing','a','a:123@lid','a:123@lid','Missing','INBOUND','TEXT','wa-two',now() + interval '4 hours');
  `);
  const aReplies = (await client.query(MESSAGE_LIST_SQL, ['a', ['a:123@lid']])).rows;
  assert.equal(aReplies.some(row => row.id === 'control'), false);
  assert.equal(aReplies.find(row => row.id === 'answer').replyType, 'TEXT');
  assert.equal(aReplies.find(row => row.id === 'answer').replySenderName, 'Friend A');
  assert.equal(aReplies.find(row => row.id === 'answer').replyAvailable, true);
  assert.equal(aReplies.find(row => row.id === 'legacy-answer').replyText, 'Old');
  assert.equal(aReplies.find(row => row.id === 'missing').replyAvailable, false);
  assert.equal((await client.query(MESSAGE_LIST_SQL, ['b', ['b:123@lid']])).rows[0].replyAvailable, false);
  assert.equal((await client.query(CHAT_LIST_SQL, ['a'])).rows.find(row => row.id === 'a:123@lid').preview, 'Missing');
  await client.query(`
    INSERT INTO conversations (id,wa_chat_id,account,name,is_group,unread_count) VALUES
      ('a:777@lid','a:34600123456@s.whatsapp.net','a','777@lid',false,1),
      ('a:34600123456@c.us',NULL,'a','Daniel',false,2),
      ('b:34600123456@c.us',NULL,'b','Other account',false,4);
    INSERT INTO messages (id,wa_message_id,account,conversation_id,sender_wa_id,content,direction,wa_timestamp) VALUES
      ('lid-history','wa-lid-history','a','a:777@lid','a:777@lid','Old inbound','INBOUND',now() - interval '2 hours'),
      ('pn-reply','wa-pn-reply','a','a:34600123456@c.us','a:self','New outbound','OUTBOUND',now() + interval '6 hours'),
      ('other-account','wa-other-account','b','b:34600123456@c.us','b:self','Private','OUTBOUND',now() + interval '7 hours');
  `);
  const merged = (await client.query(CHAT_LIST_SQL, ['a'])).rows;
  assert.equal(merged.some(row => row.id === 'a:34600123456@c.us'), false);
  assert.equal(merged.filter(row => row.id === 'a:777@lid').length, 1);
  assert.equal(merged.find(row => row.id === 'a:777@lid').name, 'Daniel');
  assert.equal(merged.find(row => row.id === 'a:777@lid').preview, 'New outbound');
  assert.equal(merged.find(row => row.id === 'a:777@lid').unread, 3);
  assert.deepEqual((await client.query(MESSAGE_LIST_SQL, ['a', ['a:777@lid', 'a:34600123456@c.us']])).rows.map(row => row.id), ['pn-reply', 'lid-history']);
  assert.deepEqual((await client.query(MESSAGE_LIST_SQL, ['b', ['a:777@lid', 'a:34600123456@c.us']])).rows, []);
  assert.equal((await client.query(CHAT_LIST_SQL, ['b'])).rows.find(row => row.id === 'b:34600123456@c.us').preview, 'Private');
  await client.query(`
    INSERT INTO conversations (id,wa_chat_id,account,name,is_group,unread_count,archived)
      VALUES ('a:34600123456@s.whatsapp.net',NULL,'a','Daniel other spelling',false,4,true);
    INSERT INTO messages (id,wa_message_id,account,conversation_id,sender_wa_id,content,direction,wa_timestamp)
      VALUES ('pn-variant','wa-pn-variant','a','a:34600123456@s.whatsapp.net','a:self','Newest variant','OUTBOUND',now() + interval '8 hours');
  `);
  const withVariants = (await client.query(CHAT_LIST_SQL, ['a'])).rows;
  assert.equal(withVariants.filter(row => row.id === 'a:777@lid').length, 1);
  assert.equal(withVariants.some(row => row.id === 'a:34600123456@c.us' || row.id === 'a:34600123456@s.whatsapp.net'), false);
  assert.equal(withVariants.find(row => row.id === 'a:777@lid').preview, 'Newest variant');
  assert.equal(withVariants.find(row => row.id === 'a:777@lid').unread, 7);
  assert.equal(withVariants.find(row => row.id === 'a:777@lid').archived, true);
  assert.equal((await client.query(CHAT_LIST_ACTIVE_SQL, ['a'])).rows.some(row => row.id === 'a:777@lid'), false);
  assert.equal((await client.query(CHAT_LIST_ARCHIVED_SQL, ['a'])).rows.some(row => row.id === 'a:777@lid'), true);
  assert.deepEqual((await client.query(MESSAGE_LIST_SQL, ['a', ['a:777@lid', 'a:34600123456@c.us', 'a:34600123456@s.whatsapp.net']])).rows.map(row => row.id), ['pn-variant', 'pn-reply', 'lid-history']);
  await client.query("INSERT INTO conversations (id,wa_chat_id,account,name,is_group) VALUES ('a:888@lid','a:34600123456@c.us','a','Ambiguous',false)");
  assert.equal((await client.query(CHAT_LIST_SQL, ['a'])).rows.some(row => row.id === 'a:34600123456@c.us'), true);
  const dir = await mkdtemp(join(tmpdir(), 'whatsapp-channel-test-'));
  let providerCalls = 0;
  const app = await createApp({
    db: client,
    env: {DATA_DIR: dir, UI_AUTH_USERNAME: 'owner', UI_AUTH_PASSWORD: 'test', APP_PUBLIC_URL: 'https://wa.example', APP_ENABLE_SENDING: 'true', TEST_SECRET: 'test-secret'},
    registry: [{channel: 'whatsapp', accountId: 'a', connectorUrl: 'http://connector', secretEnv: 'TEST_SECRET'}],
    fetchImpl: async () => { providerCalls++; throw Error('No provider request expected'); },
  });
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const authorization = `Basic ${Buffer.from('owner:test').toString('base64')}`;
    for (const chat of ['tg_direct', 'tg_group', 'tg_archived']) {
      for (const path of [`/api/messages?account=a&chat=${chat}`, `/api/chats/${chat}/avatar?account=a`]) {
        const response = await fetch(base + path, {headers: {authorization}});
        assert.equal(response.status, 404, path);
      }
      const response = await fetch(base + '/api/send', {
        method: 'POST', headers: {authorization, origin: 'https://wa.example', 'content-type': 'application/json'},
        body: JSON.stringify({account: 'a', chat, text: 'Do not send'}),
      });
      assert.equal(response.status, 404);
    }
    assert.equal(providerCalls, 0);
  } finally {
    await app.close();
    await rm(dir, {recursive: true, force: true});
  }
  console.log('PostgreSQL contact-name fixtures: channel/account isolation, groups, saved names and senders passed');
} finally {
  await client.query('ROLLBACK');
  await client.end();
}
