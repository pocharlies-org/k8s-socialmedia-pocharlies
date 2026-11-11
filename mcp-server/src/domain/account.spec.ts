import { join } from 'node:path';
import { accountKey, stripAccount, normalizeAccount, accountList } from './account';
import { parseAccounts, requireAccount, resetAccountRegistryCache } from './account-registry';

const FIXTURE = join(__dirname, 'accounts.fixture.json');

/** Point the registry at the NAS multi-account fixture and reload it. */
function useFixtureRegistry(): void {
  process.env.SOCIAL_ACCOUNTS_FILE = FIXTURE;
  resetAccountRegistryCache();
}

/**
 * Upstream's account helpers specs run against the built-in default registry
 * (personal / professional / leila + the two Instagram accounts), which is what
 * a deployment without SOCIAL_ACCOUNTS_FILE gets.
 */
function useDefaultRegistry(): void {
  delete process.env.SOCIAL_ACCOUNTS_FILE;
  resetAccountRegistryCache();
}

describe('registry account isolation (NAS fixture)', () => {
  beforeAll(() => useFixtureRegistry());
  afterAll(() => useDefaultRegistry());

  test('preserves personal legacy IDs and native device JID colons', () => {
    expect(accountKey('personal', '123:4@s.whatsapp.net')).toBe('123:4@s.whatsapp.net');
    expect(stripAccount('123:4@s.whatsapp.net').id).toBe('123:4@s.whatsapp.net');
  });

  test('round trips an arbitrary third account and does not collide', () => {
    expect(accountKey('arbitrary_3', 'same')).toBe('arbitrary_3:same');
    expect(accountKey('secondary', 'same')).not.toBe(accountKey('arbitrary_3', 'same'));
    expect(stripAccount(accountKey('arbitrary_3', 'same'))).toEqual({
      account: 'arbitrary_3',
      id: 'same',
    });
    expect(accountKey('arbitrary_3', 'arbitrary_3:same')).toBe('arbitrary_3:same');
    expect(() => accountKey('secondary', 'arbitrary_3:same')).toThrow('Cross-account');
  });

  test('rejects unknown, disabled and wrong-channel selectors', () => {
    for (const value of ['unknown', 'disabled']) expect(() => normalizeAccount(value)).toThrow();
    // An omitted selector keeps the historical default (upstream semantics).
    expect(normalizeAccount(undefined)).toBe('personal');
    expect(normalizeAccount(null)).toBe('personal');
    expect(normalizeAccount('instagram', 'instagram')).toBe('instagram');
    expect(() => normalizeAccount('secondary', 'instagram')).toThrow(/instagram account/);
    expect(() => requireAccount('instagram', 'secondary')).toThrow();
  });

  test('validates registry IDs and duplicate entries', () => {
    expect(() => parseAccounts([{ channel: 'whatsapp', accountId: 'bad:name' }])).toThrow(
      /invalid accountId/
    );
    const a = requireAccount('whatsapp', 'personal');
    expect(() => parseAccounts([a, a])).toThrow(/duplicate account/);
  });
});

describe('account helpers (default registry)', () => {
  beforeAll(() => useDefaultRegistry());

  it('keeps personal ids bare (no backfill of existing rows)', () => {
    expect(accountKey('personal', '34660242739@s.whatsapp.net')).toBe('34660242739@s.whatsapp.net');
    expect(accountKey('personal', 'tg_123')).toBe('tg_123');
  });

  it('namespaces professional ids', () => {
    expect(accountKey('professional', 'tg_123')).toBe('professional:tg_123');
    expect(accountKey('professional', '3EB0ABC')).toBe('professional:3EB0ABC');
  });

  it('namespaces leila ids (SC-1144 fase 2)', () => {
    expect(accountKey('leila', '34660242739@s.whatsapp.net')).toBe(
      'leila:34660242739@s.whatsapp.net'
    );
    expect(accountKey('leila', 'leila:tg_123')).toBe('leila:tg_123'); // idempotent
    expect(stripAccount('leila:tg_123')).toEqual({ account: 'leila', id: 'tg_123' });
  });

  it('does NOT collide across accounts for the same raw id', () => {
    expect(accountKey('personal', 'x')).not.toBe(accountKey('professional', 'x'));
  });

  it('accountKey is idempotent (never double-prefixes an already-namespaced id)', () => {
    expect(accountKey('professional', 'professional:tg_123')).toBe('professional:tg_123');
    expect(accountKey('professional', accountKey('professional', 'tg_123'))).toBe(
      'professional:tg_123'
    );
    expect(accountKey('personal', 'tg_123')).toBe('tg_123');
  });

  it('round-trips accountKey <-> stripAccount for every account', () => {
    for (const a of accountList()) {
      const raw = 'tg_999_42';
      expect(stripAccount(accountKey(a, raw))).toEqual({ account: a, id: raw });
    }
  });

  it('never reads a native JID colon as an account prefix', () => {
    expect(stripAccount('34660242739:12@s.whatsapp.net')).toEqual({
      account: 'personal',
      id: '34660242739:12@s.whatsapp.net',
    });
  });

  it('treats an un-prefixed key as personal', () => {
    expect(stripAccount('34660242739@s.whatsapp.net')).toEqual({
      account: 'personal',
      id: '34660242739@s.whatsapp.net',
    });
  });

  it('normalizeAccount defaults to personal and validates', () => {
    expect(normalizeAccount(undefined)).toBe('personal');
    expect(normalizeAccount('personal')).toBe('personal');
    expect(normalizeAccount('professional')).toBe('professional');
    expect(normalizeAccount('leila')).toBe('leila');
    expect(normalizeAccount(null)).toBe('personal');
    // Unknown accounts no longer fall back to personal (NAS fork audit P1).
    expect(() => normalizeAccount('garbage')).toThrow(/Unknown or disabled account/);
    // An Instagram account id is not a DB namespace: it files under its own one.
    expect(() => normalizeAccount('skirmshop')).toThrow(/Unknown or disabled account/);
  });
});
