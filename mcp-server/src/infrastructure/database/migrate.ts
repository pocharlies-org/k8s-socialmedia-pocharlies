import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

/**
 * Ledger of applied migration files. Before this existed migrate.ts re-ran
 * every *.sql on every invocation and the header comment claimed they were
 * all idempotent — 001_initial_schema.sql is NOT (bare CREATE TABLE/INDEX),
 * so a second run against an already-migrated DB aborted with
 * "relation ... already exists" (architect verdict SC-1144, 21-09).
 *
 * Semantics now:
 *  - a file recorded in `_migrations` is skipped;
 *  - a file that is not recorded but whose primary table already exists is
 *    BASELINED (recorded without executing) — that is the bootstrap for the
 *    prod/stg DBs, which were migrated by hand before any ledger existed;
 *  - anything else runs inside a transaction together with its ledger row,
 *    so a file is recorded iff its DDL committed.
 */
export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const LEDGER_TABLE = '_migrations';

/** First CREATE TABLE in a file — its primary object, used for baseline detection. */
function primaryTable(sql: string): string | null {
  const m = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_]\w*)/i.exec(sql);
  return m ? m[1] : null;
}

export async function runMigrations(
  client: MigrationClient,
  dir: string = join(__dirname, 'migrations')
): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
  file TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  baseline BOOLEAN NOT NULL DEFAULT FALSE
)`
  );

  const { rows } = await client.query(`SELECT file FROM ${LEDGER_TABLE}`);
  const applied = new Set(rows.map(r => String(r.file)));

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping ${file} (recorded in ${LEDGER_TABLE})`);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf-8');
    const table = primaryTable(sql);
    if (table) {
      const existing = await client.query('SELECT to_regclass($1) AS t', [table]);
      if (existing.rows.length > 0 && existing.rows[0].t != null) {
        console.log(`Baselining ${file}: table "${table}" predates the ledger`);
        await client.query(`INSERT INTO ${LEDGER_TABLE} (file, baseline) VALUES ($1, TRUE)`, [
          file,
        ]);
        applied.add(file);
        continue;
      }
    }
    console.log(`Running migration ${file}...`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(`INSERT INTO ${LEDGER_TABLE} (file) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      applied.add(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
}

async function migrate(): Promise<void> {
  const client = new Client({
    connectionString:
      process.env.DATABASE_URL ||
      'postgresql://whatsappmcp:whatsappmcp_dev@localhost:5432/whatsappmcp',
  });

  try {
    await client.connect();
    console.log('Connected to database');
    await runMigrations(client);
    console.log('Migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  void migrate();
}
