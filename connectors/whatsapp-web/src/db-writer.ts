/**
 * Direct DB writer for WhatsApp messages.
 * Writes incoming messages directly to PostgreSQL, bypassing NATS/MCP.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { WhatsAppCustomerAllowlistStatus, WhatsAppCustomerTokenStatus } from './contact-sync';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://whatsappmcp:whatsappmcp_dgx_2026@postgres:5432/whatsappmcp';

// Which WhatsApp account this connector instance serves. 'personal' keeps ids
// bare (compat with the pre-existing single-account corpus); 'professional'
// namespaces conversation/participant ids with a "professional:" prefix so the
// two accounts can coexist in the same Postgres without colliding on PKs.
// Read at call time (not captured at module load) so the value is honoured even
// if the env is set after import — and so tests can exercise both accounts.
export function connectorAccount(): string {
  const account = process.env.CONNECTOR_ACCOUNT || 'personal';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(account)) throw new Error('Invalid CONNECTOR_ACCOUNT');
  const file = process.env.SOCIAL_ACCOUNTS_FILE;
  const accounts = file
    ? JSON.parse(readFileSync(file, 'utf8'))
    : [
        { channel: 'whatsapp', accountId: 'personal', enabled: true },
        { channel: 'whatsapp', accountId: 'professional', enabled: true },
      ];
  if (
    !Array.isArray(accounts) ||
    !accounts.some(
      entry => entry.channel === 'whatsapp' && entry.accountId === account && entry.enabled === true
    )
  )
    throw new Error(`WhatsApp account is unknown or disabled: ${account}`);
  return account;
}

/**
 * Namespace an id by account (idempotent). Mirrors mcp-server domain/account.ts.
 *
 * IMPORTANT: every writer that references conversations.id / participants.id MUST
 * route the id through this helper. `conversations` and `participants` rows are
 * stored under the namespaced id (e.g. `professional:34600...`), so any FK that
 * points at them (`conversation_participants`, `whatsapp_message_keys`,
 * `messages`) has to use the SAME namespaced id — otherwise the FK target row
 * does not exist and Postgres rejects the insert. For `personal` this is a no-op
 * (bare == namespaced), which is why the personal account never hit the bug.
 */
