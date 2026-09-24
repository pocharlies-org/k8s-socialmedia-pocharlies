/**
 * Multi-account DB namespace helpers.
 *
 * DB scoping strategy (migration 002): a row's id is namespaced by account so
 * the existing PK/UNIQUE constraints stay globally valid across accounts.
 * "personal" keeps the bare id (so the ~449k pre-existing single-account rows
 * need NO backfill); every other account is prefixed with "<account>:".
 * The `account` column is a denormalized, indexed copy for fast read filtering.
 *
 * The set of namespaces comes from the account registry (account-registry.ts):
 * adding an account is configuration, not code. An unknown account is an
 * error — it used to fall back to 'personal' silently, filing another
 * account's rows under the personal namespace.
 */
import { AccountRegistryError, accountNamespaces, activeNamespaces } from './account-registry';

export type Account = string;

/** Enabled namespaces, read from the registry on each call (it reloads on change). */
export function accountList(): Account[] {
  return activeNamespaces();
}

/**
 * Validate/normalize an account selector coming from a tool arg or an event.
 * Omitted → 'personal' (the historical default). Anything else must be an
 * enabled namespace of the registry.
 */
export function normalizeAccount(value: unknown): Account {
  if (value === undefined || value === null || value === '') return 'personal';
  if (typeof value === 'string' && activeNamespaces().includes(value)) return value;
  throw new AccountRegistryError(`Unknown or disabled account: ${String(value)}`);
}

/**
 * Namespace an id by account. Personal stays bare; others are prefixed.
 * ADR 0001: only for MINTING the legacy opaque id when writing (and for
 * looking up a row by that id). The account of a stored row is its
 * `account_id` column — never re-derive it from this prefix.
 * Idempotent: an id that already carries the account prefix is returned
 * unchanged, so a namespaced id read back from the DB (and handed to a tool
 * again) is never double-prefixed.
 */
export function accountKey(account: Account, id: string): string {
  if (account === 'personal') return id;
  const prefix = `${account}:`;
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

/**
 * Inverse of accountKey: recover { account, id } from a (possibly namespaced)
 * key. ADR 0001: only for decoding a reference a CALLER handed us (tool input
 * holding a legacy id) or a connector payload — never for a DB row, whose
 * account/provider id are `account_id` / `external_id`. Only declared namespaces are prefixes — a native JID colon (device
 * suffix) is never read as an account.
 */
export function stripAccount(key: string): { account: Account; id: string } {
  for (const a of accountNamespaces()) {
    if (a !== 'personal' && key.startsWith(`${a}:`)) {
      return { account: a, id: key.slice(a.length + 1) };
    }
  }
  return { account: 'personal', id: key };
}
