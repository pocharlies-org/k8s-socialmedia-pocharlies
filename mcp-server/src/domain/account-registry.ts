import { readFileSync } from 'node:fs';

export type AccountChannel = 'whatsapp' | 'telegram' | 'instagram';
export interface SocialAccount {
  channel: AccountChannel;
  accountId: string;
  label: string;
  connectorUrl: string;
  enabled: boolean;
  qrUrl?: string;
  secretEnv?: string;
  requireInboundBeforeSend?: boolean;
}

export function parseAccounts(value: unknown): SocialAccount[] {
  if (!Array.isArray(value)) throw new Error('Account registry must be a JSON array');
  const seen = new Set<string>();
  return value.map(item => {
    if (
      !item ||
      !['whatsapp', 'telegram', 'instagram'].includes(item.channel) ||
      typeof item.accountId !== 'string' ||
      !/^[a-z][a-z0-9_-]*$/.test(item.accountId) ||
      typeof item.label !== 'string' ||
      !item.label.trim() ||
      typeof item.enabled !== 'boolean' ||
      typeof item.connectorUrl !== 'string'
    )
      throw new Error('Invalid account registry entry');
    const url = new URL(item.connectorUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Invalid connector URL');
    if (item.qrUrl !== undefined && !/^https?:$/.test(new URL(item.qrUrl).protocol))
      throw new Error('Invalid QR URL');
    if (
      item.requireInboundBeforeSend !== undefined &&
      typeof item.requireInboundBeforeSend !== 'boolean'
    )
      throw new Error('Invalid sending policy');
    if (
      item.secretEnv !== undefined &&
      (typeof item.secretEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(item.secretEnv))
    )
      throw new Error('Invalid secret environment reference');
    const key = `${item.channel}:${item.accountId}`;
    if (seen.has(key)) throw new Error(`Duplicate account: ${key}`);
    seen.add(key);
    return { ...item, connectorUrl: item.connectorUrl.replace(/\/$/, '') };
  });
}

export function getAccounts(channel?: AccountChannel, includeDisabled = false): SocialAccount[] {
  const file = process.env.SOCIAL_ACCOUNTS_FILE;
  if (!file) throw new Error('SOCIAL_ACCOUNTS_FILE must be configured');
  return parseAccounts(JSON.parse(readFileSync(file, 'utf8'))).filter(
    item => (!channel || item.channel === channel) && (includeDisabled || item.enabled)
  );
}

export function requireAccount(channel: AccountChannel, accountId: string): SocialAccount {
  const account = getAccounts(channel).find(item => item.accountId === accountId);
  if (!account) throw new Error(`Unknown or disabled ${channel} account: ${accountId}`);
  return account;
}

export function connectorSecretFor(account: SocialAccount): string {
  const secret = account.secretEnv
    ? process.env[account.secretEnv]
    : process.env.CONNECTOR_SHARED_SECRET;
  if (!secret)
    throw new Error(`Missing connector secret for ${account.channel}:${account.accountId}`);
  return secret;
}
