// Run explicitly against disposable PostgreSQL: DATABASE_URL=... tsx --test this-file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { runMigrations } from './migrate';

const dir = join(__dirname, 'migrations');
const migrationFiles = (): string[] =>
  readdirSync(dir)
    .filter(file => /^\d+.*\.sql$/.test(file))
    .sort();
const legacyMigrationFiles = (): string[] =>
  migrationFiles().filter(file => /^00[1-7]_/.test(file));

async function database(label: string): Promise<{ client: Client; url: string }> {
  assert.ok(process.env.DATABASE_URL, 'Use a disposable PostgreSQL DATABASE_URL');
  const url = new URL(process.env.DATABASE_URL);
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  const name = `schema_test_${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return { client, url: url.toString() };
}

test('legacy UUID rows, attachments, embeddings and reply FKs survive migration and rerun', async () => {
  const { client } = await database('legacy');
  try {
    for (const file of legacyMigrationFiles())
      await client.query(readFileSync(join(dir, file), 'utf8'));
    const c = (
      await client.query(
        "INSERT INTO conversations(wa_chat_id,type) VALUES('old-peer','INDIVIDUAL') RETURNING id"
      )
    ).rows[0].id;
    const p = (
      await client.query(
        "INSERT INTO participants(conversation_id,wa_user_id) VALUES($1,'old-peer') RETURNING id",
        [c]
      )
    ).rows[0].id;
    const m = (
      await client.query(
        "INSERT INTO messages(conversation_id,wa_message_id,wa_timestamp,direction,sender_id,sender_wa_id,content_hash,message_type) VALUES($1,'old-message',now(),'INBOUND',$2,'old-peer','hash','TEXT') RETURNING id",
        [c, p]
      )
    ).rows[0].id;
    await client.query(
      "INSERT INTO messages(conversation_id,wa_message_id,wa_timestamp,direction,sender_wa_id,content_hash,message_type,reply_to_message_id) VALUES($1,'old-reply',now(),'INBOUND','old-peer','hash','TEXT',$2)",
      [c, m]
    );
    await client.query(
      "INSERT INTO attachments(message_id,type,storage_key) VALUES($1,'image','s3://legacy/photo')",
      [m]
    );
    await client.query(
      "INSERT INTO message_embeddings(message_id,embedding,model) VALUES($1,$2::vector,'legacy')",
      [m, JSON.stringify(Array(4096).fill(0))]
    );
    await runMigrations(client);
    await runMigrations(client);
    assert.equal(
      (await client.query('SELECT count(*) FROM schema_migrations')).rows[0].count,
      String(migrationFiles().length)
    );
    assert.equal(
      (
        await client.query(
          "SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='messages' AND column_name='message_type'"
        )
      ).rows[0].data_type,
      'text'
    );
    assert.equal(
      (await client.query("SELECT adopted FROM schema_migrations WHERE version LIKE '001_%'"))
        .rows[0].adopted,
      true
    );
    assert.equal(
      (await client.query('SELECT conversation_id FROM messages WHERE id=$1', [m])).rows[0]
        .conversation_id,
      'old-peer'
    );
    assert.equal(
      (
        await client.query(
          'SELECT participant_id FROM conversation_participants WHERE conversation_id=$1',
          ['old-peer']
        )
      ).rows[0].participant_id,
      'old-peer'
    );
    assert.equal(
      (
        await client.query(
          "SELECT reply_to_message_id FROM messages WHERE wa_message_id='old-reply'"
        )
      ).rows[0].reply_to_message_id,
      'old-message'
    );
    assert.equal(
      (await client.query('SELECT file_url FROM attachments WHERE message_id=$1', [m])).rows[0]
        .file_url,
      's3://legacy/photo'
    );
    assert.equal(
      (await client.query('SELECT count(*) FROM message_embeddings WHERE message_id=$1', [m]))
        .rows[0].count,
      '1'
    );
    await assert.rejects(
      client.query(
        "INSERT INTO conversation_participants VALUES('missing','missing','member',now())"
      ),
      /foreign key/
    );
    await assert.rejects(
      client.query('DELETE FROM participants WHERE id=$1', ['old-peer']),
      /foreign key/
    );
  } finally {
    await client.end();
  }
});

test('partial legacy schema fails without recording migrations', async () => {
  const { client } = await database('partial');
  try {
    await client.query('CREATE TABLE messages(id uuid PRIMARY KEY)');
    await assert.rejects(runMigrations(client), /Partial untracked schema/);
    assert.equal(
      (await client.query("SELECT to_regclass('schema_migrations') AS ledger")).rows[0].ledger,
      null
    );
  } finally {
    await client.end();
  }
});

test('concurrent migrations preserve provider-readable history and isolate three connectors', async () => {
  const { client, url } = await database('fresh');
  const second = new Client({ connectionString: url });
  await second.connect();
  try {
    for (const file of legacyMigrationFiles())
      await client.query(readFileSync(join(dir, file), 'utf8'));
    const legacyConversation = (
      await client.query(
        "INSERT INTO conversations(wa_chat_id,type,avatar_url) VALUES('123:4@s.whatsapp.net','INDIVIDUAL','legacy-avatar') RETURNING id"
      )
    ).rows[0].id;
    await client.query(
      "INSERT INTO messages(conversation_id,wa_message_id,wa_timestamp,direction,sender_wa_id,content_hash,message_type,content) VALUES($1,'legacy-personal',now(),'INBOUND','123:4@s.whatsapp.net','hash','TEXT','historical')",
      [legacyConversation]
    );
    await Promise.all([runMigrations(client), runMigrations(second)]);
    const registry = join(mkdtempSync(join(tmpdir(), 'social-accounts-')), 'accounts.json');
    const accounts = ['personal', 'secondary', 'third_team'];
    writeFileSync(
      registry,
      JSON.stringify(
        accounts
          .map(accountId => ({ channel: 'whatsapp', accountId, enabled: true }))
          .concat([{ channel: 'whatsapp', accountId: 'disabled', enabled: false }])
      )
    );
    process.env.SOCIAL_ACCOUNTS_FILE = registry;
    process.env.DATABASE_URL = url;
    const w = await import(join(__dirname, '../../../../connectors/whatsapp-web/src/db-writer.ts'));
    for (const account of accounts) {
      process.env.CONNECTOR_ACCOUNT = account;
      await w.ensureHistoryTables();
      if (account === 'personal')
        assert.equal(await w.getConversationAvatar('123:4@s.whatsapp.net'), 'legacy-avatar');
      await w.ensureConversation({
        id: '123:4@s.whatsapp.net',
        name: account,
        isGroup: false,
        participantCount: 2,
      });
      await w.ensureParticipant({ id: '123:4@s.whatsapp.net', name: account });
      await w.linkParticipantToConversation('123:4@s.whatsapp.net', '123:4@s.whatsapp.net');
      const id = await w.storeMessage({
        waMessageId: 'same-message',
        conversationId: '123:4@s.whatsapp.net',
        senderWaId: '123:4@s.whatsapp.net',
        waTimestamp: new Date(),
        direction: 'INBOUND',
        content: account,
        messageType: 'TEXT',
        isForwarded: false,
        replyToWaId: 'not-imported',
      });
      assert.ok(id);
      await w.storeAttachment(id, { fileType: 'image', fileUrl: `s3://test/${account}/photo` });
      await w.storeMessageKey({
        waMessageId: 'same-message',
        conversationId: '123:4@s.whatsapp.net',
        remoteJid: '123:4@s.whatsapp.net',
        fromMe: false,
        messageTimestampMs: Date.now(),
      });
      await w.recordHistorySyncProgress({
        conversationId: '123:4@s.whatsapp.net',
        insertedCount: 1,
      });
      await w.setMessageStatus('same-message', 'read');
      assert.equal((await w.getHistorySyncStatus()).length, 1);
      assert.equal(
        await w.storeMessage({
          waMessageId: 'same-message',
          conversationId: '123:4@s.whatsapp.net',
          senderWaId: '123:4@s.whatsapp.net',
          waTimestamp: new Date(),
          direction: 'INBOUND',
          content: 'duplicate',
          messageType: 'TEXT',
          isForwarded: false,
        }),
        null
      );
    }
    process.env.CONNECTOR_ACCOUNT = 'personal';
    const history = (
      await w
        .getPool()
        .query('SELECT content FROM messages WHERE conversation_id=$1 ORDER BY content', [
          w.accountKey('123:4@s.whatsapp.net'),
        ])
    ).rows;
    assert.deepEqual(
      history.map((row: { content: string }) => row.content),
      ['historical', 'personal']
    );
    const rows = (
      await client.query(
        'SELECT m.account, m.content, m.status, a.file_url FROM messages m JOIN attachments a ON a.message_id=m.id ORDER BY m.account'
      )
    ).rows;
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.content, row.account);
      assert.equal(row.status, 'read');
      assert.equal(row.file_url, `s3://test/${row.account}/photo`);
    }
    assert.equal(
      (await client.query('SELECT count(DISTINCT id) FROM participants')).rows[0].count,
      '3'
    );
    for (const account of ['unknown', 'disabled']) {
      process.env.CONNECTOR_ACCOUNT = account;
      assert.throws(() => w.accountKey('peer'), /unknown or disabled/);
    }
    await runMigrations(client);
    assert.equal((await client.query('SELECT count(*) FROM messages')).rows[0].count, '4');
    await w.getPool().end();
  } finally {
    await second.end();
    await client.end();
  }
});

