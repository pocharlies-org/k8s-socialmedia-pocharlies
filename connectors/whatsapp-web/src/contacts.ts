/**
 * WhatsApp start chat, contacts and vCards (fase 3 / PR-9). Ported from the
 * NAS fork (startChat + ensureEmptyConversation, listContacts,
 * createContact, shareContact, buildContactMessage, whatsappContactIdentity /
 * contactAliasGroups) and adapted to prod's multiaccount model:
 *
 *  - no `whatsapp_contacts` table: the list is read (read-only) from
 *    participants + conversations + social_contact_aliases (migration 008),
 *    one entry per person — the phone jid (`@c.us` / `@s.whatsapp.net`) and
 *    the LID of the same person collapse through the aliases, the way the
 *    fork's contactAliasGroups did in memory;
 *  - starting a chat never creates a twin: the phone (and the LID WhatsApp
 *    gives for it) resolve to the EXISTING canonical conversation, merged
 *    tombstones followed; only when there is none is a row inserted —
 *    namespaced id + account_id + external_id, under the LID when it is
 *    known (the jid WhatsApp addresses the chat with), and only by a client
 *    with `ingest` on (the pairing pool never writes);
 *  - a contact card goes out as a vCard 3.0 (contactMessage) with the
 *    `waid` WhatsApp needs for its "Message" button.
 *
 * `participants.phone` of an `@lid` row holds the LID digits, never a phone
 * (measured 30-09: 2216 of 2231 rows): a phone is only taken from a phone jid
 * of the person, never from that column.
 */
import { accountKey, connectorAccount, getPool, stripAccountKey } from './db-writer';
import { MessageMutationError, whatsappAccountId } from './message-mutations';
import { normalizePhoneForWhatsApp, NormalizedWhatsAppPhone } from './contact-sync';

/** Default / largest page of GET /contacts. */
export const CONTACTS_DEFAULT_LIMIT = 200;
export const CONTACTS_MAX_LIMIT = 500;
/** WhatsApp's own limits: 4096 characters of text; a saved name, like WA Web, 100. */
export const START_CHAT_MESSAGE_MAX = 4096;
export const CONTACT_NAME_MAX = 100;
/** Contact cards per message (WA Web shares up to a handful at once). */
export const SHARE_CONTACTS_MAX = 5;

const USER_JID = /^(\d{6,20})@(c\.us|s\.whatsapp\.net|lid)$/;

function invalid(message: string, code?: string): MessageMutationError {
  return new MessageMutationError(message, 400, 'invalid_request', code);
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Control characters never reach WhatsApp or a vCard line.
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
  return text || undefined;
}

/** Phone jid (`digits@c.us` / `@s.whatsapp.net`) → `+digits`; anything else undefined. */
export function phoneFromUserJid(jid: string): string | undefined {
  const match = USER_JID.exec(stripAccountKey(jid));
  return match && match[2] !== 'lid' ? `+${match[1]}` : undefined;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface StartChatRequest {
  phone: NormalizedWhatsAppPhone;
  /** Optional first message, sent through the normal (gated) send path. */
  message?: string;
}

/** Body of POST /chats/start: {phone, message?}. 400 before anything else. */
export function parseStartChatRequest(body: Record<string, unknown>): StartChatRequest {
  const phone = normalizePhoneForWhatsApp(body.phone);
  if (!phone) {
    throw invalid('phone must be a phone number (E.164, or 9 digits of the default country)');
  }
  if (body.message !== undefined && body.message !== null && typeof body.message !== 'string') {
    throw invalid('message must be a string');
  }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message.length > START_CHAT_MESSAGE_MAX) {
    throw invalid(`message is at most ${START_CHAT_MESSAGE_MAX} characters`);
  }
  return message ? { phone, message } : { phone };
}

export interface CreateContactRequest {
  phone: NormalizedWhatsAppPhone;
  name: string;
  firstName?: string;
}

/** Body of POST /contacts/create (and POST /contacts): {phone, name, firstName?}. */
export function parseCreateContactRequest(body: Record<string, unknown>): CreateContactRequest {
  const phone = normalizePhoneForWhatsApp(body.phone ?? body.jid);
  if (!phone) throw invalid('phone must be a phone number');
  const name = cleanText(body.name ?? body.fullName);
  if (!name) throw invalid('name is required');
  if (name.length > CONTACT_NAME_MAX) {
    throw invalid(`name is at most ${CONTACT_NAME_MAX} characters`);
  }
  const firstName = cleanText(body.firstName);
  if (firstName && firstName.length > CONTACT_NAME_MAX) {
    throw invalid(`firstName is at most ${CONTACT_NAME_MAX} characters`);
  }
  return { phone, name, ...(firstName ? { firstName } : {}) };
}

