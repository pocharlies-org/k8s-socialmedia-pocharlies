import express, { Request, Response } from 'express';
import type { BaileysClient } from '../baileys-client';
import { createHMACAuth, HMACRejectReason } from './auth';

type PublicClient = Pick<BaileysClient, 'getChats' | 'fetchChatHistory' | 'backfillRecentMedia'>;

/** One rejection line per reason per this many ms; the rest are counted, not printed. */
const REJECT_LOG_INTERVAL_MS = 10_000;

/**
 * The history endpoints of the connector (sync service, mcp-server providerGet),
 * mounted at /api/public behind the connector HMAC (SKIRM-103). A GET has no
 * body, so its signature is over "{}" — express.json leaves req.body = {} — and
 * so is the one of backfill-media, whose parameters travel in the query.
 *
 * Manual call (the signature is HMAC-SHA256 of "<ts>:{}" with the connector key):
 *   ts=$(date +%s); sig=$(printf '%s:{}' "$ts" | openssl dgst -sha256 -hmac "$CONNECTOR_SHARED_SECRET" -hex | sed 's/^.* //')
 *   curl -X POST "http://localhost:3001/api/public/backfill-media?days=7&limit=200" \
 *     -H "x-connector-timestamp: $ts" -H "x-connector-signature: sha256=$sig"
 */
export function createPublicRouter(
  client: PublicClient,
  sharedSecret: string,
  options: { log?: (line: string) => void; now?: () => number } = {}
): express.Router {
  const { log = console.warn, now = Date.now } = options;
  const router = express.Router();

  // F3-4: every rejection leaves one line (method, route, origin IP, reason) so a
  // consumer nobody listed shows up in minutes. Never headers, body, signature or
  // query; the route stops at its first segment so a chat id is not logged either.
  const lastLogged = new Map<HMACRejectReason, { at: number; suppressed: number }>();
  router.use(
    createHMACAuth(sharedSecret, (req: Request, reason: HMACRejectReason) => {
      const entry = lastLogged.get(reason);
      if (entry && now() - entry.at < REJECT_LOG_INTERVAL_MS) {
        entry.suppressed += 1;
        return;
      }
      const route = `${req.baseUrl}/${req.path.split('/')[1] ?? ''}`;
      log(
        `[public-api] rejected ${req.method} ${route} ip=${req.ip} reason=${reason} suppressed=${entry?.suppressed ?? 0}`
      );
      lastLogged.set(reason, { at: now(), suppressed: 0 });
    })
  );

  // CONTRACT: http.whatsapp-connector.public-chats.v1 — GET /api/public/chats, HMAC over "<ts>:{}", 200 {chats}
  router.get('/chats', async (_req: Request, res: Response) => {
    try {
      const chats = await client.getChats();
      res.json({
        chats: chats.map((c: any) => ({
          id: c.id?._serialized || c.id,
          name: c.name,
          isGroup: c.isGroup,
          timestamp: c.timestamp,
        })),
      });
    } catch (e) {
      console.error('Error getting chats:', e);
      res.status(500).json({ error: String(e) });
    }
  });

  // CONTRACT: http.whatsapp-connector.public-history.v1 — GET /api/public/history/:chatId?limit=, HMAC over "<ts>:{}", 200 {messages}
  router.get('/history/:chatId', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 500;
      const messages = await client.fetchChatHistory(req.params.chatId, limit);
      res.json({ messages });
    } catch (e) {
      console.error('Error fetching history:', e);
      res.status(500).json({ error: String(e) });
    }
  });

  // Best-effort historical media backfill — wwebjs can usually only fetch the
  // last ~50 messages per chat, so older media will be marked unavailable.
  // CONTRACT: http.whatsapp-connector.public-backfill-media.v1 — POST /api/public/backfill-media?days=&limit=, HMAC over "<ts>:{}", empty body
  router.post('/backfill-media', async (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 7;
      const limit = parseInt(req.query.limit as string) || 100;
      const result = await client.backfillRecentMedia(days, limit);
      res.json(result);
    } catch (e) {
      console.error('Backfill failed:', e);
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
