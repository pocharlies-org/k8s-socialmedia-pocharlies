// Run explicitly against disposable PostgreSQL: DATABASE_URL=... tsx --test this-file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
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

/** Everything an already-running installation holds before 012 exists. */
const preOwnReasonMigrationFiles = (): string[] =>
  migrationFiles().filter(file => Number(file.slice(0, 3)) < 12);

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
    assert.equal(
      (
        await client.query(
          "SELECT udt_name FROM information_schema.columns WHERE table_name='social_conversation_merges' AND column_name='moved_message_ids'"
        )
      ).rows[0].udt_name,
      '_text'
    );
    await client.query(
      "UPDATE conversations SET account_id='whatsapp:personal', external_id='old-peer' WHERE id='old-peer'"
    );
    await client.query(
      "INSERT INTO conversations(id,wa_chat_id,type,account) VALUES('qa-alias','qa-alias','INDIVIDUAL','personal')"
    );
    await client.query("UPDATE messages SET conversation_id='qa-alias' WHERE id=$1", [m]);
    assert.equal(
      (await client.query("SELECT social_merge_conversation('qa-alias','old-peer') AS n")).rows[0]
        .n,
      1
    );
    assert.equal(
      (
        await client.query(
          "SELECT moved_message_ids[1] AS id FROM social_conversation_merges WHERE alias_conversation_id='qa-alias'"
        )
      ).rows[0].id,
      String(m)
    );
    assert.equal(
      (await client.query("SELECT social_unmerge_conversation('qa-alias') AS n")).rows[0].n,
      1
    );
    assert.equal(
      (await client.query('SELECT conversation_id FROM messages WHERE id=$1', [m])).rows[0]
        .conversation_id,
      'qa-alias'
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

test('reaction hints follow commit, target account, removal, and visible changes', async () => {
  const { client, url } = await database('reactions');
  const listener = new Client({ connectionString: url });
  await listener.connect();
  try {
    await runMigrations(client);
    await client.query(`INSERT INTO conversations(id,account,name) VALUES
      ('personal:peer','personal','Peer'), ('secondary:peer','secondary','Peer')`);
    const target = (
      await client.query(`INSERT INTO messages
      (conversation_id,wa_message_id,account,wa_timestamp,direction,sender_wa_id,message_type,platform)
      VALUES ('secondary:peer','secondary:target','secondary',now(),'INBOUND','secondary:peer','TEXT','whatsapp')
      RETURNING id`)
    ).rows[0].id;
    const hints: Record<string, unknown>[] = [];
    listener.on('notification', message => {
      if (message.payload) hints.push(JSON.parse(message.payload));
    });
    await listener.query('LISTEN socialmedia_changes');
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));

    await client.query(`INSERT INTO whatsapp_message_reactions
      (account,target_wa_message_id,reactor_jid,emoji)
      VALUES ('secondary','secondary:target','secondary:reactor','heart')`);
    await settle();
    assert.deepEqual(hints, [
      {
        kind: 'message',
        reason: 'reaction',
        account: 'secondary',
        conversation_id: 'secondary:peer',
        message_id: target,
        wa_message_id: 'secondary:target',
      },
    ]);

    await client.query(`UPDATE whatsapp_message_reactions SET emoji='heart',updated_at=now()
      WHERE account='secondary' AND target_wa_message_id='secondary:target'`);
    await client.query(`INSERT INTO whatsapp_message_reactions
      (account,target_wa_message_id,reactor_jid,emoji)
      VALUES ('personal','secondary:target','personal:reactor','heart'),
             ('secondary','secondary:missing','secondary:reactor','heart')`);
    await settle();
    assert.equal(hints.length, 1, 'unchanged and unmatched reactions stay silent');

    await client.query(`UPDATE whatsapp_message_reactions SET emoji=NULL,removed=true
      WHERE account='secondary' AND target_wa_message_id='secondary:target'`);
    await settle();
    assert.equal(hints.length, 2);
    assert.deepEqual(hints[1], hints[0], 'removal refreshes the same message');

    await client.query('BEGIN');
    await client.query(`UPDATE whatsapp_message_reactions SET emoji='heart',removed=false
      WHERE account='secondary' AND target_wa_message_id='secondary:target'`);
    await client.query('ROLLBACK');
    await settle();
    assert.equal(hints.length, 2, 'rolled-back changes never reach the browser');
  } finally {
    await listener.end();
    await client.end();
  }
});

/** The hint vocabulary the app is allowed to rely on. */
const HINT_KEYS = ['account', 'conversation_id', 'kind', 'message_id', 'reason', 'wa_message_id'];

