/** Mint a legacy namespaced ID after the caller has validated the account. */
export function namespaceAccountId(account: string, id: string): string {
  if (account === 'personal') return id;
  const prefix = `${account}:`;
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}
