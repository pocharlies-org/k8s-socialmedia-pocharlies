/**
 * Conversation-window builder (INFRA-370, contract v1). Postgres messages ->
 * windows + chunks (+ LLM summary and packet) -> brain push-ingest.
 *
 * Detection (initial load and incremental share the code): conversations with
 * messages newer than the (created_at, id) cursor, plus the dirty mailbox.
 * Each is recomputed from the start of the last known window before its oldest
 * changed message; same window_id + window_hash => nothing to do.
 * DRY_RUN (default true) reads Postgres only: no push, no LLM, no state writes.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool, type PoolClient } from 'pg';
import { ingestNamespaces, instanceForAccount } from '../brain-ingest-lib';
import { httpBrainClient, isPoison, type BrainClient } from './brain-client';
import { chunkWindow } from './chunker';
import {
  CONVERSATION_ADAPTER,
  PACKET_ADAPTER,
  packetDoc,
  packetHash,
  windowDocs,
  type LlmStatus,
} from './doc-builder';
import { extractWindow, openAiChat, skipReason, type ChatFn, type LlmOutcome } from './llm-extract';
import { LlmPool } from './llm-pool';
import * as st from './state';
import { WindowStream, type ChatKind, type ConversationMeta, type Window } from './window-builder';

export interface Logger {
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

/** The SQL layer; tests inject an in-memory one. */
export type Store = Pick<
  typeof st,
  | 'getCursor'
  | 'setCursor'
  | 'snapshotCursor'
  | 'changedChats'
  | 'allChats'
  | 'listDirty'
  | 'clearDirty'
  | 'conversationMeta'
  | 'streamChat'
  | 'anchorBefore'
  | 'windowsFrom'
  | 'pendingLlm'
  | 'upsertWindow'
  | 'deleteWindows'
>;

