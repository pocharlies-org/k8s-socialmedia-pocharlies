import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { SocialAccount } from '../domain/account-registry';
import { unwrapAsrJson } from './voice-json-fix-lib';
import {
  HindsightClient,
  socialmediaChatTag,
  socialmediaDocumentId,
  socialmediaScopeTag,
} from '../infrastructure/hindsight-client';

export interface SyncOptions {
  batch: number;
  intervalMs: number;
  retryMs: number;
  since: string;
  chatIds: string[];
  loop: boolean;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

export function syncOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SyncOptions {
  const since = env.HINDSIGHT_SYNC_SINCE || '1970-01-01T00:00:00Z';
  if (!Number.isFinite(Date.parse(since))) throw new Error('HINDSIGHT_SYNC_SINCE is invalid');
  if (env.HINDSIGHT_SYNC_LOOP && !['true', 'false'].includes(env.HINDSIGHT_SYNC_LOOP)) {
    throw new Error('HINDSIGHT_SYNC_LOOP must be true or false');
  }
  return {
    batch: positiveInteger(env, 'HINDSIGHT_SYNC_BATCH', 100),
    intervalMs: positiveInteger(env, 'HINDSIGHT_SYNC_INTERVAL_MS', 30000),
    retryMs: positiveInteger(env, 'HINDSIGHT_SYNC_RETRY_MS', 30000),
    since: new Date(since).toISOString(),
    chatIds: (env.HINDSIGHT_SYNC_CHAT_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    loop: env.HINDSIGHT_SYNC_LOOP === 'true',
  };
}

export interface SyncScope {
  platform: string;
  namespace: string;
  provider_account: string | null;
  conversation_id: string;
  timestamp: string;
}

export interface SyncMessage {
  id: string;
  platform: string;
  account: string;
  conversation_id: string;
  wa_message_id: string;
  wa_timestamp: Date | string;
  content: string | null;
  sender_wa_id: string | null;
  direction: string;
  message_type: string;
  is_deleted: boolean;
  metadata: Record<string, unknown> | null;
}

export interface SyncPayload {
  documentId: string;
  content: string;
  metadata: Record<string, string>;
  tags: string[];
  timestamp: string;
  scope: SyncScope;
}

export interface SyncEntry {
  destination: string;
  messageId: string;
  sourceRevision: string;
  versionHash: string;
  selectionHash: string;
  operationId: string;
  payload: SyncPayload;
  isDeleted: boolean;
  status: 'pending' | 'accepted' | 'completed' | 'failed';
  attempts: number;
}

export function destinationKey(url: string, bankId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([url.replace(/\/+$/, ''), bankId]))
    .digest('hex');
}

/** Deterministic UUID per source revision: A -> B -> A must not reuse operation A. */
export function versionOperationId(
  destination: string,
  messageId: string,
  revision: string,
  hash: string,
  previousOperationId?: string
): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify([destination, messageId, revision, hash, previousOperationId || null]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function selectionHash(accounts: SocialAccount[], options: SyncOptions): string {
  const scopes = accounts
    .filter(a => a.enabled)
    .map(a => [a.channel, a.namespace, a.accountId])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256')
    .update(stableJson({ scopes, since: options.since, chatIds: [...options.chatIds].sort() }))
    .digest('hex');
}

export function messageScope(row: SyncMessage): SyncScope {
  return {
    platform: row.platform,
    namespace: row.account,
    // Instagram metadata is authoritative, including when it is absent.
    provider_account:
      row.platform === 'instagram'
        ? typeof row.metadata?.instagram_account === 'string'
          ? row.metadata.instagram_account
          : null
        : row.account,
    conversation_id: row.conversation_id,
    timestamp: new Date(row.wa_timestamp).toISOString(),
  };
}

export function scopeEnabled(scope: SyncScope, accounts: SocialAccount[]): boolean {
  return accounts.some(
    a =>
      a.enabled &&
      a.channel === scope.platform &&
      a.namespace === scope.namespace &&
      a.accountId === scope.provider_account
  );
}

export function buildSyncEntry(
  destination: string,
  messageId: string,
  revision: string,
  row: SyncMessage | null,
  scope: SyncScope,
  accounts: SocialAccount[],
  options: SyncOptions,
  previousOperationId?: string
): SyncEntry {
  const eligible =
    row &&
    scopeEnabled(scope, accounts) &&
    Date.parse(scope.timestamp) >= Date.parse(options.since) &&
    (!options.chatIds.length || options.chatIds.includes(scope.conversation_id));
  const isDeleted =
    !eligible ||
    Boolean(row?.is_deleted) ||
    row?.metadata?.deleted_for_me === true ||
    !row?.content?.trim();
  const sender = row?.sender_wa_id || row?.direction || 'unknown';
  // Preserve original message text and time; Hindsight performs its own extraction.
  const text = row?.content ? (unwrapAsrJson(row.content) ?? row.content) : '';
  const content = isDeleted ? '' : `[${scope.timestamp}] ${sender}: ${text}`;
  const metadata: Record<string, string> = {
    platform: scope.platform,
    namespace: scope.namespace,
    provider_account: scope.provider_account || '',
    conversation_id: scope.conversation_id,
    message_id: messageId,
    source_message_id: row?.wa_message_id || '',
    sender,
    direction: row?.direction || '',
    message_type: row?.message_type || '',
    sender_name: typeof row?.metadata?.sender_name === 'string' ? row.metadata.sender_name : '',
  };
  const payload: SyncPayload = {
    documentId: socialmediaDocumentId(messageId),
    content,
    metadata,
    tags: isDeleted
      ? []
      : [
          socialmediaScopeTag(scope.platform, scope.namespace, scope.provider_account || ''),
          socialmediaChatTag(scope.conversation_id),
        ],
    timestamp: scope.timestamp,
    scope,
  };
  const versionHash = createHash('sha256').update(stableJson({ payload, isDeleted })).digest('hex');
  return {
    destination,
    messageId,
    sourceRevision: revision,
    versionHash,
    selectionHash: selectionHash(accounts, options),
    operationId: versionOperationId(
      destination,
      messageId,
      revision,
      versionHash,
      previousOperationId
    ),
    payload,
    isDeleted,
    status: 'pending',
    attempts: 0,
  };
}

export type SyncClient = Pick<
  HindsightClient,
  'getOperation' | 'retryOperation' | 'retainDocument' | 'deleteDocument'
>;
export type SaveEntry = (entry: SyncEntry, delayMs: number) => Promise<void>;

/** Reconcile before resubmitting, including after a lost HTTP acknowledgement. */
export async function advanceSyncEntry(
  entry: SyncEntry,
  client: SyncClient,
  save: SaveEntry,
  retryMs: number
): Promise<SyncEntry['status']> {
  if (entry.status === 'completed') return entry.status;
  try {
    if (entry.isDeleted) {
      await client.deleteDocument(entry.payload.documentId);
      entry.status = 'completed';
    } else {
      const operation = await client.getOperation(entry.operationId);
      if (operation.status === 'completed') {
        entry.status = 'completed';
      } else if (operation.status === 'failed' || operation.status === 'cancelled') {
        await client.retryOperation(entry.operationId);
        entry.status = 'accepted';
        entry.attempts++;
      } else if (operation.status === 'not_found') {
        await client.retainDocument({ ...entry.payload, operationId: entry.operationId });
        entry.status = 'accepted';
        entry.attempts++;
      } else {
        entry.status = 'accepted';
      }
    }
  } catch (error) {
    entry.status = 'failed';
    entry.attempts++;
    await save(entry, retryMs);
    throw error;
  }
  await save(entry, entry.status === 'completed' ? 0 : retryMs);
  return entry.status;
}

export async function saveSyncEntry(
  db: PoolClient,
  entry: SyncEntry,
  delayMs: number
): Promise<void> {
  await db.query(
    `INSERT INTO hindsight_sync_ledger
    (destination,message_id,source_revision,version_hash,operation_id,payload,is_deleted,status,attempts,retry_at,indexed_at,selection_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+($10::double precision * interval '1 millisecond'),
      CASE WHEN $8='completed' THEN now() END,$11)
    ON CONFLICT (destination,message_id) DO UPDATE SET
      source_revision=EXCLUDED.source_revision,version_hash=EXCLUDED.version_hash,
      operation_id=EXCLUDED.operation_id,payload=EXCLUDED.payload,is_deleted=EXCLUDED.is_deleted,
      selection_hash=EXCLUDED.selection_hash,
      status=EXCLUDED.status,attempts=EXCLUDED.attempts,retry_at=EXCLUDED.retry_at,
      indexed_at=EXCLUDED.indexed_at,updated_at=now()`,
    [
      entry.destination,
      entry.messageId,
      entry.sourceRevision,
      entry.versionHash,
      entry.operationId,
      JSON.stringify(entry.payload),
      entry.isDeleted,
      entry.status,
      entry.attempts,
      delayMs,
      entry.selectionHash,
    ]
  );
}

export async function seedHistoryBatch(
  db: PoolClient,
  destination: string,
  batch: number
): Promise<void> {
  // Keep cursor and queue insert atomic; live triggers win ON CONFLICT.
  await db.query('BEGIN');
  try {
    await db.query(
      'INSERT INTO hindsight_sync_destinations(destination) VALUES($1) ON CONFLICT DO NOTHING',
      [destination]
    );
    const state = await db.query(
      'SELECT * FROM hindsight_sync_destinations WHERE destination=$1 FOR UPDATE',
      [destination]
    );
    if (!state.rows[0].seeded) {
      const rows = await db.query(
        `SELECT id::text AS id FROM messages
        WHERE ($1::text IS NULL OR id > $1::uuid) ORDER BY id LIMIT $2`,
        [state.rows[0].seed_last_id, batch]
      );
      if (rows.rows.length) {
        await db.query(
          `INSERT INTO hindsight_sync_changes(message_id,scope)
          SELECT id::text,jsonb_build_object('platform',platform,'namespace',account,
            'provider_account',CASE WHEN platform='instagram' THEN metadata->>'instagram_account' ELSE account END,
            'conversation_id',conversation_id,'timestamp',wa_timestamp)
          FROM messages WHERE id=ANY($1::uuid[]) ON CONFLICT DO NOTHING`,
          [rows.rows.map(r => r.id)]
        );
      }
      await db.query(
        `UPDATE hindsight_sync_destinations SET seed_last_id=COALESCE($2,seed_last_id),seeded=$3
        WHERE destination=$1`,
        [destination, rows.rows.at(-1)?.id || null, rows.rows.length < batch]
      );
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

interface Candidate {
  message_id: string;
  revision: string;
  scope: SyncScope;
  message: SyncMessage | null;
  ledger: {
    destination: string;
    message_id: string;
    source_revision: string;
    version_hash: string;
    selection_hash: string;
    operation_id: string;
    payload: SyncPayload;
    is_deleted: boolean;
    status: SyncEntry['status'];
    attempts: number;
  } | null;
}

export async function fetchSyncCandidates(
  db: PoolClient,
  destination: string,
  accounts: SocialAccount[],
  options: SyncOptions
): Promise<Candidate[]> {
  const scopes = accounts
    .filter(a => a.enabled)
    .map(a => ({ platform: a.channel, namespace: a.namespace, provider_account: a.accountId }));
  const result = await db.query(
    `SELECT c.message_id,c.revision::text,c.scope,
    CASE WHEN m.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id',m.id,'platform',m.platform,'account',m.account,'conversation_id',m.conversation_id,
      'wa_message_id',m.wa_message_id,'wa_timestamp',m.wa_timestamp,'content',m.content,
      'sender_wa_id',m.sender_wa_id,'direction',m.direction,'message_type',m.message_type,
      'is_deleted',m.is_deleted,'metadata',m.metadata) END AS message,
    CASE WHEN l.message_id IS NULL THEN NULL ELSE to_jsonb(l) END AS ledger
    FROM hindsight_sync_changes c LEFT JOIN messages m ON m.id=c.message_id::uuid
    LEFT JOIN hindsight_sync_ledger l ON l.destination=$1 AND l.message_id=c.message_id
    WHERE (l.source_revision IS DISTINCT FROM c.revision OR l.status <> 'completed' OR l.selection_hash <> $6)
      AND (l.message_id IS NULL OR l.status='completed' OR l.retry_at<=now())
      AND (l.message_id IS NOT NULL OR EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb)
        AS s(platform text, namespace text, provider_account text)
        WHERE (c.scope->>'platform'=s.platform AND c.scope->>'namespace'=s.namespace
          AND c.scope->>'provider_account'=s.provider_account)
        OR (l.payload->'scope'->>'platform'=s.platform AND l.payload->'scope'->>'namespace'=s.namespace
          AND l.payload->'scope'->>'provider_account'=s.provider_account)))
      AND (l.message_id IS NOT NULL OR ((c.scope->>'timestamp')::timestamptz >= $3::timestamptz
        AND (cardinality($4::text[])=0 OR c.scope->>'conversation_id'=ANY($4::text[]))))
    ORDER BY c.revision LIMIT $5`,
    [
      destination,
      JSON.stringify(scopes),
      options.since,
      options.chatIds,
      options.batch,
      selectionHash(accounts, options),
    ]
  );
  return result.rows;
}

export interface SyncPassResult {
  selected: number;
  accepted: number;
  completed: number;
  failed: number;
}

/** Count provider outcomes while keeping persistence errors fatal for the pass. */
export async function advanceAndCount<Entry, Status extends string>(
  entry: Entry,
  advance: (entry: Entry, save: (value: Entry, delay: number) => Promise<void>) => Promise<Status>,
  save: (value: Entry, delay: number) => Promise<void>,
  result: SyncPassResult
): Promise<void> {
  let persistenceFailed = false;
  try {
    const status = await advance(entry, async (value, delay) => {
      try {
        await save(value, delay);
      } catch (error) {
        persistenceFailed = true;
        throw error;
      }
    });
    if (status === 'completed') result.completed++;
    else result.accepted++;
  } catch (error) {
    if (persistenceFailed) throw error;
    result.failed++;
  }
}

export async function runSyncPass(
  db: PoolClient,
  client: SyncClient,
  destination: string,
  accounts: SocialAccount[],
  options: SyncOptions
): Promise<SyncPassResult> {
  await seedHistoryBatch(db, destination, options.batch);
  const candidates = await fetchSyncCandidates(db, destination, accounts, options);
  const result: SyncPassResult = {
    selected: candidates.length,
    accepted: 0,
    completed: 0,
    failed: 0,
  };
  for (const candidate of candidates) {
    const l = candidate.ledger;
    // Finish the durable submitted snapshot before advancing to newer source data.
    const entry: SyncEntry =
      l && l.status !== 'completed'
        ? {
            destination: l.destination,
            messageId: l.message_id,
            sourceRevision: String(l.source_revision),
            versionHash: l.version_hash,
            selectionHash: l.selection_hash,
            operationId: l.operation_id,
            payload: l.payload,
            isDeleted: l.is_deleted,
            status: l.status,
            attempts: l.attempts,
          }
        : buildSyncEntry(
            destination,
            candidate.message_id,
            String(candidate.revision),
            candidate.message,
            candidate.message ? messageScope(candidate.message) : candidate.scope,
            accounts,
            options,
            l?.operation_id
          );
    if (l?.status === 'completed' && l.version_hash === entry.versionHash) {
      entry.status = 'completed';
      entry.operationId = l.operation_id;
      await saveSyncEntry(db, entry, 0);
      result.completed++;
      continue;
    }
    if (!l || l.status === 'completed') await saveSyncEntry(db, entry, 0);
    await advanceAndCount(
      entry,
      (value, save) => advanceSyncEntry(value, client, save, options.retryMs),
      (value, delay) => saveSyncEntry(db, value, delay),
      result
    );
  }
  return result;
}
