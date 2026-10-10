import express, { Request, Response } from 'express';
import { createHMACAuth, createHMACRejectLog } from '@mcp-socialmedia/shared';
import type { TelegramClientWrapper } from '../telegram-client';
import { requireSending } from './controller';

type PublicClient = Pick<
  TelegramClientWrapper,
  'isClientConnected' | 'getDialogs' | 'getMessages' | 'sendMessage'
>;

/**
 * What mcp-server (providerGet) and telegram-sync (send) call on the Telegram
 * connector, mounted at /api/public behind the same HMAC as /api/v1 (SKIRM-111).
 * A GET signs "{}", because express.json leaves req.body = {}; a send signs its
 * JSON body. The signing recipe by hand is in ARCHITECTURE.md §8.
 */
export function createPublicRouter(
  client: PublicClient,
  sharedSecret: string,
  options: { log?: (line: string) => void; now?: () => number } = {}
): express.Router {
  const router = express.Router();

  router.use(createHMACAuth(sharedSecret, createHMACRejectLog('public-api', options)));

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
