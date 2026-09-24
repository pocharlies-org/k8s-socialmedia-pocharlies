/**
 * Declarative registry of the provider accounts this MCP serves (ported from
 * the NAS fork: jibanez-staticduo/k8s-socialmedia-pocharlies account-registry,
 * adapted to SC-705/SC-1144).
 *
 * One entry per provider INSTANCE (a Baileys session, a Telegram connector, an
 * Instagram business account). The catalogue, connector routing, health
 * checks and DB namespaces derive from it — no account
 * name is special in the code any more.
 *
 * Who may use which account is NOT here: that stays in the SC-1144 identity
 * bindings (sub → accounts), which are validated against this registry.
 *
 * Source: the JSON file at SOCIAL_ACCOUNTS_FILE (ConfigMap `social-accounts`).
 * Without it, `defaultRegistry()` rebuilds exactly the accounts prod served
 * before the registry existed, from the same env vars, so rolling the image
 * before the ConfigMap is a no-op.
 */
import fs from 'node:fs';

export type AccountChannel = 'whatsapp' | 'telegram' | 'instagram';

export interface SocialAccount {
  channel: AccountChannel;
  accountId: string;
  label: string;
  transport: string;
  enabled: boolean;
  /** Connector base URL (WhatsApp / Telegram). */
  connectorUrl?: string;
  /** Telethon bridge URL (Telegram live unread). */
  bridgeUrl?: string;
  /**
   * DB namespace (the `account` column / id prefix). WhatsApp and Telegram
   * use their own accountId; an Instagram account declares which namespace its
   * rows are filed under.
   */
  namespace: string;
  /**
   * Profile (social_profiles): groups accounts of any channel for the UI and
   * permissions ("personal", "professional"...). Never decides storage.
   * Defaults to the namespace.
   */
  profile: string;
  capabilities: Record<string, boolean>;
}

const ID_RE = /^[a-z][a-z0-9_-]*$/;
const CHANNELS: readonly AccountChannel[] = ['whatsapp', 'telegram', 'instagram'];

const DEFAULT_TRANSPORT: Record<AccountChannel, string> = {
  whatsapp: 'baileys',
  telegram: 'mtcute',
  instagram: 'instagram-graph-api',
};

const DEFAULT_CAPABILITIES: Record<AccountChannel, Record<string, boolean>> = {
  whatsapp: {
    conversations: true,
    messages: true,
    media: true,
    send: true,
    templates: false,
    groups: true,
  },
  telegram: {
    conversations: true,
    messages: true,
    media: true,
    send: true,
    forums: true,
    interactions: true,
  },
  instagram: {
    conversations: true,
    messages: true,
    media: true,
    send: true,
    publish: true,
    comments: true,
    insights: true,
  },
};

export class AccountRegistryError extends Error {}

function httpUrl(value: unknown, field: string, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new AccountRegistryError(`${key}: ${field} must be a string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AccountRegistryError(`${key}: ${field} is not a URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new AccountRegistryError(`${key}: ${field} must be http(s) without credentials`);
  }
  return value.replace(/\/$/, '');
}

export function parseAccounts(value: unknown): SocialAccount[] {
  const entries = (value as { accounts?: unknown })?.accounts ?? value;
  if (!Array.isArray(entries)) {
    throw new AccountRegistryError('Account registry must be a JSON array (or {accounts: [...]})');
  }
  const seen = new Set<string>();
  const accounts = entries.map((item: any, index: number) => {
    if (!item || typeof item !== 'object') {
      throw new AccountRegistryError(`entry ${index} is not an object`);
    }
    const channel = item.channel as AccountChannel;
    if (!CHANNELS.includes(channel)) {
      throw new AccountRegistryError(`entry ${index}: unknown channel ${String(item.channel)}`);
    }
    if (typeof item.accountId !== 'string' || !ID_RE.test(item.accountId)) {
      throw new AccountRegistryError(`entry ${index}: invalid accountId ${String(item.accountId)}`);
    }
    const key = `${channel}:${item.accountId}`;
    if (seen.has(key)) throw new AccountRegistryError(`duplicate account ${key}`);
    seen.add(key);
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      throw new AccountRegistryError(`${key}: enabled must be a boolean`);
    }
    const namespace = channel === 'instagram' ? item.namespace : (item.namespace ?? item.accountId);
    if (typeof namespace !== 'string' || !ID_RE.test(namespace)) {
      throw new AccountRegistryError(`${key}: namespace is required and must be an account id`);
    }
    if (channel !== 'instagram' && namespace !== item.accountId) {
      throw new AccountRegistryError(`${key}: a ${channel} account is its own namespace`);
    }
    const profile = item.profile ?? namespace;
    if (typeof profile !== 'string' || !ID_RE.test(profile)) {
      throw new AccountRegistryError(`${key}: profile must be an account-style id`);
    }
    const connectorUrl = httpUrl(item.connectorUrl, 'connectorUrl', key);
    if (channel !== 'instagram' && !connectorUrl) {
      throw new AccountRegistryError(`${key}: connectorUrl is required`);
    }
    if (
      item.capabilities !== undefined &&
      (typeof item.capabilities !== 'object' ||
        Object.values(item.capabilities).some(v => typeof v !== 'boolean'))
    ) {
      throw new AccountRegistryError(`${key}: capabilities must map names to booleans`);
    }
    return {
      channel,
      accountId: item.accountId,
      label:
        typeof item.label === 'string' && item.label.trim() ? item.label.trim() : item.accountId,
      transport:
        typeof item.transport === 'string' && item.transport
          ? item.transport
          : DEFAULT_TRANSPORT[channel],
      enabled: item.enabled ?? true,
      connectorUrl,
      bridgeUrl: httpUrl(item.bridgeUrl, 'bridgeUrl', key),
      namespace,
      profile,
      capabilities: { ...DEFAULT_CAPABILITIES[channel], ...(item.capabilities || {}) },
    } as SocialAccount;
  });
  // An Instagram namespace must be a real WhatsApp/Telegram namespace, or its
  // rows would be filed under an account no reader filters for.
  const namespaces = new Set(accounts.filter(a => a.channel !== 'instagram').map(a => a.namespace));
  for (const a of accounts) {
    if (a.channel === 'instagram' && !namespaces.has(a.namespace)) {
      throw new AccountRegistryError(
        `instagram:${a.accountId}: namespace '${a.namespace}' is not a declared account`
      );
    }
  }
  if (!namespaces.has('personal')) {
    throw new AccountRegistryError("registry must declare the 'personal' namespace (bare ids)");
  }
  return accounts;
}

