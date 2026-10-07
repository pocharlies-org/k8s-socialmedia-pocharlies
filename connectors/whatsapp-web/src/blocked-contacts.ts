/**
 * The account's blocklist, one entry per person (fase 3 follow-up; ported
 * from the NAS fork's blocked-contacts.ts). The provider read is one
 * `fetchBlocklist()` (see contact-block.ts): untrusted, spelled as the
 * provider stored it, and only ever about the connected socket. Here the
 * entries are grouped per person — PN and LID of the same person through
 * Baileys' Signal mapping and 008's social_contact_aliases — and named from
 * participants / conversations (read only; a pairing-only client, ingest off,
 * gets the bare identities). The list is kept in memory per socket
 * (BlocklistCache), refreshed by reads and patched by `blocklist.update`.
 */
import { getPool, stripAccountKey } from './db-writer';
import { whatsappAccountId } from './message-mutations';
import { resolveCanonicalConversation } from './chat-state';
import { isJidLikeName } from './contacts';
import { normalizeProviderContactJid, providerBlocklistEntries } from './contact-block';

/**
 * Group blocklist entries into people: two entries that are the same person
 * (PN and LID, through Baileys' mapping or the account's aliases) are one.
 * `aliasesOf` returns the other identities known for a jid (already
 * normalized). Each group lists its blocked jids and every identity known.
 */
export async function groupBlockedPeople(
  entries: string[],
  aliasesOf: (jid: string) => Promise<string[]>
): Promise<Array<{ blocked: string[]; jids: string[] }>> {
  const groups: Array<{ blocked: Set<string>; jids: Set<string> }> = [];
  for (const entry of entries) {
    const identities = new Set([entry, ...(await aliasesOf(entry))]);
    const matching = groups.filter(group => [...identities].some(id => group.jids.has(id)));
    const merged = { blocked: new Set([entry]), jids: identities };
    for (const group of matching) {
      group.blocked.forEach(jid => merged.blocked.add(jid));
      group.jids.forEach(jid => merged.jids.add(jid));
      groups.splice(groups.indexOf(group), 1);
    }
    groups.push(merged);
  }
  return groups.map(group => ({
    blocked: [...group.blocked].sort(),
    jids: [...group.jids].sort(),
  }));
}

export interface BlockedContactEntry {
  /** The person's id: the LID when known (what WhatsApp blocks under), else the phone jid. */
  id: string;
  /** Every identity of the person (PN `@s.whatsapp.net` and LID). */
  jids: string[];
  /** The jids the provider lists as blocked. */
  blockedJids: string[];
  /** E.164 from a phone jid of the person; never LID digits. */
  phone: string | null;
  name: string | null;
  pushName: string | null;
  /** conversations.id of the live 1:1 chat, null when there is none. */
  conversationId: string | null;
}

/** Phone jid → `+digits`; a LID (or anything else) → null. */
export function phoneOfJid(jid: string): string | null {
  const match = /^(\d{6,20})@(?:c\.us|s\.whatsapp\.net)$/.exec(jid);
  return match ? `+${match[1]}` : null;
}

/** The id of a person: its LID when one is known, else its first phone jid. */
export function personId(jids: string[]): string {
  return jids.find(jid => jid.endsWith('@lid')) || jids[0];
}

/** Blocklist in memory (per connected socket): the last read, patched by events. */
export class BlocklistCache {
  private jids: Set<string> | null = null;
  private readAt = 0;

  constructor(private readonly ttlMs = 60_000) {}

  /** The cached list when fresh, else null (read the provider). */
  fresh(now = Date.now()): string[] | null {
    return this.jids && now - this.readAt < this.ttlMs ? [...this.jids].sort() : null;
  }

  /** The last list known, however old (null before the first read). */
  last(): { jids: string[]; readAt: string } | null {
    return this.jids
      ? { jids: [...this.jids].sort(), readAt: new Date(this.readAt).toISOString() }
      : null;
  }

  set(entries: unknown, now = Date.now()): string[] {
    const jids = providerBlocklistEntries(entries);
    this.jids = new Set(jids);
    this.readAt = now;
    return jids;
  }

  /** `blocklist.update` / `blocklist.set` from the socket. Before a full read only a `set` counts. */
  apply(event: { blocklist?: unknown; type?: unknown }, replace = false): void {
    const items = Array.isArray(event?.blocklist) ? event.blocklist : [];
    if (replace || event?.type === 'set') {
      this.set(items);
      return;
    }
    // An add / remove on an unknown list says nothing about the rest of it.
    if (!this.jids) return;
    for (const item of items) {
      const jid = normalizeProviderContactJid(item);
      if (!jid) continue;
      if (event?.type === 'remove') this.jids.delete(jid);
      else if (event?.type === 'add') this.jids.add(jid);
    }
  }

