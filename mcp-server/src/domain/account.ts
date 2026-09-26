import { getAccounts, type AccountChannel } from './account-registry';
export type Account = string;

export function normalizeAccount(value: unknown, channel?: AccountChannel): Account {
  const id = value === undefined ? 'personal' : value;
  if (typeof id !== 'string' || !getAccounts(channel).some(item => item.accountId === id)) {
    throw new Error(`Unknown or disabled account: ${String(id)}`);
  }
  return id;
}

/** Personal retains legacy bare IDs. Other accounts have explicit prefixes. */
export function accountKey(account: Account, id: string): string {
  normalizeAccount(account);
  const parsed = stripAccount(id);
  if (parsed.id !== id && parsed.account !== account) throw new Error('Cross-account identifier');
  if (account === 'personal') return id;
  const prefix = `${account}:`;
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

/** Recognize only declared prefixes; a native JID device colon is not an account. */
export function stripAccount(key: string): { account: Account; id: string } {
  for (const item of getAccounts(undefined, true)) {
    const prefix = `${item.accountId}:`;
    if (key.startsWith(prefix)) return { account: item.accountId, id: key.slice(prefix.length) };
  }
  return { account: 'personal', id: key };
}
