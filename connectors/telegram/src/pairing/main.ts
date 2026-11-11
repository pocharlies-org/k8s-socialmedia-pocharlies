/**
 * SC-1229 (SC-1197 P4b): entrypoint of the `telegram-pairing` Deployment
 * (telegram-connector image, port 3002; the manifest is already merged with
 * P3 — k8s/base/social-pairing.yaml, replicas 0, SOCIAL_PAIRING_API=off).
 * The container runs `cd /app/connectors/telegram && exec tsx src/pairing/main.ts`;
 * locally: `pnpm start:pairing` from connectors/telegram.
 *
 * Separate process from the house connectors on purpose (design D1 by
 * analogy): their main.ts is untouched and a crash here never takes the
 * house Telegram sessions down.
 *
 * Environment — the contract approved with P3, read in one place
 * (telegramPairingConfigFromEnv in ./app.ts): the 8 common variables
 * (PORT, SOCIAL_PAIRING_API, SESSION_PATH — unused, mtcute state is
 * memory-only —, CONNECTOR_SHARED_SECRET, DB_USER, DB_PASSWORD,
 * CREDENTIAL_STORE_MASTER_KEY, DATABASE_URL) plus TELEGRAM_API_ID and
 * TELEGRAM_API_HASH. This process NEVER reads TELEGRAM_SESSION_STRING*:
 * those are the house accounts' sessions and must not reach a per-sub pool
 * — and they never even arrive: the P3 manifests hand this container its
 * variables one by one through secretKeyRef (NOT envFrom), so the house
 * session strings are not part of this pod's env at all (pinned by
 * app.test.ts).
 */
import { PostgresCredentialStore } from '@mcp-socialmedia/shared';
import { getPool } from '../db-pool';
import { createPairingTelegramClient } from './client';
import { createTelegramPairingApp, telegramPairingConfigFromEnv } from './app';
import { TelegramSessionPool } from './session-pool';

function main(): void {
  const cfg = telegramPairingConfigFromEnv();
  const poolUsable = cfg.apiEnabled && cfg.storeAvailable && cfg.apiId > 0 && cfg.apiHash !== null;

  const pool = poolUsable
    ? new TelegramSessionPool({
        store: new PostgresCredentialStore(getPool()),
        createClient: createPairingTelegramClient({ apiId: cfg.apiId, apiHash: cfg.apiHash! }),
      })
    : null;
  pool?.startEvictionTimer();

  const app = createTelegramPairingApp({
    apiEnabled: cfg.apiEnabled,
    storeAvailable: cfg.storeAvailable,
    sharedSecret: cfg.sharedSecret,
    pool,
  });
  app.listen(cfg.port, () => {
    console.log(
      `telegram-pairing listening on ${cfg.port} (api=${cfg.apiEnabled ? 'on' : 'off'}, store=${
        cfg.storeAvailable ? 'available' : 'unavailable'
      }, pool=${pool ? 'ready' : 'unavailable'})`
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

try {
  main();
} catch (error) {
  console.error('telegram-pairing fatal error:', error);
  process.exit(1);
}
