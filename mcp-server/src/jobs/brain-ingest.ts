/**
 * Brain ingestion job — pushes new WhatsApp/Telegram/Instagram messages from
 * Postgres into SkirmBrain. Historical replay lives in brain-replay.ts so the
 * live cursor in `brain_ingest_cursor` stays monotonic and low-risk.
 */
import { Pool } from 'pg';
import pino from 'pino';
import {
  ACCOUNTS,
  Account,
  Cursor,
  ensureLiveCursorTable,
  fetchBatch,
  getLiveCursor,
  groupDocsByAdapter,
  instanceForAccount,
  pushToBrain,
  setLiveCursor,
} from './brain-ingest-lib';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://whatsappmcp:whatsappmcp_dev@localhost:5438/whatsappmcp';
const BRAIN_URL =
  process.env.BRAIN_URL || 'http://skirmshop-brain.skirmshop-brain-prod.svc.cluster.local';
const BRAIN_API_KEY = process.env.BRAIN_API_KEY || '';
const BATCH = parseInt(process.env.BRAIN_INGEST_BATCH || '500', 10);
const MAX_ROWS = parseInt(process.env.BRAIN_INGEST_MAX_ROWS || '0', 10);
const BACKFILL = process.env.BRAIN_INGEST_BACKFILL === 'true';
const SINCE = process.env.BRAIN_INGEST_SINCE || '1970-01-01T00:00:00Z';
const DRY_RUN = process.env.BRAIN_INGEST_DRY_RUN === 'true';

async function ingestAccount(pool: Pool, account: Account): Promise<void> {
  const instance = instanceForAccount(account);
  let cursor: Cursor | null = await getLiveCursor(pool, account);

  if (!cursor) {
    if (BACKFILL) {
      cursor = { last_created_at: SINCE, last_id: null };
      logger.info({ account, since: SINCE }, 'no cursor — starting BACKFILL from SINCE');
    } else {
      const now = new Date();
      if (!DRY_RUN) await setLiveCursor(pool, account, now, null);
      logger.info(
        { account, at: now.toISOString() },
        'no cursor — initialized to now(), skipping history'
      );
      return;
    }
  }

  let totalRows = 0;
  let totalChunks = 0;

  for (;;) {
    const remaining = MAX_ROWS > 0 ? MAX_ROWS - totalRows : BATCH;
    if (MAX_ROWS > 0 && remaining <= 0) break;

    const batchLimit = MAX_ROWS > 0 ? Math.min(BATCH, remaining) : BATCH;
    const rows = await fetchBatch(pool, { account, cursor, limit: batchLimit });
    if (rows.length === 0) break;

    const byPlatform = groupDocsByAdapter(rows);
    if (DRY_RUN) {
      for (const [adapter, docs] of byPlatform) {
        logger.info({ account, instance, adapter, docs: docs.length }, 'DRY_RUN would push');
      }
    } else {
      for (const [adapter, docs] of byPlatform) {
        const chunks = await pushToBrain({ brainUrl: BRAIN_URL, apiKey: BRAIN_API_KEY }, instance, adapter, docs);
        totalChunks += chunks;
      }
    }

    totalRows += rows.length;
    const last = rows[rows.length - 1];
    cursor = { last_created_at: last.created_at.toISOString(), last_id: last.id };
    if (!DRY_RUN) await setLiveCursor(pool, account, cursor.last_created_at, cursor.last_id);

    if (rows.length < batchLimit) break;
  }

  logger.info(
    { account, instance, rows: totalRows, chunks: totalChunks, dryRun: DRY_RUN, maxRows: MAX_ROWS },
    'account ingest done'
  );
}

async function main(): Promise<void> {
  if (!BRAIN_API_KEY && !DRY_RUN) {
    logger.warn('BRAIN_API_KEY not set — pushes will be unauthenticated (brain may reject)');
  }
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  try {
    await ensureLiveCursorTable(pool);
    for (const account of ACCOUNTS) {
      await ingestAccount(pool, account);
    }
  } finally {
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    logger.error({ err: String(err) }, 'brain-ingest failed');
    process.exit(1);
  });