async function hintFixture(label: string) {
  const { client, url } = await database(label);
  const listener = new Client({ connectionString: url });
  await listener.connect();
  await runMigrations(client);
  await client.query(
    `INSERT INTO conversations(id,account,name) VALUES
       ('secondary:peer','secondary','Peer'), ('secondary:sent','secondary','Sent')`
  );
  const insertMessage = async (waMessageId: string, direction: string) =>
    (
      await client.query(
        `INSERT INTO messages
           (conversation_id,wa_message_id,account,wa_timestamp,direction,sender_wa_id,
            message_type,platform)
         VALUES ('secondary:peer',$1,'secondary',now(),$2,'secondary:peer','TEXT','whatsapp')
         RETURNING id`,
        [waMessageId, direction]
      )
    ).rows[0].id as string;
  const hints: Record<string, unknown>[] = [];
  listener.on('notification', message => {
    if (message.payload) hints.push(JSON.parse(message.payload));
  });
  await listener.query('LISTEN socialmedia_changes');
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const react = async (
    target: string,
    reactor: string,
    emoji: string | null,
    fromMe: boolean | null,
    action: 'INSERT' | 'UPDATE' = 'INSERT'
  ) =>
    client.query(
      action === 'INSERT'
        ? `INSERT INTO whatsapp_message_reactions
             (account,target_wa_message_id,reactor_jid,emoji,from_me)
           VALUES ('secondary',$1,$2,$3,$4)`
        : `UPDATE whatsapp_message_reactions
              SET emoji=$3::text,
                  removed=($3::text IS NULL),
                  from_me=COALESCE($4::boolean, from_me),
                  updated_at=now()
            WHERE account='secondary' AND target_wa_message_id=$1 AND reactor_jid=$2`,
      [target, reactor, emoji, fromMe]
    );
  return { client, listener, hints, settle, react, insertMessage };
}

test('a reaction earns its own reason only from a peer onto our sent message', async () => {
  const { client, listener, hints, settle, react, insertMessage } =
    await hintFixture('reaction_reasons');
  try {
    const sent = await insertMessage('secondary:sent-message', 'OUTBOUND');
    await insertMessage('secondary:incoming-message', 'INBOUND');
    const reasons = (): string[] => hints.map(hint => String(hint.reason));
    // The 010 message-INSERT hints for the two rows above are real traffic, not
    // part of this matrix.
    await settle();
    hints.length = 0;

    await react('secondary:sent-message', 'secondary:peer', ':+1:', false);
    await settle();
    assert.deepEqual(hints, [
      {
        kind: 'message',
        reason: 'reaction-to-own-message',
        account: 'secondary',
        conversation_id: 'secondary:peer',
        message_id: sent,
        wa_message_id: 'secondary:sent-message',
      },
    ]);
    assert.deepEqual(
      Object.keys(hints[0]).sort(),
      HINT_KEYS,
      'the hint stays identifiers only: no emoji, no author'
    );

    // Our own device, an unknown author side, and a reaction on an incoming
    // message must all keep the reason 011 promised.
    await react('secondary:sent-message', 'secondary:me', ':heart:', true);
    await react('secondary:sent-message', 'secondary:imported', ':tada:', null);
    await react('secondary:incoming-message', 'secondary:other', ':fire:', false);
    await react('secondary:vanished', 'secondary:ghost', ':eyes:', false);
    await settle();
    assert.equal(hints.length, 4, 'the missing target stays silent');
    assert.deepEqual(reasons().slice(1), ['reaction', 'reaction', 'reaction']);

    // Changing the emoji is a new visible fact on our own message.
    await react('secondary:sent-message', 'secondary:peer', ':fire:', false, 'UPDATE');
    await settle();
    assert.equal(hints.length, 5);
    assert.equal(reasons()[4], 'reaction-to-own-message');

    // Taking it back is not a new reaction, and neither is re-ingesting it.
    await react('secondary:sent-message', 'secondary:peer', null, false, 'UPDATE');
    await settle();
    assert.equal(hints.length, 6);
    assert.equal(reasons()[5], 'reaction', 'a withdrawal refreshes without the dedicated reason');

    await client.query(
      `UPDATE whatsapp_message_reactions SET updated_at=now()
        WHERE account='secondary' AND target_wa_message_id='secondary:sent-message'
          AND reactor_jid='secondary:peer'`
    );
    await client.query(
      `INSERT INTO whatsapp_message_reactions
         (account,target_wa_message_id,reactor_jid,emoji,removed,from_me)
       VALUES ('secondary','secondary:sent-message','secondary:peer',NULL,true,false)
       ON CONFLICT (account,target_wa_message_id,reactor_jid) DO UPDATE SET
         emoji = EXCLUDED.emoji,
         removed = EXCLUDED.removed,
         from_me = COALESCE(EXCLUDED.from_me, whatsapp_message_reactions.from_me),
         updated_at = now()`
    );
    await settle();
    assert.equal(hints.length, 6, 'an identical re-ingest stays silent');
    assert.equal(
      (
        await client.query(
          `SELECT from_me FROM whatsapp_message_reactions
            WHERE account='secondary' AND target_wa_message_id='secondary:sent-message'
              AND reactor_jid='secondary:peer'`
        )
      ).rows[0].from_me,
      false,
      'a re-ingest must not erase the known author side'
    );
  } finally {
    await listener.end();
    await client.end();
  }
});

