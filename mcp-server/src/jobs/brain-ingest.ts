/**
 * Brain ingestion job — pushes WhatsApp/Telegram messages from Postgres into
 * the SkirmBrain RAG (push-ingest), one brain instance per account.
 *
 * Mapping: account 'personal' -> instance 'personal'; 'professional' -> 'skirmshop'.
 * Idempotent: the brain dedups by source_id (delete+upsert), and we keep a
 * keyset cursor per account in `brain_ingest_cursor` so we only push new rows.
 *
 * Run as a CronJob (every 5 min) via tsx:
 *   cd mcp-server && tsx src/jobs/brain-ingest.ts
 *
 * Env:
 *   DATABASE_URL          Postgres (whatsappmcp)
 *   BRAIN_URL             brain base url (default in-cluster service)
 *   BRAIN_API_KEY         X-API-Key for push-ingest (brain dashboard_api_key)
 *   BRAIN_INGEST_BATCH    rows per batch (default 500)
 *   BRAIN_INGEST_MAX_ROWS optional per-account row cap for safe replay/dry-runs
 *   BRAIN_INGEST_BACKFILL 'true' => on first run (no cursor) start from epoch
 *                         instead of now() — used for the one-off history backfill.
 *   BRAIN_INGEST_SINCE    ISO timestamp; with BACKFILL, lower bound to start from.
 *   BRAIN_INGEST_DRY_RUN  'true' => count + log only, no push, no cursor advance.
 *   BRAIN_PUSH_RETRIES    retry count for transient Brain/network failures.
 *   BRAIN_PUSH_TIMEOUT_MS timeout per push-ingest request.
 *   BRAIN_PUSH_CONCURRENCY maximum simultaneous push-ingest requests.
 *   BRAIN_INGEST_MAX_RUNTIME_MS stop cleanly after this runtime budget.
 */
import { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

const ACCOUNTS = ['personal', 'professional'] as const;
type Account = (typeof ACCOUNTS)[number];

const INSTANCE_BY_ACCOUNT: Record<Account, string> = {
  personal: 'personal',
  professional: 'skirmshop',
};

interface Cursor {
  last_created_at: string;
  last_id: string | null; // bigint stored as string by pg
}

interface Row {
  id: string; // bigint serialized as string
  wa_message_id: string;
  content: string;
  platform: string; // 'whatsapp' | 'telegram'
  account: string;
  direction: string;
  message_type: string;
  metadata: Record<string, unknown> | null;
  wa_timestamp: Date;
  created_at: Date;
  sender_wa_id: string | null;
  conversation_id: string;
  conversation_name: string | null;
}

interface BrainDoc {
  source_id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface BrainIngestConfig {
  databaseUrl: string;
  brainUrl: string;
  brainApiKey: string;
  batch: number;
  maxRows: number;
  backfill: boolean;
  since: string;
  dryRun: boolean;
  pushRetries: number;
  pushTimeoutMs: number;
  pushRetryBaseDelayMs: number;
  pushRetryMaxDelayMs: number;
  pushConcurrency: number;
  maxRuntimeMs: number;
}

export interface PushDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface AccountIngestResult {
  account: Account;
  instance: string;
  rows: number;
  chunks: number;
  partial: boolean;
  failures: ClassifiedFailure[];
}

export interface JobResult {
  accounts: AccountIngestResult[];
  rows: number;
  chunks: number;
  fatalFailures: ClassifiedFailure[];
  transientFailures: ClassifiedFailure[];
}

export interface ClassifiedFailure {
  kind: 'transient' | 'fatal';
  message: string;
  status?: number;
}

export class BrainPushError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BrainPushError';
    this.status = status;
  }
}