export function accountKey(id: string): string {
  const account = connectorAccount();
  if (account === 'personal') return id;
  const prefix = `${account}:`;
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

/**
 * Inverse of accountKey: strip the account prefix off a (possibly namespaced)
 * id, recovering the bare value. Idempotent and a no-op on `personal` and on an
 * already-bare id. Use this when an id read back from the DB (stored namespaced)
 * must be handed to an external system that only knows the bare WhatsApp id —
 * e.g. a WAMessageKey passed to sock.readMessages, or a keyCache lookup keyed by
 * the raw Baileys message id.
 */
export function stripAccountKey(id: string): string {
  const account = connectorAccount();
  if (account === 'personal') return id;
  const prefix = `${account}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

let pool: pg.Pool | null = null;
let allowlistTableReady = false;
let manualOpenTableReady = false;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
    pool.on('error', error => {
      console.error('PostgreSQL idle client error:', error);
    });
  }
  return pool;
}

export interface MessageData {
  waMessageId: string;
  conversationId: string;
  senderWaId: string;
  waTimestamp: Date;
  direction: string;
  content: string | null;
  messageType: string;
  isForwarded: boolean;
  replyToWaId?: string;
  platform?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationData {
  id: string;
  name: string;
  isGroup: boolean;
  participantCount: number;
  avatarUrl?: string;
}

export interface ParticipantData {
  id: string;
  phone?: string;
  name?: string;
  pushName?: string;
  profilePicUrl?: string;
}

export interface ConversationNameOptions {
  /** Saved address-book/group names may replace an existing useful title. */
  authoritative?: boolean;
}

function jidAliases(id: string): string[] {
  const aliases = new Set([id]);
  if (id.endsWith('@c.us')) aliases.add(id.replace(/@c\.us$/, '@s.whatsapp.net'));
  if (id.endsWith('@s.whatsapp.net')) aliases.add(id.replace(/@s\.whatsapp\.net$/, '@c.us'));
  return Array.from(aliases);
}

/** Resolve a PN chat only when one LID conversation in this account owns it. */
export async function canonicalConversationId(id: string): Promise<string> {
  const bare = stripAccountKey(id);
  if (!/^\d+(?:\.\d+)?@(?:c\.us|s\.whatsapp\.net)$/.test(bare)) return bare;
  const aliases = jidAliases(bare).map(accountKey);
  const result = await getPool().query(
    `SELECT id FROM conversations
      WHERE account = $1 AND COALESCE(is_group, false) = false
        AND id LIKE '%@lid' AND wa_chat_id = ANY($2::text[])
      LIMIT 2`,
    [connectorAccount(), aliases]
  );
  if (result.rows.length !== 1 || typeof result.rows[0].id !== 'string') return bare;
  const canonical = stripAccountKey(result.rows[0].id);
  return canonical.endsWith('@lid') ? canonical : bare;
}

export interface MessageKeyData {
  waMessageId: string;
  conversationId: string;
  remoteJid: string;
  fromMe: boolean;
  participantJid?: string;
  messageTimestampMs: number;
}

export interface HistorySyncState {
  conversationId: string;
  oldestMessageId: string | null;
  oldestTimestamp: Date | null;
  newestTimestamp: Date | null;
  totalImported: number;
  status: string;
  lastError: string | null;
  updatedAt: Date;
}

export interface WhatsAppCustomerAllowlistData {
  phoneE164: string;
  waJid: string;
  shopifyCustomerId?: string | null;
  shop?: string | null;
  email?: string | null;
  displayName?: string | null;
  status: WhatsAppCustomerAllowlistStatus;
  tokenStatus: WhatsAppCustomerTokenStatus;
  lastProbeAt?: Date | null;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
}

export type WhatsAppManualOpenStatus =
  'pending' | 'processing' | 'opened' | 'sent' | 'cancelled' | 'failed';

export interface WhatsAppManualOpenRequestInput {
  phoneE164: string;
  waJid: string;
  displayName?: string | null;
  messageText?: string | null;
  manualOpenUrl: string;
  source?: string | null;
  sourceRef?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface WhatsAppManualOpenRequest {
  id: string;
  account: string;
  phoneE164: string;
  waJid: string;
  displayName: string | null;
  messageText: string;
  manualOpenUrl: string;
  source: string | null;
  sourceRef: string | null;
  idempotencyKey: string | null;
  status: WhatsAppManualOpenStatus;
  attemptCount: number;
  lastOpenedAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function mapManualOpenRequestRow(row: any): WhatsAppManualOpenRequest {
  return {
    id: row.id,
    account: row.account,
    phoneE164: row.phone_e164,
    waJid: row.wa_jid,
    displayName: row.display_name,
    messageText: row.message_text || '',
    manualOpenUrl: row.manual_open_url,
    source: row.source,
    sourceRef: row.source_ref,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    lastOpenedAt: row.last_opened_at ? row.last_opened_at.toISOString() : null,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    completedBy: row.completed_by,
    lastError: row.last_error,
    metadata: row.metadata || {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function ensureWhatsAppCustomerAllowlistTable(): Promise<void> {
  if (allowlistTableReady) return;
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_customer_allowlist (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account TEXT NOT NULL DEFAULT 'professional',
      phone_e164 TEXT NOT NULL,
      wa_jid TEXT NOT NULL,
      shopify_customer_id TEXT,
      shop TEXT,
      email TEXT,
      display_name TEXT,
      status TEXT NOT NULL CHECK (
        status IN (
          'ready',
          'seeded_missing_token',
          'not_on_whatsapp',
          'invalid_phone',
          'probe_failed'
        )
      ),
      token_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
        token_status IN (
          'unknown',
          'has_token',
          'missing_token',
          'not_on_whatsapp',
          'error'
        )
      ),
      last_probe_at TIMESTAMPTZ,
      last_error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (phone_e164 ~ '^\\+[0-9]{8,15}$')
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_customer_allowlist_account_phone
    ON whatsapp_customer_allowlist (account, phone_e164)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_customer_allowlist_shopify_customer
    ON whatsapp_customer_allowlist (shopify_customer_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_customer_allowlist_status
    ON whatsapp_customer_allowlist (account, status, updated_at DESC)
  `);
  allowlistTableReady = true;
}

export async function upsertWhatsAppCustomerAllowlist(
  data: WhatsAppCustomerAllowlistData
): Promise<void> {
  await ensureWhatsAppCustomerAllowlistTable();
  const pool = getPool();
  await pool.query(
    `INSERT INTO whatsapp_customer_allowlist (
       account, phone_e164, wa_jid, shopify_customer_id, shop, email,
       display_name, status, token_status, last_probe_at, last_error, metadata
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT (account, phone_e164) DO UPDATE SET
       wa_jid = EXCLUDED.wa_jid,
       shopify_customer_id = COALESCE(EXCLUDED.shopify_customer_id, whatsapp_customer_allowlist.shopify_customer_id),
       shop = COALESCE(EXCLUDED.shop, whatsapp_customer_allowlist.shop),
       email = COALESCE(EXCLUDED.email, whatsapp_customer_allowlist.email),
       display_name = COALESCE(EXCLUDED.display_name, whatsapp_customer_allowlist.display_name),
       status = EXCLUDED.status,
       token_status = EXCLUDED.token_status,
       last_probe_at = COALESCE(EXCLUDED.last_probe_at, whatsapp_customer_allowlist.last_probe_at),
       last_error = EXCLUDED.last_error,
       metadata = whatsapp_customer_allowlist.metadata || EXCLUDED.metadata,
       updated_at = now()`,
    [
      connectorAccount(),
      data.phoneE164,
      data.waJid,
      data.shopifyCustomerId || null,
      data.shop || null,
      data.email || null,
      data.displayName || null,
      data.status,
      data.tokenStatus,
      data.lastProbeAt || null,
      data.lastError || null,
      JSON.stringify(data.metadata || {}),
    ]
  );
}

