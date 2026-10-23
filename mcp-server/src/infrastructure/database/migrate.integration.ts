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
  migrationFiles()
    .filter(file => /^00[1-7]_/.test(file))
    .concat('021_nas_local_unique_wa_message_id.sql');

/** Everything an already-running installation holds before 012 exists. */
const preOwnReasonMigrationFiles = (): string[] =>
  migrationFiles().filter(
    file => (Number(file.slice(0, 3)) < 26 || file.startsWith('030_')) && !isAuthorSource(file)
  );

const isAuthorSource = (file: string): boolean =>
  [
    '021_whatsapp_novedades_channels.sql',
    '022_whatsapp_contacts_view.sql',
    '023_whatsapp_chat_time_index.sql',
  ].includes(file);

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
      [m, JSON.stringify(Array(1536).fill(0))]
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

test('039 materializes an existing author contacts view without losing rows', async () => {
  const { client } = await database('author_view');
  try {
    await client.query('CREATE TABLE social_accounts(id text PRIMARY KEY)');
    await client.query(
      'CREATE TABLE messages(account text, conversation_id text, wa_timestamp timestamptz, platform text)'
    );
    await client.query(
      'CREATE TABLE participants(id text PRIMARY KEY, account text NOT NULL, name text, push_name text)'
    );
    await client.query(
      "INSERT INTO participants(id,account,name,push_name) VALUES('personal:legacy-peer','personal','Saved peer','Push peer')"
    );
    await client.query(
      "CREATE VIEW whatsapp_contacts AS SELECT account, split_part(id, ':', 2) AS jid, name, push_name, NULL::timestamptz AS updated_at FROM participants"
    );
    await client.query(readFileSync(join(dir, '039_shared_author_compat.sql'), 'utf8'));
    assert.equal(
      (await client.query("SELECT relkind FROM pg_class WHERE oid='whatsapp_contacts'::regclass"))
        .rows[0].relkind,
      'r'
    );
    assert.deepEqual((await client.query('SELECT account,jid,name FROM whatsapp_contacts')).rows, [
      { account: 'personal', jid: 'legacy-peer', name: 'Saved peer' },
    ]);
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
      (await client.query('SELECT count(*) FROM schema_migrations')).rows[0].count,
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
      (account,target_wa_message_id,reactor_jid,emoji,conversation_id)
      VALUES ('personal','secondary:target','personal:reactor','heart','personal:peer'),
             ('secondary','secondary:missing','secondary:reactor','heart','secondary:peer')`);
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
             (account,target_wa_message_id,reactor_jid,emoji,from_me,conversation_id)
           VALUES ('secondary',$1,$2,$3,$4,'secondary:peer')`
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
    const staged = mkdtempSync(join(tmpdir(), 'social-pre-own-'));
    for (const file of installed) writeFileSync(join(staged, file), readFileSync(join(dir, file)));
    await runMigrations(client, staged);
    // The ledger an existing installation already carries, so runMigrations
    // has exactly one version left and must refuse any drift on 011.
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY, checksum text NOT NULL,
         adopted boolean NOT NULL DEFAULT false,
         applied_at timestamptz NOT NULL DEFAULT now())`
    );
    const checksum = (file: string) =>
      createHash('sha256')
        .update(readFileSync(join(dir, file), 'utf8'))
        .digest('hex');
    for (const file of installed)
      await client.query(
        'INSERT INTO schema_migrations(version, checksum) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [file, checksum(file)]
      );
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
      (await client.query("SELECT count(*) FROM schema_migrations WHERE version LIKE '026_%'"))
        .rows[0].count,
      '1',
      '012 applies over an existing schema'
    );
    assert.equal(
      (await client.query("SELECT checksum FROM schema_migrations WHERE version LIKE '025_%'"))
        .rows[0].checksum,
      checksum(installed.find(file => file.startsWith('025_'))!),
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

async function stageProduction(client: Client, bigintIds = false): Promise<void> {
  const staged = mkdtempSync(join(tmpdir(), 'social-prod-baseline-'));
  const files = migrationFiles().filter(
    file => (Number(file.slice(0, 3)) <= 22 || file.startsWith('030_')) && !isAuthorSource(file)
  );
  files.push('039_shared_author_compat.sql');
  for (const file of files) {
    let sql = readFileSync(join(dir, file), 'utf8');
    if (file.startsWith('001_') && bigintIds) {
      // Production's hand-created message table uses bigint, unlike prod 001.
      sql = sql.replace(
        /(CREATE TABLE messages \(\s*)id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/,
        '$1id BIGSERIAL PRIMARY KEY'
      );
      sql = sql.replace(/(reply_to_message_id|message_id) UUID /g, '$1 BIGINT ');
    }
    writeFileSync(join(staged, file), sql);
  }
  if (bigintIds) {
    // Install the richer deployed schema before its historical reaction backfill.
    for (const file of files.filter(file => Number(file.slice(0, 3)) <= 7))
      await client.query(readFileSync(join(staged, file), 'utf8'));
    await client.query('ALTER TABLE messages ADD COLUMN reactions jsonb');
  }
  await runMigrations(client, staged);
  await client.query(
    'CREATE TABLE _migrations(file text PRIMARY KEY, baseline boolean NOT NULL DEFAULT false, applied_at timestamptz NOT NULL DEFAULT now())'
  );
  await client.query(
    "INSERT INTO _migrations(file) SELECT version FROM schema_migrations WHERE version ~ '^0(0[1-9]|1[0-9]|20)_'"
  );
  await client.query('DROP TABLE schema_migrations');
}

for (const bigintIds of [false, true]) {
  test(`WhatsApp poll/event targets preserve ${bigintIds ? 'BIGINT' : 'UUID'} IDs and isolate notifications`, async () => {
    const { client, url } = await database(bigintIds ? 'response_bigint' : 'response_uuid');
    const listener = new Client({ connectionString: url });
    await listener.connect();
    try {
      await stageProduction(client, bigintIds);
      const beforeFix = mkdtempSync(join(tmpdir(), 'social-response-before-'));
      for (const file of migrationFiles().filter(
        file => Number(file.slice(0, 3)) < 35 && !isAuthorSource(file)
      ))
        writeFileSync(join(beforeFix, file), readFileSync(join(dir, file)));
      writeFileSync(
        join(beforeFix, '039_shared_author_compat.sql'),
        readFileSync(join(dir, '039_shared_author_compat.sql'))
      );
      await runMigrations(client, beforeFix);
      await client.query(`INSERT INTO conversations(id,account,name) VALUES
        ('personal:target','personal','Target'), ('personal:other','personal','Other'),
        ('secondary:other','secondary','Other')`);
      const target = (
        await client.query(`INSERT INTO messages
        (conversation_id,wa_message_id,account,platform,wa_timestamp,direction,sender_wa_id,message_type)
        VALUES ('personal:target','response-target','personal','whatsapp',now(),'INBOUND','peer','POLL')
        RETURNING id`)
      ).rows[0].id;
      const vote = `INSERT INTO whatsapp_poll_votes
        (account,poll_wa_message_id,voter_jid,conversation_id)
        VALUES ('personal','response-target','voter','personal:other')`;
      const event = `INSERT INTO whatsapp_event_responses
        (account,event_wa_message_id,responder_jid,conversation_id,response)
        VALUES ('personal','response-target','responder','personal:other','going')`;
      if (!bigintIds) {
        for (const sql of [vote, event])
          await assert.rejects(client.query(sql), (error: { code: string; where: string }) => {
            assert.equal(error.code, '22P02');
            assert.match(error.where, /social_notify_whatsapp_response/);
            return true;
          });
        assert.equal(
          (await client.query('SELECT count(*) FROM whatsapp_poll_votes')).rows[0].count,
          '0'
        );
      }
      await runMigrations(client);
      await runMigrations(client);
      const hints: Record<string, unknown>[] = [];
      listener.on('notification', message => {
        if (message.payload) hints.push(JSON.parse(message.payload));
      });
      await listener.query('LISTEN message_updated');
      const settle = () => new Promise(resolve => setTimeout(resolve, 30));
      const expected = (kind: string) => ({
        id: bigintIds ? Number(target) : target,
        conversation_id: 'personal:target',
        kind,
      });
      await client.query('BEGIN');
      await client.query(vote);
      await settle();
      assert.equal(hints.length, 0, 'notification waits for commit');
      await client.query('COMMIT');
      await settle();
      assert.deepEqual(hints, [expected('poll')]);
      await client.query(event);
      await settle();
      assert.deepEqual(hints, [expected('poll'), expected('event')]);
      for (const table of ['whatsapp_poll_votes', 'whatsapp_event_responses'])
        assert.equal(
          (await client.query(`SELECT conversation_id FROM ${table}`)).rows[0].conversation_id,
          'personal:target',
          'same-account response follows the target chat'
        );

      // Wrong legacy account, canonical account, provider, and missing target
      // must neither redirect a response into another chat nor refresh it.
      await client.query(`INSERT INTO social_accounts(id,channel,account_key,label,legacy_namespace)
        VALUES ('whatsapp:wrong','whatsapp','wrong','Wrong','wrong')`);
      await client.query(`INSERT INTO messages
        (conversation_id,wa_message_id,account,platform,wa_timestamp,direction,sender_wa_id,message_type)
        VALUES ('personal:target','telegram-target','personal','telegram',now(),'INBOUND','peer','TEXT')`);
      for (const [account, accountId, targetId, chat] of [
        ['secondary', null, 'response-target', 'secondary:other'],
        ['personal', 'whatsapp:wrong', 'response-target', 'personal:other'],
        ['personal', null, 'telegram-target', 'personal:other'],
        ['personal', null, 'missing-target', 'personal:other'],
      ]) {
        await client.query(
          `INSERT INTO whatsapp_poll_votes
          (account,account_id,poll_wa_message_id,voter_jid,conversation_id)
          VALUES ($1,$2,$3,$4,$5)`,
          [account, accountId, targetId, `voter-${targetId}-${accountId}`, chat]
        );
        await client.query(
          `INSERT INTO whatsapp_event_responses
          (account,account_id,event_wa_message_id,responder_jid,conversation_id,response)
          VALUES ($1,$2,$3,$4,$5,'going')`,
          [account, accountId, targetId, `responder-${targetId}-${accountId}`, chat]
        );
        for (const table of ['whatsapp_poll_votes', 'whatsapp_event_responses']) {
          const key =
            table === 'whatsapp_poll_votes' ? 'poll_wa_message_id' : 'event_wa_message_id';
          const person = table === 'whatsapp_poll_votes' ? 'voter_jid' : 'responder_jid';
          const prefix = table === 'whatsapp_poll_votes' ? 'voter' : 'responder';
          assert.equal(
            (
              await client.query(
                `SELECT conversation_id FROM ${table}
            WHERE account=$1 AND ${key}=$2 AND ${person}=$3`,
                [account, targetId, `${prefix}-${targetId}-${accountId}`]
              )
            ).rows[0].conversation_id,
            chat
          );
        }
      }
      await client.query(`UPDATE whatsapp_poll_votes SET conversation_id='personal:other'
        WHERE voter_jid='voter'`);
      await client.query(`UPDATE whatsapp_event_responses SET conversation_id='personal:other'
        WHERE responder_jid='responder'`);
      await settle();
      assert.equal(hints.length, 2, 'wrong chat and unmatched identities stay silent');
      await client.query(`UPDATE whatsapp_poll_votes SET conversation_id='personal:target',retracted=true
        WHERE voter_jid='voter'`);
      await client.query(`UPDATE whatsapp_event_responses SET conversation_id='personal:target',response='unknown'
        WHERE responder_jid='responder'`);
      await settle();
      assert.deepEqual(
        hints.slice(2),
        [expected('poll'), expected('event')],
        'withdrawals refresh target'
      );
      await client.query('BEGIN');
      await client.query(`UPDATE whatsapp_poll_votes SET retracted=false WHERE voter_jid='voter'`);
      await client.query(
        `UPDATE whatsapp_event_responses SET response='going' WHERE responder_jid='responder'`
      );
      await client.query('ROLLBACK');
      await settle();
      assert.equal(hints.length, 4, 'rollback never publishes notifications');
    } finally {
      await listener.end();
      await client.end();
    }
  });
}

test('upgrade imports prod 001-020 ledger, retains bigint rows, and preserves all four send states', async () => {
  const { client } = await database('prod_upgrade');
  try {
    await stageProduction(client, true);
    await client.query(
      "INSERT INTO conversations(id,account,name) VALUES('prod:peer','personal','Peer')"
    );
    const message = (
      await client.query(
        "INSERT INTO messages(conversation_id,wa_message_id,wa_timestamp,direction,sender_wa_id,message_type) VALUES('prod:peer','prod-message',now(),'INBOUND','prod:peer','TEXT') RETURNING id"
      )
    ).rows[0].id;
    await client.query(
      "INSERT INTO whatsapp_send_attempts(account,key_hash,request_hash,status,error) SELECT 'personal',s,s,s,CASE WHEN s='failed' THEN 'failure' END FROM unnest(ARRAY['prepared','pending','sent','failed']) s"
    );
    await runMigrations(client);
    await runMigrations(client);
    assert.equal(
      (await client.query('SELECT id FROM messages WHERE wa_message_id=$1', ['prod-message']))
        .rows[0].id,
      message
    );
    assert.equal((await client.query('SELECT count(*) FROM _migrations')).rows[0].count, '20');
    assert.equal(
      (await client.query('SELECT count(*) FROM schema_migrations')).rows[0].count,
      String(migrationFiles().length)
    );
    assert.deepEqual(
      (await client.query('SELECT status FROM whatsapp_send_attempts ORDER BY status')).rows.map(
        r => r.status
      ),
      ['failed', 'pending', 'prepared', 'sent']
    );
    assert.equal(
      (await client.query("SELECT error FROM whatsapp_send_attempts WHERE status='failed'")).rows[0]
        .error,
      'failure'
    );
    await client.query(
      "INSERT INTO conversations(id,account,name) VALUES('prod:alias','personal','Alias')"
    );
    await client.query("UPDATE messages SET conversation_id='prod:alias' WHERE id=$1", [message]);
    await client.query(
      "UPDATE conversations SET muted=true,mute_until=NULL,pinned_at='2026-01-01T00:00:00Z' WHERE id='prod:alias'"
    );
    await client.query(
      "INSERT INTO whatsapp_message_reactions(account,target_wa_message_id,reactor_jid,conversation_id,emoji) VALUES('personal','prod-message','reactor','prod:alias','heart')"
    );
    await client.query(
      "INSERT INTO whatsapp_poll_votes(account,poll_wa_message_id,voter_jid,conversation_id) VALUES('personal','prod-message','voter','prod:alias')"
    );
    await client.query(
      "INSERT INTO whatsapp_event_responses(account,event_wa_message_id,responder_jid,conversation_id,response) VALUES('personal','prod-message','responder','prod:alias','going')"
    );
    assert.equal(
      (await client.query("SELECT social_merge_conversation('prod:alias','prod:peer') n")).rows[0]
        .n,
      1
    );
    const merged = (
      await client.query(
        "SELECT muted,mute_until,pinned_at IS NOT NULL pinned FROM conversations WHERE id='prod:peer'"
      )
    ).rows[0];
    assert.deepEqual(merged, { muted: true, mute_until: null, pinned: true });
    for (const table of [
      'whatsapp_message_reactions',
      'whatsapp_poll_votes',
      'whatsapp_event_responses',
    ])
      assert.equal(
        (await client.query(`SELECT conversation_id FROM ${table}`)).rows[0].conversation_id,
        'prod:peer'
      );
    assert.equal(
      (await client.query("SELECT social_unmerge_conversation('prod:alias') n")).rows[0].n,
      1
    );
    for (const table of [
      'whatsapp_message_reactions',
      'whatsapp_poll_votes',
      'whatsapp_event_responses',
    ])
      assert.equal(
        (await client.query(`SELECT conversation_id FROM ${table}`)).rows[0].conversation_id,
        'prod:alias'
      );
  } finally {
    await client.end();
  }
});

test('SKIRM-257: the hand-made prod message table without deleted_at runs 038 and keeps metadata revocations', async () => {
  const { client } = await database('prod_no_deleted_at');
  try {
    await stageProduction(client, true);
    // The deployed table never had 001's column (42703 measured on prod, 23-10).
    await client.query('ALTER TABLE messages DROP COLUMN deleted_at');
    await client.query(
      "INSERT INTO conversations(id,account,name) VALUES('prod:peer','personal','Peer')"
    );
    await client.query(
      `INSERT INTO messages(conversation_id,wa_message_id,wa_timestamp,direction,sender_wa_id,message_type,
         platform,is_deleted,metadata)
       VALUES('prod:peer','revoked',now(),'INBOUND','prod:peer','TEXT','whatsapp',true,
         '{"deleted_at":"2026-10-20T13:00:00Z"}')`
    );
    await runMigrations(client);
    await runMigrations(client);
    const row = (
      await client.query(
        `SELECT to_char(deleted_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS deleted_at, metadata->>'deleted_at' AS meta
           FROM messages WHERE wa_message_id='revoked'`
      )
    ).rows[0];
    assert.equal(row.meta, '2026-10-20T13:00:00Z');
    assert.equal(row.deleted_at, '2026-10-20T13:00:00');
    assert.equal(
      (await client.query('SELECT count(*) FROM schema_migrations')).rows[0].count,
      String(migrationFiles().length)
    );
  } finally {
    await client.end();
  }
});

test('SKIRM-261: a prefixed participant filed under another account does not abort 039 on prod data', async () => {
  const { client } = await database('prod_contacts_collision');
  try {
    await stageProduction(client, true);
    // Prod still holds the author's read-only view, ledgered with the author files.
    await client.query('DROP TABLE whatsapp_contacts');
    await client.query(readFileSync(join(dir, '022_whatsapp_contacts_view.sql'), 'utf8'));
    await client.query(
      `INSERT INTO _migrations(file) VALUES('021_whatsapp_novedades_channels.sql'),
         ('022_whatsapp_contacts_view.sql'),('023_whatsapp_chat_time_index.sql')`
    );
    await client.query(
      `INSERT INTO social_accounts(id,channel,account_key,label,legacy_namespace) VALUES
         ('telegram:personal','telegram','personal','personal','personal'),
         ('telegram:professional','telegram','professional','professional','professional')
       ON CONFLICT DO NOTHING`
    );
    // Measured on prod (23-10): the professional row was written with account='personal',
    // so the view yields (personal, tg_3401402332) twice.
    await client.query(
      `INSERT INTO participants(id,account,account_id,external_id,name) VALUES
         ('tg_3401402332','personal','telegram:personal','tg_3401402332','Sauvage Club'),
         ('professional:tg_3401402332','personal','telegram:professional','tg_3401402332','Sauvage Club')`
    );
    await runMigrations(client);
    await runMigrations(client);
    assert.deepEqual(
      (
        await client.query(
          "SELECT account,jid FROM whatsapp_contacts WHERE jid='tg_3401402332' ORDER BY account"
        )
      ).rows,
      [
        { account: 'personal', jid: 'tg_3401402332' },
        { account: 'professional', jid: 'tg_3401402332' },
      ]
    );
    assert.equal(
      (await client.query("SELECT account FROM participants WHERE id='professional:tg_3401402332'"))
        .rows[0].account,
      'professional'
    );
  } finally {
    await client.end();
  }
});

test('legacy NAS send attempts retain token hashes and timestamps and accept prod inserts', async () => {
  const { client } = await database('send_legacy');
  try {
    await stageProduction(client);
    await client.query('DROP TABLE whatsapp_send_attempts');
    await client.query(
      `CREATE TABLE whatsapp_send_attempts(account text NOT NULL,token_hash text NOT NULL,request_hash text NOT NULL,message_id text NOT NULL,status text NOT NULL CHECK(status IN ('prepared','pending','sent')),created_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,PRIMARY KEY(account,token_hash))`
    );
    await client.query(
      "INSERT INTO whatsapp_send_attempts(account,token_hash,request_hash,message_id,status,sent_at) SELECT 'personal',s,s,s,s,'2026-01-01T00:00:00Z' FROM unnest(ARRAY['prepared','pending','sent']) s"
    );
    await runMigrations(client);
    assert.deepEqual(
      (
        await client.query(
          'SELECT key_hash,token_hash,status,updated_at=sent_at same_time FROM whatsapp_send_attempts ORDER BY status'
        )
      ).rows,
      ['pending', 'prepared', 'sent'].map(s => ({
        key_hash: s,
        token_hash: s,
        status: s,
        same_time: true,
      }))
    );
    await client.query(
      "INSERT INTO whatsapp_send_attempts(account,key_hash,request_hash,status,error) VALUES('personal','new-key','new-request','failed','retryable') ON CONFLICT(account,key_hash) DO NOTHING"
    );
    assert.equal(
      (await client.query("SELECT token_hash FROM whatsapp_send_attempts WHERE key_hash='new-key'"))
        .rows[0].token_hash,
      'new-key'
    );
  } finally {
    await client.end();
  }
});

test('dimension changes preserve populated vectors and support the singular env alias', async () => {
  const { client } = await database('dimensions');
  const previous = process.env.EMBEDDING_DIMENSION;
  try {
    process.env.EMBEDDING_DIMENSION = '4096';
    await runMigrations(client);
    assert.equal(
      (
        await client.query(
          "SELECT atttypmod FROM pg_attribute WHERE attrelid='message_embeddings'::regclass AND attname='embedding'"
        )
      ).rows[0].atttypmod,
      4096
    );
    assert.equal(
      (await client.query("SELECT to_regclass('idx_message_embeddings_vector') i")).rows[0].i,
      null
    );
    await client.query(
      "INSERT INTO conversations(id,account,name) VALUES('peer','personal','Peer')"
    );
    const m = (
      await client.query(
        "INSERT INTO messages(conversation_id,wa_message_id,wa_timestamp,direction,sender_wa_id,message_type) VALUES('peer','embedding-message',now(),'INBOUND','peer','TEXT') RETURNING id"
      )
    ).rows[0].id;
    await client.query(
      "INSERT INTO message_embeddings(message_id,embedding,model) VALUES($1,$2::vector,'preserved')",
      [m, JSON.stringify(Array(4096).fill(0))]
    );
    process.env.EMBEDDING_DIMENSION = '1024';
    await assert.rejects(runMigrations(client), /Embedding dimension mismatch/);
    assert.equal(
      (await client.query('SELECT vector_dims(embedding) dims FROM message_embeddings')).rows[0]
        .dims,
      4096
    );
    process.env.EMBEDDING_DIMENSIONS = '4096';
    await runMigrations(client);
  } finally {
    delete process.env.EMBEDDING_DIMENSIONS;
    if (previous === undefined) delete process.env.EMBEDDING_DIMENSION;
    else process.env.EMBEDDING_DIMENSION = previous;
    await client.end();
  }
});

test(
  'released NAS ledger migrates without reopening historical checksums',
  { skip: !process.env.LEGACY_NAS_MIGRATIONS_DIR },
  async () => {
    const { client } = await database('nas_ledger');
    try {
      const source = process.env.LEGACY_NAS_MIGRATIONS_DIR!;
      await client.query(
        'CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,adopted boolean NOT NULL DEFAULT false,applied_at timestamptz NOT NULL DEFAULT now())'
      );
      for (const file of readdirSync(source)
        .filter(file => file.endsWith('.sql'))
        .sort()) {
        const sql = readFileSync(join(source, file));
        await client.query(sql.toString());
        await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
          file,
          createHash('sha256').update(sql).digest('hex'),
        ]);
      }
      await runMigrations(client);
      await runMigrations(client);
      assert.equal(
        (
          await client.query(
            "SELECT count(*) FROM schema_migrations WHERE version='legacy/nas/001_initial_schema.sql'"
          )
        ).rows[0].count,
        '1'
      );
      assert.equal(
        (
          await client.query(
            "SELECT atttypmod FROM pg_attribute WHERE attrelid='message_embeddings'::regclass AND attname='embedding'"
          )
        ).rows[0].atttypmod,
        4096
      );
    } finally {
      await client.end();
    }
  }
);
