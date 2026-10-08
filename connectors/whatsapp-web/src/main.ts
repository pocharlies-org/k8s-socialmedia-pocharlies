import express from 'express';
import { BaileysClient, WhatsAppMessage } from './baileys-client';
import { QRHandler } from './qr-handler';
import { EventPublisher } from './events/publisher';
import { createRouter } from './api/controller';
import { createAuthQrV2Router } from './api/auth-qr';
import { createPublicRouter } from './api/public-routes';
import { createQrRouter } from './api/qr-routes';
import { join } from 'path';
import {
  MessageReceivedEvent,
  EventType,
  PostgresCredentialStore,
  requireConnectorSecret,
} from '@mcp-socialmedia/shared';
import { scrubSignalSessionLogs } from './signal-log-scrub';
import { getPool } from './db-writer';
import {
  CredentialWriteBack,
  attachCredentialSession,
  credentialSessionKeyFromEnv,
  sessionPathForSub,
} from './credential-session';

// F0.8: redact libsignal SessionEntry console dumps (privKey/rootKey/chainKey
// Buffers) BEFORE any Baileys socket can open/close a session. Display-only;
// see signal-log-scrub.ts for the root cause. A failure to patch is loud but
// non-fatal: the connector must keep delivering messages regardless.
if (!scrubSignalSessionLogs()) {
  console.error(
    'signal-log-scrub: could not install SessionEntry inspect redaction — ' +
      'libsignal shape changed; session logs may leak private keys'
  );
}

const SESSION_PATH = process.env.SESSION_PATH || join(process.cwd(), 'session-data');
const ENCRYPTION_KEY =
  process.env.SESSION_ENCRYPTION_KEY || 'dev-encryption-key-change-in-production';
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const NATS_CA_CERT = process.env.NATS_CA_CERT;
const PORT = parseInt(process.env.PORT || '3001', 10);
// SKIRM-103 F3-2: fail closed — a missing or placeholder HMAC key stops the connector.
const CONNECTOR_SHARED_SECRET = requireConnectorSecret();
// When true, the public /qr/page renders a "Generate new QR" button wired to an
// unauthenticated POST /qr/renew. Only enable on LAN-only deployments (e.g. the
// professional connector at whatsapp-pro.e-dani.com) — never on the
// internet-exposed personal page, where anyone with the URL could disconnect.
const ALLOW_WEB_RENEW = process.env.ALLOW_WEB_RENEW === 'true';

function isKnownUndiciStreamAbort(error: unknown): boolean {
  const err = error as any;
  return (
    err?.name === 'TypeError' &&
    err?.message === 'terminated' &&
    err?.cause?.code === 'UND_ERR_SOCKET'
  );
}

process.on('uncaughtException', error => {
  if (isKnownUndiciStreamAbort(error)) {
    console.warn(`Ignored aborted remote media stream: ${error.message}`);
    return;
  }
  console.error('Fatal uncaught exception:', error);
  process.exit(1);
});