export async function ensureWhatsAppManualOpenTable(): Promise<void> {
  if (manualOpenTableReady) return;
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_manual_open_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account TEXT NOT NULL DEFAULT 'professional',
      phone_e164 TEXT NOT NULL,
      wa_jid TEXT NOT NULL,
      display_name TEXT,
      message_text TEXT NOT NULL DEFAULT '',
      manual_open_url TEXT NOT NULL,
      source TEXT,
      source_ref TEXT,
      idempotency_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'opened', 'sent', 'cancelled', 'failed')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_opened_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      completed_by TEXT,
      last_error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (phone_e164 ~ '^\\+[0-9]{8,15}$')
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_manual_open_account_idempotency
    ON whatsapp_manual_open_requests (account, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_manual_open_status
    ON whatsapp_manual_open_requests (account, status, created_at ASC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_manual_open_phone
    ON whatsapp_manual_open_requests (account, phone_e164, created_at DESC)
  `);
  manualOpenTableReady = true;
}

export async function createWhatsAppManualOpenRequest(
  data: WhatsAppManualOpenRequestInput
): Promise<WhatsAppManualOpenRequest> {
  await ensureWhatsAppManualOpenTable();
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO whatsapp_manual_open_requests (
       account, phone_e164, wa_jid, display_name, message_text, manual_open_url,
       source, source_ref, idempotency_key, metadata, attempt_count
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,1)
     ON CONFLICT (account, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO UPDATE SET
       wa_jid = EXCLUDED.wa_jid,
       display_name = COALESCE(EXCLUDED.display_name, whatsapp_manual_open_requests.display_name),
       message_text = EXCLUDED.message_text,
       manual_open_url = EXCLUDED.manual_open_url,
       source = COALESCE(EXCLUDED.source, whatsapp_manual_open_requests.source),
       source_ref = COALESCE(EXCLUDED.source_ref, whatsapp_manual_open_requests.source_ref),
       status = CASE
         WHEN whatsapp_manual_open_requests.status IN ('sent', 'cancelled') THEN whatsapp_manual_open_requests.status
         ELSE 'pending'
       END,
       attempt_count = whatsapp_manual_open_requests.attempt_count + 1,
       last_error = NULL,
       metadata = whatsapp_manual_open_requests.metadata || EXCLUDED.metadata,
       updated_at = now()
     RETURNING *`,
    [
      connectorAccount(),
      data.phoneE164,
      data.waJid,
      data.displayName || null,
      data.messageText || '',
      data.manualOpenUrl,
      data.source || null,
      data.sourceRef || null,
      data.idempotencyKey || null,
      JSON.stringify(data.metadata || {}),
    ]
  );
  return mapManualOpenRequestRow(result.rows[0]);
}

export async function listWhatsAppManualOpenRequests(
  options: { status?: WhatsAppManualOpenStatus | 'all'; limit?: number } = {}
): Promise<WhatsAppManualOpenRequest[]> {
  await ensureWhatsAppManualOpenTable();
  const pool = getPool();
  const status = !options.status || options.status === 'all' ? null : options.status;
  const limit = Math.min(Math.max(Number(options.limit || 50), 1), 200);
  const result = await pool.query(
    `SELECT *
     FROM whatsapp_manual_open_requests
     WHERE account = $1
       AND ($2::text IS NULL OR status = $2)
     ORDER BY
       CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
       created_at ASC
     LIMIT $3`,
    [connectorAccount(), status, limit]
  );
  return result.rows.map(mapManualOpenRequestRow);
}

export async function updateWhatsAppManualOpenRequestStatus(
  id: string,
  status: WhatsAppManualOpenStatus,
  options: {
    completedBy?: string | null;
    lastError?: string | null;
    metadata?: Record<string, unknown>;
  } = {}
): Promise<WhatsAppManualOpenRequest | null> {
  await ensureWhatsAppManualOpenTable();
  const pool = getPool();
  const result = await pool.query(
    `UPDATE whatsapp_manual_open_requests
     SET status = $3,
         last_opened_at = CASE
           WHEN $3 = 'opened' THEN now()
           ELSE last_opened_at
         END,
         completed_at = CASE
           WHEN $3 IN ('sent', 'cancelled', 'failed') THEN now()
           ELSE completed_at
         END,
         completed_by = COALESCE($4, completed_by),
         last_error = $5,
         metadata = metadata || $6::jsonb,
         updated_at = now()
     WHERE account = $1
       AND id = $2
     RETURNING *`,
    [
      connectorAccount(),
      id,
      status,
      options.completedBy || null,
      options.lastError || null,
      JSON.stringify(options.metadata || {}),
    ]
  );
  return result.rows[0] ? mapManualOpenRequestRow(result.rows[0]) : null;
}