export function createConfig(env: NodeJS.ProcessEnv = process.env): BrainIngestConfig {
  return {
    databaseUrl:
      env.DATABASE_URL || 'postgresql://whatsappmcp:whatsappmcp_dev@localhost:5438/whatsappmcp',
    brainUrl:
      env.BRAIN_URL || 'http://skirmshop-brain-ingest.skirmshop-brain-prod.svc.cluster.local',
    brainApiKey: env.BRAIN_API_KEY || '',
    batch: positiveInt(env.BRAIN_INGEST_BATCH, 500),
    maxRows: nonNegativeInt(env.BRAIN_INGEST_MAX_ROWS, 0),
    backfill: env.BRAIN_INGEST_BACKFILL === 'true',
    since: env.BRAIN_INGEST_SINCE || '1970-01-01T00:00:00Z',
    dryRun: env.BRAIN_INGEST_DRY_RUN === 'true',
    pushRetries: nonNegativeInt(env.BRAIN_PUSH_RETRIES, 5),
    pushTimeoutMs: positiveInt(env.BRAIN_PUSH_TIMEOUT_MS, 30_000),
    pushRetryBaseDelayMs: positiveInt(env.BRAIN_PUSH_RETRY_BASE_DELAY_MS, 2_000),
    pushRetryMaxDelayMs: positiveInt(env.BRAIN_PUSH_RETRY_MAX_DELAY_MS, 30_000),
    pushConcurrency: positiveInt(env.BRAIN_PUSH_CONCURRENCY, 1),
    maxRuntimeMs: nonNegativeInt(env.BRAIN_INGEST_MAX_RUNTIME_MS, 0),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function ensureCursorTable(pool: Pool): Promise<void> {
  // messages.id is bigint (autoincrement); the cursor used to be typed uuid
  // by mistake — drop legacy table once if its column type is wrong.
  await pool.query(`
    DO $$
    DECLARE col_type text;
    BEGIN
      SELECT data_type INTO col_type FROM information_schema.columns
        WHERE table_name = 'brain_ingest_cursor' AND column_name = 'last_id';
      IF col_type IS NOT NULL AND col_type <> 'bigint' THEN
        DROP TABLE brain_ingest_cursor;
      END IF;
    END $$;
  `);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS brain_ingest_cursor (
       account          text PRIMARY KEY,
       last_created_at  timestamptz NOT NULL,
       last_id          bigint,
       updated_at       timestamptz NOT NULL DEFAULT now()
     )`
  );
}

async function getCursor(pool: Pool, account: Account): Promise<Cursor | null> {
  const r = await pool.query(
    `SELECT last_created_at, last_id FROM brain_ingest_cursor WHERE account = $1`,
    [account]
  );
  if (r.rows.length === 0) return null;
  return { last_created_at: r.rows[0].last_created_at, last_id: r.rows[0].last_id };
}

async function setCursor(
  pool: Pool,
  account: Account,
  createdAt: Date | string,
  id: string | null // bigint as string, or null on initialization
): Promise<void> {
  await pool.query(
    `INSERT INTO brain_ingest_cursor (account, last_created_at, last_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (account) DO UPDATE
       SET last_created_at = EXCLUDED.last_created_at,
           last_id = EXCLUDED.last_id,
           updated_at = now()`,
    [account, createdAt, id]
  );
}

function sourceId(platform: string, waMessageId: string): string {
  switch ((platform || '').toLowerCase()) {
    case 'telegram':
      return `tg:${waMessageId}`;
    case 'instagram':
      return `ig:${waMessageId}`;
    case 'whatsapp':
      return `wa:${waMessageId}`;
    default:
      return `${platform || 'msg'}:${waMessageId}`;
  }
}

function adapterForPlatform(platform: string): string {
  const normalized = (platform || '').toLowerCase();
  if (normalized === 'telegram' || normalized === 'instagram') {
    return normalized;
  }
  return 'whatsapp';
}

async function fetchBatch(
  pool: Pool,
  account: Account,
  cursor: Cursor,
  limit: number
): Promise<Row[]> {
  // Keyset pagination on (created_at, id) so duplicate created_at can't skip rows.
  // messages.id is bigint; coalesce missing cursor to 0 for the first batch.
  const r = await pool.query(
    `SELECT m.id, m.wa_message_id, m.content, m.platform, m.account, m.direction,
            m.message_type, m.metadata, m.wa_timestamp, m.created_at, m.sender_wa_id,
            m.conversation_id, c.name AS conversation_name
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.account = $1
        AND m.is_deleted = false
        AND m.content IS NOT NULL AND btrim(m.content) <> ''
        AND (m.created_at, m.id) > ($2::timestamptz, COALESCE($3::bigint, 0::bigint))
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT $4`,
    [account, cursor.last_created_at, cursor.last_id, limit]
  );
  return r.rows as Row[];
}

export async function pushToBrain(
  instance: string,
  adapter: string,
  documents: BrainDoc[],
  config: BrainIngestConfig,
  deps: PushDeps = {}
): Promise<number> {
  const url = `${config.brainUrl}/instances/${instance}/push-ingest`;
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const maxAttempts = config.pushRetries + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.pushTimeoutMs);
    try {
      const resp = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.brainApiKey ? { 'X-API-Key': config.brainApiKey } : {}),
        },
        body: JSON.stringify({ adapter, documents }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new BrainPushError(
          `brain push-ingest ${instance}/${adapter} -> ${resp.status}: ${text.slice(0, 300)}`,
          resp.status
        );
      }
      const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      return Number(body.chunks_ingested ?? 0);
    } catch (err) {
      const failure = classifyFailure(err);
      lastError = err;
      if (failure.kind === 'fatal' || attempt >= maxAttempts) break;
      const delayMs = Math.min(
        config.pushRetryMaxDelayMs,
        config.pushRetryBaseDelayMs * 2 ** (attempt - 1)
      );
      logger.warn(
        {
          instance,
          adapter,
          docs: documents.length,
          attempt,
          maxAttempts,
          nextDelayMs: delayMs,
          err: failure.message,
        },
        'brain push-ingest retrying'
      );
      await sleep(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function classifyFailure(err: unknown): ClassifiedFailure {
  const status = err instanceof BrainPushError ? err.status : undefined;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
  const lower = message.toLowerCase();

  if (status !== undefined) {
    if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
      return { kind: 'transient', message, status };
    }
    return { kind: 'fatal', message, status };
  }

  if (
    lower.includes('fetch failed') ||
    lower.includes('abort') ||
    lower.includes('timeout') ||
    lower.includes('connecttimeout') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('eai_again') ||
    lower.includes('und_err') ||
    lower.includes('all tei dense endpoints failed')
  ) {
    return { kind: 'transient', message };
  }

  return { kind: 'fatal', message };
}

function toDoc(row: Row): BrainDoc {
  const extra =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata
      : {};
  return {
    source_id: sourceId(row.platform, row.wa_message_id),
    content: row.content,
    metadata: {
      ...extra,
      type: 'message',
      platform: row.platform,
      account: row.account,
      direction: row.direction,
      message_type: row.message_type,
      conversation_id: row.conversation_id,
      conversation_name: row.conversation_name,
      sender_wa_id: row.sender_wa_id,
      sender_id: row.sender_wa_id,
      wa_timestamp:
        row.wa_timestamp instanceof Date
          ? row.wa_timestamp.toISOString()
          : String(row.wa_timestamp),
    },
  };
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<number>
): Promise<number> {
  let total = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      total += await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return total;
}

async function ingestAccount(
  pool: Pool,
  account: Account,
  config: BrainIngestConfig,
  deadlineAt: number | null = null,
  deps: PushDeps = {}
): Promise<AccountIngestResult> {
  const instance = INSTANCE_BY_ACCOUNT[account];
  let cursor = await getCursor(pool, account);

  if (!cursor) {
    // First run for this account.
    if (config.backfill) {
      cursor = { last_created_at: config.since, last_id: null };
      logger.info({ account, since: config.since }, 'no cursor - starting BACKFILL from SINCE');
    } else {
      const now = new Date();
      if (!config.dryRun) await setCursor(pool, account, now, null);
      logger.info(
        { account, at: now.toISOString() },
        'no cursor - initialized to now(), skipping history'
      );
      return { account, instance, rows: 0, chunks: 0, partial: false, failures: [] };
    }
  }

  let totalRows = 0;
  let totalChunks = 0;
  const failures: ClassifiedFailure[] = [];

  for (;;) {
    if (deadlineAt !== null && Date.now() >= deadlineAt) {
      logger.warn(
        { account, instance, rows: totalRows },
        'runtime budget reached; stopping account cleanly'
      );
      break;
    }

    const remaining = config.maxRows > 0 ? config.maxRows - totalRows : config.batch;
    if (config.maxRows > 0 && remaining <= 0) break;

    const batchLimit = config.maxRows > 0 ? Math.min(config.batch, remaining) : config.batch;
    const rows = await fetchBatch(pool, account, cursor, batchLimit);
    if (rows.length === 0) break;

    // Group by platform — push-ingest takes one adapter per call.
    const byPlatform = new Map<string, BrainDoc[]>();
    for (const row of rows) {
      const adapter = adapterForPlatform(row.platform);
      const arr = byPlatform.get(adapter) ?? [];
      arr.push(toDoc(row));
      byPlatform.set(adapter, arr);
    }

    if (config.dryRun) {
      for (const [adapter, docs] of byPlatform) {
        logger.info({ account, instance, adapter, docs: docs.length }, 'DRY_RUN would push');
      }
    } else {
      try {
        totalChunks += await runWithConcurrency(
          Array.from(byPlatform.entries()),
          config.pushConcurrency,
          async ([adapter, docs]) => pushToBrain(instance, adapter, docs, config, deps)
        );
      } catch (err) {
        const failure = classifyFailure(err);
        failures.push(failure);
        logger[failure.kind === 'transient' ? 'warn' : 'error'](
          { account, instance, rowsDone: totalRows, err: failure.message, status: failure.status },
          failure.kind === 'transient'
            ? 'brain push-ingest exhausted transient retries; leaving cursor at last successful batch'
            : 'brain push-ingest failed fatally; leaving cursor at last successful batch'
        );
        break;
      }
    }

    totalRows += rows.length;
    const last = rows[rows.length - 1];
    cursor = { last_created_at: last.created_at.toISOString(), last_id: last.id };
    if (!config.dryRun) await setCursor(pool, account, cursor.last_created_at, cursor.last_id);

    if (rows.length < batchLimit) break;
  }

  logger.info(
    {
      account,
      instance,
      rows: totalRows,
      chunks: totalChunks,
      dryRun: config.dryRun,
      maxRows: config.maxRows,
      partial: failures.length > 0,
      failures: failures.length,
    },
    'account ingest done'
  );
  return {
    account,
    instance,
    rows: totalRows,
    chunks: totalChunks,
    partial: failures.length > 0,
    failures,
  };
}

async function main(config = createConfig()): Promise<JobResult> {
  if (!config.brainApiKey && !config.dryRun) {
    logger.warn('BRAIN_API_KEY not set — pushes will be unauthenticated (brain may reject)');
  }
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
  const deadlineAt = config.maxRuntimeMs > 0 ? Date.now() + config.maxRuntimeMs : null;
  const results: AccountIngestResult[] = [];
  try {
    await ensureCursorTable(pool);
    for (const account of ACCOUNTS) {
      results.push(await ingestAccount(pool, account, config, deadlineAt));
    }
  } finally {
    await pool.end();
  }

  const failures = results.flatMap(result => result.failures);
  const fatalFailures = failures.filter(failure => failure.kind === 'fatal');
  const transientFailures = failures.filter(failure => failure.kind === 'transient');
  const rows = results.reduce((sum, result) => sum + result.rows, 0);
  const chunks = results.reduce((sum, result) => sum + result.chunks, 0);

  if (fatalFailures.length > 0) {
    throw new Error(`brain-ingest fatal failures: ${fatalFailures.map(f => f.message).join('; ')}`);
  }

  if (transientFailures.length > 0) {
    if (rows > 0) {
      logger.warn(
        { rows, chunks, failures: transientFailures.map(f => f.message) },
        'brain-ingest completed partially after transient failures; next run will resume from cursor'
      );
    } else {
      throw new Error(
        `brain-ingest transient failures before progress: ${transientFailures
          .map(f => f.message)
          .join('; ')}`
      );
    }
  }

  return { accounts: results, rows, chunks, fatalFailures, transientFailures };
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      logger.error({ err: String(err) }, 'brain-ingest failed');
      process.exit(1);
    });
}