/** The accounts prod served before the registry, from the same env vars. */
export function defaultRegistry(env: NodeJS.ProcessEnv = process.env): SocialAccount[] {
  const wa = env.CONNECTOR_URL || 'http://whatsapp-connector:3001';
  const tg = env.TELEGRAM_CONNECTOR_URL || 'http://telegram-connector:3002';
  return parseAccounts([
    { channel: 'whatsapp', accountId: 'personal', connectorUrl: env.WHATSAPP_PERSONAL_URL || wa },
    {
      channel: 'whatsapp',
      accountId: 'professional',
      connectorUrl: env.WHATSAPP_PROFESSIONAL_URL || 'http://whatsapp-connector-professional:3001',
    },
    {
      channel: 'whatsapp',
      accountId: 'leila',
      connectorUrl: env.WHATSAPP_LEILA_URL || 'http://whatsapp-connector-leila:3001',
    },
    {
      channel: 'telegram',
      accountId: 'personal',
      connectorUrl: env.TELEGRAM_PERSONAL_URL || tg,
      bridgeUrl: env.TELEGRAM_BRIDGE_URL || 'http://telegram-sync:3080',
    },
    {
      channel: 'telegram',
      accountId: 'professional',
      connectorUrl: env.TELEGRAM_PROFESSIONAL_URL || 'http://telegram-connector-professional:3002',
      bridgeUrl: env.TELEGRAM_BRIDGE_PROFESSIONAL_URL || 'http://telegram-sync-professional:3080',
    },
    { channel: 'instagram', accountId: 'skirmshop', namespace: 'professional' },
    { channel: 'instagram', accountId: 'barbelpapis', namespace: 'personal' },
  ]);
}

// Cache keyed on (path, mtime, size), same reload mechanism as the identity
// bindings: editing the ConfigMap takes effect without a restart.
let cache: { key: string; data: SocialAccount[] } | null = null;

/**
 * Every declared account (enabled and disabled). Fail-closed: a configured but
 * unreadable/invalid file throws instead of silently falling back.
 */
export function allAccounts(env: NodeJS.ProcessEnv = process.env): SocialAccount[] {
  const file = env.SOCIAL_ACCOUNTS_FILE;
  if (!file) {
    const key = 'default';
    if (cache?.key !== key) cache = { key, data: defaultRegistry(env) };
    return cache.data;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (error) {
    throw new AccountRegistryError(`SOCIAL_ACCOUNTS_FILE ${file} is unreadable (${String(error)})`);
  }
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  if (cache?.key === key) return cache.data;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new AccountRegistryError(
      `SOCIAL_ACCOUNTS_FILE ${file} is not valid JSON (${String(error)})`
    );
  }
  cache = { key, data: parseAccounts(raw) };
  return cache.data;
}

/** Test seam. */
export function resetAccountRegistryCache(): void {
  cache = null;
}

export function getAccounts(channel?: AccountChannel, includeDisabled = false): SocialAccount[] {
  return allAccounts().filter(
    a => (!channel || a.channel === channel) && (includeDisabled || a.enabled)
  );
}

export function findAccount(channel: AccountChannel, accountId: string): SocialAccount | undefined {
  return getAccounts(channel).find(a => a.accountId === accountId);
}

export function requireAccount(channel: AccountChannel, accountId: string): SocialAccount {
  const account = findAccount(channel, accountId);
  if (!account)
    throw new AccountRegistryError(`Unknown or disabled ${channel} account: ${accountId}`);
  return account;
}

/**
 * DB namespaces. Includes disabled accounts: their historical rows keep their
 * prefix and must still be recognised by stripAccount.
 */
export function accountNamespaces(): string[] {
  return [...new Set(getAccounts(undefined, true).map(a => a.namespace))];
}

/** Namespaces that currently accept traffic. */
export function activeNamespaces(): string[] {
  return [...new Set(getAccounts().map(a => a.namespace))];
}

/** Every account id declared on any channel (for identity-binding validation). */
export function declaredAccountIds(): Set<string> {
  return new Set(getAccounts(undefined, true).map(a => a.accountId));
}

/** Primary key of the account in social_accounts: '<channel>:<accountId>'. */
export function socialAccountId(channel: AccountChannel, accountId: string): string {
  return `${channel}:${accountId}`;
}
