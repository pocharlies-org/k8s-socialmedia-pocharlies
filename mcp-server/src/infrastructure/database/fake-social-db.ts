/**
 * Test helper: an in-memory model of the ADR 0001 tables, answering exactly
 * the queries the ConversationResolver and the cold-send gate issue. Anything
 * else falls through to `fallback` (default: no rows).
 */
export interface FakeConversation {
  id: string;
  account_id: string;
  external_id: string;
  merged_into?: string | null;
  inbound?: boolean;
}

export interface FakeAlias {
  account_id: string;
  alias_external_id: string;
  canonical_external_id: string;
  evidence: string;
}

export function fakeSocialDb(
  conversations: FakeConversation[],
  aliases: FakeAlias[] = [],
  fallback: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> = async () => ({
    rows: [],
  })
) {
  const rows = conversations.map(c => ({ merged_into: null, inbound: false, ...c }));
  const insertedAliases: FakeAlias[] = [];
  const calls: Array<[string, unknown[]]> = [];
  const query = async (sql: string, params: unknown[] = []): Promise<{ rows: any[] }> => {
    calls.push([sql, params]);
    if (sql.includes('WHERE c.id = $1 OR (c.account_id = $2 AND c.external_id = $1)')) {
      const [ref, accountId] = params as string[];
      const hit =
        rows.find(c => c.account_id === accountId && (c.id === ref || c.external_id === ref)) ??
        rows.find(c => c.id === ref);
      return { rows: hit ? [hit] : [] };
    }
    if (sql.includes('FROM social_contact_aliases al')) {
      const [accountId, ref] = params as string[];
      const al = aliases.find(
        a => a.account_id === accountId && a.alias_external_id === ref && a.evidence !== 'blocked'
      );
      const hit =
        al &&
        rows.find(c => c.account_id === accountId && c.external_id === al.canonical_external_id);
      return { rows: hit ? [hit] : [] };
    }
    if (sql.includes('SELECT c.* FROM conversations c WHERE c.id = $1')) {
      const hit = rows.find(c => c.id === params[0]);
      return { rows: hit ? [hit] : [] };
    }
    if (sql.includes("m.direction = 'INBOUND'") && sql.includes('LIMIT 1')) {
      const hit = rows.find(c => c.id === params[0]);
      return { rows: hit?.inbound ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('INSERT INTO social_contact_aliases')) {
      const [account_id, alias_external_id, canonical_external_id, evidence] = params as string[];
      insertedAliases.push({ account_id, alias_external_id, canonical_external_id, evidence });
      return { rows: [] };
    }
    return fallback(sql, params);
  };
  return { query, calls, insertedAliases };
}
