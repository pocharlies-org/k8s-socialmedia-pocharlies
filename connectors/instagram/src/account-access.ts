import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { InstagramConfig } from './instagram-api';

export interface ConfiguredAccount {
  name: string;
  secret: string;
  ready: boolean;
  config: InstagramConfig;
}

export function secretMatches(actual: string, expected: string): boolean {
  return Boolean(actual && expected) && timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}

export function loadConfiguredAccounts(env: NodeJS.ProcessEnv = process.env): Map<string, ConfiguredAccount> {
  if (!env.SOCIAL_ACCOUNTS_FILE) throw new Error('SOCIAL_ACCOUNTS_FILE is required');
  const document = JSON.parse(readFileSync(env.SOCIAL_ACCOUNTS_FILE, 'utf8'));
  const registry = Array.isArray(document) ? document : document.accounts;
  if (!Array.isArray(registry)) throw new Error('Invalid account registry');
  const accounts = new Map<string, ConfiguredAccount>();
  const prefixes = new Set<string>();
  for (const name of (env.INSTAGRAM_ACCOUNTS || '').split(',').map(value => value.trim()).filter(Boolean)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || accounts.has(name)) throw new Error('Invalid or duplicate Instagram account');
    const matches = registry.filter(item => item.channel === 'instagram' && item.accountId === name && item.enabled === true);
    if (matches.length !== 1) throw new Error(`Instagram account is unknown or disabled: ${name}`);
    const prefix = `INSTAGRAM_${name.toUpperCase().replace(/-/g, '_')}_`;
    if (prefixes.has(prefix)) throw new Error('Instagram environment prefix collision');
    prefixes.add(prefix);
    const config: InstagramConfig = {
      accessToken: env[`${prefix}ACCESS_TOKEN`] || '',
      businessAccountId: env[`${prefix}BUSINESS_ACCOUNT_ID`] || '',
      appId: env[`${prefix}APP_ID`] || env.FACEBOOK_APP_ID || '',
      appSecret: env[`${prefix}APP_SECRET`] || env.FACEBOOK_APP_SECRET || '',
      fbAccessToken: env[`${prefix}FB_ACCESS_TOKEN`] || undefined,
    };
    const secret = typeof matches[0].secretEnv === 'string' ? env[matches[0].secretEnv] || '' : '';
    accounts.set(name, { name, secret, ready: Boolean(config.accessToken && config.businessAccountId), config });
  }
  return accounts;
}

export function accountAuthorization(accounts: Map<string, ConfiguredAccount>): RequestHandler {
  return (req, res, next): void => {
    const account = accounts.get(req.params.account);
    if (!account) { res.status(404).json({ error: 'Unknown account' }); return; }
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    if (!secretMatches(token, account.secret)) { res.status(401).json({ error: 'Authentication required' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.path === '/status') {
      res.json({ status: account.ready ? 'configured' : 'setup-required', account: account.name, connected: false });
      return;
    }
    if (!account.ready) { res.status(503).json({ status: 'setup-required', account: account.name }); return; }
    next();
  };
}