test('012 widens a reaction table that 011 installed without reopening its checksum', async () => {
  const { client, url } = await database('reaction_own_message_existing');
  const listener = new Client({ connectionString: url });
  await listener.connect();
  try {
    const installed = preOwnReasonMigrationFiles();
    for (const file of installed) await client.query(readFileSync(join(dir, file), 'utf8'));
    // The ledger an existing installation already carries, so runMigrations
    // has exactly one version left and must refuse any drift on 011.
    await client.query(
      `CREATE TABLE schema_migrations (
         version text PRIMARY KEY, checksum text NOT NULL,
         adopted boolean NOT NULL DEFAULT false,
         applied_at timestamptz NOT NULL DEFAULT now())`
    );
    const checksum = (file: string) =>
      createHash('sha256')
        .update(readFileSync(join(dir, file), 'utf8'))
        .digest('hex');
    for (const file of installed)
      await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1,$2)', [
        file,
        checksum(file),
      ]);
    await client.query(
      `INSERT INTO conversations(id,account,name) VALUES ('secondary:peer','secondary','Peer')`
    );
    const sent = (
      await client.query(
        `INSERT INTO messages
           (conversation_id,wa_message_id,account,wa_timestamp,direction,sender_wa_id,
            message_type,platform)
         VALUES ('secondary:peer','secondary:sent-message','secondary',now(),'OUTBOUND',
                 'secondary:peer','TEXT','whatsapp')
         RETURNING id`
      )
    ).rows[0].id;
    // How a 011-era connector left the row: no author side at all.
    await client.query(
      `INSERT INTO whatsapp_message_reactions
         (account,target_wa_message_id,reactor_jid,emoji)
       VALUES ('secondary','secondary:sent-message','secondary:imported','heart')`
    );

    await runMigrations(client);

    assert.equal(
      (await client.query("SELECT count(*) FROM schema_migrations WHERE version LIKE '012_%'"))
        .rows[0].count,
      '1',
      '012 applies over an existing schema'
    );
    assert.equal(
      (await client.query("SELECT checksum FROM schema_migrations WHERE version LIKE '011_%'"))
        .rows[0].checksum,
      checksum(installed.find(file => file.startsWith('011_'))!),
      '011 stays byte-identical to what existing installs recorded'
    );
    assert.equal(
      (
        await client.query(
          `SELECT is_nullable FROM information_schema.columns
            WHERE table_schema='public' AND table_name='whatsapp_message_reactions'
              AND column_name='from_me'`
        )
      ).rows[0].is_nullable,
      'YES',
      'imported reactions keep an unknown author side'
    );
    assert.equal(
      (
        await client.query(
          `SELECT from_me FROM whatsapp_message_reactions
            WHERE reactor_jid='secondary:imported'`
        )
      ).rows[0].from_me,
      null
    );

    const hints: Record<string, unknown>[] = [];
    listener.on('notification', message => {
      if (message.payload) hints.push(JSON.parse(message.payload));
    });
    await listener.query('LISTEN socialmedia_changes');
    await client.query(
      `INSERT INTO whatsapp_message_reactions
         (account,target_wa_message_id,reactor_jid,emoji,from_me)
       VALUES ('secondary','secondary:sent-message','secondary:peer','+1',false)`
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(hints, [
      {
        kind: 'message',
        reason: 'reaction-to-own-message',
        account: 'secondary',
        conversation_id: 'secondary:peer',
        message_id: sent,
        wa_message_id: 'secondary:sent-message',
      },
    ]);
  } finally {
    await listener.end();
    await client.end();
  }
});
