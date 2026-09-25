/**
 * SC-1225 (SC-1197 P1a): entrypoint of the `whatsapp-pairing` Deployment
 * (whatsapp-connector image, port 3001; manifests land with P3, replicas 0).
 * Start it with `pnpm start:pairing` from connectors/whatsapp-web.
 *
 * Separate process from the house connectors on purpose (design D1): their
 * `main.ts` is untouched and a crash here never takes the house number down.
 *
 * Environment:
 *   SOCIAL_PAIRING_API          on|off (default off → only /health answers)
 *   CREDENTIAL_STORE_ENABLED    must be "true", with
 *   CREDENTIAL_STORE_MASTER_KEY base64 of 32 bytes — else 503 pairing_unavailable
 *   CONNECTOR_SHARED_SECRET     HMAC secret shared with social-api (no default)
 *   SESSION_PATH                per-sub auth dirs (in-memory emptyDir in k8s)
 *   PORT                        default 3001
 */
import { join } from 'path';
import { PostgresCredentialStore } from '@mcp-socialmedia/shared';
import { BaileysClient } from '../baileys-client';
import { getPool } from '../db-writer';
import { scrubSignalSessionLogs } from '../signal-log-scrub';
import { createPairingApp, pairingApiEnabledFromEnv, pairingStoreAvailable } from './app';
import { SessionPool } from './session-pool';

if (!scrubSignalSessionLogs()) {
  console.error('signal-log-scrub: could not install SessionEntry inspect redaction');
}

async function main(): Promise<void> {
  const PORT = parseInt(process.env.PORT || '3001', 10);
  const SESSION_PATH = process.env.SESSION_PATH || join(process.cwd(), 'pairing-session-data');
  const ENCRYPTION_KEY =
    process.env.SESSION_ENCRYPTION_KEY || 'dev-encryption-key-change-in-production';
  const sharedSecret = (process.env.CONNECTOR_SHARED_SECRET || '').trim() || null;
  const apiEnabled = pairingApiEnabledFromEnv();
  const storeAvailable = apiEnabled && pairingStoreAvailable();

  const pool =
    apiEnabled && storeAvailable
      ? new SessionPool({
          store: new PostgresCredentialStore(getPool()),
          sessionRoot: SESSION_PATH,
          createClient: sessionPath =>
            new BaileysClient(sessionPath, ENCRYPTION_KEY, { quietQr: true, ingest: false }),
        })
      : null;
  pool?.startEvictionTimer();

  const app = createPairingApp({ apiEnabled, storeAvailable, sharedSecret, pool });
  app.listen(PORT, () => {
    console.log(
      `whatsapp-pairing listening on ${PORT} (api=${apiEnabled ? 'on' : 'off'}, store=${
        storeAvailable ? 'available' : 'unavailable'
      })`
    );
  });

  const shutdown = (): void => {
    const done = (): void => process.exit(0);
    if (!pool) return done();
    void Promise.race([
      pool.close(),
      new Promise(resolve => setTimeout(resolve, 5000).unref?.()),
    ]).then(done, done);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => {
  console.error('whatsapp-pairing fatal error:', error);
  process.exit(1);
});
