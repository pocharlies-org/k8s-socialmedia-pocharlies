import type { MessageReceivedEvent, TelegramMessageReceivedEvent } from '@mcp-socialmedia/shared';
import type { Canal } from './config';

/**
 * The body of POST /v2/mensajes/{conector} (correo.ingest.v2 `MensajeCanal`,
 * closed): only refs, direction, instant and the canonical identity. Never the
 * text, the push name, attachments or the phone (DGX-1235 B1.4).
 */
export interface MensajeCanal {
  ref: string;
  hilo_ref: string;
  direccion: 'entrante' | 'saliente';
  ts: string;
  /** The customer on an entrante; null on a saliente (the core ignores it there). */
  identidad: { canal: Canal; valor: string } | null;
}

export type Direccion = MensajeCanal['direccion'];

export const REF = /^[A-Za-z0-9_.:@-]{3,120}$/;
// The same expressions as correo_core/dominio/casos.py normalizar_identidad.
const WHATSAPP = /^([0-9]{5,20})(?::[0-9]{1,5})?@(c\.us|s\.whatsapp\.net|lid)$/;
const TELEGRAM = /^[1-9][0-9]{0,19}$/;

/** Canonical identity of correo.connector.v1, or null if it is not one of that channel. */
export function canonica(canal: Canal, valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpio = valor.replace(/\s+/g, '').toLowerCase();
  if (canal === 'telegram') return TELEGRAM.test(limpio) ? limpio : null;
  const m = WHATSAPP.exec(limpio);
  return m ? `${m[1]}@${m[2] === 'lid' ? 'lid' : 'c.us'}` : null;
}

/** `YYYY-MM-DDTHH:MM:SSZ`, the only form the core parses. */
export function tsCanonico(valor: string | number | Date): string | null {
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

type Resultado = { cuerpo: MensajeCanal } | { motivo: string };

function armar(ref: string, hilo: string | null, direccion: Direccion, ts: string | null, canal: Canal, quien: string | null): Resultado {
  if (!REF.test(ref)) return { motivo: 'ref-no-valido' };
  if (hilo === null || !REF.test(hilo)) return { motivo: 'identidad-no-canonica' };
  if (ts === null) return { motivo: 'ts-no-valido' };
  if (direccion === 'entrante' && quien === null) return { motivo: 'identidad-no-canonica' };
  return {
    cuerpo: {
      ref,
      hilo_ref: hilo,
      direccion,
      ts,
      identidad: direccion === 'entrante' ? { canal, valor: quien as string } : null,
    },
  };
}

export function cuerpoWhatsapp(e: MessageReceivedEvent, direccion: Direccion): Resultado {
  return armar(
    (e.waMessageId || '').trim(),
    canonica('whatsapp', e.conversationId),
    direccion,
    tsCanonico(e.waTimestamp),
    'whatsapp',
    canonica('whatsapp', e.senderWaId)
  );
}

export function cuerpoTelegram(e: TelegramMessageReceivedEvent, direccion: Direccion): Resultado {
  const chat = canonica('telegram', e.conversationId);
  return armar(
    `tg:${(e.telegramMessageId || '').trim()}`,
    chat === null ? null : `tg:${chat}`,
    direccion,
    tsCanonico(e.telegramTimestamp),
    'telegram',
    canonica('telegram', e.senderTelegramId)
  );
}
