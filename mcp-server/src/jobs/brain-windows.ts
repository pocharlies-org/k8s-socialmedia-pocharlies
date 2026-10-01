/**
 * brain-windows — incremental conversation-window pass (INFRA-364, ADR 0002 §7).
 * Publishes the parent `conversation_window` documents and their
 * `conversation_chunk` children as Synapse events (brain_window.<tenant>.*,
 * brain-windows-synapse.ts), which Synapse ingests with retries; the
 * backfill still uses push-ingest directly. CronJob every 30 min. Per
 * account (DB namespace):
 *
 *   1. read messages changed after `brain_windows_cursor` (keyset on
 *      (updated_at, id) — late history syncs, edits, deletions and voice
 *      notes transcribed hours later all move `updated_at`);
 *   2. recompute the windows of every affected chat over the affected range,
 *      grown to complete windows (session boundaries);
 *   3. diff against `brain_windows`: vanished windows are deleted from the
 *      brain (parent + children), new/changed ones pushed (content_hash);
 *   4. windows younger than the gap go up provisional (llm_status pending);
 *   5. the LLM runs over CLOSED pending windows, newest first, 2 in parallel,
 *      capped per pass; parents are re-pushed with their summary.
 *
 * House rule (BRAIN-INGEST-HANDOFF): a cron that merely warns exits 0 — a
 * failed Job pins the ArgoCD Application in Degraded. Only setup errors
 * (missing env, DB unreachable, unreadable config) exit non-zero.
 */
import { Pool } from 'pg';
import pino from 'pino';
import { ingestNamespaces } from './brain-ingest-lib';
import {
  BuiltWindow,
  ChatRef,
  PendingLlmWindow,
  WindowsConfig,
  WindowMessage,
  buildWindows,
  childDocs,
  childChunks,
  classifyConvKind,
  deleteWindowRow,
  diffWindows,
  ensureBrainWindowsIndexes,
  ensureBrainWindowsTables,
  fetchChangedRows,
  fetchChatMessages,
  fetchChatMeta,
  fetchPendingLlmWindows,
  getWindowsCursor,
  initialLlmStatus,
  llmInputHash,
  loadStoredWindows,
  loadWindowForLlm,
  loadWindowsConfig,
  parentDoc,
  previousSummary,
  setWindowLlmResult,
  setWindowSummary,
  setWindowsCursor,
  sessionEndBound,
  sessionStartBound,
  upsertWindow,
  windowContentHash,
  WindowSink,
  httpSink,
} from './brain-windows-lib';
import { connectPublisher, synapseSink } from './brain-windows-synapse';
import {
  llmConcurrencyFromEnv,
  LlmConfig,
  createLimiter,
  extractWindow,
  llmConfigFromEnv,
} from './brain-window-llm';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface WindowsJobOptions {
  scanRows: number; // changed rows read per batch
  maxChats: number; // chats recomputed per account pass
  maxLlm: number; // LLM windows per account pass
  coldstartLookbackHours: number; // first cursor: don't blind the recent past
  maxRuntimeMs: number; // stop cleanly before activeDeadlineSeconds
  pushDocsCap: number; // safety cap of docs pushed for one chat
}

export function optionsFromEnv(env: NodeJS.ProcessEnv): WindowsJobOptions {
  return {
    scanRows: envInt(env, 'BRAIN_WINDOWS_SCAN_ROWS', 5000),
    maxChats: envInt(env, 'BRAIN_WINDOWS_MAX_CHATS', 100),
    maxLlm: envInt(env, 'BRAIN_WINDOWS_MAX_LLM', 5),
    coldstartLookbackHours: envInt(env, 'BRAIN_WINDOWS_COLDSTART_LOOKBACK_HOURS', 168),
    maxRuntimeMs: envInt(env, 'BRAIN_WINDOWS_MAX_RUNTIME_MS', 1_440_000),
    pushDocsCap: envInt(env, 'BRAIN_WINDOWS_PUSH_DOCS_CAP', 400),
  };
}

interface AffectedChat {
  platform: string;
  conversation_id: string;
  minTs: Date;
  maxTs: Date;
}

/** Group changed rows into chats, keeping first-appearance order. */
export function groupAffectedChats(
  rows: { platform: string; conversation_id: string; wa_timestamp: Date }[]
): AffectedChat[] {
  const map = new Map<string, AffectedChat>();
  for (const r of rows) {
    const key = `${r.platform}|${r.conversation_id}`;
    const ts = new Date(r.wa_timestamp);
    const hit = map.get(key);
    if (hit) {
      if (ts < hit.minTs) hit.minTs = ts;
      if (ts > hit.maxTs) hit.maxTs = ts;
    } else {
      map.set(key, {
        platform: r.platform,
        conversation_id: r.conversation_id,
        minTs: ts,
        maxTs: ts,
      });
    }
  }
  return [...map.values()];
}

