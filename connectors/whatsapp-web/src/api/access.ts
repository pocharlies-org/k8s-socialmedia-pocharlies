import { createHash, timingSafeEqual } from 'crypto';
import type { RequestHandler } from 'express';
import { createHMACAuth } from './auth';

export function secretEquals(actual: string, expected: string): boolean {
  return (
    Boolean(actual && expected) &&
    timingSafeEqual(
      createHash('sha256').update(actual).digest(),
      createHash('sha256').update(expected).digest()
    )
  );
}

export function createConnectorAccess(
  sharedSecret: string,
  ui = {
    username: process.env.UI_AUTH_USERNAME || '',
    password: process.env.UI_AUTH_PASSWORD || '',
  },
  adminToken = process.env.WA_MANUAL_OPEN_ADMIN_TOKEN || sharedSecret
): RequestHandler {
  const hmac = createHMACAuth(sharedSecret);
  return (req, res, next): void => {
    const path = req.originalUrl.split('?')[0];
    const health = req.method === 'GET' && path === '/api/v1/health';
    const authorization = req.headers.authorization || '';
    const hasCredentials = Boolean(
      authorization || req.headers['x-connector-signature'] || req.headers['x-connector-timestamp']
    );
    if (health && !hasCredentials) {
      res.json({ status: 'alive' });
      return;
    }
    const uiPath =
      (req.method === 'GET' &&
        ['/', '/qr', '/qr/page', '/status', '/api/v1/health', '/api/v1/auth/qr'].includes(path)) ||
      (req.method === 'POST' && path === '/qr/renew');
    if (uiPath && ui.username && ui.password && authorization.startsWith('Basic ')) {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const userMatches = secretEquals(decoded.slice(0, separator), ui.username);
      const passwordMatches = secretEquals(decoded.slice(separator + 1), ui.password);
      if (separator >= 0 && userMatches && passwordMatches) {
        res.setHeader('Cache-Control', 'no-store');
        next();
        return;
      }
    }
    if (
      (path.startsWith('/api/v1/manual-open/') ||
        path === '/manual-open' ||
        path === '/manual-open/page') &&
      authorization.startsWith('Bearer ') &&
      secretEquals(authorization.slice(7).trim(), adminToken)
    ) {
      next();
      return;
    }
    const timestamp = req.headers['x-connector-timestamp'];
    const signature = req.headers['x-connector-signature'];
    if (
      !sharedSecret ||
      sharedSecret === 'dev-secret-change-in-production' ||
      typeof timestamp !== 'string' ||
      !/^\d+$/.test(timestamp) ||
      typeof signature !== 'string' ||
      !/^(sha256=)?[a-f0-9]{64}$/.test(signature)
    ) {
      if (uiPath)
        res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp connector", charset="UTF-8"');
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    hmac(req, res, next);
  };
}
