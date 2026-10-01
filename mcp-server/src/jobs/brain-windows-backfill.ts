/**
 * brain-windows-backfill — reindex of ALL WhatsApp/Telegram history into
 * `conversation_window` documents (parent) + `conversation_chunk` children
 * (INFRA-364, ADR 0002 §9 fases 2 y 3). One-shot Job, resumable, DRY_RUN by
 * default (same posture as brain-replay).
 *
 *   PHASE=push  (fase 2): every chat -> windows -> parents + children pushed,
 *               no LLM. Search works from here. Resumes by chat keyset.
 *   PHASE=llm   (fase 3): closed pending windows, NEWEST FIRST, 2 in
 *               parallel; parents re-pushed with their summary (neurons are
 *               the brain's side of push-ingest). Resumes by (end_ts, id).
 *
 * Env: RUN_ID (resume namespace, default 'infra364'), DRY_RUN (default TRUE),
 * ACCOUNT / PLATFORM (scope), BATCH_CHATS / BATCH_WINDOWS, MAX_RUNTIME_MS,
 * BRAIN_WINDOWS_CONFIG_FILE. Idempotent: the diff against brain_windows means
 * a re-run only pushes what is missing or changed.
 *
 * The cursor of the incremental CronJob is NOT touched: brain-windows
 * cold-starts with its own lookback.
 */
import { Pool } from 'pg';
import pino from 'pino';
import { ingestNamespaces, BrainPushConfig } from './brain-ingest-lib';
import {
  ChatRef,
  classifyConvKind,
  buildWindows,
  childChunks,
  childDocs,
  parentDoc,
  initialLlmStatus,
  deleteWindowFromBrain,
  deleteWindowRow,
  diffWindows,
  ensureBrainWindowsIndexes,
  ensureBrainWindowsTables,
  fetchChatMessages,
  fetchChatMeta,
  fetchPendingLlmWindows,
  getBackfillCursor,
  listChats,
  loadStoredWindows,
  loadWindowsConfig,
  pushWindowDocs,
  httpSink,
  setBackfillCursor,
  upsertWindow,
} from './brain-windows-lib';
import { createLimiter, llmConcurrencyFromEnv, llmConfigFromEnv } from './brain-window-llm';
import { PassBudget, processLlmWindow } from './brain-windows';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface BackfillOptions {
  phase: 'push' | 'llm';
  runId: string;
  dryRun: boolean;
  accounts: string[];
  platform?: string;
  batchChats: number;
  batchWindows: number;
  maxRuntimeMs: number;
  maxChatRows: number;
}

export function backfillOptionsFromEnv(env: NodeJS.ProcessEnv): BackfillOptions {
  const phase = (env.PHASE || 'push') as 'push' | 'llm';
  if (phase !== 'push' && phase !== 'llm') throw new Error(`invalid PHASE: ${env.PHASE}`);
  const platform = env.PLATFORM || undefined;
  if (platform && platform !== 'whatsapp' && platform !== 'telegram')
    throw new Error(`invalid PLATFORM: ${platform} (instagram windows are out of ADR 0002 scope)`);
  const accounts = env.ACCOUNT ? [env.ACCOUNT] : ingestNamespaces();
  return {
    phase,
    runId: env.RUN_ID || 'infra364',
    dryRun: env.DRY_RUN !== 'false', // DRY_RUN default TRUE (brain-replay posture)
    accounts,
    platform,
    batchChats: envInt('BATCH_CHATS', 50),
    batchWindows: envInt('BATCH_WINDOWS', 40),
    maxRuntimeMs: envInt('MAX_RUNTIME_MS', 3_300_000),
    maxChatRows: envInt('MAX_CHAT_ROWS', 200_000),
  };
}

export interface PushTotals {
  chats: number;
  windows: number;
  parents: number;
  children: number;
  deleted: number;
  llmEligible: number;
  trivial: number;
  messages: number;
}

