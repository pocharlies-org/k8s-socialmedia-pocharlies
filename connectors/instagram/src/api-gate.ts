import type { RequestHandler } from 'express';
import {
  createHMACAuth,
  createHMACRejectLog,
  requireConnectorSecret,
} from '@mcp-socialmedia/shared';
import type { WebhookLog } from './webhook';

/**
 * SKIRM-112: the gate of /api/v1 — the connector API answers only to a caller that signs with
 * CONNECTOR_SHARED_SECRET (createHMACAuth, the scheme of the WhatsApp connector and mcp-server).
 *
 * It fails closed without taking the process down: the webhook and /health must keep answering
 * while the API does not. A missing or blank key, or the repository's default under
 * CONNECTOR_SECRET_STRICT=true, makes every /api/v1 request a 503 and logs why at startup; the
 * default without the switch is accepted with the warning requireConnectorSecret logs (SKIRM-103).
 */
export function connectorApiGate(env: NodeJS.ProcessEnv, log: WebhookLog): RequestHandler {
  let secret: string;
  try {
    secret = requireConnectorSecret(env, message => log.warn({}, message));
  } catch (error) {
    log.warn({}, `/api/v1 answers 503: ${(error as Error).message}`);
    return (_req, res) => {
      res.status(503).json({ error: 'Connector API unavailable: no usable CONNECTOR_SHARED_SECRET' });
    };
  }
  return createHMACAuth(secret, createHMACRejectLog('instagram-api', { log: line => log.warn({}, line) }));
}
