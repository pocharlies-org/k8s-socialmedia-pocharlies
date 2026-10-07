import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

/**
 * Ledger of applied migration files. Two historical bugs shaped it:
 *
 *  - upstream SC-1144: migrate.ts used to re-run every *.sql on every boot and
 *    001_initial_schema.sql is NOT idempotent (bare CREATE TABLE), so a second
 *    run aborted with "relation already exists";
 *  - the NAS fork audit: an untracked installation whose schema had drifted
 *    silently adopted 001 and then replayed the rest on top of a partial
 *    schema.
 *
 * Semantics now (one transaction per run, advisory-locked, so a deploy either
 * migrates completely or leaves the previous schema untouched):
 *  - a file recorded in `schema_migrations` is skipped, and its checksum must
 *    still match — editing an applied file is an error, not a silent drift;
 *  - a file that is not recorded but whose primary table already exists is
 *    BASELINED (recorded without executing): that is the bootstrap for the
 *    hand-migrated prod databases. 001 is the exception — it is only baselined
 *    after its full inventory (tables, columns, primary keys, foreign keys)
 *    has been verified, so a half-migrated database fails closed;
 *  - a file that opts out with `-- migrate:always-run` is never baselined: it
 *    is written to be idempotent and must execute even when its table was
 *    created by hand. Additive 027 expands the NAS payload table while keeping
 *    the released production migration bytes and merge contracts intact.
 */
export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const LEDGER_TABLE = 'schema_migrations';

// Fingerprints of the released NAS fork 0d7423b; unknown drift still fails closed.
const LEGACY_NAS_CHECKSUMS: Record<string, string> = {
  '001_initial_schema.sql': '1d7947cc42f35fd63f7f7aeac592bd1746610dbc5838ed805231f203067b6ef8',
  '002_account_scope.sql': '5206d7543fa45377ff6d2bc81a055ac374b2796f4df587c9e89c2cf82920d03b',
  '003_whatsapp_customer_allowlist.sql':
    'd13273779ee8ce4b0897ee9d530afcc8fc37d72dff45ee80950a5cc52100f787',
  '004_whatsapp_manual_open_requests.sql':
    'd174c85b13c63469d0181a963ae749d93cd48f8f322a14e8a5d90cb4fc26fc27',
  '005_whatsapp_manual_open_processing_status.sql':
    'db8b5af27fd7026c5f64206fcb2263cdb76da51af10d6a0ac9891f43581185b7',
  '006_unread_digest_sessions.sql':
    '14296118a877fb92677d86c0d213c12b00bfc687560b91292c09e1e4fdad488c',
  '007_nas_local_unique_wa_message_id.sql':
    '8beac637f9380e8cb7aa5f0ac6e982a1195b71d6d05e6a48224d0de6ed289855',
  '008_provider_identity_schema.sql':
    '18e89d366ded6e97abfc862f038f8b05dd74d9f1d3e60f14485ff33c03bb2461',
  '009_messages_message_type_text.sql':
    '9cf262ed2530361106770986d5309c6a5a7daf675103857f389d25bc059ff170',
  '010_realtime_change_notifications.sql':
    '70ee6bceae0acc54723a7cb19665d0251ec6b7ba89b94aca5e1924ea978f1090',
  '011_reaction_change_notifications.sql':
    'b365a95dfdc477b48a5d1f025841ed0313ca912b9419bec18e6d4b4f817fe7b8',
  '012_reaction_own_message_reason.sql':
    '4fff459f5e675f1e97ee0bf14a4affa66b80cd9245322e491800b489404fdd86',
  '013_user_channel_credentials.sql':
    '798c30a396c55b12fa3f33f978818f367483d2bae3ef7e0d7406be76ee286338',
  '014_multiaccount_first_class.sql':
    'd60bd691f4425cbe69d445a926546f57b00f9756f8e0b5f6763cf82d3245cb1b',
  '015_whatsapp_message_payloads.sql':
    'fd6db6aedfb8f48fa32fffa5df834b9d749dc883ec2b5619004dd413e2c7b8d6',
  '016_uuid_safe_conversation_merges.sql':
    '951b0e7cd5de08a9dcb7c32b32ca531bd68732f563f95ea3c18c8822aeb6c851',
};

/** Files that must run even when their objects already exist (idempotent bodies). */
const ALWAYS_RUN_MARKER = '-- migrate:always-run';

/** First CREATE TABLE in a file — its primary object, used for baseline detection. */
function primaryTable(sql: string): string | null {
  const m = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_]\w*)/i.exec(sql);
  return m ? m[1] : null;
}

