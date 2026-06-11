import { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

export interface AuthenticatedRequest extends Request {
  authenticated?: boolean;
}

export function createHMACAuth(sharedSecret: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const signature = req.headers['x-connector-signature'];
    const timestamp = req.headers['x-connector-timestamp'];

    if (typeof signature !== 'string' || typeof timestamp !== 'string') {
      res.status(401).json({ error: 'Missing authentication headers' });
      return;
    }

    const requestTime = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(requestTime) || Math.abs(now - requestTime) > 300) {
      res.status(401).json({ error: 'Request timestamp too old or too far in future' });
      return;
    }

    const body = JSON.stringify(req.body || {});
    const expectedSignature = createHmac('sha256', sharedSecret)
      .update(`${timestamp}:${body}`)
      .digest('hex');
    const providedSignature = signature.replace(/^sha256=/, '');

    if (providedSignature.length !== expectedSignature.length) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const valid = timingSafeEqual(
      Buffer.from(providedSignature, 'utf8'),
      Buffer.from(expectedSignature, 'utf8')
    );
    if (!valid) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    req.authenticated = true;
    next();
  };
}
