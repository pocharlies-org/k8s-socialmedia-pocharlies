import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

// Only 001 is non-idempotent. Validate its full inventory before adopting an
// untracked installation; replay 002-007 instead of assuming they succeeded.
async function adoptInitialSchema(client: Client, sql: string): Promise<boolean> {
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
    if (!pk.rowCount) throw new Error(`Untracked schema lacks primary key: ${table}`);
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
  client: Client,
  dir = join(__dirname, 'migrations')
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('socialmedia.schema-migrations'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, adopted boolean NOT NULL DEFAULT false, applied_at timestamptz NOT NULL DEFAULT now())`
    );
    const files = readdirSync(dir)
      .filter(f => /^\d+.*\.sql$/.test(f))
      .sort();
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [file]
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Migration checksum changed: ${file}`);
        continue;
      }
      const adopted = file.startsWith('001_') && (await adoptInitialSchema(client, sql));
      if (!adopted) await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(version, checksum, adopted) VALUES ($1,$2,$3)',
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
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  (async () => {
    try {
      await client.connect();
      await runMigrations(client);
    } catch (error) {
      console.error('Migration failed:', error instanceof Error ? error.message : 'unknown error');
      process.exitCode = 1;
    } finally {
      await client.end();
    }
  })();
}
