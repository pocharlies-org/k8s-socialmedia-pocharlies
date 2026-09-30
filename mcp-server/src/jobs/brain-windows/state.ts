/**
 * SQL of the window builder: state, cursor, change detection and message reads.
 * Tables come from migration 016 (ledger); nothing is created here.
 * `ts` everywhere is epoch ms of `wa_timestamp` read as UTC.
 */
import type { Pool, PoolClient } from 'pg';
import type { ChatKind, ConversationMeta, Platform, WindowMessage } from './window-builder';
import type { LlmStatus } from './doc-builder';

export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, any>> }>;
}

export const PLATFORMS: Platform[] = ['whatsapp', 'telegram'];
const VOICE_TYPES = ['AUDIO', 'VOICE'];
const TS_MS = `floor(extract(epoch from m.wa_timestamp) * 1000)::bigint`;
const COUNTED = `m.is_deleted = false AND m.content IS NOT NULL AND btrim(m.content) <> ''`; // rule 4

export interface Cursor {
  lastCreatedAt: string;
  lastId: string;
}

export interface StateRow {
  windowId: string;
  account: string;
  platform: string;
  conversationId: string;
  firstMsgId: string;
  lastMsgId: string;
  startTs: number;
  endTs: number;
  msgCount: number;
  windowHash: string;
  kind: ChatKind;
  pushedHash: string | null;
  llmStatus: LlmStatus;
  llmInputHash: string | null;
  llmJson: unknown;
  packetHash: string | null;
  pushError: string | null;
}

// ---- lock ------------------------------------------------------------------

/** Session-level advisory lock on a dedicated connection: one builder process at a time. */
export async function tryLock(client: PoolClient): Promise<boolean> {
  const r = await client.query(`SELECT pg_try_advisory_lock(hashtext('brain-windows')) AS ok`);
  return r.rows[0]?.ok === true;
}

export async function unlock(client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_unlock(hashtext('brain-windows'))`);
}

// ---- cursor ----------------------------------------------------------------

export async function getCursor(db: Db, account: string): Promise<Cursor | null> {
  const r = await db.query(
    `SELECT last_created_at::text AS at, last_id FROM brain_window_cursor WHERE account = $1`,
    [account]
  );
  return r.rows[0] ? { lastCreatedAt: r.rows[0].at, lastId: r.rows[0].last_id } : null;
}

export async function setCursor(db: Db, account: string, c: Cursor): Promise<void> {
  await db.query(
    `INSERT INTO brain_window_cursor (account, last_created_at, last_id, updated_at)
     VALUES ($1, $2::timestamptz, $3, now())
     ON CONFLICT (account) DO UPDATE
       SET last_created_at = EXCLUDED.last_created_at, last_id = EXCLUDED.last_id, updated_at = now()`,
    [account, c.lastCreatedAt, c.lastId]
  );
}

/** Newest counted message of the account: the upper bound of this run (a snapshot). */
export async function snapshotCursor(db: Db, account: string): Promise<Cursor | null> {
  const r = await db.query(
    `SELECT m.created_at::timestamptz::text AS at, m.id::text AS id
       FROM messages m
      WHERE m.account = $1 AND m.platform = ANY($2) AND ${COUNTED}
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
    [account, PLATFORMS]
  );
  return r.rows[0] ? { lastCreatedAt: r.rows[0].at, lastId: r.rows[0].id } : null;
}

export interface ChangedChat {
  conversationId: string;
  /** oldest wa_timestamp among the new messages (ms), null = whole conversation (dirty mailbox) */
  minTs: number | null;
}

/** Conversations with messages in (cursor, snapshot] by insertion order. */
export async function changedChats(
  db: Db,
  account: string,
  from: Cursor | null,
  to: Cursor
): Promise<ChangedChat[]> {
  const r = await db.query(
    `SELECT m.conversation_id::text AS cid, min(${TS_MS}) AS min_ts
       FROM messages m
      WHERE m.account = $1 AND m.platform = ANY($2) AND ${COUNTED}
        AND ($3::timestamptz IS NULL OR (m.created_at, m.id) > ($3::timestamptz, $4))
        AND (m.created_at, m.id) <= ($5::timestamptz, $6)
      GROUP BY m.conversation_id`,
    [
      account,
      PLATFORMS,
      from?.lastCreatedAt ?? null,
      from?.lastId ?? null,
      to.lastCreatedAt,
      to.lastId,
    ]
  );
  return r.rows.map(x => ({ conversationId: x.cid, minTs: Number(x.min_ts) }));
}

/** Every conversation with counted messages (DRY_RUN / full rebuild). */
export async function allChats(db: Db, account: string): Promise<string[]> {
  const r = await db.query(
    `SELECT DISTINCT m.conversation_id::text AS cid FROM messages m
      WHERE m.account = $1 AND m.platform = ANY($2) AND ${COUNTED} ORDER BY 1`,
    [account, PLATFORMS]
  );
  return r.rows.map(x => x.cid);
}