async function tableExists(client: MigrationClient, table: string): Promise<boolean> {
  const { rows } = await client.query('SELECT to_regclass($1) AS t', [table]);
  return rows.length > 0 && rows[0].t !== null && rows[0].t !== undefined;
}

// Only 001 is non-idempotent. Validate its full inventory before adopting an
// untracked installation; replay 002-007 instead of assuming they succeeded.
async function adoptInitialSchema(client: MigrationClient, sql: string): Promise<boolean> {
  const tables = [...sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)];
  const present = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
  );
  const inventory = new Set(present.rows.map(r => `${r.table_name}.${r.column_name}`));
  const names = new Set(present.rows.map(r => r.table_name));
  if (!tables.some(t => names.has(t[1]))) return false;
  for (const [, table, body] of tables) {
    const columns = [
      ...body.matchAll(
        /^ {2}(\w+) (?:UUID|VARCHAR|TEXT|TIMESTAMP|BOOLEAN|JSONB|BYTEA|BIGINT|INTEGER|vector)\b/gm
      ),
    ];
    for (const [, column] of columns) {
      if (!inventory.has(`${table}.${column}`))
        throw new Error(`Partial untracked schema: missing ${table}.${column}`);
    }
    const pk = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'`,
      [table]
    );
    if (!pk.rows.length) throw new Error(`Untracked schema lacks primary key: ${table}`);
  }
  const refs = await client.query(
    `SELECT conrelid::regclass::text AS source, confrelid::regclass::text AS target FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`
  );
  for (const [source, target] of [
    ['participants', 'conversations'],
    ['messages', 'conversations'],
    ['messages', 'participants'],
    ['messages', 'messages'],
    ['attachments', 'messages'],
    ['message_embeddings', 'messages'],
    ['draft_replies', 'conversations'],
    ['draft_replies', 'messages'],
  ]) {
    if (!refs.rows.some(r => r.source === source && r.target === target))
      throw new Error(`Untracked schema lacks foreign key: ${source} -> ${target}`);
  }
  return true;
}

