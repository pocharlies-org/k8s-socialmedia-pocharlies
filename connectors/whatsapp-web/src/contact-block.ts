/**
 * Contact block / unblock and the account's blocklist (fase 3 follow-up).
 * Ported from the NAS fork (contact-block.ts + blocked-contacts.ts: one JID
 * spelling for both sides, the provider's own blocklist as the only proof)
 * and adapted to prod:
 *
 *  - ids in the signed body (`POST /contacts/block {phone | conversationId,
 *    action: block|unblock, confirm: true}`), errors `{error, failureClass}`;
 *  - the target is resolved like every other chat action: a conversation
 *    through its canonical row (merged tombstones followed), a phone through
 *    the conversation this account already has for it (008's PN ↔ LID
 *    aliases) — so the jid acted on is the one WhatsApp knows the chat by;
 *  - the blocklist read is collapsed per person (PN + LID of the same person
 *    are one entry) with names from participants / conversations.
 *
 * What Baileys 7.0.0-rc13 does (Socket/chats.js):
 *  - `fetchBlocklist()`: one `iq get xmlns=blocklist`, the `jid` of every
 *    item as the server stores it (a LID today, a phone jid for old entries).
 *  - `updateBlockStatus(jid, action)`: the item is ALWAYS written under the
 *    LID; a block also carries `pn_jid`. Both come from Baileys' own Signal
 *    mapping (`getLIDForPN` may ask USync; `getPNForLID` is the store only).
 *    A contact it cannot map is refused with Boom 400 "Unable to resolve …":
 *    that is 422 identity_unresolved here, never a silent success.
 *  - Inbound `blocklist.update` ({blocklist: [jid], type: add|remove}) comes
 *    from the server notification when the phone (or another device) changes
 *    the list; `blocklist.set` is typed but rc13 never emits it.
 *
 * Blocking is outward and user-visible (the contact can no longer reach us
 * and WhatsApp shows it on every linked device): the caller requires
 * `confirm: true` and the sending gate. Nothing is persisted: the block state
 * lives in WhatsApp and in a short in-memory cache of the connected socket.
 */
import { stripAccountKey } from './db-writer';
import { MessageMutationError } from './message-mutations';
import { normalizePhoneForWhatsApp, NormalizedWhatsAppPhone } from './contact-sync';

export type ContactBlockAction = 'block' | 'unblock';

/** A block error in the house shape (status + failureClass). */
export class ContactBlockError extends MessageMutationError {
  constructor(message: string, status: number, failureClass: string, code?: string) {
    super(message, status, failureClass, code);
    this.name = 'ContactBlockError';
  }
}

function invalid(message: string): ContactBlockError {
  return new ContactBlockError(message, 400, 'invalid_request');
}

// ---------------------------------------------------------------------------
// One JID spelling for both sides of a block operation
// ---------------------------------------------------------------------------

/*
 * The provider stores an address the way it happened to learn it: a legacy
 * `@c.us`, a current `@s.whatsapp.net`, a `@lid`, sometimes device-qualified.
 * Every provider-supplied address — a blocklist item or a Signal mapping —
 * goes through this function, and so does the requested chat, which is why a
 * block, its read and its confirmation cannot disagree about who they are
 * talking about. A LID stays a LID and a phone stays a phone.
 */
const DIRECT_CONTACT_JID = /^\d+@(?:c\.us|s\.whatsapp\.net|lid)$/;

/** The direct-contact address a provider value means, or null when it means none. */
export function normalizeProviderContactJid(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const userJid = value.replace(/^(\d+):\d+@/, '$1@');
  if (!DIRECT_CONTACT_JID.test(userJid)) return null;
  return userJid.replace(/@c\.us$/, '@s.whatsapp.net');
}

/** The distinct direct contacts a provider blocklist names (groups, devices-only junk dropped). */
export function providerBlocklistEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ContactBlockError(
      'WhatsApp returned an unusable blocked-contact list',
      502,
      'provider_invalid_response'
    );
  }
  const jids = raw.map(entry => normalizeProviderContactJid(entry));
  return [...new Set(jids.filter((jid): jid is string => jid !== null))].sort();
}

