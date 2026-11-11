// DATABASE_URL is required and must point to a SCRATCH database (e.g. a
// throwaway postgres:17-alpine container). This harness never runs against the
// production runtime DB; it only proves the Novedades store semantics with a
// real PostgreSQL. Run: pnpm exec tsx src/novedades-store.postgres.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (scratch database only)');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const originalQuery = pg.Pool.prototype.query;
const originalConnect = pg.Pool.prototype.connect;
pg.Pool.prototype.query = function (sql, params = []) {
  return client.query(sql, params);
};
pg.Pool.prototype.connect = async () => ({
  query: (sql, params) => client.query(sql, params),
  release: () => undefined,
});

const store = await import('./novedades-store.ts');
const {
  ensureNovedadesTables,
  getNovedadesMessage,
  listNovedadesChannels,
  listNovedadesMessages,
  listNovedadesStatus,
  listNovedadesStatusAuthors,
  markNovedadesMessageDeleted,
  markNovedadesStatusDeleted,
  markNovedadesStatusSeen,
  pruneExpiredNovedadesStatus,
  reconcileNovedadesMessageIds,
  storeNovedadesMessage,
  storeNovedadesStatus,
  upsertNovedadesChannel,
} = store;

const CH_A = '1203630000000000001@newsletter';
const CH_B = '1203630000000000002@newsletter';
const CH_C = '1203630000000000003@newsletter';
const CH_D = '1203630000000000004@newsletter';
const A = '34600000001@s.whatsapp.net';
const B = '34600000002@s.whatsapp.net';
const C = '34600000003@s.whatsapp.net';
const HOUR = 3_600_000;
const migrationSql = readFileSync(
  new URL('../migrations/002_novedades_persistence.sql', import.meta.url),
  'utf8'
);

const account = acc => {
  process.env.CONNECTOR_ACCOUNT = acc;
};

