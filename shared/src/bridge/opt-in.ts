/**
 * Tracking opt-in surfaces belong to skirmshop-labels' whatsapp-optin-ingest
 * worker, which replies to EVERY one of them (subscribe / confirm /
 * ask-for-ref / opt-out). A bridge drops them (DGX-1235 B0) so they never
 * reach the case-session machinery: the customer already gets labels' own
 * answer, and a Claude CLI session on top is the double reply Dani retired
 * (DGX-1553 — the CTA of the tracking button was opening case sessions).
 *
 * Verbatim mirror of `parseInboundWhatsAppOptIn` (skirmshop-labels
 * `packages/tracking-optin/src/inbound-parser.ts`) — same surfaces, same
 * ReDoS-safe discipline (hard length cap before any regex; disjoint-class
 * junctions with bounded quantifiers). If the labels templates change,
 * update BOTH; the round-trip against the builder strings is guarded in
 * opt-in.test.ts. Strict by design: the business number also receives real
 * human chat, and anything that is not one of OUR surfaces must still reach
 * the bridge's consumers (a sentence merely mentioning an order ref is NOT a
 * surface — the parser only takes the template or a bare ref).
 */
const MAX_PARSEABLE_LENGTH = 512;
const ES_TEMPLATE =
  /quiero\s+recibir\s+seguimiento\s+por\s+whatsapp\s+(?:del\s+pedido|de\s+mi\s+pedido)/i;
const EN_TEMPLATE =
  /want\s+to\s+receive\s+tracking\s+updates\s+on\s+whatsapp\s+for\s+(?:my\s+)?order/i;
// Bare order ref alone ("ORD18504" / "#ORD18504"): anchored whole-string, a
// single bounded run, ≥3 digits (mirror BARE_ORDER_REF / MIN_DIGITS).
const BARE_ORDER_REF = /^#?\s{0,5}([A-Za-z]{0,5}[0-9][0-9A-Za-z-]{0,30})\s{0,5}$/;
const MIN_DIGITS = /\d{3}/;
const OPT_OUT = /^\s*(?:baja|stop|unsubscribe)[\s.!]*$/i;

export function isTrackingOptInControlMessage(content: string | null | undefined): boolean {
  if (!content || typeof content !== 'string') return false;
  const text = content.trim();
  if (!text || text.length > MAX_PARSEABLE_LENGTH) return false;
  if (OPT_OUT.test(text)) return true;
  if (ES_TEMPLATE.test(text) || EN_TEMPLATE.test(text)) return true;
  const bare = BARE_ORDER_REF.exec(text);
  return Boolean(bare?.[1] && MIN_DIGITS.test(bare[1]));
}