async function main(): Promise<void> {
  // SC-705 phase 1.5: per-user sessions are keyed by the caller's Keycloak
  // `sub` (CREDENTIAL_SESSION_KEY = `<sub>` or `<sub>:<cuenta>`). The house
  // accounts (personal/professional) do NOT set it and keep the exact legacy
  // path — legacy authDir, zero store reads/writes (SC-1144 criterion 4).
  const credentialSessionKey = credentialSessionKeyFromEnv();
  const client = new BaileysClient(
    credentialSessionKey ? sessionPathForSub(SESSION_PATH, credentialSessionKey) : SESSION_PATH,
    ENCRYPTION_KEY
  );
  const qrHandler = new QRHandler();
  const eventPublisher = new EventPublisher(NATS_URL, NATS_CA_CERT);

  const app = express();
  app.use(express.json({ limit: '15mb' })); // large enough for base64 voice notes
  // SC-705: the mcp-server forwards the verified caller identity
  // (`x-user-sub`, from the gateway JWT) on every connector call. Phase 1.5
  // logs it (observable proof the header traverses gateway→mcp-server→
  // connector); the phase-2 per-sub client pool will route on it.
  app.use('/api/v1', (req, _res, next) => {
    const sub = req.headers['x-user-sub'];
    if (typeof sub === 'string' && sub) console.log(`API request carries x-user-sub=${sub}`);
    next();
  });
  app.use('/api/v1', createRouter(client, qrHandler, CONNECTOR_SHARED_SECRET));
  app.use('/api/v2', createAuthQrV2Router(qrHandler, CONNECTOR_SHARED_SECRET));

  app.get('/', (_req, res) => {
    res.redirect(302, '/qr/page');
  });

  app.get('/manual-open', (_req, res) => {
    res.redirect(302, '/api/v1/manual-open/page');
  });

  app.get('/manual-open/page', (_req, res) => {
    res.redirect(302, '/api/v1/manual-open/page');
  });

  app.use(
    createQrRouter({
      qrHandler,
      client,
      eventPublisher,
      sessionPath: SESSION_PATH,
      allowWebRenew: ALLOW_WEB_RENEW,
    })
  );

  app.listen(PORT, () => {
    console.log(`WhatsApp Connector API listening on port ${PORT}`);
    console.log(`QR page: http://localhost:${PORT}/qr/page`);
  });

  // NATS is optional
  await eventPublisher.connect();

  client.on('qr', (qr: string) => {
    console.log('QR code received — view at /qr/page');
    void qrHandler.generateQR(qr);
  });

  client.on('connected', () => {
    console.log('WhatsApp connected — session persisted to ' + SESSION_PATH);
    qrHandler.clearQR();
  });

  client.on('message', (message: WhatsAppMessage) => {
    const event: MessageReceivedEvent = {
      eventType: EventType.MESSAGE_RECEIVED,
      conversationId: message.conversationId,
      waMessageId: message.waMessageId,
      waTimestamp: message.waTimestamp.toISOString(),
      senderWaId: message.senderWaId,
      content: message.content || '',
      messageType: message.messageType,
      attachments: message.attachments,
      isForwarded: message.isForwarded,
      replyToWaId: message.replyToWaId,
      pushName: message.pushName,
      // F0.1/F0.5: real @lid sender phone (when Baileys surfaced it) and the
      // ownership flag, both already computed in-memory by ingestMessage —
      // never re-queried from the DB. JSON.stringify drops undefined keys, so
      // absent values never appear on the wire.
      senderPnE164: message.senderPnE164,
      fromMe: message.fromMe,
    };
    eventPublisher.publishMessageReceived(event);
  });

  client.on(
    'message-update',
    (update: { waMessageId: string; updateType: string; newContent?: string }) => {
      eventPublisher.publishMessageUpdated({
        eventType: EventType.MESSAGE_UPDATED,
        waMessageId: update.waMessageId,
        updateType: update.updateType as 'EDITED' | 'DELETED',
        newContent: update.newContent,
        updatedAt: new Date().toISOString(),
      });
    }
  );

  client.on(
    'chat-update',
    (update: { waChatId: string; updateType: string; metadata: Record<string, unknown> }) => {
      eventPublisher.publishChatUpdated({
        eventType: EventType.CHAT_UPDATED,
        waChatId: update.waChatId,
        updateType: update.updateType as
          'NAME_CHANGED' | 'PARTICIPANT_ADDED' | 'PARTICIPANT_REMOVED',
        metadata: update.metadata || {},
      });
    }
  );

  // SKIRM-103: the history endpoints (mcp-server providerGet, sync service) behind the HMAC.
  app.use('/api/public', createPublicRouter(client, CONNECTOR_SHARED_SECRET));

  // SC-705: per-sub session lifecycle against the credential store. The load
  // must happen BEFORE connect() so a restarted pod comes back on its stored
  // session (criterion 3: no QR after rollout restart). Write-back is
  // obligatory: without it the row and the PVC diverge and rotation is lost.
  // SC-1225: the wiring lives in attachCredentialSession() (shared with the
  // pairing pool); default options = the exact SC-705 behaviour.
  let credentialWriteBack: CredentialWriteBack | null = null;
  if (credentialSessionKey) {
    const store = new PostgresCredentialStore(getPool());
    ({ writeBack: credentialWriteBack } = await attachCredentialSession(
      client,
      store,
      credentialSessionKey
    ));
  }

  await client.connect();

  const shutdown = (): void => {
    console.log('Shutting down...');
    client.disconnect();
    void eventPublisher.disconnect();
    const done = (): void => process.exit(0);
    if (credentialWriteBack) {
      // Give a pending write-back ≤5s to land before the pod dies; a hung DB
      // must not block the shutdown (the next start re-persists on connect).
      void Promise.race([
        credentialWriteBack.flush(),
        new Promise(resolve => setTimeout(resolve, 5000).unref?.()),
      ]).then(done, done);
      return;
    }
    done();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
