/**
 * Normalize a WhatsApp JID for own-identity comparison.
 *
 * Mirrors the connector's normalizeJid (`@s.whatsapp.net` -> `@c.us`, `@lid`
 * kept as-is) and ADDITIONALLY strips the `:device` suffix from the user part
 * (e.g. `34600:3@c.us` -> `34600@c.us`). The connector's getMe() runs the raw
 * `sock.user.id` through normalizeJid only, so the cached own-JID may still
 * carry a device suffix; senderWaId is likewise device-bearing in some events.
 * Normalizing both sides the same way makes the own-JID compare robust against
 * a reply-to-self loop. Pure / side-effect free.
 */
export function normalizeJid(jid: string | null | undefined): string {
  if (!jid || typeof jid !== 'string') return '';
  let value = jid.trim();
  if (!value) return '';
  if (value.endsWith('@s.whatsapp.net')) {
    value = value.replace('@s.whatsapp.net', '@c.us');
  }
  const at = value.indexOf('@');
  if (at <= 0) return value;
  let user = value.slice(0, at);
  const domain = value.slice(at); // includes '@'
  const colon = user.indexOf(':'); // device suffix like ':3'
  if (colon > 0) user = user.slice(0, colon);
  return `${user}${domain}`;
}
