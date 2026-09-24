/**
 * Multicuenta de primera clase (docs/adr/0001-multiaccount-first-class.md).
 *
 * - syncSocialAccounts: the registry (k8s/base/social-accounts.json) is the
 *   source of social_accounts / social_profiles. Upsert only — an account that
 *   leaves the registry is disabled, never deleted (its rows keep their FK).
 * - ConversationResolver: the ONE way the MCP turns a conversation reference
 *   into a row. A reference is either the opaque `id` or the provider id
 *   (`external_id`) of the requested account, or an alias of it; the result is
 *   always the canonical conversation (tombstones follow `merged_into`). The
 *   account comes from the row's `account_id`, never from an id prefix.
 */
import { getAccounts, socialAccountId, type AccountChannel } from '../../domain/account-registry';

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export async function syncSocialAccounts(db: Queryable): Promise<number> {
  const accounts = getAccounts(undefined, true);
  for (const a of accounts) {
    const id = socialAccountId(a.channel, a.accountId);
    await db.query(
      `INSERT INTO social_accounts (id, channel, account_key, label, legacy_namespace, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label,
         legacy_namespace = EXCLUDED.legacy_namespace, enabled = EXCLUDED.enabled, updated_at = NOW()
       WHERE (social_accounts.label, social_accounts.legacy_namespace, social_accounts.enabled)
             IS DISTINCT FROM (EXCLUDED.label, EXCLUDED.legacy_namespace, EXCLUDED.enabled)`,
      [id, a.channel, a.accountId, a.label, a.namespace, a.enabled]
    );
    await db.query(
      `INSERT INTO social_profiles (id, label) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
      [a.profile]
    );
    // One profile per account: moving an account in the registry moves it here.
    await db.query(
      `DELETE FROM social_profile_accounts WHERE account_id = $1 AND profile_id <> $2`,
      [id, a.profile]
    );
    await db.query(
      `INSERT INTO social_profile_accounts (profile_id, account_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [a.profile, id]
    );
  }
  const declared = accounts.map(a => socialAccountId(a.channel, a.accountId));
  await db.query(
    `UPDATE social_accounts SET enabled = FALSE, updated_at = NOW()
      WHERE enabled AND NOT (id = ANY($1::text[]))`,
    [declared]
  );
  return accounts.length;
}

/**
 * Startup hook: never blocks the server. Before migration 008 the tables do
 * not exist and this only logs; the registry still drives routing.
 */
export async function syncSocialAccountsBestEffort(
  db: Queryable,
  log: (msg: string) => void = console.log
): Promise<void> {
  try {
    const n = await syncSocialAccounts(db);
    log(`social_accounts synced from the registry (${n} accounts)`);
  } catch (error) {
    log(`social_accounts sync skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface ConversationRow {
  id: string;
  account_id: string | null;
  external_id: string | null;
  merged_into: string | null;
  [column: string]: unknown;
}

const MAX_HOPS = 8;

export class ConversationResolver {
  constructor(private readonly db: Queryable) {}

  /**
   * Canonical conversation for `ref` within `channel:account`, or null.
   * `ref` may be the opaque id, the external id, or a contact alias.
   * A row that exists but belongs to ANOTHER account is returned as-is so
   * callers can refuse it explicitly (see belongsTo).
   */
  async resolve(
    channel: AccountChannel,
    account: string,
    ref: string
  ): Promise<ConversationRow | null> {
    const accountId = socialAccountId(channel, account);
    let rows = (
      await this.db.query(
        `SELECT c.* FROM conversations c
          WHERE c.id = $1 OR (c.account_id = $2 AND c.external_id = $1)
          ORDER BY (c.account_id = $2) DESC NULLS LAST, (c.id = $1) DESC
          LIMIT 1`,
        [ref, accountId]
      )
    ).rows;
    if (rows.length === 0) {
      rows = (
        await this.db.query(
          `SELECT c.* FROM social_contact_aliases al
             JOIN conversations c
               ON c.account_id = al.account_id AND c.external_id = al.canonical_external_id
            WHERE al.account_id = $1 AND al.alias_external_id = $2 AND al.evidence <> 'blocked'
            LIMIT 1`,
          [accountId, ref]
        )
      ).rows;
    }
    let row: ConversationRow | undefined = rows[0];
    for (let hop = 0; row?.merged_into && hop < MAX_HOPS; hop++) {
      row = (
        await this.db.query(`SELECT c.* FROM conversations c WHERE c.id = $1`, [row.merged_into])
      ).rows[0];
    }
    return row ?? null;
  }

  static belongsTo(row: ConversationRow, channel: AccountChannel, account: string): boolean {
    return row.account_id === socialAccountId(channel, account);
  }
}
