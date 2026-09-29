/**
 * WhatsApp chat state (fase 3 / PR-5, mcp-server migration 012) — the DB side
 * of archive / pin / mute / read-unread, ported from the NAS fork's
 * upsertChatState and adapted to the multiaccount model.
 *
 * No chat-state table: the state lives on the conversation row, the
 * CANONICAL one — resolved by (account_id, external_id) following
 * merged_into, or through social_contact_aliases when only the alias jid is
 * known — and never on a tombstone:
 *  - archived      (existing column; also written by setConversationState)
 *  - unread_count  (existing; read → 0, marked unread → at least 1)
 *  - pinned_at     (012; NULL = not pinned)
 *  - muted + mute_until (012; muted with mute_until NULL = forever)
 *
 * Rules (same as message-reactions.ts):
 *  - the columns come from the migration, never from here. While pinned_at /
 *    muted / mute_until are missing (42703) a pin or mute is not recorded:
 *    logged once, re-probed every few minutes, archive / read unaffected;
 *  - only a client with `ingest` on calls in here: the per-sub pairing pool
 *    never writes.
 */
import { accountKey, getPool, stripAccountKey } from './db-writer';
import { whatsappAccountId } from './message-mutations';

const UNDEFINED_TABLE = '42P01';
const UNDEFINED_COLUMN = '42703';
const MISSING_COLUMNS_RECHECK_MS = 5 * 60 * 1000;
/** Tombstones chain at most this far (merges re-point to the live canonical). */
const MAX_MERGE_HOPS = 8;

/** A WhatsApp mute: until a time, or forever (until null). */
export interface MuteState {
  until: Date | null;
}

/** What one change sets; absent fields are left as they are. */
export interface ChatStatePatch {
  archived?: boolean;
  /** 'read' → unread_count 0; 'unread' → the "marked unread" dot, unread_count ≥ 1. */
  unread?: 'read' | 'unread';
  /** null = unpinned. */
  pinnedAt?: Date | null;
  /** null = unmuted. */
  mute?: MuteState | null;
}

export interface ChatState {
  archived: boolean;
  unreadCount: number;
  /** undefined while migration 012 is missing. */
  pinnedAt?: string | null;
  muted?: boolean;
  muteUntil?: string | null;
}

export interface CanonicalConversation {
  /** conversations.id (namespaced, opaque). */
  id: string;
  /** Bare jid of the canonical conversation (`…@c.us`, `…@lid`, `…@g.us`). */
  externalId: string;
}

let columnsMissingUntil = 0;
let missingColumnsLogged = false;