export async function ensureHistoryTables(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_message_keys (
      wa_message_id text PRIMARY KEY REFERENCES messages(wa_message_id) ON DELETE CASCADE,
      conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      remote_jid text NOT NULL,
      from_me boolean NOT NULL,
      participant_jid text,
      message_timestamp_ms bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_message_keys_conversation_oldest
    ON whatsapp_message_keys (conversation_id, message_timestamp_ms ASC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sync_state (
      conversation_id text PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      oldest_message_id text,
      oldest_timestamp timestamptz,
      newest_timestamp timestamptz,
      total_imported bigint NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'pending',
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_sync_state_status
    ON whatsapp_sync_state (status, updated_at DESC)
  `);
}

export async function ensureConversation(data: ConversationData): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO conversations (id, name, is_group, participant_count, avatar_url, last_message_at, account)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (id) DO UPDATE SET
       -- A missing Baileys contact name is represented by the JID. Keep a
       -- useful saved/group name, but allow a later real name to replace a
       -- placeholder from history sync.
       name = CASE
         WHEN EXCLUDED.name IS NULL OR btrim(EXCLUDED.name) = '' THEN conversations.name
         WHEN conversations.name IS NULL OR btrim(conversations.name) = '' THEN EXCLUDED.name
         WHEN conversations.name = conversations.id
           OR conversations.name = regexp_replace(conversations.id, '^[^:]+:', '')
           OR conversations.name LIKE '%@lid'
           OR conversations.name LIKE '%@c.us'
           OR conversations.name LIKE '%@s.whatsapp.net'
           OR conversations.name LIKE '%@g.us'
         THEN EXCLUDED.name
         ELSE conversations.name
       END,
       participant_count = EXCLUDED.participant_count,
       avatar_url = COALESCE(EXCLUDED.avatar_url, conversations.avatar_url),
       last_message_at = now(),
       updated_at = now()`,
    [
      accountKey(data.id),
      data.name,
      data.isGroup,
      data.participantCount,
      data.avatarUrl || null,
      connectorAccount(),
    ]
  );
}

export async function ensureEmptyConversation(id: string, name: string): Promise<void> {
  await getPool().query(
    `INSERT INTO conversations (id, name, is_group, participant_count, account)
     VALUES ($1, $2, false, 0, $3)
     ON CONFLICT (id) DO NOTHING`,
    [accountKey(id), name, connectorAccount()]
  );
}

export async function ensureParticipant(data: ParticipantData): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO participants (id, phone, name, push_name, profile_pic_url, last_seen, account)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (id) DO UPDATE SET
       -- name may be a phonebook value while push_name is the remote
       -- profile name. Preserve the former once it is known, but refresh a
       -- name that was only copied from an earlier push name.
       name = CASE
         WHEN EXCLUDED.name IS NULL OR btrim(EXCLUDED.name) = '' THEN participants.name
         WHEN participants.name IS NULL OR btrim(participants.name) = ''
           OR participants.name = participants.id
           OR participants.name = participants.push_name
           OR participants.name LIKE '%@lid'
           OR participants.name LIKE '%@c.us'
           OR participants.name LIKE '%@s.whatsapp.net'
         THEN EXCLUDED.name
         ELSE participants.name
       END,
       push_name = COALESCE(EXCLUDED.push_name, participants.push_name),
       profile_pic_url = COALESCE(EXCLUDED.profile_pic_url, participants.profile_pic_url),
       last_seen = now()`,
    [
      accountKey(data.id),
      data.phone,
      data.name,
      data.pushName,
      data.profilePicUrl || null,
      connectorAccount(),
    ]
  );
}

/** Force a contact event's useful name into an existing participant row. */
export async function setParticipantName(
  id: string,
  name: string,
  pushName?: string
): Promise<void> {
  const cleanName = name.trim();
  if (!id || !cleanName) return;
  const pool = getPool();
  await pool.query(
    `UPDATE participants
        SET name = $2,
            push_name = COALESCE(NULLIF($3, ''), push_name),
            last_seen = now()
      WHERE id = ANY($1::text[])
        AND account = $4`,
    [jidAliases(id).map(accountKey), cleanName, pushName?.trim() || '', connectorAccount()]
  );
}

/**
 * Persist a contact/group name without allowing an account or JID mismatch.
 * Both PN spellings are accepted because conversations store normalized
 * `@c.us` ids while `wa_chat_id` may retain Baileys' `@s.whatsapp.net` form.
 */
export async function setConversationName(
  id: string,
  name: string,
  options: ConversationNameOptions = {}
): Promise<void> {
  const cleanName = name.trim();
  if (!id || !cleanName) return;
  const pool = getPool();
  const bareIds = jidAliases(stripAccountKey(id));
  const scopedIds = bareIds.map(accountKey);
  const account = connectorAccount();
  const authoritative = options.authoritative !== false;
  await pool.query(
    `UPDATE conversations
        SET name = CASE
          WHEN $5::boolean
            OR conversations.name IS NULL
            OR btrim(conversations.name) = ''
            OR conversations.name = conversations.id
            OR conversations.name = regexp_replace(conversations.id, '^[^:]+:', '')
            OR conversations.name LIKE '%@lid'
            OR conversations.name LIKE '%@c.us'
            OR conversations.name LIKE '%@s.whatsapp.net'
            OR conversations.name LIKE '%@g.us'
          THEN $3
          ELSE conversations.name
        END,
        updated_at = now()
      WHERE account = $4
        AND (id = ANY($1::text[])
          OR wa_chat_id = ANY($2::text[])
          OR wa_chat_id = ANY($1::text[]))`,
    [scopedIds, bareIds, cleanName, account, authoritative]
  );
}

/**
 * Helper: persist a profile picture URL post-hoc. Use this when the avatar
 * is fetched async (after ensureConversation/ensureParticipant has already
 * inserted the row) so we don't block message ingest on the network call.
 */
export async function setConversationAvatar(id: string, avatarUrl: string): Promise<void> {
  const pool = getPool();
  // conversations.id is stored namespaced (see accountKey); route the caller's
  // bare id through it so the UPDATE matches the real row on professional.
  await pool.query(`UPDATE conversations SET avatar_url = $2, updated_at = now() WHERE id = $1`, [
    accountKey(id),
    avatarUrl,
  ]);
}

export async function setParticipantAvatar(id: string, profilePicUrl: string): Promise<void> {
  const pool = getPool();
  // participants.id is stored namespaced; namespace the id so the UPDATE is not
  // a silent no-op on the professional account.
  await pool.query(
    `UPDATE participants SET profile_pic_url = $2, last_seen = now() WHERE id = $1`,
    [accountKey(id), profilePicUrl]
  );
}

/**
 * Persist the phone-number chat id for a conversation (conversations.wa_chat_id).
 *
 * Context: WhatsApp's privacy migration moves 1:1 chats to LID-addressed
 * conversation ids (`...@lid`). The conversation PK (conversations.id) stays the
 * LID (namespaced) so we never re-key existing rows or break replica routing,
 * but the LID alone is useless to downstream consumers that need the real phone
 * (e.g. skirmshop-labels' opt-in poller). When Baileys hands us the alternate
 * phone-number JID for a LID chat, we record it here in the long-empty
 * `wa_chat_id` column as a side-channel — best effort, never a prerequisite for
 * message ingest.
 *
 * Invariant (PR #22): `conversations.wa_chat_id` is UNIQUE and every id that
 * references a conversation row is stored under the account-namespaced id. We
 * therefore route the value through the SAME `accountKey` helper as every other
 * conversation-scoped id, so the professional account cannot collide with a
 * personal row on the UNIQUE index and the namespacing stays internally
 * consistent. No-op (does not overwrite) once a non-null value exists.
 */
export async function setConversationWaChatId(id: string, waChatId: string): Promise<void> {
  if (!id || !waChatId) return;
  const bareId = stripAccountKey(id);
  const bareWaChatId = stripAccountKey(waChatId);
  if (!/^\d+@lid$/.test(bareId) || !/^\d+@(?:s\.whatsapp\.net|c\.us)$/.test(bareWaChatId)) return;
  const pool = getPool();
  const lidId = accountKey(bareId);
  const pnId = accountKey(bareWaChatId);
  const account = connectorAccount();
  const aliasIds = jidAliases(bareWaChatId).map(accountKey);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query(
      `SELECT wa_chat_id FROM conversations
        WHERE id = $1 AND account = $2 AND COALESCE(is_group, false) = false
        FOR UPDATE`,
      [lidId, account]
    );
    const current = target.rows[0]?.wa_chat_id;
    if (target.rows.length && (!current || current === lidId) && current !== pnId) {
      const occupied = await client.query(
        `SELECT id, account, is_group FROM conversations WHERE wa_chat_id = $1 FOR UPDATE`,
        [pnId]
      );
      const owner = occupied.rows[0];
      if (
        !owner ||
        (owner.account === account && owner.is_group !== true && aliasIds.includes(owner.id))
      ) {
        if (owner) {
          await client.query(
            `UPDATE conversations SET wa_chat_id = NULL, updated_at = now()
              WHERE id = $1 AND account = $2 AND wa_chat_id = $3
                AND COALESCE(is_group, false) = false`,
            [owner.id, account, pnId]
          );
        }
        await client.query(
          `UPDATE conversations SET wa_chat_id = $2, updated_at = now()
            WHERE id = $1 AND account = $3
              AND COALESCE(is_group, false) = false
              AND (wa_chat_id IS NULL OR wa_chat_id = '' OR wa_chat_id = id)`,
          [lidId, pnId, account]
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getConversationAvatar(id: string): Promise<string | null> {
  const pool = getPool();
  // SELECT against the namespaced id so professional reads its own row.
  const r = await pool.query(`SELECT avatar_url FROM conversations WHERE id = $1`, [
    accountKey(id),
  ]);
  return r.rows[0]?.avatar_url || null;
}

/**
 * Persist the delivery status of a message (pending/sent/delivered/read/failed/deleted).
 * Idempotent — no-op if the row doesn't exist yet. status_at bumps on every change.
 * Never downgrades (read > delivered > sent > pending).
 */
export async function setMessageStatus(waMessageId: string, status: string): Promise<void> {
  if (!waMessageId) return;
  const pool = getPool();
  const rank: Record<string, number> = { pending: 1, sent: 2, delivered: 3, read: 4 };
  // messages.wa_message_id is stored namespaced; route the bare id through
  // accountKey so the status UPDATE is not a silent no-op on professional.
  const wamId = accountKey(waMessageId);
  if (rank[status] != null) {
    await pool.query(
      `UPDATE messages SET status = $2, status_at = now()
       WHERE wa_message_id = $1
         AND $3::int > CASE status
              WHEN 'pending' THEN 1
              WHEN 'sent' THEN 2
              WHEN 'delivered' THEN 3
              WHEN 'read' THEN 4
              ELSE 0 END`,
      [wamId, status, rank[status]]
    );
  } else {
    // failed/deleted: overwrite regardless.
    await pool.query(
      status === 'deleted'
        ? `UPDATE messages SET status = $2, is_deleted = TRUE, deleted_at = now(), status_at = now() WHERE wa_message_id = $1`
        : `UPDATE messages SET status = $2, status_at = now() WHERE wa_message_id = $1`,
      [wamId, status]
    );
  }
}

/**
 * Persist the real unread badge + archived flag for a conversation.
 * No-op if the row doesn't exist yet (next message creates it). `archived`
 * is optional — pass undefined to leave the stored value untouched.
 */
export async function setConversationState(
  id: string,
  unreadCount: number,
  archived?: boolean
): Promise<void> {
  // conversations.id is stored namespaced; route the bare id through accountKey
  // so the state UPDATE is not a silent no-op on the professional account.
  const convId = accountKey(await canonicalConversationId(id));
  const account = connectorAccount();
  const bare = stripAccountKey(convId);
  const pnAliases = /^\d+(?:\.\d+)?@(?:c\.us|s\.whatsapp\.net)$/.test(bare)
    ? jidAliases(bare).map(accountKey)
    : [];
  await getPool().query(
    `UPDATE conversations SET
       unread_count = CASE WHEN id = $1 THEN $2 ELSE 0 END,
       archived = COALESCE($3::boolean, archived), updated_at = now()
     WHERE account = $4 AND (id = $1 OR id = ANY($5::text[]) OR id IN (
       SELECT pn.id FROM conversations lid
       JOIN conversations pn ON pn.account = lid.account
         AND COALESCE(pn.is_group, false) = false
         AND pn.id ~ '[0-9]+@(c\\.us|s\\.whatsapp\\.net)$'
         AND regexp_replace(pn.id, '@c\\.us$', '@s.whatsapp.net') =
             regexp_replace(lid.wa_chat_id, '@c\\.us$', '@s.whatsapp.net')
       WHERE lid.account = $4 AND lid.id = $1 AND lid.id ~ '@lid$'
         AND COALESCE(lid.is_group, false) = false
         AND (SELECT COUNT(*) FROM conversations other_lid
              WHERE other_lid.account = $4 AND other_lid.id ~ '@lid$'
                AND COALESCE(other_lid.is_group, false) = false
                AND regexp_replace(other_lid.wa_chat_id, '@c\\.us$', '@s.whatsapp.net') =
                    regexp_replace(lid.wa_chat_id, '@c\\.us$', '@s.whatsapp.net')) = 1
     ))`,
    [convId, Math.max(0, unreadCount | 0), archived ?? null, account, pnAliases]
  );
}

export interface ArchiveSnapshotChat {
  jid: string;
  aliases?: string[];
  name?: string;
  archived: boolean;
}

/** Apply a complete app-state snapshot atomically for this connector's account. */
export async function applyArchiveSnapshot(
  chats: ArchiveSnapshotChat[],
  startedAt: Date
): Promise<{ archived: number; created: number }> {
  if (!Number.isFinite(startedAt.getTime())) throw new Error('Invalid archive snapshot time');
  const account = connectorAccount();
  const archivedIds = Array.from(
    new Set(
      chats
        .filter(chat => chat.archived)
        .flatMap(chat => [chat.jid, ...(chat.aliases || [])])
        .filter(jid => /@(?:g\.us|c\.us|s\.whatsapp\.net|lid)$/.test(jid))
        .flatMap(jid => jidAliases(stripAccountKey(jid)))
        .flatMap(jid => [jid, accountKey(jid)])
    )
  );
  const db = await getPool().connect();
  let created = 0;
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1), $2)', [account, 20260923]);
    // Events written while the remote snapshot was being fetched must win.
    await db.query(
      `UPDATE conversations SET archived = false, updated_at = now()
       WHERE account = $1 AND archived = true AND updated_at <= $2
         AND id <> ALL($3::text[])
         AND (wa_chat_id IS NULL OR wa_chat_id <> ALL($3::text[]))`,
      [account, startedAt, archivedIds]
    );
    for (const chat of chats) {
      if (!chat.archived) continue;
      if (!/@(?:g\.us|c\.us|s\.whatsapp\.net|lid)$/.test(chat.jid)) {
        throw new Error('Invalid archive snapshot chat');
      }
      const bareIds = Array.from(
        new Set(
          [chat.jid, ...(chat.aliases || [])]
            .filter(jid => /@(?:g\.us|c\.us|s\.whatsapp\.net|lid)$/.test(jid))
            .flatMap(jid => jidAliases(stripAccountKey(jid)))
        )
      );
      const ids = Array.from(new Set([...bareIds.map(accountKey), ...bareIds]));
      const hint = chat.name?.trim();
      const usefulHint = hint && !/@(?:g\.us|c\.us|s\.whatsapp\.net|lid)$/.test(hint) ? hint : null;
      const updated = await db.query(
        `UPDATE conversations SET archived = true, updated_at = now()
         WHERE account = $1 AND (id = ANY($2::text[]) OR wa_chat_id = ANY($2::text[]))
           AND updated_at <= $3 RETURNING id`,
        [account, ids, startedAt]
      );
      if (usefulHint) {
        await db.query(
          `UPDATE conversations SET name = $3, updated_at = now()
           WHERE account = $1 AND (id = ANY($2::text[]) OR wa_chat_id = ANY($2::text[]))
             AND (name IS NULL OR btrim(name) = '' OR name = id
               OR name = regexp_replace(id, '^[^:]+:', '')
               OR name ~ '@(g\\.us|c\\.us|s\\.whatsapp\\.net|lid)$')`,
          [account, ids, usefulHint]
        );
      }
      if (updated.rowCount) continue;
      const existing = await db.query(
        `SELECT id FROM conversations WHERE account = $1
           AND (id = ANY($2::text[]) OR wa_chat_id = ANY($2::text[])) LIMIT 1`,
        [account, ids]
      );
      if (existing.rowCount) continue;
      const normalized = chat.jid.replace(/@s\.whatsapp\.net$/, '@c.us');
      const id = accountKey(normalized);
      const inserted = await db.query(
        `INSERT INTO conversations (id, name, is_group, participant_count, account, archived)
         VALUES ($1, COALESCE($2, (
           SELECT NULLIF(name, '') FROM whatsapp_contacts
           WHERE account = $3 AND jid = ANY($4::text[])
             AND name !~ '@(g\\.us|c\\.us|s\\.whatsapp\\.net|lid)$'
           LIMIT 1
         ), (
           SELECT NULLIF(name, '') FROM participants
           WHERE account = $3 AND id = ANY($4::text[])
             AND name !~ '@(g\\.us|c\\.us|s\\.whatsapp\\.net|lid)$'
           LIMIT 1
         ), $5), $6, 0, $3, true)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, usefulHint, account, ids, normalized, normalized.endsWith('@g.us')]
      );
      created += inserted.rowCount || 0;
    }
    await db.query('COMMIT');
    return { archived: chats.filter(chat => chat.archived).length, created };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export async function getParticipantAvatar(id: string): Promise<string | null> {
  const pool = getPool();
  // SELECT against the namespaced id so professional reads its own row.
  const r = await pool.query(`SELECT profile_pic_url FROM participants WHERE id = $1`, [
    accountKey(id),
  ]);
  return r.rows[0]?.profile_pic_url || null;
}

