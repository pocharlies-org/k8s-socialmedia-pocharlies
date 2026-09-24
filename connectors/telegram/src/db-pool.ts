/**
 * SC-1145: the Postgres pool for the credential-store wiring, mirroring
 * connectors/whatsapp-web/src/db-writer.ts (same DB `whatsappmcp`, same
 * DATABASE_URL precedence: env over the dev default). Small pool — this
 * connector only ever talks to `user_channel_credentials` through
 * PostgresCredentialStore.
 */
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://whatsappmcp:whatsappmcp_dgx_2026@postgres:5432/whatsappmcp';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    // An idle client dropped by the server emits 'error' on the pool; without
    // a listener Node treats it as unhandled and the connector crashes.
    pool.on('error', error => {
      console.error('PostgreSQL idle client error:', error);
    });
  }
  return pool;
}
