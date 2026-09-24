import { accountKey, stripAccount, normalizeAccount, accountList } from './account';

describe('account helpers', () => {
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
    expect(() => normalizeAccount('skirmshop')).toThrow(/Unknown or disabled account/);
  });
});
