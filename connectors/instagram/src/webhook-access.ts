import { createHmac } from 'node:crypto';
import type { RequestHandler } from 'express';
import { secretMatches, type ConfiguredAccount } from './account-access';

export function webhookAuthorization(accounts: Map<string, ConfiguredAccount>, ids: Map<string, string>, verifyToken: string): RequestHandler {
  return (req, res, next): void => {
    if (!verifyToken) { res.sendStatus(503); return; }
    if (req.method === 'GET') {
      if (!secretMatches(String(req.query['hub.verify_token'] || ''), verifyToken)) { res.sendStatus(403); return; }
      next(); return;
    }
    if (req.method !== 'POST') { res.sendStatus(405); return; }
    const signature = req.headers['x-hub-signature-256'];
    const raw = (req as typeof req & { rawBody?: Buffer }).rawBody;
    if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature) || !raw) { res.sendStatus(401); return; }
    if (req.body?.object !== 'instagram' || !Array.isArray(req.body.entry) || !req.body.entry.length) { res.sendStatus(400); return; }
    for (const entry of req.body.entry) {
      const recipients = [entry.id, ...(entry.messaging || []).map((item: any) => item.recipient?.id), ...(entry.changes || []).map((item: any) => item.value?.recipient?.id)].filter(Boolean);
      const names = recipients.map(id => ids.get(String(id)));
      if (!names.length || names.some(name => !name || name !== names[0])) { res.sendStatus(403); return; }
      const account = accounts.get(names[0]!);
      if (!account?.ready || !account.config.appSecret) { res.sendStatus(503); return; }
      const expected = `sha256=${createHmac('sha256', account.config.appSecret).update(raw).digest('hex')}`;
      if (!secretMatches(signature, expected)) { res.sendStatus(401); return; }
    }
    next();
  };
}
