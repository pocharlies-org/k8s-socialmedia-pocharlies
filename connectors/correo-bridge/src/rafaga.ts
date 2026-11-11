import type { MessageReceivedEvent } from '@mcp-socialmedia/shared';
import type pino from 'pino';
import { tarjetaWhatsapp } from './caso';
import type { ResultadoAviso } from './hermes';

/**
 * DGX-1550: burst coalescer for the secretary wake (was: one full Hermes turn —
 * and one `estado_sesiones` of ~36 KB — per incoming message, so a live chat of
 * 20 messages meant 20 turns answering `ya_abierta`). The first entrante of a
 * `caso` opens a window of `ms`; every message that arrives inside it rides in
 * ONE card flushed when the window closes. Different `caso`s never share a window.
 *
 * shortcut: the buffer is in-memory only — a bridge restart inside a window loses
 * that burst's wake (same known limit as a lost Hermes turn; the messages stay in
 * the WhatsApp index and in the unread list).
 */

const MAX_EN_LA_VENTANA = 50;

interface Ventana {
  chat: string;
  ref: string;
  eventos: MessageReceivedEvent[];
  temporizador: ReturnType<typeof setTimeout>;
}

export class DespertarRafaga {
  private readonly ventanas = new Map<string, Ventana>();

  constructor(
    private readonly ms: number,
    private readonly avisar: (tarjeta: string, requestId: string) => Promise<ResultadoAviso>,
    private readonly logger: pino.Logger
  ) {}

  /** Non-blocking: schedules the burst flush and returns; the NATS loop never waits on it. */
  despertar(caso: string, evento: MessageReceivedEvent, chat: string, ref: string): void {
    const abierta = this.ventanas.get(caso);
    if (abierta) {
      abierta.eventos.push(evento);
      if (abierta.eventos.length > MAX_EN_LA_VENTANA) abierta.eventos.shift();
      abierta.ref = ref; // the wake's X-Request-ID: the last message of the burst
      return;
    }
    const ventana: Ventana = { chat, ref, eventos: [evento], temporizador: undefined as never };
    ventana.temporizador = setTimeout(() => void this.cerrar(caso), this.ms);
    ventana.temporizador.unref?.();
    this.ventanas.set(caso, ventana);
  }

  private async cerrar(caso: string): Promise<void> {
    const ventana = this.ventanas.get(caso);
    if (!ventana) return;
    this.ventanas.delete(caso);
    const ultimo = ventana.eventos[ventana.eventos.length - 1];
    const resultado = await this.avisar(
      tarjetaWhatsapp(ultimo, caso, ventana.chat, ventana.eventos),
      `whatsapp-skirmshop:${ventana.chat}:${ventana.ref}`
    );
    this.logger.info({ resultado, mensajes: ventana.eventos.length }, 'secretary wake');
  }
}
