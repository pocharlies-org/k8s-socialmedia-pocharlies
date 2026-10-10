import express, { Request, Response } from 'express';
import { createRejectLogger } from '@mcp-socialmedia/shared';
import type { TelegramClientWrapper } from '../telegram-client';
import { HMACRejectReason, authMiddleware, requireSending } from './controller';

type PublicClient = Pick<
  TelegramClientWrapper,
  'isClientConnected' | 'getDialogs' | 'getMessages' | 'sendMessage'
>;

/**
 * The read and send endpoints of the Telegram connector (telegram-sync's send,
 * mcp-server's providerGet), mounted at /api/public behind the connector HMAC
 * (SKIRM-111). A GET has no body, so its signature is over "{}" — express.json
 * leaves req.body = {} — and so is the one of a send, whose parameters are the
 * JSON body it signs.
 *
 * Manual call (the signature is HMAC-SHA256 of "<ts>:{}" with the connector key):
 *   ts=$(date +%s); sig=$(printf '%s:{}' "$ts" | openssl dgst -sha256 -hmac "$CONNECTOR_SHARED_SECRET" -hex | sed 's/^.* //')
 *   curl "http://localhost:3002/api/public/dialogs" \
 *     -H "x-connector-timestamp: $ts" -H "x-connector-signature: sha256=$sig"
 */
export function createPublicRouter(
  client: PublicClient,
  sharedSecret: string,
  options: { log?: (line: string) => void; now?: () => number } = {}
): express.Router {
  const { log = console.warn, now = Date.now } = options;
  const router = express.Router();

  router.use(authMiddleware(sharedSecret, createRejectLogger<HMACRejectReason>(log, now)));

  // CONTRACT: http.telegram-connector.public-dialogs.v1 — GET /api/public/dialogs, HMAC over "<ts>:{}", 200 {dialogs}
  router.get('/dialogs', async (_req: Request, res: Response) => {
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

  // CONTRACT: http.telegram-connector.public-messages.v1 — GET /api/public/messages/:chatId?limit=, HMAC over "<ts>:{}", 200 {messages}
  router.get('/messages/:chatId', async (req: Request, res: Response) => {
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

  // CONTRACT: http.telegram-connector.public-send.v1 — POST /api/public/send/:chatId {text, topicId?}, HMAC over "<ts>:<body>", 200 {success}
  router.post('/send/:chatId', requireSending, async (req: Request, res: Response) => {
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

  return router;
}
