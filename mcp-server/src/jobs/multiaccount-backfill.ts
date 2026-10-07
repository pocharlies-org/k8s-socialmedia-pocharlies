/**
 * Multicuenta de primera clase — backfill (docs/adr/0001-multiaccount-first-class.md).
 *
 * Runs AFTER migration 008. Idempotent and resumable: every step only touches
 * rows still missing `account_id`/`external_id`, and the merge skips aliases
 * already merged or blocked.
 *
 *   1. conversations / participants: one UPDATE each (≈3k / 11k rows).
 *   2. messages: batched by missing keys so UUID and numeric primary keys both
 *      work without holding row locks on the whole table.
 *   3. verify: zero rows left without keys, else exit 1 before any index.
 *   4. UNIQUE (account_id, external_id) indexes, CONCURRENTLY (no write lock).
 *      An index left INVALID by a failed build is dropped and reported.
 *   5. contact merge (phone ↔ LID), unless MULTIACCOUNT_SKIP_MERGE=true.
 *
 * DRY_RUN=true (default) only reports what it would do.
 */
import { Pool } from 'pg';
import pino from 'pino';

const logger = pino();

export interface BackfillClient {
  query(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

export interface BackfillOptions {
  batch: number;
  dryRun: boolean;
  skipMerge: boolean;
  pauseMs: number;
}

export const UNIQUE_INDEXES = [
  { name: 'uq_conversations_account_external', table: 'conversations' },
  { name: 'uq_participants_account_external', table: 'participants' },
  { name: 'uq_messages_account_external', table: 'messages' },
] as const;

const KEYED_TABLES = ['conversations', 'participants', 'messages'] as const;

export function backfillOptionsFromEnv(env: NodeJS.ProcessEnv): BackfillOptions {
  const batch = parseInt(env.BATCH || '20000', 10);
  if (!Number.isFinite(batch) || batch <= 0) throw new Error(`invalid BATCH: ${env.BATCH}`);
  return {
    batch,
    dryRun: env.DRY_RUN !== 'false',
    skipMerge: env.MULTIACCOUNT_SKIP_MERGE === 'true',
    pauseMs: parseInt(env.PAUSE_MS || '50', 10) || 0,
  };
}

async function count(client: BackfillClient, sql: string): Promise<number> {
  const { rows } = await client.query(sql);
  return Number(rows[0]?.n ?? 0);
}

export async function missingKeys(client: BackfillClient): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of KEYED_TABLES) {
    out[table] = await count(
      client,
      `SELECT count(*) AS n FROM ${table} WHERE account_id IS NULL OR external_id IS NULL`
    );
  }
  return out;
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function runBackfill(client: BackfillClient, opts: BackfillOptions): Promise<void> {
  const before = await missingKeys(client);
  logger.info({ missing: before, dryRun: opts.dryRun }, 'multiaccount backfill: rows without keys');
  if (opts.dryRun) return;

  await client.query(
    `UPDATE conversations c SET account_id = s.account_id, external_id = s.external_id
       FROM conversations c2, LATERAL social_split_legacy_id(c2.id, c2.account, NULL) s
      WHERE c2.id = c.id AND (c.account_id IS NULL OR c.external_id IS NULL)`
  );
  await client.query(
    `UPDATE participants p SET account_id = s.account_id, external_id = s.external_id
       FROM participants p2, LATERAL social_split_legacy_id(p2.id, p2.account, NULL) s
      WHERE p2.id = p.id AND (p.account_id IS NULL OR p.external_id IS NULL)`
  );

  let updated = 0;
  let count = opts.batch;
  while (count === opts.batch) {
    const res = await client.query(
      `WITH batch AS (
         SELECT m.id, s.account_id, s.external_id
           FROM messages m
           CROSS JOIN LATERAL social_split_legacy_id(m.wa_message_id, m.account, m.platform) s
          WHERE (m.account_id IS NULL OR m.external_id IS NULL)
            AND s.account_id IS NOT NULL AND s.external_id IS NOT NULL
          ORDER BY m.id LIMIT $1
       )
       UPDATE messages m SET account_id = batch.account_id, external_id = batch.external_id
         FROM batch WHERE m.id = batch.id`,
      [opts.batch]
    );
    count = res.rowCount ?? 0;
    updated += count;
    if (count < opts.batch) break;
    if (opts.pauseMs) await pause(opts.pauseMs);
  }
  logger.info({ updated }, 'multiaccount backfill: messages keyed');

  const after = await missingKeys(client);
  const left = Object.entries(after).filter(([, n]) => n > 0);
  if (left.length > 0) {
    throw new Error(
      `rows still without (account_id, external_id): ${left.map(([t, n]) => `${t}=${n}`).join(', ')}`
    );
  }

  for (const { name, table } of UNIQUE_INDEXES) {
    await client.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${table} (account_id, external_id)`
    );
    const valid = await client.query(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`,
      [name]
    );
    if (valid.rows[0]?.valid !== true) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      throw new Error(`unique index ${name} was left invalid (duplicate keys?) and was dropped`);
    }
  }
  logger.info('multiaccount backfill: unique (account_id, external_id) indexes valid');

  if (opts.skipMerge) return;
  const merged = await client.query('SELECT social_merge_contact_aliases() AS n');
  logger.info({ merged: Number(merged.rows[0]?.n ?? 0) }, 'multiaccount backfill: contacts merged');
}

async function main(): Promise<void> {
  const opts = backfillOptionsFromEnv(process.env);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await runBackfill(pool, opts);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    logger.error({ err: String(error) }, 'multiaccount backfill failed');
    process.exit(1);
  });
}
