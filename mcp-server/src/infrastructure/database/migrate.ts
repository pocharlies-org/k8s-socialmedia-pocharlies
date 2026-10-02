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
 *    created by hand. The NAS whatsapp_message_payloads table predates
 *    015_whatsapp_message_payloads.sql and has the fork's shape, so that file has to
 *    expand it instead of being skipped.
 */
export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const LEDGER_TABLE = 'schema_migrations';

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
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (done.has(file)) {
        const existing = await client.query(
          `SELECT checksum FROM ${LEDGER_TABLE} WHERE version = $1`,
          [file]
        );
        if (existing.rows[0]?.checksum !== checksum)
          throw new Error(`Migration checksum changed: ${file}`);
        continue;
      }
      const table = primaryTable(sql);
      const alwaysRun = sql.includes(ALWAYS_RUN_MARKER);
      let adopted = false;
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
          // a ledgerless replay, drop its downstream 010 trigger temporarily:
          // PostgreSQL treats the trigger's WHEN reference as a dependency of
          // message_type's type alteration. 010 runs later and restores it.
          if (
            file === '009_messages_message_type_text.sql' &&
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
      console.log(`${adopted ? 'Adopted' : 'Applied'} ${file}`);
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
