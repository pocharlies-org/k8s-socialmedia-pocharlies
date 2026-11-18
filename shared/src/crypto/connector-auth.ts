import type { NextFunction, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

export interface AuthenticatedRequest extends Request {
  authenticated?: boolean;
}

export type HMACRejectReason = 'missing_headers' | 'stale_timestamp' | 'invalid_signature';

/**
 * The HMAC gate of a connector router: sha256=HMAC(secret, "<ts>:<JSON body>") in
 * x-connector-signature and x-connector-timestamp, a 5-minute window, a constant-time
 * comparison. A GET has no body, so it signs "{}" (express.json leaves req.body = {}).
 * `onReject` sees every refusal and its reason; see createHMACRejectLog.
 */
export function createHMACAuth(
  sharedSecret: string,
  onReject?: (req: Request, reason: HMACRejectReason) => void
) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const signature = req.headers['x-connector-signature'] as string;
    const timestamp = req.headers['x-connector-timestamp'] as string;

    if (!signature || !timestamp) {
      onReject?.(req, 'missing_headers');
      res.status(401).json({ error: 'Missing authentication headers' });
      return;
    }

    // Check timestamp (5 minute window)
    const requestTime = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    const timeDiff = Math.abs(now - requestTime);

    // A non-numeric timestamp gives NaN, and NaN > 300 is false: it must not skip the window.
    if (!Number.isFinite(timeDiff) || timeDiff > 300) {
      onReject?.(req, 'stale_timestamp');
      res.status(401).json({ error: 'Request timestamp too old or too far in future' });
      return;
    }

    // Verify HMAC signature
    const body = JSON.stringify(req.body);
    const message = `${timestamp}:${body}`;
    const expectedSignature = createHmac('sha256', sharedSecret).update(message).digest('hex');

    const providedSignature = signature.replace('sha256=', '');

    // Use timing-safe comparison
    if (providedSignature.length !== expectedSignature.length) {
      onReject?.(req, 'invalid_signature');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const isValid = timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature));

    if (!isValid) {
      onReject?.(req, 'invalid_signature');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    req.authenticated = true;
    next();
  };
}

/** One rejection line per reason per this many ms; the rest are counted, not printed. */
const REJECT_LOG_INTERVAL_MS = 10_000;

/**
 * The `onReject` of a gate that leaves one line per refusal (method, route, origin IP, reason),
 * so a caller nobody listed shows up in minutes. Never headers, body, signature or query; the
 * route stops at its first segment under the mount, so an id further down is not logged either.
 */
export function createHMACRejectLog(
  label: string,
  { log = console.warn, now = Date.now }: { log?: (line: string) => void; now?: () => number } = {}
): (req: Request, reason: HMACRejectReason) => void {
  const lastLogged = new Map<HMACRejectReason, { at: number; suppressed: number }>();
  return (req, reason) => {
    const entry = lastLogged.get(reason);
    if (entry && now() - entry.at < REJECT_LOG_INTERVAL_MS) {
      entry.suppressed += 1;
      return;
    }
    const route = `${req.baseUrl}/${req.path.split('/')[1] ?? ''}`;
    log(
      `[${label}] rejected ${req.method} ${route} ip=${req.ip} reason=${reason} suppressed=${entry?.suppressed ?? 0}`
    );
    lastLogged.set(reason, { at: now(), suppressed: 0 });
  };
}