/** Test hook: forget the "columns missing" state between cases. */
export function resetChatStateForTests(): void {
  columnsMissingUntil = 0;
  missingColumnsLogged = false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pgCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** true → pin / mute columns known missing and the re-probe is not due yet. */
export function chatStateColumnsKnownMissing(): boolean {
  return columnsMissingUntil > Date.now();
}

function noteColumnsMissing(): void {
  columnsMissingUntil = Date.now() + MISSING_COLUMNS_RECHECK_MS;
  if (!missingColumnsLogged) {
    missingColumnsLogged = true;
    console.warn(
      'conversations.pinned_at / muted / mute_until do not exist yet (mcp-server migration 012 ' +
        'not applied): pin and mute go to WhatsApp but are not recorded'
    );
  }
}

function noteColumnsPresent(): void {
  if (missingColumnsLogged) {
    missingColumnsLogged = false;
    console.info('conversations pin / mute columns are available: chat state is recorded');
  }
  columnsMissingUntil = 0;
}

/**
 * The external ids a chat may be stored under: the connector writes
 * `@c.us`, the aliases of 008 carry both phone suffixes.
 */
export function externalIdCandidates(chatId: string): string[] {
  const bare = stripAccountKey(String(chatId || '').trim());
  if (!bare) return [];
  if (bare.endsWith('@s.whatsapp.net')) {
    return [bare.replace(/@s\.whatsapp\.net$/, '@c.us'), bare];
  }
  if (bare.endsWith('@c.us')) return [bare, bare.replace(/@c\.us$/, '@s.whatsapp.net')];
  return [bare];
}

/**
 * The live conversation a chat id stands for: its own row followed through
 * merged_into, else the canonical one of a (non-blocked) contact alias.
 * undefined when this account has no such conversation.
 */
export async function resolveCanonicalConversation(
  chatId: string
): Promise<CanonicalConversation | undefined> {
  const candidates = externalIdCandidates(chatId);
  if (!candidates.length) return undefined;
  const accountId = whatsappAccountId();
  const pool = getPool();
  const direct = await pool.query(
    `WITH RECURSIVE hop(id, external_id, merged_into, depth) AS (
       SELECT c.id, c.external_id, c.merged_into, 0
         FROM conversations c
        WHERE c.account_id = $1 AND c.external_id = ANY($2::text[])
       UNION ALL
       SELECT t.id, t.external_id, t.merged_into, h.depth + 1
         FROM hop h JOIN conversations t ON t.id = h.merged_into
        WHERE h.depth < $3
     )
     SELECT id, external_id FROM hop WHERE merged_into IS NULL ORDER BY depth LIMIT 1`,
    [accountId, candidates, MAX_MERGE_HOPS]
  );
  const row = direct.rows[0];
  if (row) return { id: String(row.id), externalId: String(row.external_id) };
  try {
    const alias = await pool.query(
      `SELECT c.id, c.external_id
         FROM social_contact_aliases a
         JOIN conversations c
           ON c.account_id = a.account_id AND c.external_id = a.canonical_external_id
        WHERE a.account_id = $1 AND a.alias_external_id = ANY($2::text[])
          AND a.evidence <> 'blocked' AND c.merged_into IS NULL
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT 1`,
      [accountId, candidates]
    );
    const hit = alias.rows[0];
    return hit ? { id: String(hit.id), externalId: String(hit.external_id) } : undefined;
  } catch (error) {
    if (pgCode(error) === UNDEFINED_TABLE) return undefined;
    throw error;
  }
}

/** Bare id of the newest message of a conversation of this account (for lastMessages). */
export async function latestMessageId(conversationId: string): Promise<string | undefined> {
  const result = await getPool().query(
    `SELECT m.wa_message_id
       FROM messages m
      WHERE m.conversation_id = $1 AND m.account_id = $2 AND m.platform = 'whatsapp'
      ORDER BY m.wa_timestamp DESC
      LIMIT 1`,
    [accountKey(conversationId), whatsappAccountId()]
  );
  const id = result.rows[0]?.wa_message_id;
  return id ? stripAccountKey(String(id)) : undefined;
}

function touchesNewColumns(patch: ChatStatePatch): boolean {
  return patch.pinnedAt !== undefined || patch.mute !== undefined;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function rowToState(row: Record<string, unknown>, withNewColumns: boolean): ChatState {
  const state: ChatState = {
    archived: !!row.archived,
    unreadCount: Math.max(0, Number(row.unread_count) || 0),
  };
  if (withNewColumns) {
    state.pinnedAt = iso(row.pinned_at);
    state.muted = !!row.muted;
    state.muteUntil = iso(row.mute_until);
  }
  return state;
}

/**
 * Apply a change to the canonical conversation row `conversationId`
 * (conversations.id). Returns the state after the write, or undefined when
 * nothing was written (unknown row, tombstone, or pin / mute while 012 is
 * missing). Throws only on unexpected DB errors.
 */
export async function writeChatState(
  conversationId: string,
  patch: ChatStatePatch
): Promise<ChatState | undefined> {
  const newColumns = touchesNewColumns(patch);
  if (newColumns && chatStateColumnsKnownMissing()) return undefined;
  const params: unknown[] = [accountKey(conversationId), whatsappAccountId()];
  const sets: string[] = ['updated_at = now()'];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (patch.archived !== undefined) sets.push(`archived = ${bind(patch.archived)}`);
  if (patch.unread === 'read') sets.push('unread_count = 0', 'unread_mentions = 0');
  if (patch.unread === 'unread') sets.push('unread_count = GREATEST(unread_count, 1)');
  if (patch.pinnedAt !== undefined) sets.push(`pinned_at = ${bind(patch.pinnedAt)}::timestamptz`);
  if (patch.mute !== undefined) {
    sets.push(`muted = ${bind(patch.mute !== null)}`);
    sets.push(`mute_until = ${bind(patch.mute?.until ?? null)}::timestamptz`);
  }
  // A readback that names the 012 columns only when they are known to exist
  // keeps archive / read working on a DB without the migration.
  const readNew = newColumns || !chatStateColumnsKnownMissing();
  const returning = readNew
    ? 'archived, unread_count, pinned_at, muted, mute_until'
    : 'archived, unread_count';
  const sql = `UPDATE conversations SET ${sets.join(', ')}
      WHERE id = $1 AND account_id = $2 AND merged_into IS NULL
      RETURNING ${returning}`;
  try {
    const result = await getPool().query(sql, params);
    if (readNew) noteColumnsPresent();
    const row = result.rows[0];
    return row ? rowToState(row, readNew) : undefined;
  } catch (error) {
    if (pgCode(error) !== UNDEFINED_COLUMN) throw error;
    noteColumnsMissing();
    if (newColumns) return undefined;
    // Archive / read on a DB without 012: same write, legacy readback.
    const result = await getPool().query(sql.replace(returning, 'archived, unread_count'), params);
    const row = result.rows[0];
    return row ? rowToState(row, false) : undefined;
  }
}

/**
 * A pin / mute the phone did (chats.update / chats.upsert / history): resolve
 * the canonical conversation of `jid` and record it there. Never throws;
 * returns whether a row was written.
 */
export async function recordInboundChatState(jid: string, patch: ChatStatePatch): Promise<boolean> {
  // Archive / unread of inbound events keep going through setConversationState.
  if (!touchesNewColumns(patch) || chatStateColumnsKnownMissing()) return false;
  try {
    const conversation = await resolveCanonicalConversation(jid);
    if (!conversation) return false;
    return !!(await writeChatState(conversation.id, patch));
  } catch (error) {
    console.warn(`chat state persist failed for ${jid}: ${describeError(error)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Baileys → patch. The shapes differ by source (see chats.update in
// Utils/chat-utils processSyncAction vs the history Conversation proto).
// ---------------------------------------------------------------------------

function numeric(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  const long = value as { toNumber?: () => number; low?: number; high?: number };
  if (typeof long.toNumber === 'function') return numeric(long.toNumber());
  if (typeof long.low === 'number') return (long.high || 0) * 2 ** 32 + (long.low >>> 0);
  return undefined;
}

/** WhatsApp timestamps come in seconds (proto) or ms (sync actions). */
function timestampToDate(value: number): Date {
  return new Date(value < 1e11 ? value * 1000 : value);
}

/**
 * Pin of a Baileys chat object: undefined when it says nothing, null when
 * unpinned, else the pin time (Baileys 7: a timestamp, null for an unpin).
 */
export function pinFromBaileys(chat: unknown): Date | null | undefined {
  if (!chat || typeof chat !== 'object' || !('pinned' in chat)) return undefined;
  const value = (chat as { pinned?: unknown }).pinned;
  if (value === null || value === false) return null;
  if (value === true) return new Date();
  const n = numeric(value);
  if (n === undefined || n < 0) return undefined;
  return n === 0 ? null : timestampToDate(n);
}

/**
 * Mute of a Baileys chat object (`muteEndTime`). In a chats.update from a
 * mute sync action null = unmuted and 0 / negative = forever (muted without
 * an end, or WhatsApp's -1); in a history / upsert snapshot 0 = not muted.
 */
export function muteFromBaileys(
  chat: unknown,
  source: 'sync-action' | 'snapshot'
): MuteState | null | undefined {
  if (!chat || typeof chat !== 'object' || !('muteEndTime' in chat)) return undefined;
  const value = (chat as { muteEndTime?: unknown }).muteEndTime;
  if (value === null || value === undefined) return source === 'sync-action' ? null : undefined;
  const n = numeric(value);
  if (n === undefined) return undefined;
  if (n < 0) return { until: null };
  if (n === 0) return source === 'sync-action' ? { until: null } : null;
  return { until: timestampToDate(n) };
}

/**
 * The value Baileys' chatModify({ mute }) takes: WhatsApp's muteEndTimestamp,
 * an absolute epoch in ms, or -1 for "always". (Baileys' docs call it a
 * duration; the protocol field is the end time.)
 */
export function muteEndTimestamp(mute: MuteState): number {
  return mute.until ? mute.until.getTime() : -1;
}
