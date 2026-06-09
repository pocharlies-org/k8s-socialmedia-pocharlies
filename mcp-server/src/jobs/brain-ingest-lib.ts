import { Pool } from 'pg';

export const ACCOUNTS = ['personal', 'professional'] as const;
export type Account = (typeof ACCOUNTS)[number];
export type Platform = 'whatsapp' | 'telegram' | 'instagram';

export interface Cursor {
  last_created_at: string;
  last_id: string | null;
}

export interface Row {
  id: string;
  wa_message_id: string;
  content: string;
  platform: string;
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

export interface BrainDoc {
  source_id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface BrainPushConfig {
  brainUrl: string;
  apiKey?: string;
}

export function liveCursorTableName(): string {
  return 'brain_ingest_cursor';
}

export function replayCursorTableName(): string {
  return 'brain_ingest_replay_cursor';
}

function assertCursorTableName(table: string): void {
  if (!/^brain_ingest(_replay)?_cursor$/.test(table)) {
    throw new Error(`unsafe cursor table name: ${table}`);
  }
}

export function instanceForAccount(account: Account): string {
  return account === 'professional' ? 'skirmshop' : 'personal';
}

export function sourceId(platform: string, waMessageId: string): string {
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

export function adapterForPlatform(platform: string): string {
  const normalized = (platform || '').toLowerCase();
  if (normalized === 'telegram' || normalized === 'instagram') {
    return normalized;
  }
  return 'whatsapp';
}

export async function ensureLiveCursorTable(pool: Pool): Promise<void> {
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

export async function ensureReplayCursorTable(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS brain_ingest_replay_cursor (
       run_id           text NOT NULL,
       account          text NOT NULL,
       platform         text NOT NULL,
       last_created_at  timestamptz NOT NULL,
       last_id          bigint,
       updated_at       timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (run_id, account, platform)
     )`
  );
}

export async function getLiveCursor(pool: Pool, account: Account): Promise<Cursor | null> {
  const r = await pool.query(
    `SELECT last_created_at, last_id FROM brain_ingest_cursor WHERE account = $1`,
    [account]
  );
  if (r.rows.length === 0) return null;
  return { last_created_at: r.rows[0].last_created_at, last_id: r.rows[0].last_id };
}

export async function setLiveCursor(
  pool: Pool,
  account: Account,
  createdAt: Date | string,
  id: string | null
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

export async function getReplayCursor(
  pool: Pool,
  runId: string,
  account: Account,
  platformKey: string
): Promise<Cursor | null> {
  const r = await pool.query(
    `SELECT last_created_at, last_id
       FROM brain_ingest_replay_cursor
      WHERE run_id = $1 AND account = $2 AND platform = $3`,
    [runId, account, platformKey]
  );
  if (r.rows.length === 0) return null;
  return { last_created_at: r.rows[0].last_created_at, last_id: r.rows[0].last_id };
}

export async function setReplayCursor(
  pool: Pool,
  runId: string,
  account: Account,
  platformKey: string,
  createdAt: Date | string,
  id: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO brain_ingest_replay_cursor
       (run_id, account, platform, last_created_at, last_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (run_id, account, platform) DO UPDATE
       SET last_created_at = EXCLUDED.last_created_at,
           last_id = EXCLUDED.last_id,
           updated_at = now()`,
    [runId, account, platformKey, createdAt, id]
  );
}

export async function fetchBatch(
  pool: Pool,
  opts: {
    account: Account;
    cursor: Cursor;
    limit: number;
    platform?: Platform;
    until?: string;
  }
): Promise<Row[]> {
  const params: unknown[] = [opts.account, opts.cursor.last_created_at, opts.cursor.last_id];
  const conditions = [
    `m.account = $1`,
    `m.is_deleted = false`,
    `m.content IS NOT NULL AND btrim(m.content) <> ''`,
    `(m.created_at, m.id) > ($2::timestamptz, COALESCE($3::bigint, 0::bigint))`,
  ];
  if (opts.platform) {
    params.push(opts.platform);
    conditions.push(`m.platform = $${params.length}`);
  }
  if (opts.until) {
    params.push(opts.until);
    conditions.push(`m.created_at < $${params.length}::timestamptz`);
  }
  params.push(opts.limit);
  const limitParam = params.length;
  const r = await pool.query(
    `SELECT m.id, m.wa_message_id, m.content, m.platform, m.account, m.direction,
            m.message_type, m.metadata, m.wa_timestamp, m.created_at, m.sender_wa_id,
            m.conversation_id, c.name AS conversation_name
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE ${conditions.join('\n        AND ')}
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT $${limitParam}`,
    params
  );
  return r.rows as Row[];
}

export async function pushToBrain(
  config: BrainPushConfig,
  instance: string,
  adapter: string,
  documents: BrainDoc[]
): Promise<number> {
  const url = `${config.brainUrl.replace(/\/$/, '')}/instances/${instance}/push-ingest`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'X-API-Key': config.apiKey } : {}),
    },
    body: JSON.stringify({ adapter, documents }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `brain push-ingest ${instance}/${adapter} -> ${resp.status}: ${text.slice(0, 300)}`
    );
  }
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  return Number(body.chunks_ingested ?? 0);
}

export function toDoc(row: Row): BrainDoc {
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

export function groupDocsByAdapter(rows: Row[]): Map<string, BrainDoc[]> {
  const byPlatform = new Map<string, BrainDoc[]>();
  for (const row of rows) {
    const adapter = adapterForPlatform(row.platform);
    const arr = byPlatform.get(adapter) ?? [];
    arr.push(toDoc(row));
    byPlatform.set(adapter, arr);
  }
  return byPlatform;
}

export function safeCursorTableName(table: string): string {
  assertCursorTableName(table);
  return table;
}