// ---------------------------------------------------------------------------
// vCards
// ---------------------------------------------------------------------------

export interface ContactCard {
  displayName: string;
  /** E.164 (`+34600…`). */
  phone: string;
  organization?: string;
  email?: string;
}

/** RFC 6350 §3.4 text escaping (backslash, comma, semicolon, newline). */
export function vcardEscape(value: string): string {
  return value.replace(/\r\n|\r|\n|[\\;,]/g, match =>
    match === '\\' ? '\\\\' : match === ';' ? '\\;' : match === ',' ? '\\,' : '\\n'
  );
}

/**
 * A contact card as WhatsApp itself writes it: vCard 3.0, FN, N, ORG, EMAIL
 * and `TEL;type=CELL;type=VOICE;waid=<digits>:<+E.164>` (the waid is what
 * gives the card its "Message" button on the phone).
 */
export function buildVcard(card: ContactCard): string {
  const digits = card.phone.replace(/\D/g, '');
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:;${vcardEscape(card.displayName)};;;`,
    `FN:${vcardEscape(card.displayName)}`,
  ];
  if (card.organization) lines.push(`ORG:${vcardEscape(card.organization)}`);
  lines.push(`TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`);
  if (card.email) lines.push(`EMAIL;type=INTERNET:${vcardEscape(card.email)}`);
  lines.push('END:VCARD');
  return lines.join('\n');
}

function parseCard(value: unknown, index: number): ContactCard {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const raw = item as Record<string, unknown>;
  const phone = normalizePhoneForWhatsApp(raw.phone);
  if (!phone) throw invalid(`contacts[${index}].phone must be a phone number`);
  const displayName = cleanText(raw.displayName ?? raw.name);
  if (!displayName) throw invalid(`contacts[${index}].displayName is required`);
  if (displayName.length > CONTACT_NAME_MAX) {
    throw invalid(`contacts[${index}].displayName is at most ${CONTACT_NAME_MAX} characters`);
  }
  const organization = cleanText(raw.organization);
  const email = cleanText(raw.email);
  if (organization && organization.length > CONTACT_NAME_MAX) {
    throw invalid(`contacts[${index}].organization is at most ${CONTACT_NAME_MAX} characters`);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw invalid(`contacts[${index}].email is not an email address`);
  }
  return {
    displayName,
    phone: phone.phoneE164,
    ...(organization ? { organization } : {}),
    ...(email ? { email } : {}),
  };
}

/**
 * Body of POST /contacts/share: one card ({displayName, phone, organization?,
 * email?} at the top level) or `contacts: [...]` (1..5).
 */
export function parseShareContactRequest(body: Record<string, unknown>): ContactCard[] {
  if (body.contacts !== undefined) {
    if (!Array.isArray(body.contacts) || !body.contacts.length) {
      throw invalid('contacts must be a non-empty array');
    }
    if (body.contacts.length > SHARE_CONTACTS_MAX) {
      throw invalid(`At most ${SHARE_CONTACTS_MAX} contacts per message`);
    }
    return body.contacts.map((card, index) => parseCard(card, index));
  }
  return [parseCard(body, 0)];
}

/**
 * Baileys content of a shared contact: `{contacts: {displayName, contacts}}`
 * becomes a contactMessage (one card) or a contactsArrayMessage (several).
 */
export function buildContactShareContent(cards: ContactCard[]): {
  contacts: { displayName: string; contacts: Array<{ displayName: string; vcard: string }> };
} {
  const contacts = cards.map(card => ({ displayName: card.displayName, vcard: buildVcard(card) }));
  const displayName = cards.length === 1 ? cards[0].displayName : `${cards.length} contactos`;
  return { contacts: { displayName, contacts } };
}

export interface SharedContactView {
  displayName: string;
  /** E.164 numbers of the card; `waid` ones first (those are on WhatsApp). */
  phones: string[];
  /** Digits WhatsApp itself tagged as a WhatsApp account (TEL;waid=…). */
  waids: string[];
  organization?: string;
}

function unescapeVcard(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_m, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch));
}

/**
 * What a received contactMessage / contactsArrayMessage shows: names and
 * numbers read from the vCard (never the raw vCard). Tolerates folded lines,
 * item1.TEL prefixes and missing waid.
 */
export function parseVcardView(
  displayName: string | null | undefined,
  vcard: unknown
): SharedContactView {
  const text = typeof vcard === 'string' ? vcard.replace(/\r?\n[ \t]/g, '') : '';
  const phones: string[] = [];
  const waids: string[] = [];
  let fn: string | undefined;
  let organization: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    const name = head
      .split(';')[0]
      .replace(/^item\d+\./i, '')
      .toUpperCase();
    if (name === 'FN' && value) fn = unescapeVcard(value);
    else if (name === 'ORG' && value) organization = unescapeVcard(value).replace(/;+$/, '');
    else if (name === 'TEL') {
      const waid = /(?:^|;)waid=(\d{6,20})/i.exec(head)?.[1];
      const digits = waid || value.replace(/\D/g, '');
      if (digits.length < 6 || digits.length > 20) continue;
      if (waid) waids.push(waid);
      const e164 = `+${digits}`;
      if (!phones.includes(e164)) waid ? phones.unshift(e164) : phones.push(e164);
    }
  }
  return {
    displayName: (displayName && displayName.trim()) || fn || phones[0] || 'Contacto',
    phones,
    waids: Array.from(new Set(waids)),
    ...(organization ? { organization } : {}),
  };
}

/** `metadata.contact` of a CONTACT row: the cards of a contact / contacts-array message. */
export function sharedContactsFromMessage(content: {
  contactMessage?: { displayName?: string | null; vcard?: string | null } | null;
  contactsArrayMessage?: {
    displayName?: string | null;
    contacts?: Array<{ displayName?: string | null; vcard?: string | null }> | null;
  } | null;
}): { displayName: string; contacts: SharedContactView[] } | undefined {
  if (content.contactMessage) {
    const card = parseVcardView(content.contactMessage.displayName, content.contactMessage.vcard);
    return { displayName: card.displayName, contacts: [card] };
  }
  const array = content.contactsArrayMessage;
  if (array) {
    const contacts = (array.contacts || [])
      .slice(0, 20)
      .map(item => parseVcardView(item?.displayName, item?.vcard));
    return {
      displayName:
        (array.displayName && array.displayName.trim()) || `${contacts.length} contactos`,
      contacts,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Start chat: the conversation row (never a twin)
// ---------------------------------------------------------------------------

export interface StartedChat {
  /** conversations.id (namespaced); null when nothing was persisted (ingest off). */
  conversationId: string | null;
  /** Bare jid of the chat (`…@lid` or `…@c.us`): what sends address. */
  chatId: string;
  /** E.164 of the number asked for. */
  phone: string;
  lid: string | null;
  name: string;
  /** A new conversation row was inserted. */
  created: boolean;
  /** The number resolved to a conversation this account already had. */
  existing: boolean;
  persisted: boolean;
}

export interface CreatedContact {
  phone: string;
  /** Phone jid (`…@c.us`). */
  jid: string;
  lid: string | null;
  name: string;
  /** WhatsApp accepted the address-book mutation (saveOnPrimaryAddressbook requested). */
  addressBookSync: boolean;
  /** The name landed on existing rows of this person. */
  persisted: boolean;
}

/** Stored name of a conversation (conversations.id). */
export async function conversationName(id: string): Promise<string | null> {
  const result = await getPool().query(
    `SELECT name FROM conversations WHERE id = $1 AND account_id = $2`,
    [id, whatsappAccountId()]
  );
  const name = result.rows[0]?.name;
  return typeof name === 'string' && !isJidLikeName(name) ? name : null;
}

/**
 * Insert the conversation of a chat that has none yet, under `jid` (bare,
 * `…@lid` or `…@c.us`), with the phone jid in wa_chat_id when the row is a
 * LID: 008's trigger then records the PN → LID alias (evidence wa_chat_id), so
 * a later phone-addressed message folds into this row instead of a twin.
 * ingest-only caller. Returns the conversations.id and whether it was new.
 */
export async function insertStartedConversation(input: {
  jid: string;
  name: string;
  pnJid?: string;
}): Promise<{ id: string; created: boolean }> {
  const id = accountKey(input.jid);
  const waChatId = input.jid.endsWith('@lid') && input.pnJid ? accountKey(input.pnJid) : null;
  const params = [id, input.name, connectorAccount(), whatsappAccountId(), input.jid];
  const insert = (withWaChatId: boolean) =>
    getPool().query(
      `INSERT INTO conversations
         (id, name, is_group, participant_count, account, account_id, external_id${withWaChatId ? ', wa_chat_id' : ''})
       VALUES ($1, $2, FALSE, 2, $3, $4, $5${withWaChatId ? ', $6' : ''})
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      withWaChatId ? [...params, waChatId] : params
    );
  let result;
  try {
    result = await insert(!!waChatId);
  } catch (error) {
    // wa_chat_id is UNIQUE: another (older) row may already carry that phone.
    if ((error as { code?: string })?.code !== '23505' || !waChatId) throw error;
    result = await insert(false);
  }
  return { id, created: (result.rowCount || 0) > 0 };
}

