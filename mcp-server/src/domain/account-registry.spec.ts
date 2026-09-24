import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  AccountRegistryError,
  accountNamespaces,
  activeNamespaces,
  allAccounts,
  defaultRegistry,
  getAccounts,
  parseAccounts,
  requireAccount,
  resetAccountRegistryCache,
} from './account-registry';
import { normalizeAccount, stripAccount } from './account';

const REPO = path.resolve(__dirname, '../../..');

function withRegistry(entries: unknown, fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-'));
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(file, JSON.stringify(entries));
  const previous = process.env.SOCIAL_ACCOUNTS_FILE;
  process.env.SOCIAL_ACCOUNTS_FILE = file;
  resetAccountRegistryCache();
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.SOCIAL_ACCOUNTS_FILE;
    else process.env.SOCIAL_ACCOUNTS_FILE = previous;
    resetAccountRegistryCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const wa = (accountId: string, extra: object = {}) => ({
  channel: 'whatsapp',
  accountId,
  connectorUrl: `http://wa-${accountId}:3001`,
  ...extra,
});

describe('account registry', () => {
  afterEach(() => resetAccountRegistryCache());

  it('default registry reproduces the seven accounts prod served before the registry', () => {
    const accounts = defaultRegistry({});
    expect(accounts.map(a => `${a.channel}:${a.accountId}`)).toEqual([
      'whatsapp:personal',
      'whatsapp:professional',
      'whatsapp:leila',
      'telegram:personal',
      'telegram:professional',
      'instagram:skirmshop',
      'instagram:barbelpapis',
    ]);
    const byKey = Object.fromEntries(accounts.map(a => [`${a.channel}:${a.accountId}`, a]));
    expect(byKey['whatsapp:personal'].connectorUrl).toBe('http://whatsapp-connector:3001');
    expect(byKey['whatsapp:professional'].requireInboundBeforeSend).toBe(true);
    expect(byKey['whatsapp:personal'].requireInboundBeforeSend).toBe(false);
    expect(byKey['telegram:professional'].bridgeUrl).toBe('http://telegram-sync-professional:3080');
    expect(byKey['instagram:skirmshop'].namespace).toBe('professional');
    expect(byKey['instagram:barbelpapis'].namespace).toBe('personal');
  });

  it('default registry honours the same env overrides as before', () => {
    const accounts = defaultRegistry({ WHATSAPP_LEILA_URL: 'http://leila.svc:3001/' });
    expect(accounts.find(a => a.accountId === 'leila')?.connectorUrl).toBe('http://leila.svc:3001');
  });

  it('the prod ConfigMap registry (k8s/base/social-accounts.json) is valid and equals the default one', () => {
    const fromFile = parseAccounts(
      JSON.parse(fs.readFileSync(path.join(REPO, 'k8s/base/social-accounts.json'), 'utf8'))
    );
    const env = {
      CONNECTOR_URL: 'http://whatsapp-connector.whatsapp-mcp.svc.cluster.local:3001',
      WHATSAPP_PROFESSIONAL_URL:
        'http://whatsapp-connector-professional.whatsapp-mcp.svc.cluster.local:3001',
      WHATSAPP_LEILA_URL: 'http://whatsapp-connector-leila.whatsapp-mcp.svc.cluster.local:3001',
      TELEGRAM_CONNECTOR_URL: 'http://telegram-connector.whatsapp-mcp.svc.cluster.local:3002',
      TELEGRAM_PROFESSIONAL_URL:
        'http://telegram-connector-professional.whatsapp-mcp.svc.cluster.local:3002',
      TELEGRAM_BRIDGE_URL: 'http://telegram-sync.whatsapp-mcp.svc.cluster.local:3080',
      TELEGRAM_BRIDGE_PROFESSIONAL_URL:
        'http://telegram-sync-professional.whatsapp-mcp.svc.cluster.local:3080',
    };
    const strip = (list: ReturnType<typeof parseAccounts>) =>
      list.map(({ label: _label, ...rest }) => rest);
    expect(strip(fromFile)).toEqual(strip(defaultRegistry(env)));
  });

  it('prod identity bindings only reference declared accounts', () => {
    const doc = yaml.load(
      fs.readFileSync(path.join(REPO, 'k8s/base/social-identity-bindings.yaml'), 'utf8')
    ) as { bindings: Array<{ accounts?: string[] }> };
    const declared = new Set(defaultRegistry({}).map(a => a.accountId));
    for (const entry of doc.bindings) {
      for (const account of entry.accounts || []) expect(declared).toContain(account);
    }
  });

  it('a third account with an arbitrary name works by configuration only', () => {
    withRegistry([wa('personal'), wa('shop_2')], () => {
      expect(normalizeAccount('shop_2')).toBe('shop_2');
      expect(stripAccount('shop_2:123@s.whatsapp.net')).toEqual({
        account: 'shop_2',
        id: '123@s.whatsapp.net',
      });
      expect(() => normalizeAccount('professional')).toThrow(AccountRegistryError);
    });
  });

  it('a disabled account is refused but its historical prefix is still recognised', () => {
    withRegistry([wa('personal'), wa('old', { enabled: false })], () => {
      expect(activeNamespaces()).toEqual(['personal']);
      expect(accountNamespaces()).toContain('old');
      expect(() => normalizeAccount('old')).toThrow(/Unknown or disabled/);
      expect(() => requireAccount('whatsapp', 'old')).toThrow(/Unknown or disabled/);
      expect(stripAccount('old:x')).toEqual({ account: 'old', id: 'x' });
      expect(getAccounts('whatsapp').map(a => a.accountId)).toEqual(['personal']);
    });
  });

  it('two instagram accounts may share one namespace; the namespace must exist', () => {
    const ig = (accountId: string, namespace: string) => ({
      channel: 'instagram',
      accountId,
      namespace,
    });
    expect(parseAccounts([wa('personal'), ig('a', 'personal'), ig('b', 'personal')])).toHaveLength(
      3
    );
    expect(() => parseAccounts([wa('personal'), ig('a', 'ghost')])).toThrow(
      /not a declared account/
    );
    expect(() => parseAccounts([wa('personal'), { channel: 'instagram', accountId: 'a' }])).toThrow(
      /namespace is required/
    );
  });

  it.each([
    [[wa('personal'), wa('personal')], /duplicate account/],
    [[wa('Personal')], /invalid accountId/],
    [[{ channel: 'sms', accountId: 'x' }], /unknown channel/],
    [[{ channel: 'whatsapp', accountId: 'personal' }], /connectorUrl is required/],
    [[wa('personal', { connectorUrl: 'http://u:p@host' })], /without credentials/],
    [[wa('personal', { connectorUrl: 'file:///etc/passwd' })], /http\(s\)/],
    [[wa('personal', { namespace: 'other' })], /its own namespace/],
    [
      [
        wa('personal'),
        {
          channel: 'telegram',
          accountId: 'personal',
          connectorUrl: 'http://tg',
          requireInboundBeforeSend: true,
        },
      ],
      /only applies to WhatsApp accounts/,
    ],
    [[wa('personal', { profile: 'Bad Profile' })], /profile must be/],
    [[wa('shop')], /'personal' namespace/],
    [{ nope: true }, /JSON array/],
  ])('rejects an invalid registry %#', (entries, error) => {
    expect(() => parseAccounts(entries)).toThrow(error);
  });

  it('allows the inbound gate on any WhatsApp account and defaults profile to the namespace', () => {
    const [personal, leila] = parseAccounts([
      wa('personal', { requireInboundBeforeSend: true }),
      wa('leila', { profile: 'family' }),
    ]);
    expect(personal.requireInboundBeforeSend).toBe(true);
    expect(personal.profile).toBe('personal');
    expect(leila.profile).toBe('family');
  });

  it('fails closed on a configured but unreadable or invalid file', () => {
    const previous = process.env.SOCIAL_ACCOUNTS_FILE;
    process.env.SOCIAL_ACCOUNTS_FILE = '/nonexistent/accounts.json';
    resetAccountRegistryCache();
    try {
      expect(() => allAccounts()).toThrow(/unreadable/);
    } finally {
      if (previous === undefined) delete process.env.SOCIAL_ACCOUNTS_FILE;
      else process.env.SOCIAL_ACCOUNTS_FILE = previous;
      resetAccountRegistryCache();
    }
  });

  it('accepts the {accounts: [...]} envelope', () => {
    expect(parseAccounts({ accounts: [wa('personal')] })).toHaveLength(1);
  });
});