export class PassBudget {
  constructor(
    private readonly start: number,
    private readonly limitMs: number
  ) {}
  remainingMs(): number {
    return this.limitMs - (Date.now() - this.start);
  }
  out(): boolean {
    return this.remainingMs() <= 15_000; // leave room for the cursor write
  }
}

/** Recompute, diff, delete and push the windows of one chat. */
export async function recomputeChat(
  pool: Pool,
  sink: WindowSink,
  config: WindowsConfig,
  opts: Pick<WindowsJobOptions, 'pushDocsCap'>,
  account: string,
  affected: AffectedChat,
  dryRun: boolean
): Promise<{ pushed: number; deleted: number; docs: number; chats: number }> {
  const meta = await fetchChatMeta(pool, account, [affected.conversation_id]);
  const m = meta.get(affected.conversation_id);
  if (!m) return { pushed: 0, deleted: 0, docs: 0, chats: 0 }; // conversation row gone
  const chat: ChatRef = {
    account,
    platform: affected.platform,
    conversation_id: affected.conversation_id,
    conversation_name: m.name,
    conv_kind: classifyConvKind(m, affected.conversation_id, m.name, config),
  };

  // Grow the affected range to complete windows (ADR §7.2).
  const start = await sessionStartBound(pool, chat, affected.minTs, config.gapSeconds);
  const end = await sessionEndBound(pool, chat, affected.maxTs, config.gapSeconds);
  if (start.truncated || end.truncated)
    logger.warn({ chat: chat.conversation_id }, 'session boundary truncated by lookback cap');

  const msgs: WindowMessage[] = await fetchChatMessages(pool, chat, start.bound, end.bound);
  const built: BuiltWindow[] = buildWindows(chat, msgs, config);
  const existing = await loadStoredWindows(pool, chat);
  const diff = diffWindows(existing, built);

  let deleted = 0;
  for (const gone of diff.toDelete) {
    try {
      if (!dryRun) {
        await sink.remove(account, chat.platform, gone.source_id, gone.chunk_count);
        await deleteWindowRow(pool, gone.source_id);
      }
      deleted++;
    } catch (e) {
      logger.error(
        { source: gone.source_id, err: String(e) },
        'window delete failed; retried next pass'
      );
    }
  }

  let pushed = 0;
  let docs = 0;
  for (const w of diff.toPush) {
    if (docs >= opts.pushDocsCap) {
      logger.warn({ chat: chat.conversation_id, cap: opts.pushDocsCap }, 'push doc cap reached');
      break;
    }
    const chunks = childChunks(w, config);
    const status = initialLlmStatus(w);
    const all = [parentDoc(w, { llm_status: status }), ...childDocs(w, chunks)];
    docs += all.length;
    if (dryRun) {
      pushed++;
      continue;
    }
    try {
      await sink.push(account, all);
    } catch (e) {
      // No ledger write: the next pass re-diffs and re-pushes (ADR §7.3).
      logger.error(
        { source: w.source_id, err: String(e) },
        'window push failed; retried next pass'
      );
      continue;
    }
    await upsertWindow(pool, {
      w,
      pushed_hash: w.content_hash,
      chunk_count: chunks.length,
      llm_status: status,
    });
    pushed++;
  }
  return { pushed, deleted, docs, chats: 1 };
}

/** LLM pass over closed pending windows (ADR §7.5), 2 in parallel by default (BRAIN_WINDOWS_LLM_CONCURRENCY). */
export async function runLlmPass(
  pool: Pool,
  sink: WindowSink,
  llm: LlmConfig,
  account: string,
  opts: { maxLlm: number; closedBefore: Date; budget: PassBudget; dryRun: boolean }
): Promise<{ done: number; failed: number; skipped: number }> {
  const rows = await fetchPendingLlmWindows(pool, {
    accounts: [account],
    closedBefore: opts.closedBefore,
    limit: opts.maxLlm,
  });
  const limit = createLimiter(llmConcurrencyFromEnv(process.env));
  let done = 0;
  let failed = 0;
  let skipped = 0;
  await Promise.all(
    rows.map(row =>
      limit(async () => {
        if (opts.budget.out()) {
          skipped++;
          return;
        }
        try {
          const r = await processLlmWindow(pool, sink, llm, row, opts.dryRun);
          if (r === 'done') done++;
          else if (r === 'failed') failed++;
          else skipped++;
        } catch (e) {
          failed++;
          logger.error({ source: row.source_id, err: String(e) }, 'llm window crashed');
        }
      })
    )
  );
  return { done, failed, skipped };
}