// ---------------------------------------------------------------------------
// Contacts list (read-only)
// ---------------------------------------------------------------------------

export interface ContactListEntry {
  /** The person's canonical jid (the LID when WhatsApp gave one). */
  id: string;
  name: string | null;
  pushName: string | null;
  /** E.164 when a phone jid of the person is known; never LID digits. */
  phone: string | null;
  /** Every jid of the person (PN and LID). */
  jids: string[];
  /** conversations.id of the live 1:1 chat, null when there is none. */
  conversationId: string | null;
  lastActivityAt: string | null;
}

interface ContactRow {
  person: string;
  jids: string[] | null;
  name: string | null;
  push_name: string | null;
  conversation_id: string | null;
  last_activity: Date | string | null;
}

/** A name that is only a jid or a number is no name. */
export function isJidLikeName(value: string | null | undefined): boolean {
  if (!value) return true;
  const text = value.trim();
  return (
    !text || /@(c\.us|s\.whatsapp\.net|lid|g\.us)$/.test(text) || /^\+?[\d\s()-]{6,}$/.test(text)
  );
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** One row per person → the API entry (phone from a phone jid only). */
export function contactEntryFromRow(row: ContactRow): ContactListEntry {
  const jids = Array.from(new Set((row.jids || []).map(jid => stripAccountKey(jid)))).sort();
  const phone = jids.map(phoneFromUserJid).find((value): value is string => !!value) || null;
  return {
    id: stripAccountKey(row.person),
    name: isJidLikeName(row.name) ? null : row.name,
    pushName: isJidLikeName(row.push_name) ? null : row.push_name,
    phone,
    jids,
    conversationId: row.conversation_id || null,
    lastActivityAt: iso(row.last_activity),
  };
}

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, match => `\\${match}`)}%`;
}

/**
 * The people this account knows, one entry per person: participants (1:1 and
 * group members) and live 1:1 conversations, with every PN / LID alias of 008
 * folded into its canonical jid (blocked aliases ignored). `ownJids` (our own
 * PN / LID) are left out. `query` matches the name, push name or digits.
 * Newest activity first. Read only.
 */
export async function listAccountContacts(options: {
  query?: string;
  limit?: number;
  ownJids?: string[];
}): Promise<ContactListEntry[]> {
  const limit = Math.min(
    CONTACTS_MAX_LIMIT,
    Math.max(1, Math.floor(Number(options.limit) || CONTACTS_DEFAULT_LIMIT))
  );
  const query = (options.query || '').trim().slice(0, 100);
  const digits = query.replace(/\D/g, '');
  const own = Array.from(
    new Set(
      (options.ownJids || []).flatMap(jid => {
        const bare = stripAccountKey(jid);
        return [bare, bare.replace(/@s\.whatsapp\.net$/, '@c.us')];
      })
    )
  );
  const result = await getPool().query(
    `WITH src AS (
       SELECT p.external_id AS jid, NULLIF(btrim(p.name), '') AS name,
              NULLIF(btrim(p.push_name), '') AS push_name, p.last_seen AS seen_at,
              NULL::text AS conversation_id
         FROM participants p
        WHERE p.account_id = $1 AND p.external_id ~ '^[0-9]+@(lid|c\\.us|s\\.whatsapp\\.net)$'
       UNION ALL
       SELECT c.external_id, NULLIF(btrim(c.name), ''), NULL, c.last_message_at, c.id
         FROM conversations c
        WHERE c.account_id = $1 AND NOT c.is_group AND c.merged_into IS NULL
          AND c.external_id ~ '^[0-9]+@(lid|c\\.us|s\\.whatsapp\\.net)$'
       UNION ALL
       SELECT a.alias_external_id, NULL, NULL, NULL, NULL
         FROM social_contact_aliases a
        WHERE a.account_id = $1 AND a.evidence <> 'blocked'
     ),
     -- One alias per jid, both phone suffixes folded into @c.us (hash join).
     amap AS (
       SELECT DISTINCT ON (v.k) v.k, a.canonical_external_id AS canonical
         FROM social_contact_aliases a,
              LATERAL (VALUES (regexp_replace(a.alias_external_id, '@s\\.whatsapp\\.net$', '@c.us'))) v(k)
        WHERE a.account_id = $1 AND a.evidence <> 'blocked'
        ORDER BY v.k, (v.k = a.alias_external_id) DESC
     ),
     keyed AS (
       SELECT s.*,
              regexp_replace(COALESCE(m.canonical, s.jid), '@s\\.whatsapp\\.net$', '@c.us') AS person
         FROM src s
         LEFT JOIN amap m ON m.k = regexp_replace(s.jid, '@s\\.whatsapp\\.net$', '@c.us')
        WHERE NOT (s.jid = ANY($2::text[]))
     ),
     people AS (
       SELECT person,
              array_agg(DISTINCT jid) AS jids,
              (array_agg(name ORDER BY (conversation_id IS NOT NULL) DESC, seen_at DESC NULLS LAST)
                 FILTER (WHERE name IS NOT NULL AND name !~ '@' AND name !~ '^\\+?[0-9 ()-]{6,}$'))[1] AS name,
              (array_agg(push_name ORDER BY seen_at DESC NULLS LAST)
                 FILTER (WHERE push_name IS NOT NULL))[1] AS push_name,
              (array_agg(conversation_id ORDER BY seen_at DESC NULLS LAST)
                 FILTER (WHERE conversation_id IS NOT NULL))[1] AS conversation_id,
              max(seen_at) AS last_activity,
              bool_or(name IS NOT NULL OR push_name IS NOT NULL OR conversation_id IS NOT NULL) AS known
         FROM keyed
        WHERE NOT (person = ANY($2::text[]))
        GROUP BY person
     )
     SELECT person, jids, name, push_name, conversation_id, last_activity
       FROM people
      WHERE known
        AND ($3::text = '' OR name ILIKE $4 OR push_name ILIKE $4
             OR ($5::text <> '' AND array_to_string(jids, ' ') LIKE '%' || $5 || '%'))
      ORDER BY last_activity DESC NULLS LAST, person
      LIMIT $6`,
    [whatsappAccountId(), own, query, likePattern(query), digits.length >= 3 ? digits : '', limit]
  );
  return (result.rows as ContactRow[]).map(contactEntryFromRow);
}

/**
 * The name we saved for a person on the rows that already exist (its
 * participant rows and its canonical 1:1 conversation) — never inserts. ingest
 * only. Returns the number of rows changed.
 */
export async function recordContactName(jids: string[], name: string): Promise<number> {
  const candidates = Array.from(
    new Set(
      jids.flatMap(jid => {
        const bare = stripAccountKey(jid);
        if (bare.endsWith('@s.whatsapp.net'))
          return [bare, bare.replace(/@s\.whatsapp\.net$/, '@c.us')];
        if (bare.endsWith('@c.us')) return [bare, bare.replace(/@c\.us$/, '@s.whatsapp.net')];
        return [bare];
      })
    )
  );
  if (!candidates.length) return 0;
  const result = await getPool().query(
    `WITH p AS (
       UPDATE participants SET name = $3
        WHERE account_id = $1 AND external_id = ANY($2::text[]) AND name IS DISTINCT FROM $3
       RETURNING 1
     ), c AS (
       UPDATE conversations SET name = $3, updated_at = now()
        WHERE account_id = $1 AND external_id = ANY($2::text[]) AND NOT is_group
          AND merged_into IS NULL AND name IS DISTINCT FROM $3
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM p) + (SELECT count(*) FROM c) AS changed`,
    [whatsappAccountId(), candidates, name]
  );
  return Number(result.rows[0]?.changed || 0);
}