export async function storeMessage(data: MessageData): Promise<string | null> {
  const pool = getPool();
  try {
    const result = await pool.query(
      `INSERT INTO messages (wa_message_id, conversation_id, sender_wa_id, wa_timestamp, direction, content, message_type, is_forwarded, reply_to_message_id, platform, metadata, account)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (wa_message_id) DO NOTHING
       RETURNING id`,
      [
        accountKey(data.waMessageId),
        accountKey(data.conversationId),
        accountKey(data.senderWaId),
        data.waTimestamp,
        data.direction,
        data.content,
        data.messageType,
        data.isForwarded,
        data.replyToWaId ? accountKey(data.replyToWaId) : null,
        data.platform || 'whatsapp',
        JSON.stringify(data.metadata || {}),
        connectorAccount(),
      ]
    );
    return result.rows[0]?.id || null;
  } catch (e) {
    console.error('Failed to store message:', e);
    return null;
  }
}

export async function storeAttachment(
  messageId: string,
  attachment: {
    fileType: string;
    mimeType?: string;
    fileName?: string;
    fileSize?: number;
    fileUrl?: string;
    caption?: string;
  }
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO attachments (message_id, file_type, mime_type, file_name, file_size, file_url, caption)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      messageId,
      attachment.fileType,
      attachment.mimeType,
      attachment.fileName,
      attachment.fileSize,
      attachment.fileUrl,
      attachment.caption,
    ]
  );
}

