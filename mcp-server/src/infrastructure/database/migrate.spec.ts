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
    if (/SELECT version, checksum FROM schema_migrations/.test(s)) {
      return { rows: this.ledger.filter(row => !s.includes('WHERE') || row.file === '001_initial_schema.sql').map(row => ({version: row.file, checksum: row.checksum})) };
    }
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
    expect(db.ledger.find(row => row.file === '027_whatsapp_payload_legacy_backfill.sql')?.adopted).toBe(
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
      /Migration 007_user_channel_credentials/
    );
    expect(db.ledgerFiles()).not.toContain('007_user_channel_credentials.sql');
    expect(db.openTx).toBe(false);
    expect(db.rollbacks).toBe(1);
  });

  test('migration SQL checksums are derived from the exact file bytes', async () => {
    const db = new FakeDb();
    await runMigrations(db, MIGRATIONS_DIR);
    const credentialSql = readFileSync(join(MIGRATIONS_DIR, '007_user_channel_credentials.sql'));
    const { createHash } = await import('crypto');
    expect(db.ledger.find(row => row.file === '007_user_channel_credentials.sql')?.checksum).toBe(
      createHash('sha256').update(credentialSql).digest('hex')
    );
  });
});

const PROD_BASELINE_CHECKSUMS: Record<string, string> = {
  "001_initial_schema.sql": "f14ee55fc7362beacfd6e8ed929aa1e568b8a4a48c6809ca7c274922a3a188b2",
  "002_account_scope.sql": "5206d7543fa45377ff6d2bc81a055ac374b2796f4df587c9e89c2cf82920d03b",
  "003_whatsapp_customer_allowlist.sql": "d13273779ee8ce4b0897ee9d530afcc8fc37d72dff45ee80950a5cc52100f787",
  "004_whatsapp_manual_open_requests.sql": "d174c85b13c63469d0181a963ae749d93cd48f8f322a14e8a5d90cb4fc26fc27",
  "005_whatsapp_manual_open_processing_status.sql": "db8b5af27fd7026c5f64206fcb2263cdb76da51af10d6a0ac9891f43581185b7",
  "006_unread_digest_sessions.sql": "14296118a877fb92677d86c0d213c12b00bfc687560b91292c09e1e4fdad488c",
  "007_user_channel_credentials.sql": "e7afc91c98c704bd9d0ca82ed6f171e46fc48187946601c6b9957ff0158882d1",
  "008_multiaccount_first_class.sql": "bf863303e5956095ca1a8429c276d7195d8f8c29cd4a1366cbf7fa8b85467098",
  "009_whatsapp_message_payloads.sql": "0c6eb910e86062a2658643492a63facd640915c5a83ee6787d5d2c40de6cb65b",
  "010_whatsapp_send_attempts.sql": "0d5a0fe26b778109d95a142b44202c113310db04ad6c40a98e7561581856b9b7",
  "011_whatsapp_message_reactions.sql": "0d5fbc6b4ff34fac957593aff3ee3f66f914485de98e7c1c2d5d1f32c962d527",
  "012_whatsapp_chat_state.sql": "e12d9bc014a037d1b41fdd84e10504fe4e4ed831765f995521fd5cba5748e618",
  "013_whatsapp_polls_events.sql": "69864b8493832e31fc4498ab4c09f60d50c5ceb0fe23a76be13ffa9e49f26728",
  "014_whatsapp_disappearing_timer.sql": "8756aecc75e1890d7900b8be643111e5e041210a357905efacabb321ea917124",
  "015_whatsapp_reaction_merge_backfills.sql": "0821bfa093f1db3eeb740def449c40eec4f84675cfb8206931725220d83b303e",
  "016_brain_windows.sql": "eef5500e7354eb7c0147d317fa6952a3eebd8435abbec7a9d9e6477ec065e688",
  "017_notify_message_edit_delete.sql": "de76759e0a4f32e2076a88cdd4d317ab4df94b9da296ad9d0c41135ab70f5459",
  "018_whatsapp_message_stars_pins.sql": "11e48f480d6962c723ffa5ad1f46bed9538056d5d094563b81452ddb6c25f871",
  "019_whatsapp_statuses.sql": "1a9dea6a8913d6ca6c86d600464dde56c339db62761e40fefa8dc384a6d0c126",
  "020_whatsapp_direct_chat_self_links.sql": "b60aa3562bec0ad11517df55f3db5ed2663ac84bdd49daa1c99ad7d2f755dfcb"
};
test('production 001-020 retain the exact released bytes', () => {
  const { createHash } = require('crypto');
  for (const [file, expected] of Object.entries(PROD_BASELINE_CHECKSUMS))
    expect(createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, file))).digest('hex')).toBe(expected);
});
