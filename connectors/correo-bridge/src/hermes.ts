import { createHmac } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import type pino from 'pino';

/**
 * DGX-1533: wake of the Skirmshop secretary (Hermes profile webhook), the
 * analogue of the Gmail `webhook_by_account` wake. Inbound-only: this bridge
 * never sends anything to a customer here — the answer is decided by the case
 * session after Dani's OK (the WhatsApp autopilot stays deleted, 27-10).
 *
 * Scheme (verified in synapse-adapter-gmail/notify_profile.py, the Hermes
 * receiver `gateway/platforms/webhook.py::_validate_signature`):
 *   POST {url}
 *   X-Webhook-Timestamp:    <unix seconds>
 *   X-Webhook-Signature-V2: hex(HMAC-SHA256(secret, "<ts>." + body))
 *   X-Request-ID:           <delivery id>   (Hermes dedups on it)
 *   202 delivered, 200 duplicate; 429 honours Retry-After.
 *
 * Delivery is bounded like entrega.ts: 3 attempts inside 30 s — a dead Hermes
 * must not block the sequential NATS loop for longer than that.
 */

const INTENTOS = 3;
const TOPE_MS = 30_000;
const TIEMPO_INTENTO_MS = 8_000;
const ESPERAS_MS = [1_000, 2_000];
const RETRY_AFTER_MAX_S = 25;

export function firmarWebhookHermes(secreto: string, ts: string, cuerpo: string): string {
  return createHmac('sha256', secreto).update(`${ts}.`).update(cuerpo).digest('hex');
}

export interface AvisoOptions {
  /** Full route URL: {base}/p/<perfil>/webhooks/<ruta>. */
  url: string;
  secreto: string;
  logger: pino.Logger;
  fetchImpl?: typeof fetch;
  ahora?: () => number;
  dormir?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type ResultadoAviso = 'enviado' | 'duplicado' | 'rechazado' | 'agotado';

export class AvisoHermes {
  readonly contadores = { enviados: 0, duplicados: 0, rechazados: 0, agotados: 0 };
  private readonly fetchImpl: typeof fetch;
  private readonly ahora: () => number;
  private readonly dormir: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly opts: AvisoOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.ahora = opts.ahora ?? (() => Date.now());
    this.dormir = opts.dormir ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  }

  /** One signed wake card. Never throws: the caller's message already went to the core. */
  async avisar(mensaje: string, requestId: string): Promise<ResultadoAviso> {
    const datos = JSON.stringify({ mensaje });
    const fin = this.ahora() + TOPE_MS;
    let ultimo: number | string = '';
    for (let i = 0; i < INTENTOS; i++) {
      if (i > 0) {
        const espera = ESPERAS_MS[i - 1];
        if (this.ahora() + espera >= fin) break;
        await this.dormir(espera).catch(() => undefined);
      }
      const presupuesto = Math.min(TIEMPO_INTENTO_MS, fin - this.ahora());
      if (presupuesto <= 0) break;
      const r = await this.intento(datos, requestId, presupuesto);
      if (r.status === 202) {
        this.contadores.enviados++;
        return 'enviado';
      }
      if (r.status === 200) {
        this.contadores.duplicados++;
        return 'duplicado';
      }
      if (typeof r.status === 'number' && r.status >= 400 && r.status < 500 && r.status !== 429) {
        this.contadores.rechazados++;
        // PII-free: the status only, never the card.
        this.opts.logger.error({ status: r.status }, 'hermes rejected the wake; not retried');
        return 'rechazado';
      }
      if (r.status === 429) {
        // The route asks for calm: wait its Retry-After while the budget allows.
        const esperaMs = Math.min(r.retryAfterS ?? 30, RETRY_AFTER_MAX_S) * 1000;
        if (this.ahora() + esperaMs >= fin) break;
        await this.dormir(esperaMs).catch(() => undefined);
        ultimo = 429;
        continue;
      }
      ultimo = r.status;
    }
    this.contadores.agotados++;
    this.opts.logger.error({ intentos: INTENTOS, ultimo }, 'hermes wake unreachable: secretary not notified (the customer message stays unread in WhatsApp)');
    return 'agotado';
  }

  /** The status (plus `Retry-After` seconds when 429), or 'timeout' / 'red'. Never throws. */
  private async intento(datos: string, requestId: string, presupuesto: number): Promise<{ status: number | 'timeout' | 'red'; retryAfterS?: number }> {
    const ts = String(Math.floor(this.ahora() / 1000));
    const peticion = new AbortController();
    const reloj = new AbortController();
    const tiempo = this.dormir(presupuesto, reloj.signal).then(() => 'timeout' as const, () => 'cancelado' as const);
    const llamada = this.fetchImpl(this.opts.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': ts,
        'X-Webhook-Signature-V2': firmarWebhookHermes(this.opts.secreto, ts, datos),
        'X-Request-ID': requestId,
      },
      body: datos,
      signal: peticion.signal,
    }).then(
      res => {
        void res.arrayBuffer().catch(() => undefined);
        const retry = res.status === 429 ? Number(res.headers.get('Retry-After')) : NaN;
        return { status: res.status, retryAfterS: Number.isFinite(retry) && retry >= 0 ? retry : undefined };
      },
      () => ({ status: 'red' as const })
    );
    try {
      const r = await Promise.race([llamada, tiempo]);
      if (r === 'timeout') {
        peticion.abort();
        return { status: 'timeout' };
      }
      return r === 'cancelado' ? { status: 'red' } : r;
    } finally {
      reloj.abort();
    }
  }
}
