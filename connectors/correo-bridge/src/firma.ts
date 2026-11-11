import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingHttpHeaders } from 'http';

/**
 * HMAC V2 of correo.ingest.v1, the TypeScript side of correo_core/hmac.py
 * (architect finding 12: two implementations, one set of vectors,
 * fixtures/hmac_vectores.json). Signed string:
 * `"<ts>." + "<METHOD> <path?query>\n" + body`, lowercase hex HMAC-SHA256.
 */

export const VENTANA_S = 60;
const INSTANTE = /^[0-9]{1,12}$/;
const FIRMA = /^[0-9a-f]{64}$/;

export function firmarV2(secreto: string, ts: string, metodo: string, objetivo: string, cuerpo: string | Buffer): string {
  return createHmac('sha256', secreto).update(`${ts}.${metodo} ${objetivo}\n`).update(cuerpo).digest('hex');
}

/**
 * The key id that signed this request, or null. `objetivo` is the raw request
 * target exactly as it arrived (`@` and `:` not rewritten). Never says why.
 */
export function verificarV2(
  secretos: ReadonlyMap<string, string>,
  cabeceras: IncomingHttpHeaders,
  metodo: string,
  objetivo: string,
  cuerpo: Buffer,
  ahoraS: number
): string | null {
  const [claveId, ts, firma] = ['x-correo-key-id', 'x-correo-timestamp', 'x-correo-signature'].map(c => cabeceras[c]);
  if (typeof claveId !== 'string' || typeof ts !== 'string' || typeof firma !== 'string') return null;
  if (!INSTANTE.test(ts) || !FIRMA.test(firma) || Math.abs(ahoraS - Number(ts)) > VENTANA_S) return null;
  const secreto = secretos.get(claveId);
  if (secreto === undefined) return null;
  const esperada = Buffer.from(firmarV2(secreto, ts, metodo, objetivo, cuerpo));
  return timingSafeEqual(esperada, Buffer.from(firma)) ? claveId : null;
}
