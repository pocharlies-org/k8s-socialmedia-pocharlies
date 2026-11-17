/**
 * brain-windows — incremental conversation-window worker (INFRA-364, ADR 0002 §7;
 * resident and event-driven since SC-5926). Publishes the parent
 * `conversation_window` documents and their `conversation_chunk` children as
 * Synapse events (brain_window.<tenant>.*, brain-windows-synapse.ts), which
 * synapse-adapter-hindsight retains in Hindsight (SC-5827: the Brain is gone).
 *
 * Trigger (SC-5926, rules: events, never polling): migration 045 makes
 * Postgres `pg_notify('brain_windows_changes', {account})` whenever a statement
 * moves `messages.updated_at` (new rows, edits, deletions, voice notes
 * transcribed later, late history syncs). The Deployment `brain-windows`
 * LISTENs, debounces per account and recomputes:
 *
 *   1. read messages changed after `brain_windows_cursor` (keyset on
 *      (updated_at, id));
 *   2. recompute the windows of every affected chat over the affected range,
 *      grown to complete windows (session boundaries);
 *   3. diff against `brain_windows`: vanished windows are published as deleted
 *      (parent + children), new/changed ones pushed (content_hash);
 *   4. windows younger than the gap go up provisional (llm_status pending).
 *
 * The LLM never blocks that: it runs in waves over CLOSED pending windows
 * (newest first, BRAIN_WINDOWS_MAX_LLM per account), fired by one timer armed at
 * the next close read from the ledger (`nextLlmReadyAt`). A wave that summarised
 * something chains the next; one that did not pauses (10 min doubling to 1 h),
 * and each failed window has its own backoff (045). NOTIFY is not durable: a
 * cursor pass at start covers what was missed, and a lost LISTEN connection
 * exits the process so Kubernetes restarts it into that pass.
 *
 * Setup errors (missing env, DB unreachable, unreadable config) exit non-zero.
 */
import { Client, Pool } from 'pg';
import pino from 'pino';
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
  commitLlmSummary,
  nextLlmReadyAt,
  setWindowsCursor,
  sessionEndBound,
  sessionStartBound,
  upsertWindow,
  windowContentHash,
  WindowSink,
  ingestNamespaces,
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
  maxDeletesPerChat: number; // above this the pass deletes nothing for the chat
}

