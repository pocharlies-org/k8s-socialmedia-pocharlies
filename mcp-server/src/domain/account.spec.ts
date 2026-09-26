import { join } from 'node:path';
import { accountKey, stripAccount, normalizeAccount } from './account';
import { parseAccounts, requireAccount } from './account-registry';

beforeAll(() => { process.env.SOCIAL_ACCOUNTS_FILE = join(__dirname, 'accounts.fixture.json'); });

describe('registry account isolation', () => {
  test('preserves personal legacy IDs and native device JID colons', () => {
    expect(accountKey('personal', '123:4@s.whatsapp.net')).toBe('123:4@s.whatsapp.net');
    expect(stripAccount('123:4@s.whatsapp.net').id).toBe('123:4@s.whatsapp.net');
  });
  test('round trips an arbitrary third account and does not collide', () => {
    expect(accountKey('arbitrary_3', 'same')).toBe('arbitrary_3:same');
    expect(accountKey('secondary', 'same')).not.toBe(accountKey('arbitrary_3', 'same'));
    expect(stripAccount(accountKey('arbitrary_3', 'same'))).toEqual({ account: 'arbitrary_3', id: 'same' });
    expect(accountKey('arbitrary_3', 'arbitrary_3:same')).toBe('arbitrary_3:same');
    expect(() => accountKey('secondary', 'arbitrary_3:same')).toThrow('Cross-account');
  });
  test('rejects unknown, disabled and wrong-channel selectors', () => {
    for (const value of ['unknown', 'disabled', null]) expect(() => normalizeAccount(value)).toThrow();
    expect(() => requireAccount('instagram', 'secondary')).toThrow();
  });
  test('validates registry IDs and duplicate entries', () => {
    expect(() => parseAccounts([{ channel: 'whatsapp', accountId: 'bad:name' }])).toThrow();
    const a = requireAccount('whatsapp', 'personal');
    expect(() => parseAccounts([a, a])).toThrow('Duplicate');
  });
});