// ---- dirty mailbox (written by the transcribers, INFRA-368) ----------------

const UNDEFINED_TABLE = '42P01';

export interface DirtyChat {
  conversationId: string;
  seenUpTo: string; // max(touched_at) read, text round-trips microseconds
}

/** Read without deleting: a crash before processing must not lose the signal. */
export async function listDirty(db: Db, account: string): Promise<DirtyChat[]> {
  try {
    const r = await db.query(
      `SELECT conversation_id, max(touched_at)::text AS upto
         FROM brain_window_dirty WHERE account = $1 GROUP BY conversation_id`,
      [account]
    );
    return r.rows.map(x => ({ conversationId: x.conversation_id, seenUpTo: x.upto }));
  } catch (e) {
    if ((e as { code?: string }).code === UNDEFINED_TABLE) return []; // INFRA-368 not deployed yet
    throw e;
  }
}

/** Only what was seen: a row touched while we were working stays for the next run. */
export async function clearDirty(db: Db, account: string, d: DirtyChat): Promise<void> {
  await db.query(
    `DELETE FROM brain_window_dirty
      WHERE account = $1 AND conversation_id = $2 AND touched_at <= $3::timestamptz`,
    [account, d.conversationId, d.seenUpTo]
  );
}

// ---- conversation + messages -----------------------------------------------

export async function conversationMeta(
  db: Db,
  account: string,
  conversationId: string,
  kinds: Record<string, ChatKind>
): Promise<ConversationMeta | null> {
  const r = await db.query(
    `SELECT c.name, c.type,
            (SELECT m.platform FROM messages m
              WHERE m.conversation_id = c.id AND m.account = $2 AND m.platform = ANY($3) LIMIT 1) AS platform
       FROM conversations c WHERE c.id::text = $1`,
    [conversationId, account, PLATFORMS]
  );
  const row = r.rows[0];
  if (!row || !row.platform) return null;
  return {
    platform: row.platform as Platform,
    account,
    conversationId,
    conversationName: row.name ?? null,
    isGroup: row.type === 'GROUP',
    kind: kinds[conversationId] ?? 'chat',
  };
}

export interface MsgKey {
  ts: number;
  id: string;
}

/**
 * One keyset page of a conversation ordered by (wa_timestamp ms, id).
 * `from` is inclusive (the anchor window's first message), `after` exclusive (paging).
 */
export async function fetchChatPage(
  db: Db,
  account: string,
  conversationId: string,
  opts: { fromTs: number | null; toTs?: number | null; after: MsgKey | null; limit: number }
): Promise<WindowMessage[]> {
  const r = await db.query(
    `SELECT id, ts, content, message_type, reply_to, sender FROM (
       SELECT m.id, ${TS_MS} AS ts, m.content, m.message_type,
              m.reply_to_message_id::text AS reply_to,
              COALESCE(NULLIF(btrim(p.name), ''), NULLIF(m.sender_wa_id, ''), '?') AS sender
         FROM messages m LEFT JOIN participants p ON p.id = m.sender_id
        WHERE m.account = $1 AND m.conversation_id::text = $2 AND m.platform = ANY($3) AND ${COUNTED}
     ) m
     WHERE ($4::bigint IS NULL OR m.ts >= $4::bigint)
       AND ($5::bigint IS NULL OR m.ts <= $5::bigint)
       AND ($6::bigint IS NULL OR (m.ts, m.id) > ($6::bigint, $7))
     ORDER BY m.ts, m.id LIMIT $8`,
    [
      account,
      conversationId,
      PLATFORMS,
      opts.fromTs,
      opts.toTs ?? null,
      opts.after?.ts ?? null,
      opts.after?.id ?? null,
      opts.limit,
    ]
  );
  return r.rows.map(x => ({
    id: String(x.id),
    ts: Number(x.ts),
    sender: String(x.sender),
    content: String(x.content),
    isVoice: VOICE_TYPES.includes(String(x.message_type).toUpperCase()),
    replyToId: x.reply_to ?? null,
  }));
}

/** Async stream over fetchChatPage. */
export async function* streamChat(
  db: Db,
  account: string,
  conversationId: string,
  fromTs: number | null,
  toTs: number | null = null,
  pageSize = 2_000
): AsyncGenerator<WindowMessage> {
  let after: MsgKey | null = null;
  for (;;) {
    const page = await fetchChatPage(db, account, conversationId, {
      fromTs,
      toTs,
      after,
      limit: pageSize,
    });
    for (const m of page) yield m;
    if (page.length < pageSize) return;
    const last = page[page.length - 1];
    after = { ts: last.ts, id: last.id };
  }
}

// ---- window state ----------------------------------------------------------