try {
  // 0. Additive bootstrap: migration + ensureNovedadesTables on top of a
  // legacy table that must stay untouched.
  await client.query(
    `CREATE TABLE IF NOT EXISTS whatsapp_message_payloads (
       wa_message_id text PRIMARY KEY, account text, conversation_id text, message_payload jsonb)`
  );
  await client.query(`DELETE FROM whatsapp_message_payloads`);
  await client.query(
    `INSERT INTO whatsapp_message_payloads
     VALUES ('professional:HIST1','professional','c','{"a":1}'::jsonb)`
  );
  await client.query(migrationSql);
  await store.ensureNovedadesTables();
  await store.ensureNovedadesTables();
  await client.query(migrationSql); // still idempotent after ensure created them
  const tables = (
    await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name LIKE 'whatsapp_novedades%' ORDER BY 1`
    )
  ).rows.map(r => r.table_name);
  assert.deepEqual(tables, [
    'whatsapp_novedades_channels',
    'whatsapp_novedades_messages',
    'whatsapp_novedades_status',
  ]);
  console.log('additive bootstrap passed: migration+ensure idempotent, legacy table intact');

  // 1. Same server_id across channels and accounts (rc13 collision scenario).
  account('personal');
  await store.storeNovedadesMessage({
    channelJid: CH_A,
    key: { id: 'SRV-DUP', remoteJid: CH_A },
    message: { conversation: 'post-A' },
    messageTimestampMs: Date.now() - 1000,
  });
  await store.storeNovedadesMessage({
    channelJid: CH_B,
    key: { id: 'SRV-DUP', remoteJid: CH_B },
    message: { conversation: 'post-B' },
    messageTimestampMs: Date.now() - 1000,
  });
  assert.deepEqual((await store.getNovedadesMessage(CH_A, 'SRV-DUP')).payload, {
    conversation: 'post-A',
  });
  assert.deepEqual((await store.getNovedadesMessage(CH_B, 'SRV-DUP')).payload, {
    conversation: 'post-B',
  });
  account('professional');
  await store.storeNovedadesMessage({
    channelJid: CH_A,
    key: { id: 'SRV-DUP', remoteJid: CH_A },
    message: { conversation: 'post-prof' },
    messageTimestampMs: Date.now() - 500,
  });
  assert.equal(
    (await store.getNovedadesMessage(CH_A, 'SRV-DUP')).payload.conversation,
    'post-prof'
  );
  account('personal');
  assert.equal((await store.getNovedadesMessage(CH_A, 'SRV-DUP')).payload.conversation, 'post-A');
  console.log('same server_id coexists per channel and per account');

  // 2. Reconcile single client row + payload-less ACK keeps everything.
  await store.storeNovedadesMessage({
    channelJid: CH_C,
    key: { id: 'CLI-1', remoteJid: CH_C, fromMe: true },
    message: { conversation: 'draft' },
    identityKind: 'client',
  });
  let rec = await store.reconcileNovedadesMessageIds({
    channelJid: CH_C,
    clientId: 'CLI-1',
    serverId: 'SRV-1',
  });
  assert.deepEqual(rec, { status: 'updated', messageId: 'SRV-1' });
  let row = await store.getNovedadesMessage(CH_C, 'CLI-1');
  assert.equal(row.messageId, 'SRV-1');
  assert.equal(row.clientId, 'CLI-1');
  assert.equal(row.serverId, 'SRV-1');
  assert.equal(row.fromMe, true);
  await store.storeNovedadesMessage({ channelJid: CH_C, key: { id: 'SRV-1', remoteJid: CH_C } });
  row = await store.getNovedadesMessage(CH_C, 'SRV-1');
  assert.equal(row.fromMe, true, 'ACK without fromMe must not clear from_me');
  assert.equal(row.visibility, 'visible', 'ACK without payload must keep visibility');
  assert.deepEqual(row.payload, { conversation: 'draft' });
  // ACK before the post itself
  await store.storeNovedadesMessage({ channelJid: CH_C, key: { id: 'SRV-ACK', remoteJid: CH_C } });
  let ackRow = await store.getNovedadesMessage(CH_C, 'SRV-ACK');
  assert.equal(ackRow.visibility, 'unknown');
  assert.equal(ackRow.payload, null);
  await store.storeNovedadesMessage({
    channelJid: CH_C,
    key: { id: 'SRV-ACK', remoteJid: CH_C, participant: A },
    message: { conversation: 'ya' },
    messageTimestampMs: Date.now(),
  });
  ackRow = await store.getNovedadesMessage(CH_C, 'SRV-ACK');
  assert.equal(ackRow.visibility, 'visible');
  assert.equal(ackRow.key.participant, A);
  assert.equal(ackRow.authorJid, A);
  console.log('client/server reconcile + ACK guards hold with real Postgres');

  // 3. Reconcile with TWO rows and different payloads/deleted flags (P1 case).
  await store.storeNovedadesMessage({
    channelJid: CH_D,
    key: { id: 'SRV-7', remoteJid: CH_D },
    message: { conversation: 'server copy' },
    metadata: { src: 'server' },
  });
  await store.storeNovedadesMessage({
    channelJid: CH_D,
    key: { id: 'CLI-7', remoteJid: CH_D, fromMe: true },
    message: { conversation: 'client copy' },
    identityKind: 'client',
    metadata: { src: 'client', draft: true },
  });
  let soft = await store.markNovedadesMessageDeleted(CH_D, 'CLI-7');
  assert.deepEqual(soft, { marked: true, createdTombstone: false });
  rec = await store.reconcileNovedadesMessageIds({
    channelJid: CH_D,
    clientId: 'CLI-7',
    serverId: 'SRV-7',
  });
  assert.equal(rec.mergedDuplicate, true);
  assert.equal(rec.messageId, 'SRV-7');
  const live = await store.getNovedadesMessage(CH_D, 'SRV-7');
  assert.deepEqual(live.payload, { conversation: 'server copy' });
  assert.equal(live.clientId, 'CLI-7');
  assert.equal(live.isDeleted, true, 'client deletion ORs into the live row');
  assert.ok(live.deletedAt);
  assert.equal(live.metadata.src, 'server', 'server metadata wins on overlap');
  assert.equal(live.metadata.draft, true, 'client metadata is merged in');
  const archived = (
    await client.query(
      `SELECT message_id, message_payload, server_id, client_id, superseded_by
         FROM whatsapp_novedades_messages
        WHERE channel_jid = $1 AND superseded_by IS NOT NULL`,
      [CH_D]
    )
  ).rows;
  assert.equal(archived.length, 1);
  assert.equal(archived[0].message_id, 'CLI-7');
  assert.deepEqual(archived[0].message_payload, { conversation: 'client copy' });
  assert.equal(archived[0].client_id, 'CLI-7');
  assert.equal(archived[0].superseded_by, 'SRV-7');
  assert.equal((await store.listNovedadesMessages(CH_D, { includeDeleted: true })).length, 1);
  assert.equal((await store.getNovedadesMessage(CH_D, 'CLI-7')).messageId, 'SRV-7');
  await store.storeNovedadesMessage({
    channelJid: CH_D,
    key: { id: 'SRV-8', remoteJid: CH_D },
    message: { conversation: 'otro' },
  });
  // 4. Revoke arriving BEFORE the post (tombstone, no resurrection).
  let tomb = await store.markNovedadesMessageDeleted(CH_D, 'SRV-FUTURE');
  assert.equal(tomb.createdTombstone, true);
  await store.storeNovedadesMessage({
    channelJid: CH_D,
    key: { id: 'SRV-FUTURE', remoteJid: CH_D },
    message: { conversation: 'revoked-post' },
  });
  const revoked = await store.getNovedadesMessage(CH_D, 'SRV-FUTURE');
  assert.equal(revoked.isDeleted, true);
  assert.equal(revoked.visibility, 'visible');
  assert.deepEqual(revoked.payload, { conversation: 'revoked-post' });
  assert.equal(
    (await store.listNovedadesMessages(CH_D)).filter(r => r.messageId === 'SRV-FUTURE').length,
    0
  );
  console.log('two-row reconcile archives without data loss; revoke-before-post holds');

  // 3b. Ingestion-path collapse (reviewer P1): the natural three-store sequence
  // store(client) -> store(server) -> store({id: client, server_id: server})
  // must collapse the duplicate atomically, never surface a raw 23505, and leave
  // exactly ONE live row for the post.
  // The scratch accounts are the ones db-writer accepts; isolation here comes
  // from dedicated channels, so this proves the collapse without disturbing the
  // other sections.
  account('professional');
  const CH_P1 = '1203630000000000005@newsletter';
  const CH_P2 = '1203630000000000006@newsletter';
  const CH_P3 = '1203630000000000007@newsletter';
  assert.deepEqual(
    await store.storeNovedadesMessage({
      channelJid: CH_P1,
      key: { id: 'P1-CLI', remoteJid: CH_P1, fromMe: true },
      message: { conversation: 'borrador propio' },
      identityKind: 'client',
      metadata: { draft: true },
    }),
    { matchedMessageId: 'P1-CLI', visibility: 'visible' }
  );
  assert.deepEqual(
    await store.storeNovedadesMessage({
      channelJid: CH_P1,
      key: { id: 'P1-SRV', remoteJid: CH_P1 },
      message: { conversation: 'publicado' },
      messageTimestampMs: 1_700_000_010_000,
      metadata: { views: 12 },
    }),
    { matchedMessageId: 'P1-SRV', visibility: 'visible' }
  );
  const third = {
    channelJid: CH_P1,
    key: { id: 'P1-CLI', remoteJid: CH_P1, server_id: 'P1-SRV' },
    message: { conversation: 'publicado', serverMessageId: 'P1-SRV' },
    messageTimestampMs: 1_700_000_010_000,
    metadata: { views: 13 },
  };
  assert.deepEqual(await store.storeNovedadesMessage(third), {
    matchedMessageId: 'P1-SRV',
    visibility: 'visible',
  });
  const p1Rows = (
    await client.query(
      `SELECT message_id, server_id, client_id, superseded_by, from_me, message_payload, metadata
         FROM whatsapp_novedades_messages
        WHERE channel_jid = $1
        ORDER BY message_id`,
      [CH_P1]
    )
  ).rows;
  assert.equal(p1Rows.length, 2, 'the duplicate is archived, never physically deleted');
  assert.equal(p1Rows.filter(r => r.superseded_by === null).length, 1, 'exactly one live row');
  assert.equal(p1Rows[0].message_id, 'P1-CLI');
  assert.equal(p1Rows[0].superseded_by, 'P1-SRV');
  assert.deepEqual(p1Rows[0].message_payload, { conversation: 'borrador propio' });
  assert.equal(p1Rows[0].metadata.reconciled_into, 'P1-SRV');
  assert.equal(p1Rows[1].message_id, 'P1-SRV');
  assert.equal(p1Rows[1].server_id, 'P1-SRV');
  assert.equal(p1Rows[1].client_id, 'P1-CLI', 'the survivor claims the client alias');
  assert.equal(p1Rows[1].from_me, true, 'the local send flag survives the collapse');
  assert.equal(p1Rows[1].metadata.views, 13, 'the confirming event wins on overlap');
  assert.equal(p1Rows[1].metadata.draft, true, 'client-only metadata survives the collapse');
  assert.equal((await store.getNovedadesMessage(CH_P1, 'P1-CLI')).messageId, 'P1-SRV');
  assert.deepEqual(
    (await store.listNovedadesMessages(CH_P1)).map(r => r.messageId),
    ['P1-SRV'],
    'the channel timeline shows one post, not two'
  );
  assert.equal((await store.getNovedadesMessage(CH_P1, 'P1-SRV')).timestampMs, 1_700_000_010_000);
  // A repeat of the confirmed key must be a plain upsert now: no error, no new row.
  assert.deepEqual(await store.storeNovedadesMessage(third), {
    matchedMessageId: 'P1-SRV',
    visibility: 'visible',
  });
  assert.equal(
    (
      await client.query(
        `SELECT count(*)::int AS live FROM whatsapp_novedades_messages
          WHERE channel_jid = $1 AND superseded_by IS NULL`,
        [CH_P1]
      )
    ).rows[0].live,
    1
  );
  // A revoke on the client id, arriving before the ids are confirmed, is OR-merged
  // by the collapse instead of being resurrected by the incoming post.
  await store.storeNovedadesMessage({
    channelJid: CH_P2,
    key: { id: 'P2-CLI', remoteJid: CH_P2 },
    message: { conversation: 'propio' },
    identityKind: 'client',
  });
  await store.storeNovedadesMessage({
    channelJid: CH_P2,
    key: { id: 'P2-SRV', remoteJid: CH_P2 },
    message: { conversation: 'servidor' },
  });
  assert.deepEqual(await store.markNovedadesMessageDeleted(CH_P2, 'P2-CLI'), {
    marked: true,
    createdTombstone: false,
  });
  await store.storeNovedadesMessage({
    channelJid: CH_P2,
    key: { id: 'P2-CLI', remoteJid: CH_P2, server_id: 'P2-SRV' },
    message: { conversation: 'servidor' },
  });
  const revokedCollapse = await store.getNovedadesMessage(CH_P2, 'P2-SRV');
  assert.equal(revokedCollapse.isDeleted, true, 'the collapse keeps the revoke');
  assert.ok(revokedCollapse.deletedAt);
  assert.deepEqual(revokedCollapse.payload, { conversation: 'servidor' });
  assert.deepEqual(
    (await store.listNovedadesMessages(CH_P2)).map(r => r.messageId),
    []
  );
  assert.deepEqual(
    (await store.listNovedadesMessages(CH_P2, { includeDeleted: true })).map(r => r.messageId),
    ['P2-SRV']
  );
  // When only the client row exists, the confirmed key renames it in place.
  await store.storeNovedadesMessage({
    channelJid: CH_P3,
    key: { id: 'P3-CLI', remoteJid: CH_P3 },
    message: { conversation: 'unico' },
    identityKind: 'client',
  });
  assert.deepEqual(
    await store.storeNovedadesMessage({
      channelJid: CH_P3,
      key: { id: 'P3-CLI', remoteJid: CH_P3, server_id: 'P3-SRV' },
      message: { conversation: 'unico' },
    }),
    { matchedMessageId: 'P3-SRV', visibility: 'visible' }
  );
  assert.equal(
    (
      await client.query(
        `SELECT count(*)::int AS total FROM whatsapp_novedades_messages WHERE channel_jid = $1`,
        [CH_P3]
      )
    ).rows[0].total,
    1,
    'a single row is renamed, no archive needed'
  );
  const renamed = await store.getNovedadesMessage(CH_P3, 'P3-CLI');
  assert.equal(renamed.messageId, 'P3-SRV');
  assert.equal(renamed.clientId, 'P3-CLI');
  assert.deepEqual(renamed.payload, { conversation: 'unico' });
  account('personal');
  console.log('ingestion collapse: three-store sequence leaves one live post without 23505');

  // 5. Statuses: author scoping, events hidden, freshness rules.
  await store.storeNovedadesStatus({
    key: { id: 'ST-FRESH', remoteJid: 'status@broadcast', participant: A },
    message: { conversation: 'vivo' },
    messageTimestampMs: Date.now() - HOUR,
  });
  await store.storeNovedadesStatus({
    key: { id: 'ST-OLD', remoteJid: 'status@broadcast', participant: B },
    message: { conversation: 'viejo' },
    messageTimestampMs: Date.now() - 25 * HOUR,
  });
  await store.storeNovedadesStatus({
    key: { id: 'ST-REACTION', remoteJid: 'status@broadcast', participant: C },
    message: {
      reactionMessage: {
        key: { id: 'ST-FRESH', remoteJid: 'status@broadcast', participant: A },
        text: '❤️',
      },
    },
    messageTimestampMs: Date.now(),
  });
  await store.storeNovedadesStatus({
    key: { id: 'ST-MINE', remoteJid: 'status@broadcast', fromMe: true },
    authorJid: '34600000001@c.us',
    message: { imageMessage: { caption: 'propio' } },
    messageTimestampMs: Date.now() - 60_000,
  });
  let actives = await store.listNovedadesStatus();
  assert.deepEqual(actives.map(s => s.messageId).sort(), ['ST-FRESH', 'ST-MINE']);
  const mine = actives.find(s => s.messageId === 'ST-MINE');
  assert.equal(mine.authorJid, A);
  assert.equal(mine.fromMe, true);
  assert.deepEqual(mine.key, { id: 'ST-MINE', remoteJid: 'status@broadcast', fromMe: true });
  assert.ok(actives.find(s => s.messageId === 'ST-FRESH').ttlRemainingMs > 22 * HOUR);
  let all = await store.listNovedadesStatus({ includeExpired: true, visibility: 'all' });
  assert.equal(all.find(s => s.messageId === 'ST-OLD').active, false);
  assert.equal(all.find(s => s.messageId === 'ST-REACTION').visibility, 'event');
  await assert.rejects(
    store.storeNovedadesStatus({
      key: { id: 'ST-NOTS', remoteJid: 'status@broadcast', participant: A },
      message: { conversation: 'x' },
    }),
    err => err.code === 'NOVEDADES_STATUS_TIMESTAMP_REQUIRED'
  );
  await store.storeNovedadesStatus({
    key: { id: 'ST-UNKNOWN', remoteJid: 'status@broadcast', participant: A },
    message: { conversation: 'sin ts' },
    allowUnknownFreshness: true,
  });
  assert.equal(
    (await store.listNovedadesStatus()).some(s => s.messageId === 'ST-UNKNOWN'),
    false,
    'freshness-unknown is never active'
  );
  all = await store.listNovedadesStatus({ includeExpired: true });
  assert.equal(all.find(s => s.messageId === 'ST-UNKNOWN').freshnessUnknown, true);
  console.log('status author/expiry/event/unknown-freshness semantics verified');

  // 6. Status soft-delete, tombstone-before-status, no revival on redelivery.
  soft = await store.markNovedadesStatusDeleted({ authorJid: A, messageId: 'ST-FRESH' });
  assert.deepEqual(soft, { marked: true, createdTombstone: false });
  await store.storeNovedadesStatus({
    key: { id: 'ST-FRESH', remoteJid: 'status@broadcast', participant: A },
    message: { conversation: 'redelivered' },
    messageTimestampMs: Date.now() - 2 * HOUR,
  });
  assert.equal(
    (await store.listNovedadesStatus()).some(s => s.messageId === 'ST-FRESH'),
    false
  );
  all = await store.listNovedadesStatus({ includeDeleted: true });
  const stillDead = all.find(s => s.messageId === 'ST-FRESH');
  assert.equal(stillDead.isDeleted, true);
  assert.deepEqual(stillDead.payload, { conversation: 'redelivered' });
  tomb = await store.markNovedadesStatusDeleted({ authorJid: B, messageId: 'ST-TOMB' });
  assert.equal(tomb.createdTombstone, true);
  await store.storeNovedadesStatus({
    key: { id: 'ST-TOMB', remoteJid: 'status@broadcast', participant: B },
    message: { conversation: 'después' },
    messageTimestampMs: Date.now() - 60_000,
  });
  all = await store.listNovedadesStatus({ includeDeleted: true });
  const tombStatus = all.find(s => s.messageId === 'ST-TOMB' && s.authorJid === B);
  assert.equal(tombStatus.isDeleted, true);
  assert.equal(tombStatus.freshnessUnknown, false);
  assert.ok(tombStatus.expiresAt, 'tombstone adopts the real expiry when the status arrives');

  // 7. Author rollup + seen.
  let authors = await store.listNovedadesStatusAuthors();
  const aRow = authors.find(r => r.authorJid === A);
  assert.ok(aRow);
  assert.equal(aRow.active, 1);
  assert.equal(aRow.unseen, 1);
  assert.equal(
    authors.some(r => r.authorJid === C),
    false,
    'reaction-only author is not a status'
  );
  assert.equal(
    authors.some(r => r.authorJid === B),
    false,
    'expired-only author hidden'
  );
  await store.markNovedadesStatusSeen({ authorJid: A, messageId: 'ST-MINE' });
  authors = await store.listNovedadesStatusAuthors();
  assert.equal(authors.find(r => r.authorJid === A).unseen, 0);

  // 8. Prune (synthetic, opt-in): only known-freshness expired statuses.
  let pr = await store.pruneExpiredNovedadesStatus();
  assert.ok(pr.deleted >= 1);
  assert.equal(
    (await client.query(`SELECT 1 FROM whatsapp_novedades_status WHERE wa_message_id='ST-OLD'`))
      .rowCount,
    0
  );
  assert.equal(
    (await client.query(`SELECT 1 FROM whatsapp_novedades_status WHERE wa_message_id='ST-UNKNOWN'`))
      .rowCount,
    1,
    'freshness-unknown rows are never pruned'
  );
  pr = await store.pruneExpiredNovedadesStatus({ now: new Date(Date.now() + 48 * HOUR) });
  assert.ok(pr.deleted >= 2);
  assert.equal(
    (await client.query(`SELECT 1 FROM whatsapp_novedades_status WHERE wa_message_id='ST-UNKNOWN'`))
      .rowCount,
    1
  );
  const postsLeft = (
    await client.query(`SELECT COUNT(*)::int AS c FROM whatsapp_novedades_messages`)
  ).rows[0].c;
  assert.ok(postsLeft >= 5, 'prune never touches channel posts');
  assert.equal(
    (
      await client.query(
        `SELECT 1 FROM whatsapp_message_payloads WHERE wa_message_id='professional:HIST1'`
      )
    ).rowCount,
    1,
    'legacy history untouched end-to-end'
  );
  console.log('soft-delete/tombstone/rollup/prune verified; legacy history intact');

  // 9. Channel directory merge + account isolation.
  await store.upsertNovedadesChannel({
    jid: CH_A,
    name: 'Canal A',
    subscriberCount: 42,
    rawMetadata: { id: CH_A, name: 'Canal A' },
  });
  await store.upsertNovedadesChannel({
    jid: CH_A,
    name: 'Canal A renombrado',
    description: 'nueva',
  });
  const chans = await store.listNovedadesChannels();
  const chA = chans.find(c => c.jid === CH_A);
  assert.equal(chA.name, 'Canal A renombrado');
  assert.equal(chA.description, 'nueva');
  assert.equal(chA.subscriberCount, 42);
  assert.deepEqual(chA.rawMetadata, { id: CH_A, name: 'Canal A' });
  account('professional');
  assert.equal((await store.listNovedadesChannels()).length, 0, 'channel directory is per account');

  // 10. Author rollup identity: two statuses posted in the same second whose
  //     provider ids sort backwards must still produce a distinguishable signal.
  account('personal');
  const TIE = '34600000004@s.whatsapp.net';
  const tieTs = Date.now() - 5 * 60_000;
  const stored = async id =>
    store.storeNovedadesStatus({
      key: { id, remoteJid: 'status@broadcast', participant: TIE },
      message: { conversation: `tie ${id}` },
      messageTimestampMs: tieTs,
    });
  await stored('ST-TIE-BBB');
  await stored('ST-TIE-AAA');
  // Arrival order is what decides here; pin it so a coarse clock cannot make
  // the assertion pass for the wrong reason.
  await client.query(
    `UPDATE whatsapp_novedades_status SET created_at = '2026-09-28 10:00:00.000001+00'::timestamptz
      WHERE account = 'personal' AND author_jid = $1 AND wa_message_id = 'ST-TIE-BBB'`,
    [TIE]
  );
  await client.query(
    `UPDATE whatsapp_novedades_status SET created_at = '2026-09-28 10:00:00.000002+00'::timestamptz
      WHERE account = 'personal' AND author_jid = $1 AND wa_message_id = 'ST-TIE-AAA'`,
    [TIE]
  );
  const tupleOf = row => [row.latestPostedAt, row.latestReceivedAt, row.latestStatusId];
  const authorsOf = async () =>
    (await store.listNovedadesStatusAuthors()).find(r => r.authorJid === TIE);
  const tie = await authorsOf();
  assert.ok(tie, 'same-second author listed');
  assert.equal(
    tupleOf(tie).join('|'),
    `${new Date(tieTs).toISOString()}|2026-09-28T10:00:00.000002Z|ST-TIE-AAA`,
    'the later arrival wins over a higher-sorting id, with microseconds intact'
  );
  assert.equal(tie.total, 2);
  assert.equal(tie.active, 2);
  // A client comparing the tuple as strings must see the second post arrive.
  assert.ok(
    JSON.stringify([tie.latestPostedAt, '2026-09-28T10:00:00.000001Z', 'ST-TIE-BBB']) <
      JSON.stringify(tupleOf(tie)),
    'the tuple strictly grows when the newer id sorts first'
  );

  // Backfill of an OLDER status: it must not move the identity or its watermark.
  await store.storeNovedadesStatus({
    key: { id: 'ST-TIE-BACKFILL', remoteJid: 'status@broadcast', participant: TIE },
    message: { conversation: 'más antiguo, llega tarde' },
    messageTimestampMs: tieTs - 2 * HOUR,
  });
  await client.query(
    `UPDATE whatsapp_novedades_status SET created_at = '2026-09-28 10:00:00.000003+00'::timestamptz
      WHERE account = 'personal' AND author_jid = $1 AND wa_message_id = 'ST-TIE-BACKFILL'`,
    [TIE]
  );
  const afterBackfill = await authorsOf();
  assert.deepEqual(
    tupleOf(afterBackfill),
    tupleOf(tie),
    'a late-arriving older status is not signalled as new'
  );
  assert.equal(afterBackfill.total, 3, 'the older status is still counted');

  // A newer post with an id that sorts lower still moves the identity.
  await store.storeNovedadesStatus({
    key: { id: 'AAA-NEWEST', remoteJid: 'status@broadcast', participant: TIE },
    message: { conversation: 'el más reciente' },
    messageTimestampMs: tieTs + 60_000,
  });
  const newest = await authorsOf();
  assert.equal(newest.latestStatusId, 'AAA-NEWEST');
  assert.equal(newest.latestPostedAt, new Date(tieTs + 60_000).toISOString());
  assert.ok(
    JSON.stringify(tupleOf(newest)) > JSON.stringify(tupleOf(tie)),
    'posting time dominates the tuple'
  );
  console.log('status author identity tie-break verified (same second, reverse ids, backfill)');

  console.log('NOVEDADES POSTGRES HARNESS: all assertions passed');
} finally {
  pg.Pool.prototype.query = originalQuery;
  pg.Pool.prototype.connect = originalConnect;
  await client.end();
}
