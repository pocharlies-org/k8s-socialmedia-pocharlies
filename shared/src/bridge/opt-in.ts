import { trackingOptInBaseUrl } from './config';

/**
 * Tracking opt-in control messages ("Hola Skirmshop, quiero recibir
 * seguimiento por WhatsApp del pedido ORD…" with the tracking link) belong to
 * skirmshop-labels' whatsapp-optin-ingest worker: a bridge drops them (DGX-1235
 * B0, moved from whatsapp-synapse-bridge/src/filter.ts). Off while
 * TRACKING_OPT_IN_BASE_URL is unset.
 */
const TRACKING_OPT_IN_PREFIX =
  'hola skirmshop, quiero recibir seguimiento por whatsapp del pedido ';
const TRACKING_OPT_IN_ORDER_RE = /\bord\d{3,}\b/i;

export function isTrackingOptInControlMessage(content: string | null | undefined): boolean {
  if (!content || typeof content !== 'string') return false;
  const trackingBase = trackingOptInBaseUrl();
  if (!trackingBase) return false;
  const text = content.trim().toLowerCase();
  return (
    text.startsWith(TRACKING_OPT_IN_PREFIX) &&
    TRACKING_OPT_IN_ORDER_RE.test(text) &&
    text.includes(trackingBase.toLowerCase())
  );
}