export async function runMigrations(
  client: MigrationClient,
  dir: string = join(__dirname, 'migrations')
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('socialmedia.schema-migrations'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (version text PRIMARY KEY, checksum text NOT NULL, adopted boolean NOT NULL DEFAULT false, applied_at timestamptz NOT NULL DEFAULT now())`
    );
    const files = readdirSync(dir)
      .filter(f => /^\d+.*\.sql$/.test(f))
      .sort();
    const recorded = await client.query(`SELECT version FROM ${LEDGER_TABLE}`);
    const done = new Set(recorded.rows.map(r => String(r.version)));
    const nasInitial = await client.query(
      `SELECT version, checksum FROM ${LEDGER_TABLE} WHERE version = '001_initial_schema.sql'`
    );
    if (nasInitial.rows[0]?.checksum === LEGACY_NAS_CHECKSUMS['001_initial_schema.sql']) {
      const legacy = await client.query(`SELECT version, checksum FROM ${LEDGER_TABLE}`);
      for (const row of legacy.rows) {
        const file = String(row.version);
        if (LEGACY_NAS_CHECKSUMS[file] && row.checksum !== LEGACY_NAS_CHECKSUMS[file])
          throw new Error(`Legacy NAS migration checksum changed: ${file}`);
      }
      // Keep the original 001 fingerprint as an audit row. The equivalent
      // prod baseline is adopted; additive migrations perform all expansion.
      await client.query(
        `UPDATE ${LEDGER_TABLE} SET version = 'legacy/nas/001_initial_schema.sql' WHERE version = '001_initial_schema.sql'`
      );
      done.delete('001_initial_schema.sql');
      for (const [oldFile, file] of [
        ['001_initial_schema.sql', '001_initial_schema.sql'],
        ['013_user_channel_credentials.sql', '007_user_channel_credentials.sql'],
        ['014_multiaccount_first_class.sql', '008_multiaccount_first_class.sql'],
        ['015_whatsapp_message_payloads.sql', '009_whatsapp_message_payloads.sql'],
      ]) {
        if (!legacy.rows.some(row => row.version === oldFile) || done.has(file)) continue;
        const checksum = createHash('sha256')
          .update(readFileSync(join(dir, file)))
          .digest('hex');
        await client.query(
          `INSERT INTO ${LEDGER_TABLE}(version, checksum, adopted) VALUES ($1,$2,$3)`,
          [file, checksum, true]
        );
        done.add(file);
      }
    }
    // Production's older runner used a different ledger. Import its baseline
    // filenames rather than replaying migrations already committed there.
    if (await tableExists(client, '_migrations')) {
      const production = await client.query('SELECT file, baseline FROM _migrations');
      for (const row of production.rows) {
        const file = String(row.file);
        if (!files.includes(file) || done.has(file)) continue;
        const checksum = createHash('sha256')
          .update(readFileSync(join(dir, file)))
          .digest('hex');
        await client.query(
          `INSERT INTO ${LEDGER_TABLE}(version, checksum, adopted) VALUES ($1,$2,$3)`,
          [file, checksum, Boolean(row.baseline)]
        );
        done.add(file);
      }
    }
    const apply = async (file: string): Promise<void> => {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (done.has(file)) {
        const existing = await client.query(
          `SELECT checksum FROM ${LEDGER_TABLE} WHERE version = $1`,
          [file]
        );
        if (existing.rows[0]?.checksum !== checksum)
          throw new Error(`Migration checksum changed: ${file}`);
        return;
      }
      const table = primaryTable(sql);
      const alwaysRun =
        sql.includes(ALWAYS_RUN_MARKER) ||
        file === '009_whatsapp_message_payloads.sql' ||
        file === '011_whatsapp_message_reactions.sql';
      let adopted = false;
      if (file === '015_whatsapp_reaction_merge_backfills.sql') {
        const type = await client.query(
          "SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='messages' AND column_name='id'"
        );
        if (type.rows[0]?.data_type === 'uuid') {
          await apply('030_message_id_compatible_reaction_backfills.sql');
          adopted = true;
        }
      }
      if (file.startsWith('001_') && table) {
        // Inspect the whole expected inventory: a partial schema may contain
        // a later 001 table even when its first table is absent.
        adopted = await adoptInitialSchema(client, sql);
      }
      if (!adopted && table && !alwaysRun && (await tableExists(client, table))) {
        adopted = true;
      }
      if (!adopted) {
        try {
          // The already-applied fork migration is checksum-pinned in NAS. On
          // a ledgerless replay, drop its downstream realtime trigger temporarily:
          // PostgreSQL treats the trigger's WHEN reference as a dependency of
          // message_type's type alteration. 024 runs later and restores it.
          if (
            file === '023_messages_message_type_text.sql' &&
            (await tableExists(client, 'messages'))
          ) {
            await client.query(
              'DROP TRIGGER IF EXISTS messages_realtime_update_hint ON public.messages'
            );
          }
          await client.query(sql);
        } catch (error) {
          throw new Error(
            `Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      await client.query(
        `INSERT INTO ${LEDGER_TABLE}(version, checksum, adopted) VALUES ($1,$2,$3)`,
        [file, checksum, adopted]
      );
      done.add(file);
      console.log(`${adopted ? 'Adopted' : 'Applied'} ${file}`);
    };
    for (const file of files) {
      // The preserved prod 008 expects provider-text IDs although prod 001
      // creates UUIDs. Prepare only that incompatible fresh/legacy schema.
      if (file === '008_multiaccount_first_class.sql' && !done.has(file)) {
        const identity = await client.query(
          "SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='conversations' AND column_name='id'"
        );
        if (identity.rows[0]?.data_type === 'uuid') {
          await apply('021_nas_local_unique_wa_message_id.sql');
          await apply('022_provider_identity_schema.sql');
        }
      }
      // Prod 009's index needs wa_timestamp; hand-created NAS payload tables
      // used milliseconds. Expand before executing that unchanged baseline.
      if (
        file === '009_whatsapp_message_payloads.sql' &&
        !done.has(file) &&
        (await tableExists(client, 'whatsapp_message_payloads'))
      ) {
        await apply('027_whatsapp_payload_legacy_backfill.sql');
      }
      if (
        file === '011_whatsapp_message_reactions.sql' &&
        !done.has(file) &&
        (await tableExists(client, 'whatsapp_message_reactions'))
      ) {
        await apply('032_legacy_whatsapp_reaction_shape.sql');
      }
      await apply(file);
    }
    const rawDimensions = process.env.EMBEDDING_DIMENSIONS ?? process.env.EMBEDDING_DIMENSION;
    if (rawDimensions !== undefined) {
      const raw = rawDimensions;
      if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 16000)
        throw new Error('EMBEDDING_DIMENSIONS must be an integer between 1 and 16000');
      await client.query('SELECT social_configure_embedding_dimensions($1::integer)', [
        Number(raw),
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

if (require.main === module) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Migration failed: DATABASE_URL is unset');
    process.exitCode = 1;
  } else {
    const client = new Client({ connectionString: databaseUrl });
    (async () => {
      try {
        await client.connect();
        await runMigrations(client);
      } catch (error) {
        console.error(
          'Migration failed:',
          error instanceof Error ? error.message : 'unknown error'
        );
        process.exitCode = 1;
      } finally {
        await client.end();
      }
    })();
  }
}
