import pg from 'pg';

interface SendAttemptRow {
  request_hash: string;
  message_id: string;
  status: 'prepared' | 'pending' | 'sent' | 'failed';
  updated_at: Date | null;
  error: string | null;
}

/** In-memory equivalent of the account-scoped reservation/claim/confirmation table. */
export function installSendAttemptStore(
  options: {
    sentAt?: string;
    onQuery?: () => void;
  } = {}
) {
  const original = Object.getOwnPropertyDescriptor(pg.Pool.prototype, 'query');
  const rows = new Map<string, SendAttemptRow>();
  (pg.Pool.prototype as any).query = async (sql: string, params: string[] = []) => {
    options.onQuery?.();
    if (/CREATE TABLE|token_hash|sent_at/.test(sql)) {
      throw new Error('Connector must use the production migration 010 schema without DDL');
    }
    const key = `${params[0]}:${params[1]}`;
    if (sql.includes('INSERT INTO whatsapp_send_attempts')) {
      if (rows.has(key)) return { rowCount: 0, rows: [] };
      rows.set(key, {
        request_hash: params[2],
        message_id: params[3],
        status: 'prepared',
        updated_at: null,
        error: null,
      });
      return { rowCount: 1, rows: [{ message_id: params[3] }] };
    }
    const row = rows.get(key);
    if (sql.includes('SELECT request_hash'))
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    if (sql.includes('UPDATE whatsapp_send_attempts')) {
      if (!row) return { rowCount: 0, rows: [] };
      if (sql.includes("SET status = 'pending'")) {
        const fingerprint = /AND request_hash = \$3/.test(sql) ? row.request_hash : row.message_id;
        if (fingerprint !== params[2] || !['prepared', 'failed'].includes(row.status))
          return { rowCount: 0, rows: [] };
        row.status = 'pending';
        row.error = null;
        return { rowCount: 1, rows: [{ message_id: row.message_id }] };
      }
      if (/SET (?:status = 'failed', )?error = \$3/.test(sql)) {
        const claimed = !sql.includes("status = 'failed'");
        if (row.status !== (claimed ? 'pending' : 'prepared')) return { rowCount: 0, rows: [] };
        row.error = params[2];
        if (!claimed) row.status = 'failed';
        return { rowCount: 1, rows: [] };
      }
      if (row.status !== 'pending') return { rowCount: 0, rows: [] };
      row.status = 'sent';
      row.message_id = params[2] || row.message_id;
      row.updated_at = new Date(options.sentAt ?? '2026-01-01T00:00:00Z');
      return { rowCount: 1, rows: [{ updated_at: row.updated_at }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  return {
    rows,
    restore: () => {
      if (original) Object.defineProperty(pg.Pool.prototype, 'query', original);
      else Reflect.deleteProperty(pg.Pool.prototype, 'query');
    },
  };
}
