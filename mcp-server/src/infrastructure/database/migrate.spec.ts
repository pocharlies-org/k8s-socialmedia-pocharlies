import { join } from 'path';
import { readdirSync, readFileSync } from 'fs';
import { MigrationClient, runMigrations } from './migrate';

/** Fake pg client for the migration ledger and ordering behavior. */
class FakeDb implements MigrationClient {
  tables = new Set<string>();
  ledger: Array<{ file: string; checksum: string; adopted: boolean }> = [];
  executed: string[] = [];
  openTx = false;
  commits = 0;
  rollbacks = 0;
  failOnBody: string | null = null;

  async query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    const s = sql.trim();
    if (/^BEGIN$/i.test(s)) {
      this.openTx = true;
      return { rows: [] };
    }
    if (/^COMMIT$/i.test(s)) {
      this.openTx = false;
      this.commits += 1;
      return { rows: [] };
    }
    if (/^ROLLBACK$/i.test(s)) {
      this.openTx = false;
      this.rollbacks += 1;
      return { rows: [] };
    }
    if (/^SELECT pg_advisory_xact_lock/.test(s)) return { rows: [] };
    if (/CREATE TABLE IF NOT EXISTS schema_migrations/.test(s)) return { rows: [] };
    if (/SELECT version FROM schema_migrations/.test(s)) {
      return { rows: this.ledger.map(row => ({ version: row.file })) };
    }
    if (/SELECT checksum FROM schema_migrations WHERE version = \$1/.test(s)) {
      const row = this.ledger.find(entry => entry.file === String(params?.[0]));
      return { rows: row ? [{ checksum: row.checksum }] : [] };
    }
    if (/SELECT to_regclass\(\$1\)/.test(s)) {
      const table = String(params?.[0]);
      return { rows: [{ t: this.tables.has(table) ? table : null }] };
    }
    if (/INSERT INTO schema_migrations/.test(s)) {
      this.ledger.push({
        file: String(params?.[0]),
        checksum: String(params?.[1]),
        adopted: Boolean(params?.[2]),
      });
      return { rows: [] };
    }
    if (this.failOnBody && s.includes(this.failOnBody)) {
      throw new Error(`relation "${this.failOnBody}" already exists`);
    }
    this.executed.push(s);
    for (const match of s.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-zA-Z_]\w*)/gi)) {
      this.tables.add(match[1]);
    }
    return { rows: [] };
  }

  ledgerFiles(): string[] {
    return this.ledger.map(row => row.file);
  }
}

const MIGRATIONS_DIR = join(__dirname, 'migrations');
const ALL_FILES = readdirSync(MIGRATIONS_DIR)
  .filter(file => /^\d+.*\.sql$/.test(file))
  .sort();

describe('migrate.ts schema_migrations ledger', () => {
  test('fresh DB applies every file in order and rerun is a no-op', async () => {
    const db = new FakeDb();
    await runMigrations(db, MIGRATIONS_DIR);
    const firstRun = [...db.executed];
    await runMigrations(db, MIGRATIONS_DIR);

    expect(db.ledgerFiles()).toEqual(ALL_FILES);
    expect(db.ledger.every(row => !row.adopted)).toBe(true);
    expect(db.executed).toEqual(firstRun);
    expect(db.commits).toBe(2);
    expect(db.openTx).toBe(false);
  });

  test('an existing NAS payload table still executes the expand migration', async () => {
    const db = new FakeDb();
    db.tables.add('whatsapp_message_payloads');
    await runMigrations(db, MIGRATIONS_DIR);

    const payloadMigration = db.executed.find(sql =>
      sql.includes('ADD COLUMN IF NOT EXISTS wa_timestamp')
    );
    expect(payloadMigration).toBeDefined();
    expect(db.ledger.find(row => row.file === '015_whatsapp_message_payloads.sql')?.adopted).toBe(
      false
    );
  });

  test('changed applied migration checksum fails closed', async () => {
    const db = new FakeDb();
    await runMigrations(db, MIGRATIONS_DIR);
    db.ledger[0].checksum = 'stale';
    await expect(runMigrations(db, MIGRATIONS_DIR)).rejects.toThrow(/Migration checksum changed/);
    expect(db.openTx).toBe(false);
    expect(db.rollbacks).toBe(1);
  });

  test('a failing file rolls back and is not recorded', async () => {
    const db = new FakeDb();
    db.failOnBody = 'user_channel_credentials';
    await expect(runMigrations(db, MIGRATIONS_DIR)).rejects.toThrow(
      /Migration 013_user_channel_credentials/
    );
    expect(db.ledgerFiles()).not.toContain('013_user_channel_credentials.sql');
    expect(db.openTx).toBe(false);
    expect(db.rollbacks).toBe(1);
  });

  test('migration SQL checksums are derived from the exact file bytes', async () => {
    const db = new FakeDb();
    await runMigrations(db, MIGRATIONS_DIR);
    const credentialSql = readFileSync(join(MIGRATIONS_DIR, '013_user_channel_credentials.sql'));
    const { createHash } = await import('crypto');
    expect(db.ledger.find(row => row.file === '013_user_channel_credentials.sql')?.checksum).toBe(
      createHash('sha256').update(credentialSql).digest('hex')
    );
  });
});