export const EMPTY_PUSH_TOTALS: PushTotals = {
  chats: 0,
  windows: 0,
  parents: 0,
  children: 0,
  deleted: 0,
  llmEligible: 0,
  trivial: 0,
  messages: 0,
};

/** Fase 2: push every window of one chat (diff- idempotent). */
export async function backfillChat(
  pool: Pool,
  brain: BrainPushConfig,
  config: ReturnType<typeof loadWindowsConfig>,
  opts: Pick<BackfillOptions, 'dryRun' | 'maxChatRows'>,
  account: string,
  platform: string,
  conversationId: string
): Promise<PushTotals> {
  const totals = { ...EMPTY_PUSH_TOTALS };
  const meta = await fetchChatMeta(pool, account, [conversationId]);
  const m = meta.get(conversationId);
  if (!m) return totals;
  const chat: ChatRef = {
    account,
    platform,
    conversation_id: conversationId,
    conversation_name: m.name,
    conv_kind: classifyConvKind(m, conversationId, m.name, config),
  };
  const msgs = await fetchChatMessages(
    pool,
    chat,
    new Date(0),
    new Date(Date.now() + 3600_000),
    opts.maxChatRows
  );
  if (msgs.length >= opts.maxChatRows)
    logger.warn({ chat: conversationId, cap: opts.maxChatRows }, 'chat truncated by MAX_CHAT_ROWS');
  totals.messages = msgs.length;
  const built = buildWindows(chat, msgs, config);
  const existing = await loadStoredWindows(pool, chat);
  const diff = diffWindows(existing, built);

  for (const gone of diff.toDelete) {
    if (!opts.dryRun) {
      await deleteWindowFromBrain(brain, account, platform, gone.source_id, gone.chunk_count, msg =>
        logger.debug(msg)
      );
      await deleteWindowRow(pool, gone.source_id);
    }
    totals.deleted++;
  }
  for (const w of diff.toPush) {
    const chunks = childChunks(w, config);
    totals.windows++;
    totals.parents++;
    totals.children += chunks.length;
    if (w.trivial) totals.trivial++;
    if (w.llm_eligible && !w.trivial) totals.llmEligible++;
    if (opts.dryRun) continue;
    await pushWindowDocs(brain, account, [
      parentDoc(w, { llm_status: initialLlmStatus(w) }),
      ...childDocs(w, chunks),
    ]);
    await upsertWindow(pool, {
      w,
      pushed_hash: w.content_hash,
      chunk_count: chunks.length,
      llm_status: initialLlmStatus(w),
    });
  }
  totals.chats = 1;
  return totals;
}

/** Fase 2 loop: chats in keyset order, resumable, batched, deadline-aware. */
export async function runPushPhase(
  pool: Pool,
  brain: BrainPushConfig,
  config: ReturnType<typeof loadWindowsConfig>,
  opts: BackfillOptions
): Promise<PushTotals> {
  const budget = new PassBudget(Date.now(), opts.maxRuntimeMs);
  const totals = { ...EMPTY_PUSH_TOTALS };
  const cur = await getBackfillCursor(pool, opts.runId, 'push');
  let after =
    cur && cur.last_account && cur.last_conversation_id
      ? {
          account: cur.last_account,
          platform: cur.last_platform ?? '',
          conversation_id: cur.last_conversation_id,
        }
      : null;
  for (;;) {
    const chats = await listChats(pool, {
      accounts: opts.accounts,
      platform: opts.platform,
      after,
      limit: opts.batchChats,
    });
    if (!chats.length) break;
    for (const chat of chats) {
      if (budget.out()) {
        logger.warn('push phase stopping: runtime budget exhausted (resumable)');
        return totals;
      }
      try {
        const t = await backfillChat(
          pool,
          brain,
          config,
          opts,
          chat.account,
          chat.platform,
          chat.conversation_id
        );
        for (const k of Object.keys(totals) as (keyof PushTotals)[]) totals[k] += t[k];
      } catch (e) {
        logger.error({ chat: chat.conversation_id, err: String(e) }, 'chat backfill failed');
      }
      after = chat;
      if (!opts.dryRun)
        await setBackfillCursor(pool, opts.runId, 'push', {
          last_account: chat.account,
          last_platform: chat.platform,
          last_conversation_id: chat.conversation_id,
        });
    }
    if (chats.length < opts.batchChats) break;
  }
  return totals;
}

