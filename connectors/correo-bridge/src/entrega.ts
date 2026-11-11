import { setTimeout as sleep } from 'timers/promises';
import type pino from 'pino';
import type { MensajeCanal } from './cuerpo';
import { firmarV2 } from './firma';

/**
 * Bounded delivery of one message to the correo core (DGX-1235 B1.5, architect
 * finding 11). NATS core is at-most-once and the subscription loop is
 * sequential: a core that is down must not block it. 3 attempts in under 30 s,
 * then the message is discarded and counted in `correo_bridge_agotados_total`
 * (alert in k8s/base/correo-bridge.yaml). A 4xx is not retried; a 5xx, a
 * timeout or a network error is. A message lost this way is not reconciled.
 */

export const INTENTOS = 3;
export const TOPE_MS = 30_000;
const TIEMPO_INTENTO_MS = 8_000;
const ESPERAS_MS = [1_000, 2_000];

export type ResultadoEntrega = 'entregado' | 'duplicado' | 'rechazado' | 'agotado';

export interface EntregaOptions {
  coreUrl: string;
  /** Connector id -> its producer towards the core (one producer per connector). */
  productores: ReadonlyMap<string, { id: string; secreto: string }>;
  logger: pino.Logger;
  fetchImpl?: typeof fetch;
  /** Clock in ms and a cancellable sleep: injected by the tests. */
  ahora?: () => number;
  dormir?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class Entrega {
  readonly contadores = { entregados: 0, duplicados: 0, rechazados: 0, agotados: 0 };
  private readonly fetchImpl: typeof fetch;
  private readonly ahora: () => number;
  private readonly dormir: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly opts: EntregaOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.ahora = opts.ahora ?? (() => Date.now());
    this.dormir = opts.dormir ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  }

  async entregar(conector: string, cuerpo: MensajeCanal): Promise<{ resultado: ResultadoEntrega; intentos: number }> {
    const productor = this.opts.productores.get(conector);
    if (!productor) throw new Error('no producer for this connector');
    const url = new URL(`/v2/mensajes/${conector}`, this.opts.coreUrl);
    const datos = JSON.stringify(cuerpo);
    const fin = this.ahora() + TOPE_MS;
    let intentos = 0;
    let ultimo: number | string = '';
    for (let i = 0; i < INTENTOS; i++) {
      if (i > 0) {
        const espera = ESPERAS_MS[i - 1];
        if (this.ahora() + espera >= fin) break;
        await this.dormir(espera).catch(() => undefined);
      }
      const presupuesto = Math.min(TIEMPO_INTENTO_MS, fin - this.ahora());
      if (presupuesto <= 0) break;
      intentos++;
      const status = await this.intento(url, productor, datos, presupuesto);
      if (status === 202 || status === 200) {
        const resultado = status === 202 ? 'entregado' : 'duplicado';
        this.contadores[resultado === 'entregado' ? 'entregados' : 'duplicados']++;
        return { resultado, intentos };
      }
      if (typeof status === 'number' && status >= 400 && status < 500) {
        this.contadores.rechazados++;
        // PII-free: the connector id and the status, never the ref, the thread or the identity.
        this.opts.logger.error({ conector, status }, 'correo core rejected the message; not retried');
        return { resultado: 'rechazado', intentos };
      }
      ultimo = status;
    }
    this.contadores.agotados++;
    this.opts.logger.error({ conector, intentos, ultimo }, 'correo core unreachable: message discarded (correo_bridge_agotados_total)');
    return { resultado: 'agotado', intentos };
  }

  /** The status, or 'timeout' / 'red'. Never throws. */
  private async intento(url: URL, productor: { id: string; secreto: string }, datos: string, presupuesto: number): Promise<number | 'timeout' | 'red'> {
    const ts = String(Math.floor(this.ahora() / 1000));
    const peticion = new AbortController();
    const reloj = new AbortController();
    const tiempo = this.dormir(presupuesto, reloj.signal).then(() => 'timeout' as const, () => 'cancelado' as const);
    const llamada = this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Correo-Key-Id': productor.id,
        'X-Correo-Timestamp': ts,
        'X-Correo-Signature': firmarV2(productor.secreto, ts, 'POST', url.pathname + url.search, datos),
      },
      body: datos,
      signal: peticion.signal,
    }).then(
      res => {
        void res.arrayBuffer().catch(() => undefined);
        return res.status;
      },
      () => 'red' as const
    );
    try {
      const r = await Promise.race([llamada, tiempo]);
      if (r === 'timeout') peticion.abort();
      return r === 'cancelado' ? 'red' : r;
    } finally {
      reloj.abort();
    }
  }
}
