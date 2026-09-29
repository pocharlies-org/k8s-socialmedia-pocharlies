/**
 * Retention of the connector's own bookkeeping tables (fase 3 / PR-2).
 *
 *  - whatsapp_send_attempts (migration 010): rows older than
 *    WA_SEND_ATTEMPT_RETENTION_DAYS (default 7) — the idempotency window: a key
 *    reused after it sends again;
 *  - whatsapp_message_payloads (migration 009, PR-1 shipped it without a purge):
 *    rows older than DURABLE_PAYLOAD_RETENTION_DAYS (default 90) by created_at.
 *    Quoting/forwarding a message older than that falls back to process memory.
 *
 * Opportunistic: `maybeRunRetention()` is called from the ingest path and runs
 * at most once per hour per process (the first one 5 minutes after start), in
 * the background, never overlapping.
 * Deletes go in batches of 5000 rows (ctid IN (SELECT … LIMIT)) with a cap per
 * run, scoped to this connector's account. A missing table is skipped (the
 * migration has not landed yet); 0 days disables a table's purge. The caller
 * only calls in here when `ingest` is on: the per-sub pairing pool never does.
 */
import { connectorAccount, getPool } from './db-writer';

export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** The first purge waits this long after start (not on the boot burst). */
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;
export const RETENTION_BATCH_SIZE = 5000;
const MAX_BATCHES_PER_TABLE = 20;
const DEFAULT_SEND_ATTEMPT_DAYS = 7;
const DEFAULT_PAYLOAD_DAYS = 90;
const UNDEFINED_TABLE = '42P01';

/** Tables purged here; the name is interpolated, so it is never caller input. */
type RetentionTable = 'whatsapp_send_attempts' | 'whatsapp_message_payloads';

let lastRunAt = Date.now() - RETENTION_INTERVAL_MS + FIRST_RUN_DELAY_MS;
let running: Promise<void> | null = null;

/** Test hook: the next maybeRunRetention() is due immediately. */
export function resetRetentionStateForTests(): void {
  lastRunAt = 0;
  running = null;
}

function envDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function sendAttemptRetentionDays(): number {
  return envDays('WA_SEND_ATTEMPT_RETENTION_DAYS', DEFAULT_SEND_ATTEMPT_DAYS);
}

export function payloadRetentionDays(): number {
  return envDays('DURABLE_PAYLOAD_RETENTION_DAYS', DEFAULT_PAYLOAD_DAYS);
}

export function purgeSql(table: RetentionTable): string {
  return `DELETE FROM ${table}
     WHERE ctid IN (
       SELECT ctid FROM ${table}
        WHERE account = $1 AND created_at < NOW() - make_interval(days => $2)
        LIMIT ${RETENTION_BATCH_SIZE})`;
}

/** Delete this account's rows older than `days`, batch by batch. Returns the count. */
export async function purgeTable(table: RetentionTable, days: number): Promise<number> {
  if (!(days > 0)) return 0;
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch++) {
    const result = await getPool().query(purgeSql(table), [connectorAccount(), days]);
    const deleted = result.rowCount || 0;
    total += deleted;
    if (deleted < RETENTION_BATCH_SIZE) break;
  }
  return total;
}

async function purgeQuietly(table: RetentionTable, days: number): Promise<void> {
  try {
    const deleted = await purgeTable(table, days);
    if (deleted) console.info(`retention: purged ${deleted} ${table} rows older than ${days}d`);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === UNDEFINED_TABLE) return;
    console.warn(
      `retention: ${table} purge failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function runRetention(): Promise<void> {
  await purgeQuietly('whatsapp_send_attempts', sendAttemptRetentionDays());
  await purgeQuietly('whatsapp_message_payloads', payloadRetentionDays());
}

/**
 * Start a purge in the background if none ran in the last hour. Returns the
 * running purge (tests await it); callers ignore it.
 */
export function maybeRunRetention(nowMs: number = Date.now()): Promise<void> | null {
  if (running || nowMs - lastRunAt < RETENTION_INTERVAL_MS) return null;
  lastRunAt = nowMs;
  running = runRetention().finally(() => {
    running = null;
  });
  return running;
}
