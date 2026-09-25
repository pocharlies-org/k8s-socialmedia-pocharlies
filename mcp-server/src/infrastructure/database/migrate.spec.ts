import { join } from 'path';
import { MigrationClient, runMigrations } from './migrate';

/**
 * Fake pg client: models tables, the `_migrations` ledger and transactions
 * closely enough to prove the chain is idempotent without a live postgres
 * (same fake-DB pattern as session-store/adapters.spec.ts; the real-server
 * suite stays gated on CREDSTORE_TEST_DATABASE_URL).
 */
class FakeDb implements MigrationClient {
  tables = new Set<string>();
  ledger: Array<{ file: string; baseline: boolean }> = [];
  /** migration bodies actually executed, in order (excludes ledger bookkeeping) */
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
    if (/CREATE TABLE IF NOT EXISTS _migrations/.test(s)) return { rows: [] };
    if (/SELECT file FROM _migrations/.test(s)) {
      return { rows: this.ledger.map(l => ({ file: l.file })) };
    }
    if (/SELECT to_regclass\(\$1\)/.test(s)) {
      const t = String(params?.[0]);
      return { rows: [{ t: this.tables.has(t) ? t : null }] };
    }
    if (/INSERT INTO _migrations/.test(s)) {
      this.ledger.push({ file: String(params?.[0]), baseline: /TRUE/.test(s) });
      return { rows: [] };
    }
    // Anything else is a migration body.
    if (this.failOnBody && s.includes(this.failOnBody)) {
      throw new Error(`relation "${this.failOnBody}" already exists`);
    }
    this.executed.push(s);
    for (const m of s.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-zA-Z_]\w*)/gi)) {
      this.tables.add(m[1]);
    }
    return { rows: [] };
  }

  ledgerFiles(): string[] {
    return this.ledger.map(l => l.file);
  }
}

const MIGRATIONS_DIR = join(__dirname, 'migrations');
const ALL_FILES = [
  '001_initial_schema.sql',
  '002_account_scope.sql',
  '003_whatsapp_customer_allowlist.sql',
  '004_whatsapp_manual_open_requests.sql',
  '005_whatsapp_manual_open_processing_status.sql',
  '006_unread_digest_sessions.sql',
  '007_user_channel_credentials.sql',
  '008_multiaccount_first_class.sql',
  '009_whatsapp_message_payloads.sql',
];

describe('migrate.ts _migrations ledger', () => {
  test('fresh DB: applies every file in order, records each, commits per file', async () => {
    const db = new FakeDb();
    await runMigrations(db, MIGRATIONS_DIR);

    expect(db.ledgerFiles()).toEqual(ALL_FILES);
    expect(db.ledger.every(l => !l.baseline)).toBe(true);
    expect(db.executed).toHaveLength(ALL_FILES.length);
    expect(db.executed[0]).toMatch(/CREATE TABLE conversations/); // 001, the non-idempotent one
    expect(db.executed[db.executed.length - 1]).toMatch(/social_accounts/);
    expect(db.commits).toBe(ALL_FILES.length);
    expect(db.openTx).toBe(false);
  });

  test('re-run on the same DB is a no-op: nothing re-executes (the SC-1144 blocker)', async () => {
    const db = new FakeDb();
    await runMigrations(db, MIGRATIONS_DIR);
    const before = [...db.executed];

    await runMigrations(db, MIGRATIONS_DIR);
    expect(db.executed).toEqual(before);
    expect(db.ledgerFiles()).toEqual(ALL_FILES);
  });

  test('already-migrated prod DB without a ledger: 001 is baselined, never re-executed; 007 applies', async () => {
    // Simulate the live whatsappmcp DB: 001-006 applied by hand (schema may
    // have diverged), no `_migrations` table yet, 007 missing.
    const db = new FakeDb();
    for (const t of [
      'conversations',
      'participants',
      'messages',
      'whatsapp_customer_allowlist',
      'whatsapp_manual_open_requests',
      'unread_digest_sessions',
    ]) {
      db.tables.add(t);
    }

    await runMigrations(db, MIGRATIONS_DIR);

    // The blocker: 001's bare CREATE TABLE must never hit an existing schema.
    expect(db.executed.some(sql => /CREATE TABLE conversations/.test(sql))).toBe(false);
    // 007 (table absent) really runs.
    expect(db.executed.some(sql => /user_channel_credentials/.test(sql))).toBe(true);
    expect(db.ledgerFiles()).toEqual(ALL_FILES);
    expect(db.ledger.find(l => l.file === '001_initial_schema.sql')?.baseline).toBe(true);
    expect(db.ledger.find(l => l.file === '007_user_channel_credentials.sql')?.baseline).toBe(false);
  });

  test('a failing file is rolled back and NOT recorded; earlier files stay recorded', async () => {
    const db = new FakeDb();
    db.failOnBody = 'user_channel_credentials';

    await expect(runMigrations(db, MIGRATIONS_DIR)).rejects.toThrow(/007_user_channel_credentials/);
    expect(db.ledgerFiles()).toEqual(ALL_FILES.slice(0, 6));
    expect(db.openTx).toBe(false);
    expect(db.rollbacks).toBe(1);
  });

  test('a file added to the ledger mid-chain is picked up on the next run only', async () => {
    const db = new FakeDb();
    // Pre-record 001-003 as applied (e.g. a partial ledger from a prior run)
    // while their tables exist.
    for (const f of ALL_FILES.slice(0, 3)) db.ledger.push({ file: f, baseline: true });
    db.tables.add('conversations');

    await runMigrations(db, MIGRATIONS_DIR);
    expect(db.executed.every(sql => !/CREATE TABLE conversations/.test(sql))).toBe(true);
    expect(db.ledgerFiles()).toEqual(ALL_FILES);
  });
});