/** Fase 3 loop: closed pending windows newest-first, resumable, 2 in parallel. */
export async function runLlmPhase(
  pool: Pool,
  brain: BrainPushConfig,
  config: ReturnType<typeof loadWindowsConfig>,
  opts: BackfillOptions
): Promise<{ done: number; failed: number; skipped: number; scanned: number }> {
  const llm = llmConfigFromEnv(process.env);
  const llmSink = httpSink(brain, msg => logger.debug(msg));
  const budget = new PassBudget(Date.now(), opts.maxRuntimeMs);
  const stats = { done: 0, failed: 0, skipped: 0, scanned: 0 };
  const cur = await getBackfillCursor(pool, opts.runId, 'llm');
  let after =
    cur && cur.last_end_ts && cur.last_source_id
      ? { end_ts: cur.last_end_ts, source_id: cur.last_source_id }
      : null;
  const limit = createLimiter(llmConcurrencyFromEnv(process.env));
  for (;;) {
    const rows = await fetchPendingLlmWindows(pool, {
      accounts: opts.accounts,
      closedBefore: new Date(Date.now() - config.gapSeconds * 1000),
      limit: opts.batchWindows,
      after,
    });
    if (!rows.length) break;
    if (opts.dryRun) {
      stats.scanned += rows.length;
      logger.info({ scanned: stats.scanned }, 'DRY_RUN llm phase: counting, not extracting');
      break;
    }
    for (const row of rows) {
      if (budget.out()) {
        logger.warn('llm phase stopping: runtime budget exhausted (resumable)');
        return stats;
      }
      stats.scanned++;
      const r = await limit(() => processLlmWindow(pool, llmSink, llm, row, false));
      if (r === 'done') stats.done++;
      else if (r === 'failed') stats.failed++;
      else stats.skipped++;
      after = { end_ts: new Date(row.end_ts), source_id: row.source_id };
      await setBackfillCursor(pool, opts.runId, 'llm', {
        last_end_ts: row.end_ts,
        last_source_id: row.source_id,
      });
    }
    if (rows.length < opts.batchWindows) break;
  }
  return stats;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error(
      'DATABASE_URL is unset: refusing to run brain-windows-backfill without an explicit database connection'
    );
  const configFile = process.env.BRAIN_WINDOWS_CONFIG_FILE;
  if (!configFile)
    throw new Error('BRAIN_WINDOWS_CONFIG_FILE is unset (k8s/base/brain-windows-config.yaml)');
  const config = loadWindowsConfig(configFile);
  const opts = backfillOptionsFromEnv(process.env);
  const brain: BrainPushConfig = {
    brainUrl:
      process.env.BRAIN_URL ||
      'http://skirmshop-brain-ingest.skirmshop-brain-prod.svc.cluster.local',
    apiKey: process.env.BRAIN_API_KEY || '',
  };

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await ensureBrainWindowsTables(pool);
    try {
      await ensureBrainWindowsIndexes(pool);
    } catch (e) {
      logger.warn({ err: String(e) }, 'ensure indexes failed; continuing');
    }
    logger.info({ phase: opts.phase, runId: opts.runId, dryRun: opts.dryRun }, 'backfill start');
    if (opts.phase === 'push') {
      const t = await runPushPhase(pool, brain, config, opts);
      logger.info({ ...t, dryRun: opts.dryRun }, 'backfill push phase done (resumable)');
    } else {
      const s = await runLlmPhase(pool, brain, config, opts);
      logger.info({ ...s, dryRun: opts.dryRun }, 'backfill llm phase done (resumable)');
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      logger.error({ err: String(err) }, 'brain-windows-backfill failed');
      process.exit(1);
    });
}