export async function storeMessageKey(data: MessageKeyData): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO whatsapp_message_keys
       (wa_message_id, conversation_id, remote_jid, from_me, participant_jid, message_timestamp_ms)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (wa_message_id) DO UPDATE SET
       conversation_id = EXCLUDED.conversation_id,
       remote_jid = EXCLUDED.remote_jid,
       from_me = EXCLUDED.from_me,
       participant_jid = EXCLUDED.participant_jid,
       message_timestamp_ms = EXCLUDED.message_timestamp_ms,
       updated_at = now()`,
    [
      // wa_message_id FK -> messages.wa_message_id and conversation_id FK ->
      // conversations.id are both stored namespaced; the caller hands us bare
      // ids, so namespace them here to keep the FK targets resolvable.
      accountKey(data.waMessageId),
      accountKey(data.conversationId),
      data.remoteJid,
      data.fromMe,
      data.participantJid || null,
      data.messageTimestampMs,
    ]
  );
}

export async function recordHistorySyncProgress(data: {
  conversationId: string;
  oldestMessageId?: string | null;
  oldestTimestamp?: Date | null;
  newestTimestamp?: Date | null;
  insertedCount?: number;
  status?: string;
  lastError?: string | null;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO whatsapp_sync_state
       (conversation_id, oldest_message_id, oldest_timestamp, newest_timestamp, total_imported, status, last_error)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'pending'), $7)
     ON CONFLICT (conversation_id) DO UPDATE SET
       oldest_message_id = COALESCE(EXCLUDED.oldest_message_id, whatsapp_sync_state.oldest_message_id),
       oldest_timestamp = CASE
         WHEN EXCLUDED.oldest_timestamp IS NULL THEN whatsapp_sync_state.oldest_timestamp
         WHEN whatsapp_sync_state.oldest_timestamp IS NULL THEN EXCLUDED.oldest_timestamp
         ELSE LEAST(whatsapp_sync_state.oldest_timestamp, EXCLUDED.oldest_timestamp)
       END,
       newest_timestamp = CASE
         WHEN EXCLUDED.newest_timestamp IS NULL THEN whatsapp_sync_state.newest_timestamp
         WHEN whatsapp_sync_state.newest_timestamp IS NULL THEN EXCLUDED.newest_timestamp
         ELSE GREATEST(whatsapp_sync_state.newest_timestamp, EXCLUDED.newest_timestamp)
       END,
       total_imported = whatsapp_sync_state.total_imported + EXCLUDED.total_imported,
       status = COALESCE(EXCLUDED.status, whatsapp_sync_state.status),
       last_error = EXCLUDED.last_error,
       updated_at = now()`,
    [
      // whatsapp_sync_state.conversation_id FK -> conversations.id (namespaced).
      // accountKey is idempotent, so callers that already hold a namespaced id
      // (e.g. backfillHistory's loadOldest rows) are not double-prefixed.
      accountKey(data.conversationId),
      data.oldestMessageId || null,
      data.oldestTimestamp || null,
      data.newestTimestamp || null,
      data.insertedCount || 0,
      data.status || null,
      data.lastError || null,
    ]
  );
}

