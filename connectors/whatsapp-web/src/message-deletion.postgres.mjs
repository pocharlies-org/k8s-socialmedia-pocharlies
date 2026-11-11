// Run with SHARED_DB_AUDIT_DISPOSABLE=1 and DATABASE_URL pointing at scratch PostgreSQL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

assert.equal(process.env.SHARED_DB_AUDIT_DISPOSABLE, '1', 'Explicit disposable opt-in required');
assert.ok(process.env.DATABASE_URL, 'Scratch DATABASE_URL is required');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const schema = `connector_deletion_${randomUUID().replaceAll('-', '')}`;
const originalQuery = pg.Pool.prototype.query;
const originalAccount = process.env.CONNECTOR_ACCOUNT;
pg.Pool.prototype.query = function (sql, params) {
  return client.query(sql, params);
};
process.env.CONNECTOR_ACCOUNT = 'professional';

try {
  assert.equal(
    (await client.query('SHOW server_version_num')).rows[0].server_version_num.slice(0, 2),
    '16'
  );
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(`SET TIME ZONE 'Europe/Madrid'`);
  const durable = await import('./durable-message-store.ts');
  const mutations = await import('./message-mutations.ts');
  const writer = await import('./db-writer.ts');
  const first = '2026-10-10T09:20:00.123456Z';
  const action = { source: 'connector', actor: 'qa', at: new Date('2026-10-20T12:00:00Z') };
  for (const kind of ['uuid_timestamp', 'uuid_timestamptz', 'bigint_metadata']) {
    const legacy = kind !== 'bigint_metadata';
    const idType = legacy ? 'uuid' : 'bigint';
    await client.query(`CREATE TABLE messages (
      id ${idType} PRIMARY KEY, wa_message_id text, account text, account_id text,
      platform text, conversation_id text, content text, raw_payload bytea,
      is_deleted boolean DEFAULT false, status text DEFAULT 'read', status_at timestamptz,
      updated_at timestamptz, metadata jsonb
      ${legacy ? `, deleted_at ${kind === 'uuid_timestamp' ? 'timestamp' : 'timestamptz'}` : ''}
    )`);
    await client.query(
      `CREATE TABLE whatsapp_message_payloads (wa_message_id text, message_payload jsonb)`
    );
    await client.query(`CREATE TABLE attachments (message_id ${idType}, storage_key text)`);
    let index = 0;
    const makeRow = async (
      name,
      metadata = null,
      oldDeletedAt = null,
      account = 'professional',
      platform = 'whatsapp'
    ) => {
      index += 1;
      const id = legacy
        ? `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`
        : String(index);
      await client.query(
        `INSERT INTO messages
        (id, wa_message_id, account, account_id, platform, conversation_id, content, raw_payload, metadata
          ${legacy ? ', deleted_at' : ''})
        VALUES ($1,$2,$3,$4,$5,'professional:123@g.us','retained text',decode('cafe','hex'),$6
          ${legacy ? ',$7' : ''})`,
        [
          id,
          `professional:${name}`,
          account,
          `whatsapp:${account}`,
          platform,
          metadata && JSON.stringify(metadata),
          ...(legacy ? [oldDeletedAt] : []),
        ]
      );
      await client.query(
        `INSERT INTO whatsapp_message_payloads VALUES ($1, '{"conversation":"retained payload"}')`,
        [`professional:${name}`]
      );
      await client.query('INSERT INTO attachments VALUES ($1,$2)', [id, `media/${id}`]);
      return id;
    };
    const row = async id =>
      (
        await client.query("SELECT *, encode(raw_payload,'hex') AS raw FROM messages WHERE id=$1", [
          id,
        ])
      ).rows[0];
    for (const route of ['mutation', 'status', 'durable']) {
      const name = `${route}-fresh`;
      const id = await makeRow(name, { preserved: 'metadata' });
      const wrongAccount = await makeRow(name, null, null, 'personal');
      const wrongPlatform = await makeRow(name, null, null, 'professional', 'telegram');
      const revoke = async () =>
        route === 'mutation'
          ? mutations.markMessageRevoked(name, action)
          : route === 'status'
            ? writer.setMessageStatus(name, 'deleted')
            : durable.markMessageDeleted(name);
      await revoke();
      const initial = await row(id);
      assert.equal(initial.is_deleted, true);
      assert.equal(initial.status, 'deleted');
      assert.ok(Number.isFinite(Date.parse(initial.metadata.deleted_at)));
      assert.equal(initial.metadata.preserved, 'metadata');
      await revoke();
      assert.deepEqual(
        (await row(id)).metadata,
        initial.metadata,
        `${kind} ${route} replay preserves first timestamp/provenance`
      );
      assert.equal((await row(wrongAccount)).is_deleted, false);
      assert.equal((await row(wrongPlatform)).is_deleted, false);
      if (legacy)
        assert.equal(
          (await row(id)).deleted_at,
          null,
          'metadata writes do not depend on the legacy column'
        );

      for (const seed of ['metadata', ...(legacy ? ['column'] : [])]) {
        const prior = await makeRow(
          `${route}-${seed}`,
          seed === 'metadata'
            ? { deleted_at: first, deleted_source: 'whatsapp', deleted_by: 'original' }
            : null,
          seed === 'column' ? '2026-10-10 09:20:00.123456+00' : null
        );
        const target = `${route}-${seed}`;
        if (route === 'mutation') await mutations.markMessageRevoked(target, action);
        else if (route === 'status') await writer.setMessageStatus(target, 'deleted');
        else await durable.markMessageDeleted(target);
        const result = await row(prior);
        assert.equal(
          result.metadata.deleted_at,
          seed === 'metadata'
            ? first
            : kind === 'uuid_timestamp'
              ? '2026-10-10T09:20:00.123456'
              : '2026-10-10T11:20:00.123456+02:00'
        );
        if (seed === 'metadata') {
          assert.equal(result.metadata.deleted_source, 'whatsapp');
          assert.equal(result.metadata.deleted_by, 'original');
        }
      }
    }
    for (const route of ['mutation', 'durable']) {
      const name = `${route}-local`;
      const id = await makeRow(name);
      const wrongAccount = await makeRow(name, null, null, 'personal');
      const local = () =>
        route === 'mutation'
          ? mutations.markMessageDeletedForMe(name, action)
          : durable.markMessageDeletedForMe(name, '123@g.us');
      await local();
      const initial = await row(id);
      assert.equal(initial.is_deleted, false, 'local deletion never records remote revocation');
      assert.equal(initial.status, 'read');
      assert.equal(initial.metadata.deleted_at, undefined);
      assert.equal(initial.metadata.deleted_for_me, true);
      assert.equal((await row(wrongAccount)).metadata, null);
      await local();
      assert.deepEqual(
        (await row(id)).metadata,
        initial.metadata,
        'local replay preserves timestamp'
      );
      await mutations.markMessageRevoked(name, action);
      const remote = await row(id);
      assert.equal(remote.is_deleted, true, 'remote revoke still works after local deletion');
      assert.equal(remote.metadata.deleted_source, 'connector');
      await local();
      assert.deepEqual(
        (await row(id)).metadata,
        remote.metadata,
        'local delete preserves remote provenance'
      );

      const revokedName = `${route}-already-remote`;
      const revokedId = await makeRow(revokedName, {
        deleted_at: first,
        deleted_source: 'whatsapp',
        deleted_by: 'original',
      });
      await client.query("UPDATE messages SET is_deleted=true, status='deleted' WHERE id=$1", [
        revokedId,
      ]);
      if (route === 'mutation') await mutations.markMessageDeletedForMe(revokedName, action);
      else {
        await durable.markMessageDeletedForMe(revokedName, '999@g.us');
        assert.equal(
          (await row(revokedId)).metadata.deleted_for_me,
          undefined,
          'durable local deletion respects the chat'
        );
        await durable.markMessageDeletedForMe(revokedName, '123@g.us');
      }
      const both = await row(revokedId);
      assert.equal(both.is_deleted, true);
      assert.equal(both.status, 'deleted');
      assert.equal(both.metadata.deleted_for_me, true);
      assert.equal(both.metadata.deleted_at, first);
      assert.equal(both.metadata.deleted_source, 'whatsapp');
      assert.equal(both.metadata.deleted_by, 'original');
    }
    const data = await client.query(`SELECT * FROM messages`);
    for (const item of data.rows) {
      assert.equal(item.content, 'retained text');
      assert.equal(item.raw_payload.toString('hex'), 'cafe');
    }
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM attachments')).rows[0].n,
      index
    );
    assert.equal(
      (
        await client.query(`SELECT count(*)::int AS n FROM whatsapp_message_payloads
      WHERE message_payload = '{"conversation":"retained payload"}'`)
      ).rows[0].n,
      index
    );
    console.log(
      `PASS ${kind}: remote revoke/status/durable, local deletion, replay, provenance, scope, content and media retention`
    );
    await client.query('DROP TABLE attachments, whatsapp_message_payloads, messages');
  }
} finally {
  pg.Pool.prototype.query = originalQuery;
  if (originalAccount === undefined) delete process.env.CONNECTOR_ACCOUNT;
  else process.env.CONNECTOR_ACCOUNT = originalAccount;
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
}