  clear(): void {
    this.jids = null;
    this.readAt = 0;
  }
}

/** Both phone spellings of a jid (the DB keeps `@c.us` and `@s.whatsapp.net` rows). */
function spellings(jid: string): string[] {
  if (jid.endsWith('@s.whatsapp.net')) return [jid, jid.replace(/@s\.whatsapp\.net$/, '@c.us')];
  if (jid.endsWith('@c.us')) return [jid, jid.replace(/@c\.us$/, '@s.whatsapp.net')];
  return [jid];
}

/**
 * The PN ↔ LID pairs 008 recorded for these jids (either side), normalized.
 * A table that does not exist yet (old DB) is no alias.
 */
export async function accountAliasPairs(jids: string[]): Promise<Array<[string, string]>> {
  const candidates = [...new Set(jids.flatMap(spellings))];
  if (!candidates.length) return [];
  try {
    const result = await getPool().query(
      `SELECT a.alias_external_id, a.canonical_external_id
         FROM social_contact_aliases a
        WHERE a.account_id = $1 AND a.evidence <> 'blocked'
          AND (a.alias_external_id = ANY($2::text[]) OR a.canonical_external_id = ANY($2::text[]))`,
      [whatsappAccountId(), candidates]
    );
    const pairs: Array<[string, string]> = [];
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const alias = normalizeProviderContactJid(stripAccountKey(String(row.alias_external_id)));
      const canonical = normalizeProviderContactJid(
        stripAccountKey(String(row.canonical_external_id))
      );
      if (alias && canonical && alias !== canonical) pairs.push([alias, canonical]);
    }
    return pairs;
  } catch (error) {
    if ((error as { code?: string })?.code === '42P01') return [];
    throw error;
  }
}

interface NameRow {
  external_id: string;
  name: string | null;
  push_name: string | null;
  source: 'conversation' | 'participant';
}

/**
 * Names and the live 1:1 conversation of each blocked person (read only).
 * The conversation is resolved like any chat (merged rows followed, aliases);
 * the name prefers the conversation's, then the participant's, never a jid.
 */
export async function describeBlockedPeople(
  groups: Array<{ blocked: string[]; jids: string[] }>
): Promise<BlockedContactEntry[]> {
  const all = [...new Set(groups.flatMap(group => group.jids.flatMap(spellings)))];
  const rows: NameRow[] = [];
  if (all.length) {
    const result = await getPool().query(
      `SELECT c.external_id, NULLIF(btrim(c.name), '') AS name, NULL::text AS push_name,
              'conversation' AS source
         FROM conversations c
        WHERE c.account_id = $1 AND NOT c.is_group AND c.merged_into IS NULL
          AND c.external_id = ANY($2::text[])
       UNION ALL
       SELECT p.external_id, NULLIF(btrim(p.name), ''), NULLIF(btrim(p.push_name), ''),
              'participant'
         FROM participants p
        WHERE p.account_id = $1 AND p.external_id = ANY($2::text[])`,
      [whatsappAccountId(), all]
    );
    rows.push(...(result.rows as NameRow[]));
  }
  const entries: BlockedContactEntry[] = [];
  for (const group of groups) {
    const keys = new Set(group.jids.flatMap(spellings));
    const mine = rows.filter(row => keys.has(stripAccountKey(String(row.external_id))));
    const named = (source: NameRow['source']) =>
      mine.find(row => row.source === source && !isJidLikeName(row.name))?.name || null;
    const pushName =
      mine.find(row => row.push_name && !isJidLikeName(row.push_name))?.push_name || null;
    let conversationId: string | null = null;
    for (const jid of [personId(group.jids), ...group.jids]) {
      const conversation = await resolveCanonicalConversation(jid);
      if (conversation) {
        conversationId = conversation.id;
        break;
      }
    }
    entries.push({
      id: personId(group.jids),
      jids: group.jids,
      blockedJids: group.blocked,
      phone: group.jids.map(phoneOfJid).find((value): value is string => !!value) || null,
      name: named('conversation') || named('participant'),
      pushName,
      conversationId,
    });
  }
  return entries;
}

/** Compatibility view for the web app: direct provider identities, without grouping. */
export function parseProviderBlocklist(raw: unknown): string[] {
  return providerBlocklistEntries(raw).sort();
}

export async function readBlockedContacts(socket: {
  fetchBlocklist(): Promise<unknown>;
}): Promise<string[]> {
  return parseProviderBlocklist(await socket.fetchBlocklist());
}