test('legacy secondary participant duplicates retain metadata and converge on provider identities', async () => {
  const { client } = await database('duplicates');
  try {
    for (const file of legacyMigrationFiles())
      await client.query(readFileSync(join(dir, file), 'utf8'));
    const conversations = [];
    for (const peer of ['first-chat', 'second-chat']) {
      const c = (
        await client.query(
          "INSERT INTO conversations(wa_chat_id,type,account) VALUES($1,'INDIVIDUAL','secondary') RETURNING id",
          [peer]
        )
      ).rows[0].id;
      conversations.push(c);
      const p = (
        await client.query(
          "INSERT INTO participants(conversation_id,wa_user_id,name,account) VALUES($1,'same-peer',$2,'secondary') RETURNING id",
          [c, peer]
        )
      ).rows[0].id;
      await client.query(
        "INSERT INTO messages(conversation_id,wa_message_id,wa_timestamp,direction,sender_id,sender_wa_id,content_hash,message_type,account) VALUES($1,$2,now(),'INBOUND',$3,'same-peer','hash','TEXT','secondary')",
        [c, peer + '-message', p]
      );
    }
    await client.query(
      'CREATE TABLE whatsapp_message_keys(wa_message_id text PRIMARY KEY REFERENCES messages(wa_message_id), conversation_id text NOT NULL, remote_jid text, from_me boolean, participant_jid text, message_timestamp_ms bigint, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())'
    );
    await client.query(
      "INSERT INTO whatsapp_message_keys(wa_message_id,conversation_id) VALUES('first-chat-message',$1)",
      [conversations[0]]
    );
    await runMigrations(client);
    assert.deepEqual(
      (await client.query('SELECT name FROM participants ORDER BY name')).rows.map(r => r.name),
      ['first-chat', 'second-chat']
    );
    assert.equal(
      (await client.query('SELECT count(DISTINCT participant_id) FROM conversation_participants'))
        .rows[0].count,
      '1'
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*) FROM messages WHERE sender_id='secondary:same-peer' AND sender_wa_id='secondary:same-peer'"
        )
      ).rows[0].count,
      '2'
    );
    assert.deepEqual(
      (await client.query('SELECT wa_message_id,conversation_id FROM whatsapp_message_keys')).rows,
      [{ wa_message_id: 'secondary:first-chat-message', conversation_id: 'secondary:first-chat' }]
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*) FROM legacy_identity_map WHERE entity='participants' AND canonical_id='secondary:same-peer'"
        )
      ).rows[0].count,
      '2'
    );
  } finally {
    await client.end();
  }
});

test('empty database initializes every version and reruns unchanged', async () => {
  const { client } = await database('empty');
  try {
    await runMigrations(client);
    await runMigrations(client);
    assert.equal(
      (await client.query('SELECT count(*) FROM schema_migrations WHERE NOT adopted')).rows[0]
        .count,
      String(migrationFiles().length)
    );
  } finally {
    await client.end();
  }
});