export interface Deps {
  db: st.Db;
  store: Store;
  brain: BrainClient;
  chat: ChatFn | null;
  pool: LlmPool;
  kinds: Record<string, ChatKind>;
  /** null = no cap (initial load) */
  maxLlmPerRun: number | null;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunStats {
  chats: number;
  windowsPushed: number;
  windowsUnchanged: number;
  windowsDeleted: number;
  poison: number;
  failures: number;
  llmDone: number;
  llmSkipped: number;
  llmErrors: number;
}

const emptyStats = (): RunStats => ({
  chats: 0,
  windowsPushed: 0,
  windowsUnchanged: 0,
  windowsDeleted: 0,
  poison: 0,
  failures: 0,
  llmDone: 0,
  llmSkipped: 0,
  llmErrors: 0,
});

export function loadChatKinds(
  path = join(__dirname, 'chat-kinds.json'),
  log?: Logger
): Record<string, ChatKind> {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  const out: Record<string, ChatKind> = {};
  for (const [id, kind] of Object.entries(raw)) {
    if (kind === 'bot' || kind === 'broadcast') out[id] = kind;
    else log?.warn(`chat-kinds.json: ignoring ${id}: '${kind}' is not bot|broadcast`);
  }
  if (!Object.keys(out).length) {
    log?.warn(
      'chat-kinds.json is empty (stub until INFRA-367 delivers the list): every chat is treated as kind=chat'
    );
  }
  return out;
}

/** Windows of a conversation from `fromTs` (null = from the start), streamed by keyset. */
export async function* streamWindows(
  d: { db: st.Db; store: Store },
  meta: ConversationMeta,
  fromTs: number | null,
  toTs: number | null = null
): AsyncGenerator<Window> {
  const s = new WindowStream(meta);
  for await (const m of d.store.streamChat(d.db, meta.account, meta.conversationId, fromTs, toTs)) {
    for (const w of s.push(m)) yield w;
  }
  for (const w of s.end()) yield w;
}

// ---- phase 1: windows + chunks -----------------------------------------------

function stateFor(
  w: Window,
  meta: ConversationMeta,
  base: Partial<st.StateRow>,
  llmStatus: LlmStatus,
  llmJson: unknown
): st.StateRow {
  return {
    windowId: w.windowId,
    account: meta.account,
    platform: meta.platform,
    conversationId: meta.conversationId,
    firstMsgId: w.firstMsgId,
    lastMsgId: w.lastMsgId,
    startTs: w.startTs,
    endTs: w.endTs,
    msgCount: w.messageCount,
    windowHash: w.windowHash,
    kind: meta.kind,
    pushedHash: base.pushedHash ?? null,
    llmStatus,
    llmInputHash: llmJson == null ? null : w.windowHash,
    llmJson,
    packetHash: base.packetHash ?? null,
    pushError: null,
  };
}

async function processChat(
  d: Deps,
  account: string,
  instance: string,
  conversationId: string,
  minTs: number | null,
  stats: RunStats
): Promise<void> {
  const meta = await d.store.conversationMeta(d.db, account, conversationId, d.kinds);
  const anchor =
    meta && minTs !== null
      ? await d.store.anchorBefore(d.db, account, conversationId, minTs)
      : null;
  const old = await d.store.windowsFrom(d.db, account, conversationId, meta ? anchor : null);
  const oldById = new Map(old.map(r => [r.windowId, r]));
  const seen = new Set<string>();

  if (meta) {
    for await (const w of streamWindows(d, meta, anchor)) {
      seen.add(w.windowId);
      const prev = oldById.get(w.windowId);
      const current = prev && prev.windowHash === w.windowHash && prev.kind === meta.kind;
      if (current && prev.pushedHash === w.windowHash) {
        stats.windowsUnchanged++;
        continue;
      }
      if (current && prev.pushError) {
        stats.windowsUnchanged++; // poison with the same content: do not retry forever
        continue;
      }
      const reason = skipReason(w, meta.kind);
      const llmStatus: LlmStatus = reason ? 'skipped' : 'pending';
      const llmJson = reason ? { status: 'skipped', reason } : null;
      const row = stateFor(
        w,
        meta,
        current ? { packetHash: prev.packetHash } : { packetHash: prev?.packetHash },
        llmStatus,
        llmJson
      );
      try {
        await d.brain.push(instance, CONVERSATION_ADAPTER, windowDocs(w, meta, llmStatus, null));
        await d.store.upsertWindow(d.db, { ...row, pushedHash: w.windowHash, pushed: true });
        stats.windowsPushed++;
      } catch (e) {
        if (!isPoison(e)) throw e;
        stats.poison++;
        d.log.error(`poison window ${w.windowId}: ${(e as Error).message}`);
        await d.store.upsertWindow(d.db, {
          ...row,
          pushedHash: prev?.pushedHash ?? null,
          pushError: String((e as Error).message).slice(0, 500),
        });
      }
    }
  }

  // Windows that no longer exist (first message changed, messages removed): delete, after the new ones are in.
  // The state row goes ONLY when the brain confirmed the delete: a failed delete (poison or not) keeps it,
  // counts as a failure and is retried next run; dropping it would orphan the points in the brain forever.
  for (const r of old.filter(x => !seen.has(x.windowId))) {
    try {
      await d.brain.deleteWindow(instance, r.windowId);
      await d.store.deleteWindows(d.db, [r.windowId]);
      stats.windowsDeleted++;
    } catch (e) {
      stats.failures++;
      d.log.error(`delete-window ${r.windowId} failed, state row kept: ${(e as Error).message}`);
    }
  }
}

// ---- phase 2: LLM pass -----------------------------------------------------------

function outcomeFromJson(j: unknown): LlmOutcome | null {
  const o = j as LlmOutcome | null;
  return o && (o.status === 'done' || o.status === 'skipped') ? o : null;
}

async function llmWindow(
  d: Deps,
  instance: string,
  row: st.StateRow,
  stats: RunStats
): Promise<'ok' | 'error'> {
  const meta = await d.store.conversationMeta(d.db, row.account, row.conversationId, d.kinds);
  if (!meta) return 'ok';
  let w: Window | undefined;
  for await (const x of streamWindows(d, meta, row.startTs, row.endTs)) {
    if (x.windowId === row.windowId) {
      w = x;
      break;
    }
  }
  if (!w || w.windowHash !== row.windowHash) return 'ok'; // changed since: the next incremental run rebuilds it

  let outcome = row.llmInputHash === row.windowHash ? outcomeFromJson(row.llmJson) : null;
  if (!outcome) {
    if (!d.chat) throw new Error('LLM pass without a chat function');
    outcome = await extractWindow(w, { chat: d.chat, pool: d.pool, sleep: d.sleep });
    if (outcome.status === 'skipped' && outcome.reason.startsWith('llm_error')) {
      stats.llmErrors++;
      d.log.warn(`LLM unavailable for ${w.windowId}: ${outcome.reason}`);
      return 'error'; // stays pending, retried next run
    }
    // Checkpoint the answer BEFORE pushing: a crash here never pays for the same call twice.
    await d.store.upsertWindow(d.db, { ...row, llmJson: outcome, llmInputHash: w.windowHash });
  }

  const status: LlmStatus = outcome.status === 'done' ? 'done' : 'skipped';
  const result = outcome.status === 'done' ? outcome.result : null;
  let packetH = row.packetHash;
  try {
    await d.brain.push(instance, CONVERSATION_ADAPTER, windowDocs(w, meta, status, result));
    if (result) {
      const p = packetDoc(w, meta, result);
      if (p && packetHash(p) !== row.packetHash) {
        await d.brain.push(instance, PACKET_ADAPTER, [p]);
        packetH = packetHash(p);
      }
    }
  } catch (e) {
    if (!isPoison(e)) throw e;
    stats.poison++;
    d.log.error(`poison LLM push ${w.windowId}: ${(e as Error).message}`);
    await d.store.upsertWindow(d.db, {
      ...row,
      llmStatus: status,
      llmJson: outcome,
      llmInputHash: w.windowHash,
      pushError: String((e as Error).message).slice(0, 500),
    });
    return 'ok';
  }
  await d.store.upsertWindow(d.db, {
    ...row,
    llmStatus: status,
    llmJson: outcome,
    llmInputHash: w.windowHash,
    pushedHash: w.windowHash,
    packetHash: packetH,
    pushError: null,
    pushed: true,
  });
  if (status === 'done') stats.llmDone++;
  else stats.llmSkipped++;
  return 'ok';
}

async function llmPass(d: Deps, account: string, instance: string, stats: RunStats): Promise<void> {
  // No LLM configured, or maxLlmPerRun === 0 (explicitly off): windows stay pending, nothing is asked.
  if (!d.chat || d.maxLlmPerRun === 0) return;
  const pending = await d.store.pendingLlm(d.db, account, d.maxLlmPerRun); // most recent first
  if (!pending.length) return;
  d.log.info(`LLM pass ${account}: ${pending.length} pending (cap ${d.maxLlmPerRun ?? 'none'})`);
  const queue = [...pending];
  let consecutiveErrors = 0;
  const worker = async () => {
    for (let row = queue.shift(); row && consecutiveErrors < 5; row = queue.shift()) {
      try {
        consecutiveErrors =
          (await llmWindow(d, instance, row, stats)) === 'error' ? consecutiveErrors + 1 : 0;
      } catch (e) {
        stats.failures++;
        d.log.error(`LLM pass ${row.windowId}: ${(e as Error).message}`);
      }
    }
  };
  // The pool is what enforces the cap; the workers just keep it full.
  await Promise.all(Array.from({ length: d.pool.max }, worker));
}

// ---- run ---------------------------------------------------------------------------

export async function runAccount(d: Deps, account: string): Promise<RunStats> {
  const stats = emptyStats();
  const instance = instanceForAccount(account);
  const cursor = await d.store.getCursor(d.db, account);
  const snapshot = await d.store.snapshotCursor(d.db, account);
  const todo = new Map<string, number | null>();
  if (snapshot) {
    for (const c of await d.store.changedChats(d.db, account, cursor, snapshot))
      todo.set(c.conversationId, c.minTs);
  }
  const dirty = await d.store.listDirty(d.db, account);
  for (const x of dirty) todo.set(x.conversationId, null); // the mailbox does not say which message: whole chat
  d.log.info(
    `${account}: ${todo.size} conversations to recompute (${dirty.length} dirty, cursor ${cursor ? 'set' : 'initial load'})`
  );

  for (const [cid, minTs] of todo) {
    stats.chats++;
    try {
      await processChat(d, account, instance, cid, minTs, stats);
    } catch (e) {
      stats.failures++;
      d.log.error(`chat ${cid}: ${(e as Error).message}`);
    }
  }
  if (stats.failures === 0) {
    if (snapshot) await d.store.setCursor(d.db, account, snapshot);
    for (const x of dirty) await d.store.clearDirty(d.db, account, x);
  } else {
    d.log.warn(
      `${account}: ${stats.failures} failures, cursor and mailbox NOT advanced (idempotent rerun)`
    );
  }
  // initial load (no cursor): no cap; `0` stays 0 (LLM off) — the override never turns "off" into "unlimited"
  await llmPass(
    { ...d, maxLlmPerRun: d.maxLlmPerRun === 0 || cursor ? d.maxLlmPerRun : null },
    account,
    instance,
    stats
  );
  return stats;
}

// ---- DRY_RUN: histogram, read-only --------------------------------------------------

export interface Histogram {
  account: string;
  conversations: number;
  messages: number;
  windows: number;
  chunks: number;
  truncated: number;
  byKind: Record<string, number>;
  byMessageCount: Record<string, number>;
  byChars: Record<string, number>;
  llmEligible: number;
  llmSkipped: Record<string, number>;
}

const bucket = (n: number, edges: number[], labels: string[]) =>
  labels[edges.findIndex(e => n <= e)] ?? labels[labels.length - 1];
const MC_EDGES = [1, 2, 5, 10, 50, Infinity];
const MC_LABELS = ['1', '2', '3-5', '6-10', '11-50', '51+'];
const CH_EDGES = [400, 1600, 4000, 16384, Infinity];
const CH_LABELS = ['<=400', '401-1600', '1601-4000', '4001-16384', '>16384'];

export async function dryRunAccount(
  d: Pick<Deps, 'db' | 'store' | 'kinds' | 'log'>,
  account: string
): Promise<Histogram> {
  const h: Histogram = {
    account,
    conversations: 0,
    messages: 0,
    windows: 0,
    chunks: 0,
    truncated: 0,
    byKind: {},
    byMessageCount: {},
    byChars: {},
    llmEligible: 0,
    llmSkipped: {},
  };
  const inc = (o: Record<string, number>, k: string) => {
    o[k] = (o[k] ?? 0) + 1;
  };
  for (const cid of await d.store.allChats(d.db, account)) {
    const meta = await d.store.conversationMeta(d.db, account, cid, d.kinds);
    if (!meta) continue;
    h.conversations++;
    for await (const w of streamWindows(d, meta, null)) {
      h.windows++;
      h.messages += w.messageCount;
      h.chunks += chunkWindow(w, w.header).length;
      if (w.truncatedBySize) h.truncated++;
      inc(h.byKind, meta.kind);
      inc(h.byMessageCount, bucket(w.messageCount, MC_EDGES, MC_LABELS));
      inc(h.byChars, bucket(w.windowText.length, CH_EDGES, CH_LABELS));
      const reason = skipReason(w, meta.kind);
      if (reason) inc(h.llmSkipped, reason);
      else h.llmEligible++;
    }
  }
  return h;
}

export const LLM_TARGET = { min: 18_000, max: 20_000 };

export function formatHistogram(all: Histogram[]): string {
  const lines: string[] = ['DRY_RUN brain-windows (read-only: no push, no LLM, no state writes)'];
  const eligible = all.reduce((n, h) => n + h.llmEligible, 0);
  for (const h of all) {
    lines.push(
      `\n[${h.account}] conversations=${h.conversations} messages=${h.messages} windows=${h.windows} chunks=${h.chunks} truncated_by_size=${h.truncated}`,
      `  kind:        ${JSON.stringify(h.byKind)}`,
      `  msgs/window: ${JSON.stringify(h.byMessageCount)}`,
      `  chars:       ${JSON.stringify(h.byChars)}`,
      `  LLM eligible=${h.llmEligible} skipped=${JSON.stringify(h.llmSkipped)}`
    );
  }
  const verdict =
    eligible >= LLM_TARGET.min * 0.5 && eligible <= LLM_TARGET.max * 1.5
      ? 'within a factor of the target'
      : 'FAR FROM the target: tell the tech-lead';
  lines.push(
    `\nLLM-eligible windows, all accounts: ${eligible} (target ${LLM_TARGET.min}-${LLM_TARGET.max}; ${verdict})`
  );
  return lines.join('\n');
}

// ---- entrypoint ---------------------------------------------------------------------

const consoleLog: Logger = {
  info: (m, e) => console.log(m, e ?? ''),
  warn: (m, e) => console.warn(m, e ?? ''),
  error: (m, e) => console.error(m, e ?? ''),
};

/** Invalid configuration: the only thing that exits 1 (a cron that merely warns must not go Degraded). */
export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new ConfigError(`${name} is unset: refusing to start brain-windows without it`);
  return v;
}

