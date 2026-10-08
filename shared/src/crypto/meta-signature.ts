import { createHmac, timingSafeEqual } from 'crypto';

// `x-hub-signature-256` as Meta sends it: `sha256=` and the 64 hex chars of the digest.
const META_SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/;

/**
 * Verify Meta's `x-hub-signature-256` (HMAC-SHA256 of the raw request body, keyed with the
 * app secret). The one verifier for every Meta webhook (instagram, whatsapp-cloud). Not the
 * `ts:body` scheme of `verifyHMACSignature`, which is the connectors' own.
 *
 * `secrets` is the closed list of app secrets that may have signed it; Meta does not say which
 * app did. Empty secrets are dropped before comparing (an empty key signs anything) and an empty
 * list verifies nothing. A header that is not `sha256=<64 hex>` is false without comparing:
 * `timingSafeEqual` throws on buffers of different length.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  secrets: string[]
): boolean {
  const match = header === undefined ? null : META_SIGNATURE.exec(header);
  if (!match) return false;

  const provided = Buffer.from(match[1], 'hex');
  return secrets
    .filter(secret => secret)
    .some(secret =>
      timingSafeEqual(createHmac('sha256', secret).update(rawBody).digest(), provided)
    );
}
