/**
 * Instagram Webhook Handler — Multi-account
 * Routes incoming events to the correct account based on recipient ID / business account ID.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, Request, Response } from 'express';
import pino from 'pino';

const logger = pino(
  process.env.NODE_ENV === 'test'
    ? { level: 'silent' }
    : { transport: { target: 'pino-pretty', options: { colorize: true } } }
);

export interface WebhookEvent {
  type: 'dm' | 'comment' | 'mention' | 'story_mention' | 'unknown';
  senderId: string;
  senderUsername?: string;
  conversationId?: string;
  messageId?: string;
  text?: string;
  mediaId?: string;
  timestamp: string;
  raw: unknown;
}

type EventCallback = (account: string, event: WebhookEvent) => Promise<boolean>;

const META_MILLISECONDS_THRESHOLD = 1_000_000_000_000;
const MIN_META_EVENT_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_META_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Meta webhook examples use epoch milliseconds, while older Messenger
 * integrations sometimes send epoch seconds. Normalize both without ever
 * allowing malformed or missing input to throw an Invalid Date RangeError.
 */
export function normalizeMetaTimestamp(value: unknown, fallbackMs = Date.now()): string {
  const safeFallbackMs = Number.isFinite(fallbackMs) ? fallbackMs : Date.now();
  const fallback = new Date(safeFallbackMs).toISOString();
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;

  const epochMs = numeric >= META_MILLISECONDS_THRESHOLD ? numeric : numeric * 1000;
  if (
    !Number.isFinite(epochMs) ||
    epochMs < MIN_META_EVENT_TIMESTAMP_MS ||
    epochMs > Date.now() + MAX_META_FUTURE_SKEW_MS
  ) {
    return fallback;
  }
  return new Date(Math.trunc(epochMs)).toISOString();
}

export function createWebhookRouter(
  verifyToken: string,
  appSecret: string,
  bizIdToAccount: Map<string, string>,
  onEvent: EventCallback
): Router {
  const router = Router();

  // Meta webhook verification (GET)
  router.get('/webhook', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === verifyToken) {
      logger.info('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      logger.warn('Webhook verification failed');
      res.sendStatus(403);
    }
  });

  // Resolve which account an entry belongs to
  function resolveAccount(entry: any): string | undefined {
    // Try recipient ID from messaging events (legacy Messenger format)
    for (const messaging of entry.messaging || []) {
      const recipientId = messaging.recipient?.id;
      if (recipientId && bizIdToAccount.has(recipientId)) {
        return bizIdToAccount.get(recipientId)!;
      }
    }
    // Try recipient ID from changes events (Instagram Business Login format)
    for (const change of entry.changes || []) {
      const recipientId = change.value?.recipient?.id;
      if (recipientId && bizIdToAccount.has(recipientId)) {
        return bizIdToAccount.get(recipientId)!;
      }
    }
    // Try entry.id (page/account ID)
    if (entry.id && bizIdToAccount.has(entry.id)) {
      return bizIdToAccount.get(entry.id)!;
    }
    return undefined;
  }

  // Incoming webhook events (POST)
  router.post('/webhook', async (req: Request, res: Response) => {
    const body = req.body;
    const receivedAtMs = Date.now();

    if (!isValidSignature(req, appSecret)) {
      logger.warn('Webhook signature validation failed');
      res.sendStatus(401);
      return;
    }

    if (body.object !== 'instagram') {
      logger.warn({ object: body.object }, 'Ignoring non-instagram webhook');
      res.sendStatus(400);
      return;
    }

    for (const entry of body.entry || []) {
      const account = resolveAccount(entry);
      if (account !== 'skirmshop') {
        logger.warn(
          { entryId: entry.id },
          'Rejecting webhook for unknown or non-Skirmshop account'
        );
        res.sendStatus(403);
        return;
      }

      // Instagram Messaging (DMs)
      for (const messaging of entry.messaging || []) {
        if (isInboundDm(messaging)) {
          const event: WebhookEvent = {
            type: 'dm',
            senderId: messaging.sender?.id || '',
            conversationId: `${messaging.sender?.id}-${messaging.recipient?.id}`,
            messageId: messaging.message.mid,
            text: messaging.message.text,
            timestamp: normalizeMetaTimestamp(messaging.timestamp, receivedAtMs),
            raw: messaging,
          };

          if (messaging.message.attachments) {
            event.text =
              event.text || `[${messaging.message.attachments[0]?.type || 'attachment'}]`;
          }

          logger.info({ account, messageId: event.messageId }, 'Inbound Skirmshop DM received');
          if (!(await onEvent(account, event))) {
            res.sendStatus(503);
            return;
          }
        }
      }

      // Instagram Changes (DMs, comments, mentions) — Business Login format
      for (const change of entry.changes || []) {
        // DMs come through `changes` with field=messages in the Business Login API
        if (change.field === 'messages' && isInboundDm(change.value || {})) {
          const value = change.value || {};
          const event: WebhookEvent = {
            type: 'dm',
            senderId: value.sender?.id || '',
            conversationId: `${value.sender?.id}-${value.recipient?.id}`,
            messageId: value.message?.mid,
            text: value.message?.text,
            timestamp: normalizeMetaTimestamp(value.timestamp, receivedAtMs),
            raw: value,
          };
          if (value.message?.attachments) {
            event.text = event.text || `[${value.message.attachments[0]?.type || 'attachment'}]`;
          }
          logger.info({ account, messageId: event.messageId }, 'Inbound Skirmshop DM received');
          if (!(await onEvent(account, event))) {
            res.sendStatus(503);
            return;
          }
          continue;
        }
      }
    }

    res.sendStatus(200);
  });

  return router;
}

export function isValidSignature(req: Request, appSecret: string): boolean {
  const signature = req.get('x-hub-signature-256');
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!appSecret || !rawBody || !signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function isInboundDm(value: any): boolean {
  const senderId = value.sender?.id;
  const recipientId = value.recipient?.id;
  const message = value.message;
  return Boolean(
    senderId &&
    recipientId &&
    senderId !== recipientId &&
    message &&
    !message.is_echo &&
    !message.isEcho
  );
}
