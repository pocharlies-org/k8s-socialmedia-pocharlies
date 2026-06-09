/**
 * Historical Brain replay for WhatsApp/Telegram/Instagram.
 *
 * Unlike brain-ingest.ts, this job never touches `brain_ingest_cursor`.
 * Progress is scoped by RUN_ID/account/platform in `brain_ingest_replay_cursor`.
 */
import { Pool } from 'pg';
import pino from 'pino';
import {
  ACCOUNTS,
  Account,
  Platform,
  Cursor,
  ensureReplayCursorTable,
  fetchBatch,
  getReplayCursor,
  groupDocsByAdapter,
  instanceForAccount,
  pushToBrain,
  setReplayCursor,
} from './brain-ingest-lib';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

export interface ReplayOptions {
  databaseUrl: string;
  brainUrl: string;
  apiKey: string;
  batch: number;
  limit: number;
  dryRun: boolean;
  runId: string;
  since: string;
  until?: string;
  accounts: Account[];
  platform?: Platform;
}

function parseAccount(value: string | undefined): Account[] {
  if (!value) return [...ACCOUNTS];
  if (value === 'personal' || value === 'professional') return [value];
  throw new Error(`invalid ACCOUNT: ${value}`);
}

function parsePlatform(value: string | undefined): Platform | undefined {
  if (!value) return undefined;
  if (value === 'whatsapp' || value === 'telegram' || value === 'instagram') return value;
  throw new Error(`invalid PLATFORM: ${value}`);
}

export function replayOptionsFromEnv(env: NodeJS.ProcessEnv): ReplayOptions {
  return {
    databaseUrl:
      env.DATABASE_URL || 'postgresql://whatsappmcp:whatsappmcp_dev@localhost:5438/whatsappmcp',
    brainUrl: env.BRAIN_URL || 'http://skirmshop-brain.skirmshop-brain-prod.svc.cluster.local',
    apiKey: env.BRAIN_API_KEY || '',
    batch: parseInt(env.BATCH || env.BRAIN_INGEST_BATCH || '500', 10),
    limit: parseInt(env.LIMIT || env.BRAIN_INGEST_MAX_ROWS || '0', 10),
    dryRun: env.DRY_RUN !== 'false' && env.BRAIN_REPLAY_DRY_RUN !== 'false',
    runId: env.RUN_ID || 'manual',
    since: env.SINCE || env.BRAIN_INGEST_SINCE || '1970-01-01T00:00:00Z',
    until: env.UNTIL || undefined,
    accounts: parseAccount(env.ACCOUNT),
    platform: parsePlatform(env.PLATFORM),
  };
}

async function replayAccount(pool: Pool, opts: ReplayOptions, account: Account): Promise<void> {
  const instance = instanceForAccount(account);
  const platformKey = opts.platform || 'all';
  let cursor: Cursor | null = await getReplayCursor(pool, opts.runId, account, platformKey);
  if (!cursor) {
    cursor = { last_created_at: opts.since, last_id: null };
  }

  let totalRows = 0;
  let totalChunks = 0;

  for (;;) {
    const remaining = opts.limit > 0 ? opts.limit - totalRows : opts.batch;
    if (opts.limit > 0 && remaining <= 0) break;
    const batchLimit = opts.limit > 0 ? Math.min(opts.batch, remaining) : opts.batch;
    const rows = await fetchBatch(pool, {
      account,
      cursor,
      limit: batchLimit,
      platform: opts.platform,
      until: opts.until,
    });
    if (rows.length === 0) break;

    const byPlatform = groupDocsByAdapter(rows);
    if (opts.dryRun) {
      for (const [adapter, docs] of byPlatform) {
        logger.info({ runId: opts.runId, account, instance, adapter, docs: docs.length }, 'DRY_RUN would replay');
      }
    } else {
      for (const [adapter, docs] of byPlatform) {
        const chunks = await pushToBrain({ brainUrl: opts.brainUrl, apiKey: opts.apiKey }, instance, adapter, docs);
        totalChunks += chunks;
      }
    }

    totalRows += rows.length;
    const last = rows[rows.length - 1];
    cursor = { last_created_at: last.created_at.toISOString(), last_id: last.id };
    if (!opts.dryRun) {
      await setReplayCursor(pool, opts.runId, account, platformKey, cursor.last_created_at, cursor.last_id);
    }
    if (rows.length < batchLimit) break;
  }

  logger.info(
    {
      runId: opts.runId,
      account,
      instance,
      platform: platformKey,
      rows: totalRows,
      chunks: totalChunks,
      dryRun: opts.dryRun,
      limit: opts.limit,
      since: opts.since,
      until: opts.until,
    },
    'account replay done'
  );
}

export async function runReplay(opts: ReplayOptions): Promise<void> {
  if (!opts.apiKey && !opts.dryRun) {
    logger.warn('BRAIN_API_KEY not set — pushes will be unauthenticated (brain may reject)');
  }
  const pool = new Pool({ connectionString: opts.databaseUrl, max: 4 });
  try {
    await ensureReplayCursorTable(pool);
    for (const account of opts.accounts) {
      await replayAccount(pool, opts, account);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runReplay(replayOptionsFromEnv(process.env))
    .then(() => process.exit(0))
    .catch(err => {
      logger.error({ err: String(err) }, 'brain-replay failed');
      process.exit(1);
    });
}
