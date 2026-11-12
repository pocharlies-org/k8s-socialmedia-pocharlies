import { createHmac } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import type pino from 'pino';
import { postConPresupuesto } from './peticion';

/**
 * SC-5382 (pieza 5 de SC-5370): el wake de la secretaria de Skirmshop se PUBLICA
 * en el bus de Synapse en vez de llamar a Hermes directamente.
 *
 * Antes (DGX-1533): POST firmado a la ruta de Hermes, 3 intentos en 30 s y
 * descarte — `agotado`, «the customer message stays unread in WhatsApp». Ahora:
 * POST /eventos del gateway, que escribe `webhook_inbox` + `outbox` en UNA
 * transacción antes del 202. El adapter gmail entrega el comando a Hermes desde
 * `adapter.hermes.wake`, con su presupuesto de reintentos, su 429 y su DLQ, que el
 * re-drive de SC-5380 devuelve cuando Hermes vuelve. **El 202 del gateway es el
 * límite de durabilidad**: con Hermes caído el wake espera en la cola, no se tira.
 *
 * Inbound-only: este bridge nunca contesta al cliente; la respuesta la decide la
 * sesión del caso con el OK de Dani (el autopilot de WhatsApp sigue borrado, 27-10).
 *
 * CONTRACT: http.gateway.eventos.v1 — POST /eventos, productor `correo`
 * CONTRACT: eventos.hermes.wake
 */

export const ROUTING_KEY = 'eventos.hermes.wake';
const PRODUCTOR = 'correo';
/** La ruta de la secretaria de Skirmshop (DGX-1533): ahora viaja en el comando. */
const TENANT = 'skirmshop';
const PERFIL = 'secretaria-skirmshop';
const RUTA = 'whatsapp-skirmshop';

const INTENTOS = 3;
const TOPE_MS = 30_000;
const TIEMPO_INTENTO_MS = 8_000;
const ESPERAS_MS = [1_000, 2_000];

export type ResultadoWake = 'publicado' | 'rechazado' | 'agotado';

export interface PublicadorOptions {
  /** Base del gateway Synapse, sin path: el Service del cluster, nunca el borde. */
  eventosUrl: string;
  secreto: string;
  logger: pino.Logger;
  fetchImpl?: typeof fetch;
  ahora?: () => number;
  dormir?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** La firma del gateway: HMAC-SHA256 hex del body CRUDO, con el prefijo `sha256=`. */
export function firmarEventos(secreto: string, cuerpo: string): string {
  return `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}`;
}

export class PublicadorWake {
  readonly contadores = { publicados: 0, rechazados: 0, agotados: 0 };
  private readonly fetchImpl: typeof fetch;
  private readonly ahora: () => number;
  private readonly dormir: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly opts: PublicadorOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.ahora = opts.ahora ?? (() => Date.now());
    this.dormir = opts.dormir ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  }

  /** Un wake al bus. Nunca lanza: el mensaje del cliente ya fue al núcleo. */
  async publicar(mensaje: string, requestId: string): Promise<ResultadoWake> {
    const url = new URL('/eventos', this.opts.eventosUrl);
    const datos = JSON.stringify({
      routing_key: ROUTING_KEY,
      tenant: TENANT,
      profile: PERFIL,
      route: RUTA,
      request_id: requestId,
      payload: { mensaje },
    });
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
      const status = await this.intento(url, datos, presupuesto);
      if (status === 202 || status === 200) {
        this.contadores.publicados++;
        return 'publicado';
      }
      if (typeof status === 'number' && status >= 400 && status < 500) {
        this.contadores.rechazados++;
        // PII-free: el estado, nunca la tarjeta. Un 401/403 es credencial o
        // allowlist mal puestas; un 413, una tarjeta demasiado grande.
        this.opts.logger.error({ status }, 'synapse rejected the wake; not retried');
        return 'rechazado';
      }
      ultimo = status;
    }
    this.contadores.agotados++;
    this.opts.logger.error({ intentos: INTENTOS, ultimo }, 'synapse unreachable: wake not published (correo_bridge_despertares_total{resultado="agotado"})');
    return 'agotado';
  }

  /** El estado, o 'timeout' / 'red'. Nunca lanza. */
  private intento(url: URL, datos: string, presupuesto: number): Promise<number | 'timeout' | 'red'> {
    return postConPresupuesto(url, {
      'X-Synapse-Producer': PRODUCTOR,
      'X-Hub-Signature-256': firmarEventos(this.opts.secreto, datos),
    }, datos, presupuesto, { fetchImpl: this.fetchImpl, dormir: this.dormir });
  }
}