export async function processLlmWindow(
  pool: Pool,
  sink: WindowSink,
  llm: LlmConfig,
  row: PendingLlmWindow,
  dryRun: boolean
): Promise<'done' | 'failed' | 'skipped'> {
  const w = await loadWindowForLlm(pool, row);
  if (!w) {
    await setWindowLlmResult(pool, row.source_id, 'failed', null, 'window messages not found');
    return 'failed';
  }
  if (w.trivial || !w.llm_eligible) {
    await setWindowLlmResult(pool, row.source_id, 'skipped', null, null);
    return 'skipped';
  }
  const freshHash = windowContentHash({
    window_key: w.window_key,
    part: w.part,
    transcript: w.transcript,
    message_ids: w.messages.map(m => m.wa_message_id),
    conversation_name: w.chat.conversation_name,
    conv_kind: w.chat.conv_kind,
  });
  if (freshHash !== row.content_hash) {
    // The chat moved on since this row was pushed: the diff (which runs
    // before this pass) will re-push it with a fresh hash; extracting the old
    // text would mislabel it. Skip without touching the status.
    logger.info({ source: row.source_id }, 'llm skipped: content changed since ledger');
    return 'skipped';
  }
  const prev = await previousSummary(
    pool,
    w.chat.account,
    w.chat.platform,
    w.chat.conversation_id,
    w.start_ts
  );
  const inputHash = llmInputHash(llm.model, w.header, w.transcript, prev);
  if (row.llm_input_hash === inputHash) {
    // Checkpoint (ADR §5): this exact input was extracted before — the row is
    // only 'pending' because a content-preserving re-push reset the status.
    // Restore done and re-attach the stored summary; no LLM call.
    const s = await pool.query(`SELECT llm_summary FROM brain_windows WHERE source_id = $1`, [
      row.source_id,
    ]);
    const summary = s.rows.length ? (s.rows[0].llm_summary as string | null) : null;
    if (summary) {
      await setWindowLlmResult(pool, row.source_id, 'done', null, null);
      if (!dryRun) await sink.push(w.chat.account, [parentDoc(w, { llm_status: 'done', summary })]);
    }
    return 'skipped';
  }
  if (dryRun) return 'skipped';

  try {
    const { extraction } = await extractWindow(llm, w, prev);
    await setWindowLlmResult(pool, row.source_id, 'done', inputHash, null);
    await setWindowSummary(pool, row.source_id, extraction.summary);
    // Re-push the parent with content = header + summary (ADR §5).
    await sink.push(w.chat.account, [
      parentDoc(w, {
        llm_status: 'done',
        summary: extraction.summary,
        extraction: extraction as unknown as Record<string, unknown>,
      }),
    ]);
    return 'done';
  } catch (e) {
    // Failure keeps the previous input hash (NULL for a first attempt) so the
    // next pass retries it — the checkpoint only short-circuits successes.
    await setWindowLlmResult(
      pool,
      row.source_id,
      'failed',
      null,
      e instanceof Error ? e.message : String(e)
    );
    return 'failed';
  }
}

