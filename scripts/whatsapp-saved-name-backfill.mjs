#!/usr/bin/env node
// One-account, one-contact import from the personal wacli companion.
// The selector and before-image stay outside this repository with mode 0600.
// Required for dry-run/apply: DATABASE_URL, WACLI_DB_PATH,
// WACLI_SESSION_DB_PATH, SOCIALMEDIA_CREDS_PATH, SELECTOR_FILE.
// Apply and rollback additionally require BACKUP_FILE outside this repository.
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { openSync, readFileSync, writeFileSync, closeSync, fsyncSync, existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const ACCOUNT = 'personal';
const REPO = resolve(import.meta.dirname, '..');
const MODES = new Set(['--dry-run', '--self-test', '--apply', '--rollback']);

class BackfillError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireOutsideRepo(path) {
  if (!path) throw new BackfillError('missing_private_path');
  const absolute = resolve(path);
  const canonical = existsSync(absolute)
    ? realpathSync(absolute)
    : resolve(realpathSync(dirname(absolute)), basename(absolute));
  if (canonical === REPO || canonical.startsWith(`${REPO}/`)) {
    throw new BackfillError('private_path_in_repository');
  }
  return canonical;
}

function readPrivateJson(path) {
  const canonical = requireOutsideRepo(path);
  const file = statSync(canonical);
  if (!file.isFile() || (file.mode & 0o077) !== 0) {
    throw new BackfillError('private_file_permissions');
  }
  return JSON.parse(readFileSync(canonical, 'utf8'));
}

function phoneFromJid(value) {
  const match = /^(\d{6,15})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/.exec(String(value || ''));
  return match?.[1] || null;
}

function phoneAliases(phone) {
  return [`${phone}@c.us`, `${phone}@s.whatsapp.net`];
}

function openSource(path) {
  return new DatabaseSync(requireOutsideRepo(path), { readOnly: true, timeout: 1000 });
}

function selectedSource() {
  const selector = readPrivateJson(process.env.SELECTOR_FILE);
  if (
    selector.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(selector.key) ||
    !/^[a-f0-9]{64}$/.test(selector.mac)
  ) {
    throw new BackfillError('invalid_selector');
  }
  const key = Buffer.from(selector.key, 'hex');
  const expected = Buffer.from(selector.mac, 'hex');
  const contacts = openSource(process.env.WACLI_DB_PATH);
  try {
    const rows = contacts
      .prepare('SELECT jid, full_name FROM contacts WHERE full_name IS NOT NULL')
      .all();
    const matches = rows.filter(row => {
      const digest = createHmac('sha256', key).update(`${row.jid}\0${row.full_name}`).digest();
      return timingSafeEqual(digest, expected);
    });
    if (
      matches.length !== 1 ||
      !phoneFromJid(matches[0].jid) ||
      !matches[0].full_name.trim() ||
      Array.from(matches[0].full_name).length > 256 ||
      /[\x00-\x1f\x7f]/.test(matches[0].full_name)
    ) {
      throw new BackfillError('source_not_unique');
    }
    const phone = phoneFromJid(matches[0].jid);
    const conflicting = rows.some(
      row => phoneFromJid(row.jid) === phone && row.full_name.trim() !== matches[0].full_name.trim()
    );
    if (conflicting) throw new BackfillError('source_name_conflict');
    return { phone, name: matches[0].full_name.trim() };
  } finally {
    contacts.close();
  }
}

function verifySameAccount() {
  const session = openSource(process.env.WACLI_SESSION_DB_PATH);
  let devices;
  try {
    devices = session.prepare('SELECT jid FROM whatsmeow_device').all();
  } finally {
    session.close();
  }
  const credentials = JSON.parse(
    readFileSync(requireOutsideRepo(process.env.SOCIALMEDIA_CREDS_PATH), 'utf8')
  );
  const owner = phoneFromJid(String(credentials.me?.id || '').replace(/:\d+@/, '@'));
  if (devices.length !== 1 || !owner || phoneFromJid(devices[0].jid) !== owner) {
    throw new BackfillError('account_identity_mismatch');
  }
}

async function plan(client, source, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const chats = (
    await client.query(
      `SELECT id, wa_chat_id, name, updated_at::text AS updated_at FROM conversations
     WHERE account=$1 AND is_group=false
       AND (wa_chat_id=ANY($2::text[]) OR id=ANY($2::text[]))${suffix}`,
      [ACCOUNT, phoneAliases(source.phone)]
    )
  ).rows;
  if (
    chats.length !== 1 ||
    !/^\d+@lid$/.test(chats[0].id) ||
    phoneFromJid(chats[0].wa_chat_id) !== source.phone
  ) {
    throw new BackfillError('pn_lid_mapping_not_unique');
  }
  const chat = chats[0];
  const contacts = (
    await client.query(
      `SELECT jid, name, push_name, updated_at::text AS updated_at FROM whatsapp_contacts
     WHERE account=$1 AND (jid=$2 OR jid=ANY($3::text[]))${suffix}`,
      [ACCOUNT, chat.id, phoneAliases(source.phone)]
    )
  ).rows;
  const target = contacts.find(row => row.jid === chat.id);
  if (!target || contacts.some(row => String(row.name || '').trim())) {
    throw new BackfillError('saved_name_already_present');
  }
  const people = (
    await client.query(
      `SELECT id, name, push_name FROM participants WHERE account=$1 AND id=$2${suffix}`,
      [ACCOUNT, chat.id]
    )
  ).rows;
  if (
    people.length !== 1 ||
    !people[0].push_name ||
    people[0].name !== people[0].push_name ||
    chat.name !== people[0].push_name
  ) {
    throw new BackfillError('title_no_longer_push_name');
  }
  return { chat, contact: target, participant: people[0], source };
}

async function applyPlan(client, prepared) {
  const { chat, contact, participant, source } = prepared;
  const saved = await client.query(
    `UPDATE whatsapp_contacts SET name=$3, updated_at=now()
      WHERE account=$1 AND jid=$2 AND (name IS NULL OR btrim(name)='')
      RETURNING updated_at::text AS updated_at`,
    [ACCOUNT, contact.jid, source.name]
  );
  const person = await client.query(
    `UPDATE participants SET name=$3
      WHERE account=$1 AND id=$2 AND name=$4 AND push_name=$4
      RETURNING id`,
    [ACCOUNT, participant.id, source.name, participant.push_name]
  );
  const title = await client.query(
    `UPDATE conversations SET name=$3, updated_at=now()
      WHERE account=$1 AND id=$2 AND is_group=false AND name=$4
      RETURNING updated_at::text AS updated_at`,
    [ACCOUNT, chat.id, source.name, chat.name]
  );
  if (saved.rowCount !== 1 || person.rowCount !== 1 || title.rowCount !== 1) {
    throw new BackfillError('compare_and_set_failed');
  }
  return {
    version: 1,
    account: ACCOUNT,
    jid: chat.id,
    sourcePhone: source.phone,
    appliedName: source.name,
    before: {
      contact: { name: contact.name, pushName: contact.push_name, updatedAt: contact.updated_at },
      participant: { name: participant.name, pushName: participant.push_name },
      conversation: { name: chat.name, updatedAt: chat.updated_at },
    },
    appliedAt: {
      contact: saved.rows[0].updated_at,
      conversation: title.rows[0].updated_at,
    },
  };
}

async function verifyApplied(client, prepared) {
  const { rows } = await client.query(
    `SELECT c.name AS title, p.name AS person, wc.name AS saved
    FROM conversations c JOIN participants p ON p.account=c.account AND p.id=c.id
    JOIN whatsapp_contacts wc ON wc.account=c.account AND wc.jid=c.id
    WHERE c.account=$1 AND c.id=$2`,
    [ACCOUNT, prepared.chat.id]
  );
  if (rows.length !== 1 || Object.values(rows[0]).some(value => value !== prepared.source.name)) {
    throw new BackfillError('verification_failed');
  }
}

async function rollback(client, backup) {
  if (
    backup.version !== 1 ||
    backup.account !== ACCOUNT ||
    !/^\d+@lid$/.test(backup.jid) ||
    !phoneFromJid(`${backup.sourcePhone}@s.whatsapp.net`)
  ) {
    throw new BackfillError('invalid_backup');
  }
  const saved = await client.query(
    `UPDATE whatsapp_contacts SET name=$3, updated_at=$4
      WHERE account=$1 AND jid=$2 AND name=$5 AND updated_at=$6
      RETURNING jid`,
    [
      ACCOUNT,
      backup.jid,
      backup.before.contact.name,
      backup.before.contact.updatedAt,
      backup.appliedName,
      backup.appliedAt.contact,
    ]
  );
  const person = await client.query(
    `UPDATE participants SET name=$3
      WHERE account=$1 AND id=$2 AND name=$4 AND push_name=$5
      RETURNING id`,
    [
      ACCOUNT,
      backup.jid,
      backup.before.participant.name,
      backup.appliedName,
      backup.before.participant.pushName,
    ]
  );
  const title = await client.query(
    `UPDATE conversations SET name=$3, updated_at=$4
      WHERE account=$1 AND id=$2 AND name=$5 AND updated_at=$6 AND is_group=false
      RETURNING id`,
    [
      ACCOUNT,
      backup.jid,
      backup.before.conversation.name,
      backup.before.conversation.updatedAt,
      backup.appliedName,
      backup.appliedAt.conversation,
    ]
  );
  if (saved.rowCount !== 1 || person.rowCount !== 1 || title.rowCount !== 1) {
    throw new BackfillError('rollback_conflict');
  }
}

async function selfTest(client) {
  await client.query('BEGIN');
  try {
    await client.query(`CREATE TEMP TABLE conversations (
      id text PRIMARY KEY, account text, wa_chat_id text, name text,
      is_group boolean, updated_at timestamptz DEFAULT now());
      CREATE TEMP TABLE participants (id text PRIMARY KEY, account text, name text, push_name text);
      CREATE TEMP TABLE whatsapp_contacts (
        account text, jid text, name text, push_name text, updated_at timestamptz DEFAULT now(),
        PRIMARY KEY (account,jid));
      INSERT INTO conversations (id,account,wa_chat_id,name,is_group)
        VALUES ('12025550123@lid','personal','34600111222@s.whatsapp.net','Fixture',false);
      INSERT INTO participants VALUES ('12025550123@lid','personal','Fixture','Fixture');
      INSERT INTO whatsapp_contacts (account,jid,name,push_name)
        VALUES ('personal','12025550123@lid',NULL,'Fixture');
      INSERT INTO conversations (id,account,wa_chat_id,name,is_group)
        VALUES ('22025550123@lid','secondary','34600111222@s.whatsapp.net','Other',false);`);
    const source = { phone: '34600111222', name: 'Fixture saved' };
    const prepared = await plan(client, source, true);
    const backup = JSON.parse(JSON.stringify(await applyPlan(client, prepared)));
    await verifyApplied(client, prepared);
    await rollback(client, backup);
    const foreign = await client.query(`SELECT name FROM conversations
      WHERE account='secondary' AND id='22025550123@lid'`);
    assert.equal(foreign.rows[0].name, 'Other');
    const restored = await client.query(
      `SELECT c.name AS title, p.name AS person, wc.name AS saved
      FROM conversations c JOIN participants p ON p.account=c.account AND p.id=c.id
      JOIN whatsapp_contacts wc ON wc.account=c.account AND wc.jid=c.id
      WHERE c.account=$1 AND c.id=$2`,
      [ACCOUNT, prepared.chat.id]
    );
    assert.deepEqual(restored.rows[0], { title: 'Fixture', person: 'Fixture', saved: null });
    await client.query(`INSERT INTO conversations (id,account,wa_chat_id,name,is_group)
      VALUES ('32025550123@lid','personal','34600111222@s.whatsapp.net','Duplicate',false)`);
    await assert.rejects(
      plan(client, source, true),
      error => error instanceof BackfillError && error.code === 'pn_lid_mapping_not_unique'
    );
  } finally {
    await client.query('ROLLBACK');
  }
}

async function main() {
  const mode = process.argv[2] || '--dry-run';
  if (!MODES.has(mode) || process.argv.length > 3) throw new BackfillError('invalid_mode');
  if (!process.env.DATABASE_URL) throw new BackfillError('missing_database_url');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if (mode === '--self-test') {
      await selfTest(client);
      console.log(JSON.stringify({ mode: 'self-test', passed: true, liveRowsChanged: 0 }));
      return;
    }
    if (mode === '--rollback') {
      const backup = readPrivateJson(process.env.BACKUP_FILE);
      await client.query('BEGIN');
      try {
        await rollback(client, backup);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      console.log(JSON.stringify({ mode: 'rollback', rowsRestored: 3 }));
      return;
    }
    verifySameAccount();
    const source = selectedSource();
    await client.query(mode === '--dry-run' ? 'BEGIN READ ONLY' : 'BEGIN');
    try {
      const prepared = await plan(client, source, mode === '--apply');
      if (mode === '--dry-run') {
        await client.query('ROLLBACK');
        console.log(
          JSON.stringify({
            mode: 'dry-run',
            identityVerified: true,
            uniqueMapping: true,
            compareAndSetEligible: true,
            rowsWouldChange: 3,
          })
        );
        return;
      }
      const backupPath = requireOutsideRepo(process.env.BACKUP_FILE);
      const backup = await applyPlan(client, prepared);
      await verifyApplied(client, prepared);
      const fd = openSync(backupPath, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(backup));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const directory = openSync(dirname(backupPath), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      await client.query('COMMIT');
      console.log(JSON.stringify({ mode: 'apply', rowsChanged: 3, backupCreated: true }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(
    `backfill failed: ${error instanceof BackfillError ? error.code : 'unexpected_error'}`
  );
  process.exitCode = 1;
});