export async function getHistorySyncStatus(limit: number = 200): Promise<HistorySyncState[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT conversation_id, oldest_message_id, oldest_timestamp, newest_timestamp,
            total_imported, status, last_error, updated_at
     FROM whatsapp_sync_state s
     WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.id = s.conversation_id AND c.account = $2)
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit, connectorAccount()]
  );
  return r.rows.map(row => ({
    conversationId: row.conversation_id,
    oldestMessageId: row.oldest_message_id,
    oldestTimestamp: row.oldest_timestamp,
    newestTimestamp: row.newest_timestamp,
    totalImported: Number(row.total_imported || 0),
    status: row.status,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  }));
}

export async function linkParticipantToConversation(
  conversationId: string,
  participantId: string
): Promise<void> {
  const pool = getPool();
  // conversation_id FK -> conversations.id and participant_id FK -> participants.id.
  // Both parent rows are written under the account-namespaced id (see accountKey),
  // so the link row MUST reference the namespaced ids too. Without this the
  // professional account inserted bare ids here while conversations/participants
  // held `professional:`-prefixed ids -> conversation_participants_conversation_id_fkey
  // violation -> the whole message ingest aborted and nothing was persisted.
  const convId = accountKey(conversationId);
  const partId = accountKey(participantId);
  try {
    await pool.query(
      `INSERT INTO conversation_participants (conversation_id, participant_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [convId, partId]
    );
  } catch (e) {
    const err = e as { code?: string; constraint?: string; message?: string };
    // Re-throw with full context so the caller's structured log pins the exact
    // id/account that failed instead of an opaque FK string.
    throw new Error(
      `linkParticipantToConversation failed (account=${connectorAccount()}, ` +
        `conversation_id=${convId}, participant_id=${partId}, ` +
        `pgcode=${err.code ?? '?'}, constraint=${err.constraint ?? '?'}): ${err.message ?? e}`
    );
  }
}
