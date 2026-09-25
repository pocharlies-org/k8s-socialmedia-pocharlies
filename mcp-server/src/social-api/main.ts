/**
 * SC-1227 (SC-1197 P1b): entrypoint of the `social-api` Deployment (mcp-server
 * image, port 3020; the Deployment itself lands with P3, replicas 0). The
 * container runs `cd /app/mcp-server && exec tsx src/social-api/main.ts`.
 *
 * social-api is the single public face of the pairing epic (design Topología):
 * the only process that verifies the Keycloak JWT and the only caller of the
 * per-sub pools. It opens no DB connection and writes no credential row
 * itself — the whatsapp-pairing pool does, keyed by the sessionKey = sub
 * derived from the verified token. Env names are the contract with the P3
 * manifests; see env.ts for the full list and the defaults.
 */
import { createSocialApiApp } from './app';
import { contextFromEnv } from './env';

function main(): void {
  const PORT = parseInt(process.env.PORT || '3020', 10);
  const ctx = contextFromEnv();
  const app = createSocialApiApp(ctx);
  app.listen(PORT, () => {
    console.log(
      `social-api listening on ${PORT} (api=${ctx.apiEnabled ? 'on' : 'off'}, store=${
        ctx.storeAvailable ? 'available' : 'unavailable'
      }, pairing=${ctx.whatsappPairing ? 'configured' : 'unconfigured'})`
    );
  });
}

try {
  main();
} catch (error) {
  console.error('social-api fatal error:', error);
  process.exit(1);
}