async function accountPass(
  pool: Pool,
  sink: WindowSink,
  llm: LlmConfig,
  config: WindowsConfig,
  opts: WindowsJobOptions,
  account: string,
  dryRun: boolean
): Promise<Record<string, number>> {
  const budget = new PassBudget(Date.now(), opts.maxRuntimeMs);
  const stats = {
    chats: 0,
    pushed: 0,
    deleted: 0,
    docs: 0,
    llm_done: 0,
    llm_failed: 0,
    llm_skipped: 0,
  };

  let cursor = await getWindowsCursor(pool, account);
  if (!cursor) {
    const t = new Date(Date.now() - opts.coldstartLookbackHours * 3600_000);
    cursor = { last_updated_at: t.toISOString(), last_id: null };
    if (!dryRun) await setWindowsCursor(pool, account, t, null);
    logger.info({ account, at: t.toISOString() }, 'no windows cursor — cold start with lookback');
  }

  for (;;) {
    const changed = await fetchChangedRows(pool, account, cursor, opts.scanRows);
    if (!changed.length) break;
    const chats = groupAffectedChats(changed);
    const processedKeys = new Set<string>();
    for (const affected of chats.slice(0, opts.maxChats)) {
      if (budget.out()) break;
      try {
        const r = await recomputeChat(pool, sink, config, opts, account, affected, dryRun);
        stats.chats += r.chats;
        stats.pushed += r.pushed;
        stats.deleted += r.deleted;
        stats.docs += r.docs;
      } catch (e) {
        // One broken chat must not stall the account; it self-heals when the
        // chat changes again (the cursor has not passed it yet either way —
        // it is added to processedKeys before the cursor decision below).
        logger.error(
          { account, chat: affected.conversation_id, err: String(e) },
          'chat recompute failed'
        );
      }
      processedKeys.add(`${affected.platform}|${affected.conversation_id}`);
    }
    // Advance the cursor to the last row whose chat was processed (chats over
    // the per-pass cap, and everything behind them, stay for the next pass).
    let lastProcessed: (typeof changed)[number] | null = null;
    for (const row of changed) {
      if (!processedKeys.has(`${row.platform}|${row.conversation_id}`)) break;
      lastProcessed = row;
    }
    if (!lastProcessed) break; // even the first chat was over the cap: stop
    cursor = {
      last_updated_at: new Date(lastProcessed.updated_at).toISOString(),
      last_id: lastProcessed.id,
    };
    if (!dryRun) await setWindowsCursor(pool, account, cursor.last_updated_at, cursor.last_id);
    if (changed.length < opts.scanRows) break;
    if (budget.out()) break;
  }

  const llmStats = await runLlmPass(pool, sink, llm, account, {
    maxLlm: opts.maxLlm,
    closedBefore: new Date(Date.now() - config.gapSeconds * 1000),
    budget,
    dryRun,
  });
  stats.llm_done += llmStats.done;
  stats.llm_failed += llmStats.failed;
  stats.llm_skipped += llmStats.skipped;
  return stats;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error(
      'DATABASE_URL is unset: refusing to run brain-windows without an explicit database connection'
    );
  const configFile = process.env.BRAIN_WINDOWS_CONFIG_FILE;
  if (!configFile)
    throw new Error('BRAIN_WINDOWS_CONFIG_FILE is unset (k8s/base/brain-windows-config.yaml)');
  const config = loadWindowsConfig(configFile);
  // INFRA-364: the incremental pass publishes to Synapse (retries and
  // visibility in the engine); BRAIN_WINDOWS_SINK=http keeps the old direct
  // push-ingest path for a rollback without a code change.
  const sinkKind = process.env.BRAIN_WINDOWS_SINK || 'synapse';
  let publisher: Awaited<ReturnType<typeof connectPublisher>> | null = null;
  let sink: WindowSink;
  if (sinkKind === 'http') {
    sink = httpSink(
      {
        brainUrl:
          process.env.BRAIN_URL ||
          'http://skirmshop-brain-ingest.skirmshop-brain-prod.svc.cluster.local',
        apiKey: process.env.BRAIN_API_KEY || '',
      },
      msg => logger.debug(msg)
    );
  } else if (sinkKind === 'synapse') {
    const url = process.env.SYNAPSE_RABBITMQ_URL;
    if (!url)
      throw new Error(
        'SYNAPSE_RABBITMQ_URL is unset (secret whatsapp-mcp-synapse-rabbitmq); set BRAIN_WINDOWS_SINK=http to push directly'
      );
    publisher = await connectPublisher(url);
    sink = synapseSink(publisher);
  } else {
    throw new Error(`BRAIN_WINDOWS_SINK=${sinkKind}: expected synapse or http`);
  }
  const llm = llmConfigFromEnv(process.env);
  const opts = optionsFromEnv(process.env);
  const dryRun = process.env.BRAIN_WINDOWS_DRY_RUN === 'true';

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const totals: Record<string, number> = {};
  try {
    await ensureBrainWindowsTables(pool);
    try {
      await ensureBrainWindowsIndexes(pool);
    } catch (e) {
      // A failed CONCURRENTLY build leaves an INVALID index; the scan still
      // works (slower). Warn, do not die.
      logger.warn({ err: String(e) }, 'ensure indexes failed; continuing');
    }
    for (const account of ingestNamespaces()) {
      try {
        const s = await accountPass(pool, sink, llm, config, opts, account, dryRun);
        for (const [k, v] of Object.entries(s)) totals[k] = (totals[k] ?? 0) + v;
        logger.info({ account, ...s, dryRun }, 'account pass done');
      } catch (e) {
        logger.error({ account, err: String(e) }, 'account pass failed; continuing with the next');
      }
    }
  } finally {
    await pool.end();
    await publisher?.close();
  }
  logger.info({ ...totals, sink: sinkKind, dryRun }, 'brain-windows pass finished');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      logger.error({ err: String(err) }, 'brain-windows failed (setup error)');
      process.exit(1);
    });
}