export function optionsFromEnv(env: NodeJS.ProcessEnv): WindowsJobOptions {
  return {
    scanRows: envInt(env, 'BRAIN_WINDOWS_SCAN_ROWS', 5000),
    maxChats: envInt(env, 'BRAIN_WINDOWS_MAX_CHATS', 100),
    maxLlm: envInt(env, 'BRAIN_WINDOWS_MAX_LLM', 5),
    coldstartLookbackHours: envInt(env, 'BRAIN_WINDOWS_COLDSTART_LOOKBACK_HOURS', 168),
    maxRuntimeMs: envInt(env, 'BRAIN_WINDOWS_MAX_RUNTIME_MS', 1_440_000),
    pushDocsCap: envInt(env, 'BRAIN_WINDOWS_PUSH_DOCS_CAP', 400),
    maxDeletesPerChat: envInt(env, 'BRAIN_WINDOWS_MAX_DELETES_PER_CHAT', 50),
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
  opts: Pick<WindowsJobOptions, 'pushDocsCap' | 'maxDeletesPerChat'>,
  account: string,
  affected: AffectedChat,
  dryRun: boolean
): Promise<{ pushed: number; deleted: number; docs: number; chats: number; refused: number }> {
  const meta = await fetchChatMeta(pool, account, [affected.conversation_id]);
  const m = meta.get(affected.conversation_id);
  if (!m) return { pushed: 0, deleted: 0, docs: 0, chats: 0, refused: 0 }; // conversation row gone
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
  // Only the windows of the rebuilt range can vanish (see loadStoredWindows).
  const existing = await loadStoredWindows(pool, chat, { from: start.bound, to: end.bound });
  const diff = diffWindows(existing, built);
  let refused = 0;
  if (diff.toDelete.length > opts.maxDeletesPerChat) {
    // A recomputed session range rarely loses more than a handful of windows;
    // hundreds at once is a bug, not a chat. Keep everything and shout.
    logger.error(
      { chat: chat.conversation_id, toDelete: diff.toDelete.length, cap: opts.maxDeletesPerChat },
      'refusing mass delete: too many vanished windows for one chat'
    );
    refused = diff.toDelete.length;
    diff.toDelete = [];
  }

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
  return { pushed, deleted, docs, chats: 1, refused };
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
    if (
      !(await commitLlmSummary(
        pool,
        row.source_id,
        row.content_hash,
        inputHash,
        extraction.summary
      ))
    ) {
      logger.info({ source: row.source_id }, 'llm result dropped: content changed during the call');
      return 'skipped';
    }
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

/**
 * Recompute the windows of one account from its cursor — no LLM (SC-5926: the
 * events to Synapse/Hindsight never wait for the resident). `more` = rows left
 * for a next run (per-run chat cap or budget).
 */
export async function recomputeAccount(
  pool: Pool,
  sink: WindowSink,
  config: WindowsConfig,
  opts: WindowsJobOptions,
  account: string,
  budget: PassBudget
): Promise<{ stats: Record<string, number>; more: boolean }> {
  const stats = { chats: 0, pushed: 0, deleted: 0, refused_deletes: 0, docs: 0 };

  let cursor = await getWindowsCursor(pool, account);
  if (!cursor) {
    const t = new Date(Date.now() - opts.coldstartLookbackHours * 3600_000);
    cursor = { last_updated_at: t.toISOString(), last_id: null };
    await setWindowsCursor(pool, account, t, null);
    logger.info({ account, at: t.toISOString() }, 'no windows cursor — cold start with lookback');
  }

  for (;;) {
    const changed = await fetchChangedRows(pool, account, cursor, opts.scanRows);
    if (!changed.length) return { stats, more: false };
    const chats = groupAffectedChats(changed);
    const processedKeys = new Set<string>();
    for (const affected of chats.slice(0, opts.maxChats)) {
      if (budget.out()) break;
      try {
        const r = await recomputeChat(pool, sink, config, opts, account, affected, false);
        stats.chats += r.chats;
        stats.pushed += r.pushed;
        stats.deleted += r.deleted;
        stats.refused_deletes += r.refused;
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
    // the per-run cap, and everything behind them, stay for the next read).
    let lastProcessed: (typeof changed)[number] | null = null;
    for (const row of changed) {
      if (!processedKeys.has(`${row.platform}|${row.conversation_id}`)) break;
      lastProcessed = row;
    }
    if (!lastProcessed) return { stats, more: true }; // budget out before the first chat
    cursor = {
      last_updated_at: new Date(lastProcessed.updated_at).toISOString(),
      last_id: lastProcessed.id,
    };
    await setWindowsCursor(pool, account, cursor.last_updated_at, cursor.last_id);
    const leftBehind = lastProcessed !== changed[changed.length - 1];
    if (changed.length < opts.scanRows && !leftBehind) return { stats, more: false };
    if (budget.out()) return { stats, more: true };
  }
}

/** Pause after an LLM wave that summarised nothing: 10 min doubling to 1 h. */
const LLM_PAUSE_BASE_MS = 600_000;
const LLM_PAUSE_MAX_MS = 3_600_000;
/** A wave that found nothing ready (stale timer, pod/DB clock skew) re-arms no sooner than this. */
const LLM_IDLE_REARM_MS = 30_000;

export interface WorkerHooks {
  accounts: string[];
  debounceMs: number;
  recompute(account: string): Promise<{ refused: number; more: boolean }>;
  llmWave(account: string): Promise<{ done: number; failed: number; skipped: number }>;
  /** nextLlmReadyAt over every account. */
  nextReadyAt(): Promise<Date | null>;
  /** Is a closed window of this account waiting for the LLM right now? */
  llmReady(account: string): Promise<boolean>;
  metrics(text: string): Promise<void>;
}

/**
 * The event-driven scheduler (SC-5926). `changed(account)` (a NOTIFY) debounces
 * a recompute of that account — never two at once for one account; a change
 * during a run queues one more. After each recompute the LLM timer is re-armed
 * at the next close the ledger knows; one wave at a time.
 */
export class WindowsWorker {
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly stallStart = new Map<string, number>();
  private llmTimer: NodeJS.Timeout | null = null;
  private waving = false;
  private pauseUntil = 0;
  private failStreak = 0;
  private closed = false;

  constructor(private readonly h: WorkerHooks) {}

  changed(account: string, delayMs = this.h.debounceMs): void {
    if (this.closed || !this.h.accounts.includes(account)) return;
    if (this.running.has(account)) {
      this.dirty.add(account);
      return;
    }
    if (this.pending.has(account)) return;
    this.pending.set(
      account,
      setTimeout(() => {
        this.pending.delete(account);
        void this.recompute(account);
      }, delayMs)
    );
  }

  private async recompute(account: string): Promise<void> {
    this.running.add(account);
    let more = false;
    try {
      const r = await this.h.recompute(account);
      more = r.more;
      await this.h.metrics(passMetricsText({ [account]: r.refused }, Date.now()));
    } catch (e) {
      // DB trouble: the next change (or the restart after a lost LISTEN) retries.
      logger.error({ account, err: String(e) }, 'recompute failed');
    } finally {
      this.running.delete(account);
    }
    if (more) this.changed(account, 0);
    else if (this.dirty.has(account)) this.changed(account);
    this.dirty.delete(account);
    await this.armLlm();
  }

  async armLlm(): Promise<void> {
    if (this.closed || this.waving) return; // a running wave re-arms when it ends
    let at: Date | null;
    try {
      at = await this.h.nextReadyAt();
    } catch (e) {
      logger.error({ err: String(e) }, 'llm timer not armed; the next recompute retries');
      return;
    }
    if (this.llmTimer) clearTimeout(this.llmTimer);
    this.llmTimer = null;
    if (!at || this.closed) return;
    const now = Date.now();
    const delay = Math.max(at.getTime() - now, this.pauseUntil - now, 0);
    this.llmTimer = setTimeout(() => {
      this.llmTimer = null;
      void this.wave();
    }, delay);
  }

  private async wave(): Promise<void> {
    if (this.closed || this.waving) return;
    this.waving = true;
    try {
      let done = 0;
      let picked = 0;
      for (const account of this.h.accounts) {
        try {
          const r = await this.h.llmWave(account);
          done += r.done;
          picked += r.done + r.failed + r.skipped;
          if (r.done > 0) this.stallStart.set(account, Date.now());
          logger.info({ account, ...r }, 'llm wave done');
        } catch (e) {
          logger.error({ account, err: String(e) }, 'llm wave failed');
        }
      }
      if (done > 0 || picked === 0) {
        this.failStreak = 0;
        this.pauseUntil = picked === 0 ? Date.now() + LLM_IDLE_REARM_MS : 0;
      } else {
        const pause = Math.min(LLM_PAUSE_BASE_MS * 2 ** this.failStreak, LLM_PAUSE_MAX_MS);
        this.pauseUntil = Date.now() + pause;
        this.failStreak++;
        logger.warn({ pauseMs: pause }, 'llm wave summarised nothing; pausing the LLM');
      }
      await this.pushStall();
    } finally {
      this.waving = false;
    }
    await this.armLlm();
  }

  /** brain_windows_llm_stalled_seconds: how long ready LLM work has waited without one summary. */
  private async pushStall(): Promise<void> {
    const now = Date.now();
    const lines: string[] = [];
    for (const a of this.h.accounts) {
      let ready: boolean;
      try {
        ready = await this.h.llmReady(a);
      } catch {
        continue;
      }
      if (!ready) this.stallStart.delete(a);
      else if (!this.stallStart.has(a)) this.stallStart.set(a, now);
      const since = this.stallStart.get(a);
      const secs = since === undefined ? 0 : Math.floor((now - since) / 1000);
      lines.push(`brain_windows_llm_stalled_seconds{account="${a}"} ${secs} ${now}`);
    }
    if (lines.length) await this.h.metrics(lines.join('\n') + '\n');
  }

  close(): void {
    this.closed = true;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    if (this.llmTimer) clearTimeout(this.llmTimer);
    this.llmTimer = null;
  }
}

// Fed by the triggers of migration 045 (provider) — consumed only here.
export const CHANGES_CHANNEL = 'brain_windows_changes';

/** The account of a 045 notification payload, or null if it is malformed. */
export function changedAccount(payload: string | undefined): string | null {
  try {
    const account = (JSON.parse(payload ?? '') as { account?: unknown }).account;
    return typeof account === 'string' && account ? account : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // SC-5827: sin guarda SEMANTIC_PROVIDER. Este worker es el productor vivo del
  // indice de conversaciones en Hindsight (publica brain_window.* y
  // synapse-adapter-hindsight lo retiene).
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error(
      'DATABASE_URL is unset: refusing to run brain-windows without an explicit database connection'
    );
  const configFile = process.env.BRAIN_WINDOWS_CONFIG_FILE;
  if (!configFile)
    throw new Error('BRAIN_WINDOWS_CONFIG_FILE is unset (k8s/base/brain-windows-config.yaml)');
  // Read on every use: a ConfigMap edit applies without a restart. Read once
  // here so an unreadable file is a setup error.
  const config = (): WindowsConfig => loadWindowsConfig(configFile);
  config();
  const url = process.env.SYNAPSE_RABBITMQ_URL;
  if (!url) throw new Error('SYNAPSE_RABBITMQ_URL is unset (secret whatsapp-mcp-synapse-rabbitmq)');
  const publisher = await connectPublisher(url);
  const sink = synapseSink(publisher);
  const llm = llmConfigFromEnv(process.env);
  const opts = optionsFromEnv(process.env);
  const metricsUrl = process.env.BRAIN_WINDOWS_METRICS_URL;

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  await ensureBrainWindowsTables(pool);
  try {
    await ensureBrainWindowsIndexes(pool);
  } catch (e) {
    // A failed CONCURRENTLY build leaves an INVALID index; the scan still
    // works (slower). Warn, do not die.
    logger.warn({ err: String(e) }, 'ensure indexes failed; continuing');
  }
  const accounts = ingestNamespaces();
  const closedBefore = (): Date => new Date(Date.now() - config().gapSeconds * 1000);
  const worker = new WindowsWorker({
    accounts,
    debounceMs: envInt(process.env, 'BRAIN_WINDOWS_DEBOUNCE_MS', 15_000),
    recompute: async (account): Promise<{ refused: number; more: boolean }> => {
      const budget = new PassBudget(Date.now(), opts.maxRuntimeMs);
      const { stats, more } = await recomputeAccount(pool, sink, config(), opts, account, budget);
      logger.info({ account, ...stats, more }, 'account recomputed');
      return { refused: stats.refused_deletes, more };
    },
    llmWave: account =>
      runLlmPass(pool, sink, llm, account, {
        maxLlm: opts.maxLlm,
        closedBefore: closedBefore(),
        budget: new PassBudget(Date.now(), opts.maxRuntimeMs),
        dryRun: false,
      }),
    nextReadyAt: () => nextLlmReadyAt(pool, accounts, config().gapSeconds),
    llmReady: async account =>
      (
        await fetchPendingLlmWindows(pool, {
          accounts: [account],
          closedBefore: closedBefore(),
          limit: 1,
        })
      ).length > 0,
    metrics: text => pushMetrics(metricsUrl, text),
  });

  // LISTEN before the startup pass, so a change committed during it wakes us again.
  const listener = new Client({ connectionString: databaseUrl });
  const lost = (why: string): never => {
    logger.error({ why }, 'LISTEN connection lost: exiting so the restart pass catches up');
    process.exit(1);
  };
  listener.on('error', e => lost(String(e)));
  listener.on('end', () => lost('connection ended'));
  listener.on('notification', n => {
    const account = changedAccount(n.payload);
    if (account) worker.changed(account);
  });
  await listener.connect();
  await listener.query(`LISTEN ${CHANGES_CHANNEL}`);

  // Startup pass: everything after each cursor (what changed while we were
  // down or a lost NOTIFY), then whatever the LLM has ready.
  for (const account of accounts) worker.changed(account, 0);
  await worker.armLlm();
  logger.info({ accounts, channel: CHANGES_CHANNEL }, 'brain-windows: listening');

  const shutdown = async (): Promise<void> => {
    logger.info('brain-windows: shutting down');
    worker.close();
    listener.removeAllListeners('end');
    listener.removeAllListeners('error');
    await listener.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await publisher.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

/**
 * Prometheus text lines for one pass: the mass deletes the per-chat cap
 * refused (an alert fires on any > 0 — the cap only stops the damage, a
 * human has to look) and when the pass finished.
 */
// CONTRACT: metric.brain-windows.refused-deletes.v1
export function passMetricsText(refusedByAccount: Record<string, number>, nowMs: number): string {
  const lines = Object.entries(refusedByAccount).map(
    ([account, n]) => `brain_windows_refused_deletes{account="${account}"} ${n} ${nowMs}`
  );
  lines.push(`brain_windows_pass_finished_timestamp_seconds ${Math.floor(nowMs / 1000)} ${nowMs}`);
  return lines.join('\n') + '\n';
}

/** Best effort: a metrics outage must never stop the worker. */
async function pushMetrics(url: string | undefined, text: string): Promise<void> {
  if (!url) return;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) logger.warn({ status: resp.status }, 'metrics push rejected');
  } catch (e) {
    logger.warn({ err: String(e) }, 'metrics push failed');
  }
}

if (require.main === module) {
  main().catch(err => {
    logger.error({ err: String(err) }, 'brain-windows failed (setup error)');
    process.exit(1);
  });
}
