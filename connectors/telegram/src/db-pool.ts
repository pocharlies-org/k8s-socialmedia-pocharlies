/**
 * SC-1145: the Postgres pool for the credential-store wiring, mirroring
 * connectors/whatsapp-web/src/db-writer.ts (same DB `whatsappmcp`, same
 * DATABASE_URL is REQUIRED (SC-1239 C2: no baked-in fallback). Small pool —
 * this connector only talks to `user_channel_credentials` through
 * PostgresCredentialStore and, since DGX-1235 B2, to `telegram_send_attempts`
 * (send-idempotency.ts) when a send carries an Idempotency-Key. The check lives
 * inside getPool(): a pod without a database still boots, while a
 * credential-session pod missing DATABASE_URL fails hard at startup with an
 * error naming the variable, and a keyed send without it is refused (503).
 */
import pg from 'pg';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is unset: refusing to start the telegram credential store without an explicit database connection'
      );
    }
    pool = new pg.Pool({ connectionString, max: 2 });
    // An idle client dropped by the server emits 'error' on the pool; without
    // a listener Node treats it as unhandled and the connector crashes.
    pool.on('error', error => {
      console.error('PostgreSQL idle client error:', error);
    });
  }
  return pool;
}

/** Close and forget the pool (shutdown, tests): the next getPool() opens a new one. */
export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  await current?.end();
}
