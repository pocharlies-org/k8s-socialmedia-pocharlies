import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountKey, stripAccount, normalizeAccount, accountList } from './account';
import { AccountRegistryError, resetAccountRegistryCache } from './account-registry';

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

  // SKIRM-107 (guard adoptado del fork NAS, jibanez-staticduo): un id ya
  // namespaced a OTRA cuenta no se escribe ni se lee bajo esta.
  describe('cross-account guard', () => {
    it('rejects an id namespaced to another account, personal included', () => {
      expect(() => accountKey('professional', 'leila:123')).toThrow(AccountRegistryError);
      expect(() => accountKey('professional', 'leila:123')).toThrow('Cross-account identifier');
      expect(() => accountKey('personal', 'leila:123')).toThrow('Cross-account identifier');
      expect(() => accountKey('leila', 'professional:123@s.whatsapp.net')).toThrow(
        'Cross-account identifier'
      );
    });

    it('keeps the idempotent and bare cases', () => {
      expect(accountKey('professional', 'professional:123')).toBe('professional:123');
      expect(accountKey('leila', 'leila:123')).toBe('leila:123');
      expect(accountKey('personal', '123')).toBe('123');
      expect(accountKey('professional', '123')).toBe('professional:123');
    });

    it('does not read a native JID colon as another account', () => {
      expect(accountKey('professional', '34660242739:12@s.whatsapp.net')).toBe(
        'professional:34660242739:12@s.whatsapp.net'
      );
      expect(accountKey('personal', '34660242739:12@s.whatsapp.net')).toBe(
        '34660242739:12@s.whatsapp.net'
      );
    });

    describe('with a disabled account in the registry', () => {
      let dir: string;
      const previous = process.env.SOCIAL_ACCOUNTS_FILE;
      beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-guard-'));
        const file = path.join(dir, 'accounts.json');
        const wa = (accountId: string, extra: object = {}) => ({
          channel: 'whatsapp',
          accountId,
          connectorUrl: `http://wa-${accountId}:3001`,
          ...extra,
        });
        fs.writeFileSync(
          file,
          JSON.stringify([wa('personal'), wa('professional'), wa('old', { enabled: false })])
        );
        process.env.SOCIAL_ACCOUNTS_FILE = file;
        resetAccountRegistryCache();
      });
      afterAll(() => {
        if (previous === undefined) delete process.env.SOCIAL_ACCOUNTS_FILE;
        else process.env.SOCIAL_ACCOUNTS_FILE = previous;
        resetAccountRegistryCache();
        fs.rmSync(dir, { recursive: true, force: true });
      });

      // accountKey does not validate the account (no normalizeAccount): the
      // account-less search walks disabled namespaces too, and their historical
      // rows keep their prefix.
      it('a disabled account still namespaces, and its own prefix is still idempotent', () => {
        expect(accountKey('old', '123')).toBe('old:123');
        expect(accountKey('old', 'old:123')).toBe('old:123');
      });

      it('a disabled account namespace still counts as another account for the guard', () => {
        expect(() => accountKey('professional', 'old:123')).toThrow('Cross-account identifier');
        expect(() => accountKey('old', 'professional:123')).toThrow('Cross-account identifier');
      });
    });
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
