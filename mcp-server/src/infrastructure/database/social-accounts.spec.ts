import { useTestAccounts } from '../../domain/test-accounts';
import {
  ConversationResolver,
  syncSocialAccounts,
  syncSocialAccountsBestEffort,
} from './social-accounts';
import { fakeSocialDb } from './fake-social-db';

describe('syncSocialAccounts', () => {
  it('upserts every registry account with its profile and disables the undeclared ones', async () => {
    useTestAccounts({ whatsapp: { personal: 'http://wa', professional: 'http://wa-pro' } });
    const calls: Array<[string, unknown[]]> = [];
    const n = await syncSocialAccounts({
      query: async (sql: string, params: unknown[] = []) => {
        calls.push([sql, params]);
        return { rows: [] };
      },
    });
    expect(n).toBeGreaterThanOrEqual(2);
    const upserts = calls.filter(([sql]) => sql.includes('INSERT INTO social_accounts'));
    expect(upserts.map(([, p]) => p[0])).toEqual(
      expect.arrayContaining(['whatsapp:personal', 'whatsapp:professional'])
    );
    const disable = calls.find(([sql]) => sql.includes('SET enabled = FALSE'));
    expect(disable?.[1][0]).toEqual(upserts.map(([, p]) => p[0]));
    expect(calls.some(([sql]) => sql.includes('DELETE FROM social_accounts'))).toBe(false);
  });

  it('never throws at startup (pre-008 DB)', async () => {
    const log = jest.fn();
    await syncSocialAccountsBestEffort(
      { query: async () => Promise.reject(new Error('relation "social_accounts" does not exist')) },
      log
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sync skipped'));
  });
});

describe('ConversationResolver', () => {
  const PRO = 'whatsapp:professional';
  const db = fakeSocialDb(
    [
      { id: 'professional:1@lid', account_id: PRO, external_id: '1@lid' },
      {
        id: 'professional:34600000001@s.whatsapp.net',
        account_id: PRO,
        external_id: '34600000001@s.whatsapp.net',
        merged_into: 'professional:1@lid',
      },
      { id: '9@lid', account_id: 'whatsapp:personal', external_id: '9@lid' },
    ],
    [
      {
        account_id: PRO,
        alias_external_id: '34600000002@s.whatsapp.net',
        canonical_external_id: '1@lid',
        evidence: 'senderPnE164',
      },
    ]
  );
  const r = new ConversationResolver(db);

  it.each([
    ['opaque id', 'professional:1@lid'],
    ['external id', '1@lid'],
    ['tombstone id', 'professional:34600000001@s.whatsapp.net'],
    ['tombstone external id', '34600000001@s.whatsapp.net'],
    ['contact alias', '34600000002@s.whatsapp.net'],
  ])('resolves a %s to the canonical conversation', async (_label, ref) => {
    expect((await r.resolve('whatsapp', 'professional', ref))?.id).toBe('professional:1@lid');
  });

  it('returns a foreign row so callers can refuse it, and null for unknown refs', async () => {
    const foreign = await r.resolve('whatsapp', 'professional', '9@lid');
    expect(foreign && ConversationResolver.belongsTo(foreign, 'whatsapp', 'professional')).toBe(
      false
    );
    expect(await r.resolve('whatsapp', 'professional', 'nope@lid')).toBeNull();
  });
});
