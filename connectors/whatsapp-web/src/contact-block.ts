export class ContactBlockError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/*
 * One JID spelling for both sides of a block operation.
 *
 * The provider stores an address the way it happened to learn it: a legacy
 * `@c.us`, a current `@s.whatsapp.net`, a `@lid`, sometimes device-qualified.
 * Baileys writes user JIDs and its blocklist read returns those stored strings
 * untouched, so an address that is written one way and read another is seen as
 * two different contacts. Every provider-supplied address — a blocklist item or
 * a Signal mapping — goes through this function, and so does the requested
 * chat, which is why a block, its read and its confirmation cannot disagree
 * about who they are talking about.
 */
const DIRECT_CONTACT_JID = /^\d+@(?:c\.us|s\.whatsapp\.net|lid)$/;

/** The direct-contact address a provider value means, or null when it means none. */
export function normalizeProviderContactJid(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const userJid = value.replace(/^(\d+):\d+@/, '$1@');
  if (!DIRECT_CONTACT_JID.test(userJid)) return null;
  return userJid.replace(/@c\.us$/, '@s.whatsapp.net');
}

/** The distinct direct contacts a provider blocklist names, in provider spelling. */
export function providerBlocklistEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ContactBlockError('WhatsApp returned an unusable blocked-contact list', 502);
  }
  const jids = raw.map(entry => normalizeProviderContactJid(entry));
  return [...new Set(jids.filter((jid): jid is string => jid !== null))];
}

export function contactBlockJid(value: unknown): string {
  if (typeof value !== 'string' || !DIRECT_CONTACT_JID.test(value)) {
    throw new ContactBlockError('A direct contact is required', 400);
  }
  return value.replace(/@c\.us$/, '@s.whatsapp.net');
}

async function contactBlockAliases(socket: any, chat: string) {
  const jid = contactBlockJid(chat);
  const mapping = socket.signalRepository?.lidMapping;
  // A socket without a Signal mapping store has no alias to offer, which is a
  // known contact rather than an error: the canonical address still stands.
  const resolve = jid.endsWith('@lid') ? mapping?.getPNForLID : mapping?.getLIDForPN;
  const alias = typeof resolve === 'function' ? await resolve.call(mapping, jid) : null;
  // Signal stores may hold the same identity device-qualified or in the legacy
  // spelling. An unknown alias must not hide the canonical entry.
  const normalizedAlias = normalizeProviderContactJid(alias);
  return { jid, aliases: new Set([jid, ...(normalizedAlias ? [normalizedAlias] : [])]) };
}

/** The addresses of this contact that the provider really lists as blocked. */
async function blockedAddresses(socket: any, chat: string): Promise<string[]> {
  const { aliases } = await contactBlockAliases(socket, chat);
  return providerBlocklistEntries(await socket.fetchBlocklist()).filter(jid => aliases.has(jid));
}

export async function readContactBlocked(socket: any, chat: string): Promise<boolean> {
  return (await blockedAddresses(socket, chat)).length > 0;
}

/*
 * A contact can be listed twice, once per identity, and clearing one leaves the
 * other answering messages. Every listed identity is therefore cleared and only
 * then confirmed, with the LID first: it is the address Baileys can write
 * without resolving a second identity, so it is the one least likely to fail.
 */
function unblockTargets(jid: string, listed: string[]): string[] {
  const ordered = [...listed].sort(
    (a, b) => Number(b.endsWith('@lid')) - Number(a.endsWith('@lid'))
  );
  return [...new Set([...ordered, jid])].slice(0, 2);
}

function providerReason(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return message || 'no reason given by WhatsApp';
}

export async function setContactBlocked(socket: any, chat: string, blocked: boolean) {
  const { jid } = await contactBlockAliases(socket, chat);
  const listed = () => blockedAddresses(socket, chat);
  // The provider's own answer is the only proof asked for: a transport
  // acknowledgement, or its absence, proves nothing about the stored state.
  const reached = async () => {
    const blocking = (await listed()).length > 0;
    return blocking === blocked;
  };

  if (await reached()) return { blocked, changed: false, confirmed: true };

  const action = blocked ? 'block' : 'unblock';
  const targets = blocked ? [jid] : unblockTargets(jid, await listed());
  let refused: unknown = null;
  for (const target of targets) {
    try {
      await socket.updateBlockStatus(target, action);
    } catch (error) {
      // A refused IQ can still have landed, so the state is re-read either way.
      refused = error;
    }
    if (await reached()) break;
  }

  if (await reached()) return { blocked, changed: true, confirmed: true };
  if (refused) {
    throw new ContactBlockError(
      `WhatsApp refused the change and the contact block state did not change: ${providerReason(refused)}`,
      409
    );
  }
  throw new ContactBlockError(
    'Contact block state was not confirmed; refresh before retrying',
    409
  );
}