/** MAX_LLM_PER_RUN: unset = 200; `0` = LLM off (never "unlimited"); otherwise a non-negative integer. */
export function parseMaxLlmPerRun(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 200;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new ConfigError(`MAX_LLM_PER_RUN must be a non-negative integer, got '${raw}'`);
  return n;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const DATABASE_URL = required(env, 'DATABASE_URL');
  const dryRun = env.DRY_RUN !== 'false'; // default true
  // No default for the brain: a wrong default (skirmshop-brain instead of the ingest service) would push to the wrong place.
  const brain = dryRun
    ? null
    : httpBrainClient({
        brainUrl: required(env, 'BRAIN_URL'),
        apiKey: required(env, 'BRAIN_API_KEY'),
      });
  const maxLlmPerRun = parseMaxLlmPerRun(env.MAX_LLM_PER_RUN);
  const accounts = (
    env.BRAIN_WINDOWS_ACCOUNTS ? env.BRAIN_WINDOWS_ACCOUNTS.split(',') : ingestNamespaces()
  ).map(a => a.trim());
  const kinds = loadChatKinds(undefined, consoleLog);
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

  if (dryRun) {
    // Manual, read-only tool: a SQL error here must be loud (exit 1), it is the proof that the SQL runs.
    try {
      const hs: Histogram[] = [];
      for (const a of accounts)
        hs.push(await dryRunAccount({ db: pool, store: st, kinds, log: consoleLog }, a));
      console.log(formatHistogram(hs));
      return 0;
    } finally {
      await pool.end();
    }
  }

  // Live run (cron): soft failures (brain down, a chat that fails, DB hiccup) warn and exit 0.
  let lockClient: PoolClient | null = null;
  try {
    lockClient = await pool.connect();
    if (!(await st.tryLock(lockClient))) {
      console.log('brain-windows: another process holds the advisory lock; exiting 0');
      return 0;
    }
    if (!env.LLM_BASE_URL)
      consoleLog.warn(
        'LLM_BASE_URL unset: windows are pushed with llm_status=pending, no extraction'
      );
    const deps: Deps = {
      db: pool,
      store: st,
      brain: brain!,
      chat: env.LLM_BASE_URL ? openAiChat(env) : null,
      pool: new LlmPool(2),
      kinds,
      maxLlmPerRun,
      log: consoleLog,
    };
    let failures = 0;
    for (const a of accounts) {
      try {
        const s = await runAccount(deps, a);
        console.log(`${a}: ${JSON.stringify(s)}`);
        failures += s.failures;
      } catch (e) {
        failures++;
        consoleLog.error(`${a}: run failed: ${(e as Error).message}`);
      }
    }
    if (failures)
      consoleLog.warn(
        `brain-windows: ${failures} soft failure(s); exit 0, the next run retries (cursor not advanced)`
      );
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    consoleLog.error(`brain-windows: soft failure: ${(e as Error).message}; exit 0`);
    return 0;
  } finally {
    lockClient?.release();
    await pool.end().catch(() => undefined);
  }
}

if (require.main === module) {
  main().then(
    code => process.exit(code),
    e => {
      console.error(e);
      process.exit(1);
    }
  );
}
