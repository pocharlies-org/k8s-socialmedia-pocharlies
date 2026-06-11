import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import pino from 'pino';
import { EventType, MessageReceivedEvent } from '@mcp-socialmedia/shared';
import { normalizeWhatsAppPhone } from './phone';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

export type WebhookMessageCallback = (event: MessageReceivedEvent) => void;

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export function createWebhookRouter(
  verifyToken: string,
  appSecret: string,
  onMessage: WebhookMessageCallback
): Router {
  const router = Router();

  router.get('/webhook', (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === verifyToken) {
      logger.info('WhatsApp Cloud webhook verified successfully');
      res.status(200).send(String(challenge || ''));
      return;
    }

    logger.warn('WhatsApp Cloud webhook verification failed');
    res.sendStatus(403);
  });

  router.post('/webhook', (req: RawBodyRequest, res: Response) => {
    if (appSecret && !verifyMetaSignature(req, appSecret)) {
      logger.warn('WhatsApp Cloud webhook signature verification failed');
      res.sendStatus(403);
      return;
    }

    res.sendStatus(200);

    const body = req.body as any;
    if (body?.object !== 'whatsapp_business_account') {
      logger.warn({ object: body?.object }, 'Ignoring non-WhatsApp webhook');
      return;
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};

        for (const status of value.statuses || []) {
          logger.info(
            {
              messageId: status.id,
              status: status.status,
              recipientId: status.recipient_id,
              timestamp: status.timestamp,
            },
            'WhatsApp Cloud message status'
          );
        }

        for (const message of value.messages || []) {
          const event = toMessageReceivedEvent(message);
          if (!event) continue;
          logger.info(
            {
              conversationId: event.conversationId,
              waMessageId: event.waMessageId,
              messageType: event.messageType,
            },
            'WhatsApp Cloud inbound message'
          );
          onMessage(event);
        }
      }
    }
  });

  return router;
}

function verifyMetaSignature(req: RawBodyRequest, appSecret: string): boolean {
  const signature = req.headers['x-hub-signature-256'];
  if (typeof signature !== 'string' || !req.rawBody) return false;

  const expected = createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
  const provided = signature.replace(/^sha256=/, '');
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
}

function toMessageReceivedEvent(message: any): MessageReceivedEvent | null {
  const normalized = normalizeWhatsAppPhone(message?.from);
  if (!normalized || !message?.id) return null;

  const timestamp = Number(message.timestamp || Date.now() / 1000);
  const content = extractContent(message);
  const messageType = mapMessageType(message.type);

  return {
    eventType: EventType.MESSAGE_RECEIVED,
    account: 'professional',
    conversationId: normalized.waJid,
    waMessageId: message.id,
    waTimestamp: new Date(timestamp * 1000).toISOString(),
    senderWaId: normalized.waJid,
    content,
    messageType,
    attachments: extractAttachments(message),
    isForwarded: Boolean(message.context?.forwarded),
    replyToWaId: message.context?.id,
  };
}

function extractContent(message: any): string {
  if (message.type === 'text') return String(message.text?.body || '');
  if (message.type === 'button') return String(message.button?.text || message.button?.payload || '');
  if (message.type === 'interactive') {
    return (
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      JSON.stringify(message.interactive || {})
    );
  }
  if (message.type === 'location') {
    return `[location] ${message.location?.latitude || ''},${message.location?.longitude || ''}`;
  }
  if (message.type === 'contacts') return '[contacts]';
  return message[message.type]?.caption || `[${message.type || 'message'}]`;
}

function mapMessageType(type: string | undefined): string {
  const normalized = String(type || 'text').toLowerCase();
  const mapping: Record<string, string> = {
    text: 'TEXT',
    image: 'IMAGE',
    video: 'VIDEO',
    audio: 'AUDIO',
    document: 'DOCUMENT',
    location: 'LOCATION',
    contacts: 'CONTACT',
    sticker: 'STICKER',
  };
  return mapping[normalized] || 'TEXT';
}

function extractAttachments(message: any): MessageReceivedEvent['attachments'] {
  const media = message?.[message.type];
  if (!media?.id) return undefined;
  return [
    {
      type: mapMessageType(message.type),
      url: `meta-media:${media.id}`,
      metadata: {
        mediaId: media.id,
        mimetype: media.mime_type,
        sha256: media.sha256,
        caption: media.caption,
      },
    },
  ];
}
