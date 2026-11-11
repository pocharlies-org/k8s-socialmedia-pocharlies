type Rows = Record<string, unknown>[];

/**
 * The route of a stubbed pg.Pool#query for whatsapp_send_attempts as the connector drives it
 * (migration 010): prepared → pending → sent. A failure after the claim leaves the row pending.
 */
export function sendAttemptsRoute(): (sql: string, params: unknown[]) => Rows {
  const attempts = new Map<string, { request_hash: string; message_id: string; status: string }>();
  return (sql, params) => {
    const key = `${String(params[0])}:${String(params[1])}`;
    if (/INSERT INTO whatsapp_send_attempts/.test(sql)) {
      if (attempts.has(key)) return [];
      attempts.set(key, {
        request_hash: String(params[2]),
        message_id: String(params[3]),
        status: 'prepared',
      });
      return [{ message_id: params[3] }];
    }
    const row = attempts.get(key);
    if (/SELECT request_hash/.test(sql)) return row ? [{ ...row, updated_at: new Date(5) }] : [];
    if (/SET status = 'pending'/.test(sql) && row?.status === 'prepared') {
      row.status = 'pending';
      return [{ message_id: row.message_id }];
    }
    if (/SET status = 'sent'/.test(sql) && row?.status === 'pending') {
      row.status = 'sent';
      return [{ updated_at: new Date(5) }];
    }
    return [];
  };
}