const toRow = (x: Record<string, any>): StateRow => ({
  windowId: x.window_id,
  account: x.account,
  platform: x.platform,
  conversationId: x.conversation_id,
  firstMsgId: x.first_msg_id,
  lastMsgId: x.last_msg_id,
  startTs: Number(x.start_ms),
  endTs: Number(x.end_ms),
  msgCount: x.msg_count,
  windowHash: x.window_hash,
  kind: x.kind,
  pushedHash: x.pushed_hash,
  llmStatus: x.llm_status,
  llmInputHash: x.llm_input_hash,
  llmJson: x.llm_json,
  packetHash: x.packet_hash,
  pushError: x.push_error,
});

const SELECT_STATE = `SELECT *, (extract(epoch from start_ts) * 1000)::bigint AS start_ms,
                              (extract(epoch from end_ts) * 1000)::bigint AS end_ms
                        FROM brain_window_state`;

/** Start of the last known window that begins at or before `ts`, else null (= from the start). */
export async function anchorBefore(
  db: Db,
  account: string,
  conversationId: string,
  ts: number
): Promise<number | null> {
  const r = await db.query(
    `SELECT (extract(epoch from max(start_ts)) * 1000)::bigint AS ms FROM brain_window_state
      WHERE account = $1 AND conversation_id = $2 AND start_ts <= to_timestamp($3::float8 / 1000)`,
    [account, conversationId, ts]
  );
  return r.rows[0]?.ms == null ? null : Number(r.rows[0].ms);
}

export async function windowsFrom(
  db: Db,
  account: string,
  conversationId: string,
  fromTs: number | null
): Promise<StateRow[]> {
  const r = await db.query(
    `${SELECT_STATE}
      WHERE account = $1 AND conversation_id = $2
        AND ($3::float8 IS NULL OR start_ts >= to_timestamp($3::float8 / 1000))
      ORDER BY start_ts`,
    [account, conversationId, fromTs]
  );
  return r.rows.map(toRow);
}

export async function getWindow(db: Db, windowId: string): Promise<StateRow | null> {
  const r = await db.query(`${SELECT_STATE} WHERE window_id = $1`, [windowId]);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

export async function pendingLlm(
  db: Db,
  account: string,
  limit: number | null
): Promise<StateRow[]> {
  const r = await db.query(
    `${SELECT_STATE} WHERE account = $1 AND llm_status = 'pending' AND push_error IS NULL AND pushed_hash = window_hash
      ORDER BY end_ts DESC
      ${limit ? 'LIMIT $2' : ''}`,
    limit ? [account, limit] : [account]
  );
  return r.rows.map(toRow);
}

export async function upsertWindow(db: Db, s: StateRow & { pushed?: boolean }): Promise<void> {
  await db.query(
    `INSERT INTO brain_window_state
       (window_id, account, platform, conversation_id, first_msg_id, last_msg_id, start_ts, end_ts,
        msg_count, window_hash, kind, pushed_hash, pushed_at, llm_status, llm_input_hash, llm_json,
        packet_hash, push_error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7::float8/1000),to_timestamp($8::float8/1000),
             $9,$10,$11,$12, CASE WHEN $18::boolean THEN now() END, $13,$14,$15::jsonb,$16,$17, now())
     ON CONFLICT (window_id) DO UPDATE SET
       last_msg_id = EXCLUDED.last_msg_id, start_ts = EXCLUDED.start_ts, end_ts = EXCLUDED.end_ts,
       msg_count = EXCLUDED.msg_count, window_hash = EXCLUDED.window_hash, kind = EXCLUDED.kind,
       pushed_hash = EXCLUDED.pushed_hash,
       pushed_at = CASE WHEN $18::boolean THEN now() ELSE brain_window_state.pushed_at END,
       llm_status = EXCLUDED.llm_status, llm_input_hash = EXCLUDED.llm_input_hash,
       llm_json = EXCLUDED.llm_json, packet_hash = EXCLUDED.packet_hash,
       push_error = EXCLUDED.push_error, updated_at = now()`,
    [
      s.windowId,
      s.account,
      s.platform,
      s.conversationId,
      s.firstMsgId,
      s.lastMsgId,
      s.startTs,
      s.endTs,
      s.msgCount,
      s.windowHash,
      s.kind,
      s.pushedHash,
      s.llmStatus,
      s.llmInputHash,
      s.llmJson == null ? null : JSON.stringify(s.llmJson),
      s.packetHash,
      s.pushError,
      s.pushed === true,
    ]
  );
}

export async function deleteWindows(db: Db, windowIds: string[]): Promise<void> {
  if (!windowIds.length) return;
  await db.query(`DELETE FROM brain_window_state WHERE window_id = ANY($1)`, [windowIds]);
}

/** Type guard for pools passed where a Db is expected. */
export const asDb = (p: Pool | PoolClient): Db => p as unknown as Db;
