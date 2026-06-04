import express, { Request, Response } from 'express';
import pino from 'pino';
import { createHMACAuth, AuthenticatedRequest } from './auth';
import { WhatsAppCloudAPI, CloudConnectorError, cloudError } from './cloud-api';
import { createWebhookRouter } from './webhook';
import { WhatsAppCloudPublisher } from './publisher';

const logger = pino({ transport: { target: 'pino-pretty', options: { colorize: true } } });

const PORT = parseInt(process.env.PORT || '3004', 10);
const CONNECTOR_SHARED_SECRET =
  process.env.CONNECTOR_SHARED_SECRET || 'dev-secret-change-in-production';
const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const NATS_CA_CERT = process.env.NATS_CA_CERT;
const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || 'v25.0';
const WEBHOOK_VERIFY_TOKEN =
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'whatsapp-cloud-verify-token';
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';

const api = new WhatsAppCloudAPI({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
  graphApiVersion: GRAPH_API_VERSION,
});

const publisher = new WhatsAppCloudPublisher(
  NATS_URL,
  NATS_CA_CERT && NATS_CA_CERT !== 'none' ? NATS_CA_CERT : undefined
);

const app = express();
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buffer) => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  })
);

app.use(
  '/',
  createWebhookRouter(WEBHOOK_VERIFY_TOKEN, FACEBOOK_APP_SECRET, event => {
    publisher.publishMessageReceived(event);
  })
);

const auth = createHMACAuth(CONNECTOR_SHARED_SECRET);

app.get('/', (_req, res) => {
  res.redirect(302, '/status');
});

app.get('/health', (_req, res) => {
  const connected = api.isConfigured();
  res.status(connected ? 200 : 503).json(statusPayload(connected));
});

app.get('/status', (_req, res) => {
  const connected = api.isConfigured();
  res.json(statusPayload(connected));
});

app.get('/api/v1/health', (_req, res) => {
  const connected = api.isConfigured();
  res.status(connected ? 200 : 503).json(statusPayload(connected));
});

app.post('/api/v1/messages/send', auth, (req: AuthenticatedRequest, res: Response): void => {
  void (async (): Promise<void> => {
    try {
      requireSendingEnabled();
      const body = (req.body || {}) as Record<string, unknown>;
      const sendToken = optionalString(body.sendToken);
      const conversationId = optionalString(body.conversationId);
      const content = optionalString(body.content);
      if (!sendToken || !conversationId || !content) {
        throw cloudError('Missing required fields', 'invalid_request', 400);
      }

      const result = await api.sendText({
        conversationId,
        content,
        previewUrl: Boolean(body.previewUrl),
      });
      const messageId = firstMetaMessageId(result);
      logger.info({ conversationId, messageId }, 'WhatsApp Cloud text sent');
      res.json({
        messageId,
        sentAt: new Date().toISOString(),
        raw: result,
      });
    } catch (error) {
      respondWithCloudError(res, error);
    }
  })();
});

app.post('/api/v1/messages/template', auth, (req: AuthenticatedRequest, res: Response): void => {
  void (async (): Promise<void> => {
    try {
      requireSendingEnabled();
      const body = (req.body || {}) as Record<string, unknown>;
      const templateName = optionalString(body.templateName || body.name);
      const conversationId = optionalString(body.conversationId || body.to);
      if (!templateName || !conversationId) {
        throw cloudError('Missing templateName or conversationId', 'invalid_request', 400);
      }

      const result = await api.sendTemplate({
        conversationId,
        templateName,
        languageCode: optionalString(body.languageCode) || 'es',
        components: Array.isArray(body.components) ? body.components : undefined,
      });
      const messageId = firstMetaMessageId(result);
      logger.info({ conversationId, templateName, messageId }, 'WhatsApp Cloud template sent');
      res.json({
        messageId,
        sentAt: new Date().toISOString(),
        raw: result,
      });
    } catch (error) {
      respondWithCloudError(res, error);
    }
  })();
});

app.listen(PORT, () => {
  logger.info({ port: PORT, ...api.redactedConfig() }, 'WhatsApp Cloud connector listening');
});

void publisher.connect();

process.on('SIGTERM', () => {
  void publisher.disconnect().finally(() => process.exit(0));
});

function statusPayload(connected: boolean): Record<string, unknown> {
  return {
    status: connected ? 'ok' : 'degraded',
    platform: 'whatsapp-cloud',
    connected,
    serviceReady: connected,
    natsConnected: publisher.isConnected(),
    sendingEnabled:
      process.env.ENABLE_SENDING === 'true' && process.env.EMERGENCY_DISABLE_SENDING !== 'true',
    ...api.redactedConfig(),
  };
}

function requireSendingEnabled(): void {
  if (process.env.ENABLE_SENDING !== 'true') {
    throw cloudError('Sending is disabled', 'invalid_request', 403);
  }
  if (process.env.EMERGENCY_DISABLE_SENDING === 'true') {
    throw cloudError('Sending is emergency disabled', 'invalid_request', 403);
  }
}

function respondWithCloudError(res: Response, error: unknown): void {
  const connectorError = error as Partial<CloudConnectorError>;
  const statusCode =
    typeof connectorError.statusCode === 'number' ? connectorError.statusCode : 500;
  const failureClass = connectorError.failureClass || 'meta_error';
  const message = error instanceof Error ? error.message : String(error);
  logger.warn({ statusCode, failureClass, details: connectorError.details }, message);
  res.status(statusCode).json({
    error: message,
    failureClass,
    details: connectorError.details,
    actionable:
      failureClass === 'template_required'
        ? 'Use an approved WhatsApp template when outside the 24-hour customer service window.'
        : undefined,
  });
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function firstMetaMessageId(result: Record<string, unknown>): string | null {
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const first = messages[0] as Record<string, unknown> | undefined;
  return typeof first?.id === 'string' ? first.id : null;
}
