// Explicit disposable database only; each test creates its own empty database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from 'pg';
import { runMigrations } from '../mcp-server/src/infrastructure/database/migrate';

const root = join(__dirname, '..');
const migrations = join(root, 'mcp-server/src/infrastructure/database/migrations');
const author = '1470fa85ec529cafb7090baa9f22429812a34236';
const sql = (name: string) => readFileSync(join(migrations, name), 'utf8');
const authorSql = (name: string) =>
  execFileSync(
    'git',
    ['show', `${author}:mcp-server/src/infrastructure/database/migrations/${name}`],
    { cwd: root, encoding: 'utf8' }
  );

async function database(label: string): Promise<Client> {
  assert.equal(process.env.SHARED_DB_AUDIT_DISPOSABLE, '1', 'Explicit disposable opt-in required');
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point at disposable PostgreSQL');
  const url = new URL(process.env.DATABASE_URL);
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  const name = `shared_db_audit_${label}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

for (const kind of ['uuid', 'bigint'] as const) {
  test(`all fork migrations apply and rerun with ${kind} messages; receipts keep external text IDs`, async () => {
    const client = await database(kind);
    try {
      const staged = mkdtempSync(join(tmpdir(), 'social-shared-schema-'));
      const files = readdirSync(migrations)
        .filter(name => name.endsWith('.sql'))
        .sort();
      const preReceipts = mkdtempSync(join(tmpdir(), 'social-shared-before-receipts-'));
      for (const file of files) {
        let body = sql(file);
        if (kind === 'bigint' && file.startsWith('001_')) {
          // Model the author's documented message IDs without altering released SQL.
          body = body.replace(
            /(CREATE TABLE messages \(\s*)id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/,
            '$1id BIGSERIAL PRIMARY KEY'
          );
          body = body.replace(/(reply_to_message_id|message_id) UUID /g, '$1 BIGINT ');
        }
        writeFileSync(join(staged, file), body);
        if (!file.startsWith('038_')) writeFileSync(join(preReceipts, file), body);
      }
      if (kind === 'bigint') {
        for (const file of files.filter(name => /^00[1-7]_/.test(name)))
          await client.query(readFileSync(join(staged, file), 'utf8'));
        // The author's deployed schema has this legacy column before 015.
        await client.query('ALTER TABLE messages ADD COLUMN reactions jsonb');
      }
      await runMigrations(client, preReceipts);
      assert.equal(
        (
          await client.query(
            "SELECT data_type FROM information_schema.columns WHERE table_name='messages' AND column_name='id'"
          )
        ).rows[0].data_type,
        kind
      );
      assert.equal(
        (
          await client.query(
            "SELECT data_type FROM information_schema.columns WHERE table_name='conversations' AND column_name='id'"
          )
        ).rows[0].data_type,
        'text'
      );
      await client.query(
        "INSERT INTO conversations(id,account,name) VALUES('audit:peer','personal','Synthetic peer')"
      );
      const message = (
        await client.query(
          "INSERT INTO messages(conversation_id,wa_message_id,wa_timestamp,direction,sender_wa_id,message_type,platform,account) VALUES('audit:peer','audit-wa',now(),'OUTBOUND','audit:peer','TEXT','whatsapp','personal') RETURNING id"
        )
      ).rows[0].id;
      await client.query(
        "INSERT INTO whatsapp_message_payloads(account,wa_message_id,conversation_id,message_key,message_payload) VALUES('personal','audit-wa','audit:peer','{\"fromMe\":true}','{\"conversation\":\"synthetic\"}')"
      );
      await runMigrations(client, staged);
      await runMigrations(client, staged);
      assert.equal(
        (await client.query('SELECT status FROM messages WHERE id=$1', [message])).rows[0].status,
        'sent'
      );
      await client.query(
        "INSERT INTO whatsapp_message_receipts(account,chat_id,message_id,participant_id,aliases,read_at) VALUES('personal','audit:peer','audit-wa','audit:participant',ARRAY['audit:participant'],now())"
      );
      assert.equal((await client.query('SELECT id FROM messages')).rows[0].id, message);
      assert.equal(
        (await client.query('SELECT message_id FROM whatsapp_message_receipts')).rows[0].message_id,
        'audit-wa'
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='whatsapp_message_receipts'::regclass AND contype='f'"
          )
        ).rows[0].n,
        0
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,
        files.length
      );
    } finally {
      await client.end();
    }
  });
}

test('raw author contact view conflicts with the durable table and Hindsight trigger contract', async () => {
  const client = await database('contacts');
  try {
    await client.query('CREATE TABLE participants(account text,id text,name text,push_name text)');
    await client.query(
      'CREATE TABLE whatsapp_contacts(account text,jid text,phone text,name text,push_name text)'
    );
    await client.query(
      "INSERT INTO whatsapp_contacts VALUES('personal','audit-peer','000','Saved name','Push name')"
    );
    await assert.rejects(
      client.query(authorSql('022_whatsapp_contacts_view.sql')),
      (error: any) => error.code === '42809'
    );
    assert.equal(
      (await client.query('SELECT name FROM whatsapp_contacts')).rows[0].name,
      'Saved name'
    );
    await client.query('ALTER TABLE whatsapp_contacts RENAME TO preserved_contacts');
    await client.query(authorSql('022_whatsapp_contacts_view.sql'));
    await client.query(
      'CREATE FUNCTION audit_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'
    );
    await assert.rejects(
      client.query(
        'CREATE TRIGGER audit_contact_trigger AFTER INSERT OR DELETE OR UPDATE OF name,push_name,phone ON whatsapp_contacts FOR EACH ROW EXECUTE FUNCTION audit_trigger()'
      ),
      (error: any) => ['42809', '42703'].includes(error.code)
    );
  } finally {
    await client.end();
  }
});

test('omitted TEXT to UUID history FK remains a required compatibility case', async () => {
  const client = await database('history_fk');
  try {
    await client.query('CREATE TABLE conversations(id uuid PRIMARY KEY)');
    await assert.rejects(
      client.query(
        'CREATE TABLE incompatible_history(conversation_id text REFERENCES conversations(id))'
      ),
      (error: any) => error.code === '42804'
    );
    await client.query(
      'CREATE TABLE whatsapp_message_keys(wa_message_id text PRIMARY KEY,conversation_id text NOT NULL)'
    );
    await client.query(
      "INSERT INTO whatsapp_message_keys VALUES('synthetic-wa','synthetic-provider-chat')"
    );
    assert.equal(
      (await client.query('SELECT conversation_id FROM whatsapp_message_keys')).rows[0]
        .conversation_id,
      'synthetic-provider-chat'
    );
  } finally {
    await client.end();
  }
});

test('raw author channels migration does not widen a connector-owned existing table', async () => {
  const client = await database('channels');
  try {
    await client.query('CREATE TABLE social_accounts(id text PRIMARY KEY)');
    await client.query(
      'CREATE TABLE whatsapp_novedades_channels(account text,channel_jid text,name text NOT NULL,PRIMARY KEY(account,channel_jid))'
    );
    await client.query(
      "INSERT INTO whatsapp_novedades_channels VALUES('personal','audit@newsletter','Saved channel')"
    );
    await client.query(authorSql('021_whatsapp_novedades_channels.sql'));
    await assert.rejects(
      client.query(
        "INSERT INTO whatsapp_novedades_channels VALUES('personal','second@newsletter','Second')"
      ),
      (error: any) => error.code === '42703'
    );
    assert.equal(
      (await client.query('SELECT name FROM whatsapp_novedades_channels')).rows[0].name,
      'Saved channel'
    );
  } finally {
    await client.end();
  }
});
