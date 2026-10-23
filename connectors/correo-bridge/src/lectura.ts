import type { IncomingMessage, ServerResponse } from 'http';
import type pino from 'pino';
import { ClienteConectores, ConectorNoResponde, FilaTelegram, FilaWhatsapp } from './conectores';
import { canonica, REF, tsCanonico } from './cuerpo';
import { normalizeJid } from './filter';
import { verificarV2 } from './firma';
import type { IndiceRefs } from './refs';

// CONTRACT: correo.connector.v1
/**
 * The read routes of correo.connector.v1 (DGX-1235 B1.6): GET /mensajes/{ref}
 * and GET /hilos/{hilo_ref}?limite=. HMAC V2 with the connector's key, over
 * the raw request target: node's `req.url` is the request line as it arrived
 * (what Express calls `originalUrl`), with `@` and `:` not rewritten. The text
 * lives only in memory and in the response: never stored, never logged. The
 * send route of the contract is B2's: this handler does not know it.
 */

const TEXTO_MAX = 4096;
const ADJUNTOS_MAX = 20;
const HILO_MAX = 50;
const CUERPO_MAX = 4096;

interface MensajeLeido {
  ref: string;
  hilo_ref: string;
  direccion: 'entrante' | 'saliente';
  ts: string;
  texto: string;
  adjuntos: Array<{ tipo: string }>;
}

type Error_ = 'no_autenticado' | 'no_encontrado' | 'no_procesable' | 'canal_no_responde';
const ERRORES: Record<Error_, [number, string]> = {
  no_autenticado: [401, 'Sin firma, firma mala o fuera de plazo.'],
  no_encontrado: [404, 'No existe en este conector.'],
  no_procesable: [422, 'La petición no cumple el contrato.'],
  canal_no_responde: [502, 'El canal no responde.'],
};

export interface LecturaOptions {
  /** Connector id (`wa-*`, `tg-*`) -> its key. */
  secretos: ReadonlyMap<string, string>;
  conectores: ClienteConectores;
  /** Own WhatsApp JID, '' while unknown (me-cache). */
  jidPropio: () => Promise<string>;
  refs: IndiceRefs;
  ahoraS?: () => number;
  logger: pino.Logger;
}

function recortar(texto: unknown): string {
  if (typeof texto !== 'string') return '';
  if (texto.length <= TEXTO_MAX) return texto;
  return Array.from(texto).slice(0, TEXTO_MAX).join('');
}

function tipo(valor: unknown): string {
  const t = String(valor ?? '').toLowerCase().replace(/[^a-z_]/g, '_').slice(0, 20);
  return t || 'otro';
}

function leerCuerpo(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise(resolve => {
    const trozos: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > CUERPO_MAX) {
        resolve(null);
        req.destroy();
        return;
      }
      trozos.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(trozos)));
    req.on('error', () => resolve(null));
  });
}

function desdeWhatsapp(f: FilaWhatsapp, hilo: string, propio: string): MensajeLeido | null {
  const ref = typeof f.id === 'string' ? f.id : '';
  const ts = typeof f.timestamp === 'number' ? tsCanonico(f.timestamp * 1000) : null;
  if (!REF.test(ref) || ts === null) return null;
  return {
    ref,
    hilo_ref: hilo,
    // The connector's history says fromMe:false always: the direction is the sender.
    direccion: normalizeJid(String(f.from ?? '')) === propio ? 'saliente' : 'entrante',
    ts,
    texto: recortar(f.body),
    adjuntos: f.hasMedia === true ? [{ tipo: tipo(f.type) }] : [],
  };
}

function desdeTelegram(f: FilaTelegram, hilo: string): MensajeLeido | null {
  const ref = `tg:${String(f.telegramMessageId ?? '')}`;
  const ts = typeof f.telegramTimestamp === 'string' ? tsCanonico(f.telegramTimestamp) : null;
  if (!REF.test(ref) || ts === null) return null;
  const adjuntos = Array.isArray(f.attachments) && f.attachments.length > 0
    ? f.attachments.map(a => ({ tipo: tipo(a?.type) }))
    : f.messageType && f.messageType !== 'TEXT' ? [{ tipo: tipo(f.messageType) }] : [];
  return {
    ref,
    hilo_ref: hilo,
    direccion: f.isOutbound === true ? 'saliente' : 'entrante',
    ts,
    texto: recortar(f.content),
    adjuntos: adjuntos.slice(0, ADJUNTOS_MAX),
  };
}

