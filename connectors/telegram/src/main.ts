import express from 'express';
import { PostgresCredentialStore, credentialSessionKeyFromEnv } from '@mcp-socialmedia/shared';
import { TelegramClientWrapper, TelegramMessage } from './telegram-client';
import { TelegramEventPublisher, TelegramMessageReceivedEvent } from './events/publisher';
import { createRouter } from './api/controller';
import { getPool } from './db-pool';
import {
  TelegramCredentialWriteBack,
  createTelegramCredentialWriteBack,
  resolveTelegramSession,
} from './credential-session';

const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || '';
const TELEGRAM_SESSION_STRING = process.env.TELEGRAM_SESSION_STRING || '';
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const NATS_CA_CERT = process.env.NATS_CA_CERT;
const PORT = parseInt(process.env.PORT || '3002', 10);
const CONNECTOR_ACCOUNT = process.env.CONNECTOR_ACCOUNT || 'personal';
const CONNECTOR_SHARED_SECRET =
  process.env.CONNECTOR_SHARED_SECRET || 'dev-secret-change-in-production';

async function main() {
  // Validate required configuration
  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
    console.error('TELEGRAM_API_ID and TELEGRAM_API_HASH are required');
    console.error('Get them from https://my.telegram.org/apps');
    process.exit(1);
  }

  // SC-705 part 4 (SC-1145): per-user sessions are keyed by the caller's
  // Keycloak `sub` (CREDENTIAL_SESSION_KEY = `<sub>` or `<sub>:<cuenta>`,
  // shared/session-store/credential-session-key.ts). The house accounts
  // (personal/professional) do NOT set it and keep the exact legacy path —
  // TELEGRAM_SESSION_STRING, zero store reads/writes, no adoption.
  const credentialSessionKey = credentialSessionKeyFromEnv();
  let credentialStore: PostgresCredentialStore | null = null;
  let credentialWriteBack: TelegramCredentialWriteBack | null = null;
  let sessionString = TELEGRAM_SESSION_STRING;
  if (credentialSessionKey) {
    credentialStore = new PostgresCredentialStore(getPool());
    const resolved = await resolveTelegramSession(
      credentialStore,
      credentialSessionKey,
      TELEGRAM_SESSION_STRING
    );
    sessionString = resolved.sessionString ?? '';
    console.log(
      `credential-store: telegram session for ${credentialSessionKey} resolved from ${resolved.source}`
    );
    if (!sessionString) {
      console.error(
        `No telegram session for ${credentialSessionKey}: no credential-store row and no TELEGRAM_SESSION_STRING — the MTProto pairing gesture for this user is still pending`
      );
      process.exit(1);
    }
  }

  if (!sessionString) {
    console.error('TELEGRAM_SESSION_STRING is required');
    console.error('Run "pnpm generate-session" to create one');
    process.exit(1);
  }

  const client = new TelegramClientWrapper({
    apiId: TELEGRAM_API_ID,
    apiHash: TELEGRAM_API_HASH,
    sessionString,
  });

  if (credentialSessionKey && credentialStore) {
    // Write-back on every mtcute persist (session import, per-DC auth-key
    // creation, update-state sync) — the baileys saveCreds counterpart.
    credentialWriteBack = createTelegramCredentialWriteBack(
      credentialStore,
      credentialSessionKey,
      () => client.exportSessionString()
    );
    client.setSessionPersistHook(() => credentialWriteBack?.schedule());
    // Revoked session: cancel any in-flight write, then drop the row (a
    // trailing put must never resurrect a deleted dead credential).
    client.setSessionInvalidatedHook(async () => {
      credentialWriteBack?.cancel();
      await credentialStore.delete(credentialSessionKey, 'telegram');
    });
  }

  const eventPublisher = new TelegramEventPublisher(NATS_URL, NATS_CA_CERT);

  // Setup Express API
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  // SC-1145 (mirrors whatsapp-web): the mcp-server forwards the verified
  // caller identity (`x-user-sub`, from the gateway JWT) on every connector
  // call. Phase 1.5 logs it (observable proof the header traverses
  // gateway→mcp-server→connector); the phase-2 per-sub pool will route on it.
  app.use('/api/v1', (req, _res, next) => {
    const sub = req.headers['x-user-sub'];
    if (typeof sub === 'string' && sub) console.log(`API request carries x-user-sub=${sub}`);
    next();
  });
  app.use('/api/v1', createRouter(client, CONNECTOR_SHARED_SECRET));

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      connected: client.isClientConnected(),
      platform: 'telegram',
    });
  });

  app.listen(PORT, () => {
    console.log(`Telegram Connector API listening on port ${PORT}`);
  });

  // Connect to NATS
  await eventPublisher.connect();

  // Handle connection
  client.on('connected', () => {
    console.log('Connected to Telegram');
  });

  // Handle messages
  client.on('message', async (message: TelegramMessage) => {
    const event: TelegramMessageReceivedEvent = {
      eventType: 'TelegramMessageReceived',
      account: CONNECTOR_ACCOUNT,
      conversationId: message.conversationId,
      telegramMessageId: message.telegramMessageId,
      telegramTimestamp: message.telegramTimestamp.toISOString(),
      senderTelegramId: message.senderTelegramId,
      senderUsername: message.senderUsername,
      senderFirstName: message.senderFirstName,
      content: message.content || '',
      messageType: message.messageType,
      attachments: message.attachments,
      isForwarded: message.isForwarded,
      replyToMessageId: message.replyToMessageId,
      topicId: message.topicId,
      isOutbound: message.isOutbound,
      chatType: message.chatType,
      chatTitle: message.chatTitle,
    };

    await eventPublisher.publishMessageReceived(event);
  });

  // Connect to Telegram

  // --- Public API endpoints (no auth, for brain/dashboard) ---
  app.get('/api/public/dialogs', async (_req, res) => {
    try {
      if (!client.isClientConnected()) {
        res.status(503).json({ error: 'Not connected' });
        return;
      }
      const dialogs = await client.getDialogs();
      res.json({ dialogs });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/public/messages/:chatId', async (req, res) => {
    try {
      if (!client.isClientConnected()) {
        res.status(503).json({ error: 'Not connected' });
        return;
      }
      const limit = parseInt(req.query.limit as string) || 50;
      const messages = await client.getMessages(req.params.chatId, limit);
      res.json({ messages });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/public/send/:chatId', async (req, res) => {
    try {
      if (!client.isClientConnected()) {
        res.status(503).json({ error: 'Not connected' });
        return;
      }
      const { text, topicId } = req.body;
      if (!text) {
        res.status(400).json({ error: 'Missing text' });
        return;
      }
      const tid = topicId !== undefined && topicId !== null ? Number(topicId) : undefined;
      if (tid !== undefined && (!Number.isInteger(tid) || tid <= 0)) {
        res.status(400).json({ error: 'topicId must be a positive integer' });
        return;
      }
      await client.sendMessage(req.params.chatId, text, tid);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  await client.connect();

  // SC-1145: start() imported the session (mtcute persist → scheduled
  // write-back). Flush so the row exists deterministically before the pod
  // declares itself live — criterion 2 (persistence after rollout restart)
  // must not depend on the 2s debounce surviving a fast crash loop.
  if (credentialWriteBack) {
    await credentialWriteBack.flush();
  }

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('Shutting down...');
    // Land a pending write-back (≤5s; a hung DB must not block the pod from
    // dying — the next start re-persists on connect) before disconnecting.
    if (credentialWriteBack) {
      await Promise.race([
        credentialWriteBack.flush(),
        new Promise(resolve => setTimeout(resolve, 5000).unref?.()),
      ]);
    }
    await client.disconnect();
    await eventPublisher.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