/** A direct contact jid in the spelling Baileys writes (`@s.whatsapp.net` / `@lid`), or 400. */
export function contactBlockJid(value: unknown): string {
  const bare = typeof value === 'string' ? stripAccountKey(value.trim()) : '';
  if (!DIRECT_CONTACT_JID.test(bare)) {
    throw invalid('A direct contact is required (a phone or LID chat, never a group)');
  }
  return bare.replace(/@c\.us$/, '@s.whatsapp.net');
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ContactBlockRequest {
  action: ContactBlockAction;
  phone?: NormalizedWhatsAppPhone;
  conversationId?: string;
}

/**
 * Body of POST /contacts/block: `{phone | conversationId, action:
 * block|unblock, confirm: true}` — exactly one target, and the explicit
 * confirmation (blocking is visible to the contact and on every device).
 */
export function parseContactBlockRequest(body: Record<string, unknown>): ContactBlockRequest {
  const action = body.action;
  if (action !== 'block' && action !== 'unblock') {
    throw invalid('action must be block or unblock');
  }
  const conversationRaw = body.conversationId ?? body.chatId;
  const hasConversation =
    conversationRaw !== undefined && conversationRaw !== null && conversationRaw !== '';
  const hasPhone = body.phone !== undefined && body.phone !== null && body.phone !== '';
  if (hasConversation === hasPhone) {
    throw invalid('Exactly one of phone or conversationId is required');
  }
  if (body.confirm !== true) {
    throw invalid(
      `confirm: true is required: ${action === 'block' ? 'blocking' : 'unblocking'} a contact is visible to them and on every linked device`
    );
  }
  if (hasPhone) {
    const phone = normalizePhoneForWhatsApp(body.phone);
    if (!phone) {
      throw invalid('phone must be a phone number (E.164, or 9 digits of the default country)');
    }
    return { action, phone };
  }
  if (typeof conversationRaw !== 'string' || !conversationRaw.trim()) {
    throw invalid('conversationId must be a string');
  }
  const conversationId = conversationRaw.trim();
  // A group is never a contact: refused before anything else is looked up.
  if (/@g\.us$/.test(conversationId)) {
    throw invalid('A group cannot be blocked: block one of its members instead');
  }
  return { action, conversationId };
}

// ---------------------------------------------------------------------------
// Provider operations (socket only; no DB)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BlockSocket = any;

/** The other identity (PN ↔ LID) Baileys' Signal store holds for a contact, normalized. */
export async function signalAlias(socket: BlockSocket, jid: string): Promise<string | null> {
  const mapping = socket?.signalRepository?.lidMapping;
  const resolve = jid.endsWith('@lid') ? mapping?.getPNForLID : mapping?.getLIDForPN;
  if (typeof resolve !== 'function') return null;
  const alias = await Promise.resolve(resolve.call(mapping, jid)).catch(() => null);
  return normalizeProviderContactJid(alias);
}

async function contactAliases(socket: BlockSocket, chat: string) {
  const jid = contactBlockJid(chat);
  const alias = await signalAlias(socket, jid);
  return { jid, aliases: new Set([jid, ...(alias ? [alias] : [])]) };
}

/** The live blocklist of this socket, normalized (one provider read). */
export async function readBlocklist(socket: BlockSocket): Promise<string[]> {
  return providerBlocklistEntries(await socket.fetchBlocklist());
}

/** Whether the provider lists this contact (any of its identities) as blocked. */
export async function readContactBlocked(socket: BlockSocket, chat: string): Promise<boolean> {
  const { aliases } = await contactAliases(socket, chat);
  return (await readBlocklist(socket)).some(jid => aliases.has(jid));
}

/*
 * A contact can be listed twice, once per identity, and clearing one leaves
 * the other in place. Every listed identity is therefore cleared, LID first
 * (the address Baileys writes without resolving a second identity), then
 * confirmed.
 */
function unblockTargets(jid: string, listed: string[]): string[] {
  const ordered = [...listed].sort(
    (a, b) => Number(b.endsWith('@lid')) - Number(a.endsWith('@lid'))
  );
  return [...new Set([...ordered, jid])].slice(0, 3);
}

function providerReason(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return message || 'no reason given by WhatsApp';
}

/** Baileys' own refusal when its Signal store cannot map the contact PN ↔ LID. */
function isUnresolvedIdentity(error: unknown): boolean {
  return /Unable to resolve (?:PN|LID)|pn_jid required/i.test(providerReason(error));
}

export interface ContactBlockOutcome {
  blocked: boolean;
  /** WhatsApp was asked to change something (false: it already was that way). */
  changed: boolean;
  /** The provider's blocklist, re-read, shows the requested state. */
  confirmed: true;
  /** The jid acted on and the identities of the person (PN / LID). */
  jid: string;
  jids: string[];
  /** The whole blocklist as last read (to refresh the cache). */
  blocklist: string[];
}

/**
 * Block or unblock ONE direct contact and prove it with the provider's own
 * blocklist: a transport acknowledgement, or its absence, proves nothing.
 * Already in the requested state → nothing is written (idempotent).
 */
export async function setContactBlocked(
  socket: BlockSocket,
  chat: string,
  blocked: boolean
): Promise<ContactBlockOutcome> {
  const { jid, aliases } = await contactAliases(socket, chat);
  let blocklist = await readBlocklist(socket);
  const listed = () => blocklist.filter(entry => aliases.has(entry));
  const reached = () => listed().length > 0 === blocked;
  const outcome = (changed: boolean): ContactBlockOutcome => ({
    blocked,
    changed,
    confirmed: true,
    jid,
    jids: [...aliases].sort(),
    blocklist,
  });

  if (reached()) return outcome(false);

  const action: ContactBlockAction = blocked ? 'block' : 'unblock';
  const targets = blocked ? [jid] : unblockTargets(jid, listed());
  let refused: unknown = null;
  for (const target of targets) {
    try {
      await socket.updateBlockStatus(target, action);
    } catch (error) {
      // A refused IQ can still have landed, so the state is re-read either way.
      refused = error;
    }
    blocklist = await readBlocklist(socket);
    if (reached()) return outcome(true);
  }

  if (refused && isUnresolvedIdentity(refused)) {
    throw new ContactBlockError(
      `WhatsApp cannot ${action} ${jid} yet: this device does not know both its phone and LID identity (${providerReason(refused)}). Open or receive a message in the chat first.`,
      422,
      'identity_unresolved'
    );
  }
  if (refused) {
    throw new ContactBlockError(
      `WhatsApp refused the ${action} and the contact block state did not change: ${providerReason(refused)}`,
      422,
      'rejected_by_whatsapp'
    );
  }
  throw new ContactBlockError(
    `The ${action} of ${jid} was not confirmed by WhatsApp's blocklist; refresh before retrying`,
    409,
    'block_not_confirmed'
  );
}
