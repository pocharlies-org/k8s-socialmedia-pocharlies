import { providerBlocklistEntries } from './contact-block';

/*
 * Provider blocklist read (Baileys 7.0.0-rc13 `sock.fetchBlocklist()`).
 *
 * What the library actually does is one `iq type="get" xmlns="blocklist"` and
 * then `getBinaryNodeChildren(list,'item').map(n => n.attrs.jid)`, so:
 * - It is a read. No contact lookup, no chat write, nothing that can mutate a
 *   contact or send a message.
 * - Every entry is untrusted provider data: the declared type is
 *   `(string | undefined)[]`, and nothing guarantees a direct-chat JID. A
 *   device-qualified or group-shaped item has to be rejected here rather than
 *   passed to the browser.
 * - Every entry is spelled as the provider stored it, so the same person can be
 *   listed as `@c.us`, `@s.whatsapp.net` or `@lid`. `providerBlocklistEntries`
 *   is the one spelling rule shared with the block read and its confirmation:
 *   an address shown as blocked is an address that can be unblocked, and an
 *   address reported as unblocked is one the provider really dropped.
 * - The answer belongs to the connected socket only, so it can never describe
 *   another account.
 *
 * An address therefore keeps its own realm (a LID stays a LID, a phone stays a
 * phone) and only the two spellings the rest of this connector already unifies
 * are reduced: a device suffix is dropped and `@c.us` becomes
 * `@s.whatsapp.net`. No per-account identifier is invented anywhere.
 */

/** Direct-contact JIDs only, normalized, deduplicated and in a stable order. */
export function parseProviderBlocklist(raw: unknown): string[] {
  return providerBlocklistEntries(raw).sort();
}

/** Reads the live blocklist of this socket and nothing else. */
export async function readBlockedContacts(socket: any): Promise<string[]> {
  return parseProviderBlocklist(await socket.fetchBlocklist());
}
