/**
 * The opt-in Idempotency-Key of the house connectors' send routes, read the
 * same way by WhatsApp (http.whatsapp-connector.send-idempotency.v1) and
 * Telegram (http.telegram-connector.send-idempotency.v1, DGX-1235 B2): header
 * `Idempotency-Key` and/or body field `idempotencyKey`, at most 200 characters.
 * Each connector keeps its own store and replay rules.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_BODY_FIELD = 'idempotencyKey';
const MAX_KEY_LENGTH = 200;

/**
 * The caller's idempotency key: header `Idempotency-Key` and/or body
 * `idempotencyKey`. Absent (or blank) → `{}`: the legacy, non-idempotent path.
 * Both given with different values, a non-string or an over-long key → error.
 */
export function readIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
  body: unknown
): { key?: string; error?: string } {
  const header = headers[IDEMPOTENCY_HEADER];
  const field =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)[IDEMPOTENCY_BODY_FIELD]
      : undefined;
  if (Array.isArray(header)) return { error: 'Idempotency-Key must be a single header' };
  if (field !== undefined && field !== null && typeof field !== 'string') {
    return { error: 'idempotencyKey must be a string' };
  }
  const fromHeader = header?.trim() || undefined;
  const fromBody = (typeof field === 'string' && field.trim()) || undefined;
  if (fromHeader && fromBody && fromHeader !== fromBody) {
    return { error: 'Idempotency-Key header and idempotencyKey body field differ' };
  }
  const key = fromHeader || fromBody;
  if (!key) return {};
  if (key.length > MAX_KEY_LENGTH) {
    return { error: `Idempotency-Key is longer than ${MAX_KEY_LENGTH} characters` };
  }
  return { key };
}
