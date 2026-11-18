// Temp tables shadow production names in this connection; the transaction rolls back.
import assert from 'node:assert/strict';
import pg from 'pg';
import { MESSAGE_LIST_SQL } from '../lib/chat-names.mjs';
import { pollVoterNames } from '../lib/poll-voter-names.mjs';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE messages(id text, wa_message_id text, account text,
    conversation_id text, content text, message_type text, metadata jsonb, reply_to_message_id text,
    is_edited boolean, is_deleted boolean, status text, direction text, wa_timestamp timestamptz, platform text, sender_wa_id text);
    CREATE TEMP TABLE participants(id text, account text, name text, push_name text);
    CREATE TEMP TABLE whatsapp_contacts(account text,jid text,name text,push_name text);
    CREATE TEMP TABLE social_contact_aliases(account_id text,alias_external_id text,canonical_external_id text,evidence text);
    INSERT INTO participants VALUES('b:123@lid','b','Other account',NULL),('a:123@lid','a','Push name',NULL);
    INSERT INTO whatsapp_contacts VALUES('a','456@s.whatsapp.net','Saved contact',NULL),('b','456@s.whatsapp.net','Wrong contact',NULL);
    INSERT INTO social_contact_aliases VALUES('whatsapp:a','456@s.whatsapp.net','123@lid','observed');
    INSERT INTO messages VALUES
      ('1','a:original','a','a:chat','Original kept','TEXT','{}',NULL,false,true,'deleted','INBOUND',now(),'whatsapp','a:123@lid'),
      ('2','a:local','a','a:chat','Hidden locally','TEXT','{"deleted_for_me":true}',NULL,false,true,'deleted','INBOUND',now(),'whatsapp','a:123@lid'),
      ('3','a:receipt','a','a:chat','Read text','TEXT','{}',NULL,false,false,'read','OUTBOUND',now(),'whatsapp',NULL),
      ('4','a:envelope','a','a:chat',NULL,'ENCREACTIONMESSAGE','{}',NULL,false,false,NULL,'INBOUND',now(),'whatsapp','a:123@lid'),
      ('5','b:private','b','b:chat','Other account','TEXT','{}',NULL,false,false,NULL,'INBOUND',now(),'whatsapp','b:123@lid');`);
  const messages = (await client.query(MESSAGE_LIST_SQL, ['a', ['a:chat']])).rows;
  assert.deepEqual(messages.map(row => row.id).sort(), ['1', '3']);
  assert.equal(messages.find(row => row.id === '1').isDeleted, true);
  assert.equal(messages.find(row => row.id === '1').text, 'Original kept');
  assert.equal(messages.find(row => row.id === '3').deliveryStatus, 'read');
  const names = await pollVoterNames(async (sql, args) => (await client.query(sql, args)).rows,
    'a', [{ options: [{ name: 'Followers', voters: [{ jid: '123@lid', fromMe: false }] }] }]);
  assert.deepEqual(names[0].options[0].voters, [{ id: '123@lid', name: 'Saved contact' }]);
  console.log('PostgreSQL: retained revocations, local hide, protocol filter, receipts and account-scoped poll names pass');
} finally {
  await client.query('ROLLBACK');
  await client.end();
}