/** The connector's key id says the channel; the thread must be canonical for it. */
function hiloDelCanal(claveId: string, hilo: string): string | null {
  if (claveId.startsWith('wa-')) return canonica('whatsapp', hilo) === hilo ? hilo : null;
  if (claveId.startsWith('tg-') && hilo.startsWith('tg:')) {
    return canonica('telegram', hilo.slice(3)) === hilo.slice(3) ? hilo.slice(3) : null;
  }
  return null;
}

export function crearLectura(opts: LecturaOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const ahoraS = opts.ahoraS ?? (() => Math.floor(Date.now() / 1000));

  const responder = (res: ServerResponse, status: number, cuerpo: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(cuerpo));
  };
  const fallo = (res: ServerResponse, ruta: string, e: Error_): void => {
    const [status, detalle] = ERRORES[e];
    opts.logger.info({ ruta, status }, 'correo.connector read');
    responder(res, status, { error: e, detalle });
  };

  /** Messages of a thread, oldest to newest, at most `limite`. Null if the thread is empty. */
  async function leerHilo(claveId: string, hilo: string, chat: string, limite: number): Promise<MensajeLeido[] | null> {
    let mensajes: MensajeLeido[];
    if (claveId.startsWith('wa-')) {
      const propio = normalizeJid(await opts.jidPropio());
      if (!propio) throw new ConectorNoResponde();
      const filas = await opts.conectores.historialWhatsapp(chat, limite);
      mensajes = filas.map(f => desdeWhatsapp(f, hilo, propio)).filter((m): m is MensajeLeido => m !== null);
    } else {
      const filas = await opts.conectores.mensajesTelegram(chat, limite);
      mensajes = filas.map(f => desdeTelegram(f, hilo)).filter((m): m is MensajeLeido => m !== null);
    }
    if (mensajes.length === 0) return null;
    return mensajes.sort((a, b) => a.ts.localeCompare(b.ts)).slice(-limite);
  }

  return async (req, res) => {
    const objetivo = req.url ?? '/';
    const [camino, query = ''] = objetivo.split('?', 2);
    const m = /^\/(mensajes|hilos)\/([^/]+)$/.exec(camino);
    if (!m) return false;
    const ruta = m[1];

    const cuerpo = await leerCuerpo(req);
    const claveId = cuerpo === null ? null
      : verificarV2(opts.secretos, req.headers, req.method ?? '', objetivo, cuerpo, ahoraS());
    if (claveId === null) {
      fallo(res, ruta, 'no_autenticado');
      return true;
    }
    if (req.method !== 'GET') {
      fallo(res, ruta, 'no_encontrado');
      return true;
    }

    let param: string;
    try {
      param = decodeURIComponent(m[2]);
    } catch {
      fallo(res, ruta, 'no_procesable');
      return true;
    }
    const params = new URLSearchParams(query);
    const claves = [...params.keys()];
    let limite = HILO_MAX;
    if (ruta === 'hilos') {
      const l = params.get('limite');
      if (claves.some(k => k !== 'limite') || claves.length > 1 || (l !== null && !/^[1-9][0-9]?$/.test(l)) || Number(l ?? 30) > HILO_MAX) {
        fallo(res, ruta, 'no_procesable');
        return true;
      }
      limite = Number(l ?? 30);
    } else if (claves.length > 0) {
      fallo(res, ruta, 'no_procesable');
      return true;
    }
    if (!REF.test(param)) {
      fallo(res, ruta, 'no_procesable');
      return true;
    }

    const hilo = ruta === 'hilos' ? param : opts.refs.hilo(param);
    const chat = hilo === undefined ? null : hiloDelCanal(claveId, hilo);
    if (hilo === undefined || chat === null) {
      fallo(res, ruta, 'no_encontrado');
      return true;
    }
    try {
      const mensajes = await leerHilo(claveId, hilo, chat, limite);
      if (ruta === 'hilos') {
        if (mensajes === null) fallo(res, ruta, 'no_encontrado');
        else {
          opts.logger.info({ ruta, status: 200, n: mensajes.length }, 'correo.connector read');
          responder(res, 200, { mensajes });
        }
        return true;
      }
      const uno = mensajes?.find(x => x.ref === param);
      if (!uno) fallo(res, ruta, 'no_encontrado');
      else {
        opts.logger.info({ ruta, status: 200 }, 'correo.connector read');
        responder(res, 200, uno);
      }
    } catch (error) {
      if (!(error instanceof ConectorNoResponde)) opts.logger.error({ ruta, err: (error as Error).name }, 'correo.connector read failed');
      fallo(res, ruta, 'canal_no_responde');
    }
    return true;
  };
}
