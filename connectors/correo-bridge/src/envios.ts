import { createHash } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type pino from 'pino';
import { normalizeJid } from '@mcp-socialmedia/shared';
import { ClienteConectores, ConectorNoResponde, RespuestaEnvio } from './conectores';
import { REF, tsCanonico } from './cuerpo';
import { verificarV2 } from './firma';
import { CodigoError, ERRORES, leerCuerpo, responder } from './http';

// CONTRACT: correo.connector.v1
/**
 * POST /envios of correo.connector.v1 (DGX-1235 B2 (ii)): an answer a person
 * approved in Postia, sent once. The bridge only translates: it checks the
 * body, that the conversation has an inbound message and that the send is on,
 * and hands the text to the connector with the core's `idempotencia` as
 * Idempotency-Key. It stores nothing; the connector keeps the idempotency
 * (send-idempotency of each connector). Whoever calls this route sends as
 * Skirmshop: only the core holds the connector's key. Neither the text, the
 * identity nor the key are logged or echoed in an error.
 */

const CUERPO_MAX = 64 * 1024; // 4096 code points escaped by json.dumps: ≤12 bytes each
const TEXTO_MAX = 4096;
const HISTORIA = 50;
const CAMPOS = ['destino_ref', 'idempotencia', 'sha256', 'texto'];
const IDEMPOTENCIA = /^[A-Za-z0-9_.:-]{1,200}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DESTINO_WA = /^[0-9]{5,20}@(c\.us|lid)$/;
const DESTINO_TG = /^[1-9][0-9]{0,19}$/;


interface Envio {
  destino_ref: string;
  texto: string;
  sha256: string;
  idempotencia: string;
}

export interface EnviosOptions {
  /** Connector id (`wa-*`, `tg-*`) -> its key. */
  secretos: ReadonlyMap<string, string>;
  conectores: ClienteConectores;
  /** Own WhatsApp JID, '' while unknown (me-cache). */
  jidPropio: () => Promise<string>;
  /** ENABLE_OUTBOUND. */
  habilitado: boolean;
  ahoraS?: () => number;
  logger: pino.Logger;
}

/** The closed body of `Envio`, valid for the channel of the key that signed it; null otherwise. */
function envioValido(cuerpo: Buffer, canal: 'wa' | 'tg'): Envio | null {
  let datos: unknown;
  try {
    datos = JSON.parse(cuerpo.toString('utf-8'));
  } catch {
    return null;
  }
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return null;
  const d = datos as Record<string, unknown>;
  if (Object.keys(d).sort().join() !== CAMPOS.join()) return null;
  const { destino_ref, texto, sha256, idempotencia } = d;
  if (typeof destino_ref !== 'string' || typeof texto !== 'string' || typeof sha256 !== 'string' || typeof idempotencia !== 'string') return null;
  const largo = Array.from(texto).length;
  if (largo < 1 || largo > TEXTO_MAX || !SHA256.test(sha256) || !IDEMPOTENCIA.test(idempotencia)) return null;
  if (!(canal === 'wa' ? DESTINO_WA : DESTINO_TG).test(destino_ref)) return null;
  if (createHash('sha256').update(texto, 'utf8').digest('hex') !== sha256) return null;
  return { destino_ref, texto, sha256, idempotencia };
}

export function crearEnvios(opts: EnviosOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const ahoraS = opts.ahoraS ?? (() => Math.floor(Date.now() / 1000));

  const fallo = (res: ServerResponse, e: CodigoError): void => {
    const [status, detalle] = ERRORES[e];
    opts.logger.info({ ruta: 'envios', status, error: e }, 'correo.connector send');
    responder(res, status, { error: e, detalle });
  };

  /** Whether the conversation has at least one inbound message among its last HISTORIA (hasInboundHistory). */
  async function conEntrante(canal: 'wa' | 'tg', destino: string): Promise<boolean> {
    if (canal === 'wa') {
      const propio = normalizeJid(await opts.jidPropio());
      if (!propio) throw new ConectorNoResponde();
      const filas = await opts.conectores.historialWhatsapp(destino, HISTORIA);
      return filas.some(f => typeof f.from === 'string' && f.from !== '' && normalizeJid(f.from) !== propio);
    }
    const filas = await opts.conectores.mensajesTelegram(destino, HISTORIA);
    return filas.some(f => f.isOutbound === false);
  }

  /** The connector's answer, in the contract's terms. A 200 without a usable id is not «sent». */
  function traducir(canal: 'wa' | 'tg', r: RespuestaEnvio): { status: 200; cuerpo: unknown } | CodigoError {
    const c = r.cuerpo ?? {};
    if (r.status === 200) {
      const id = typeof c.messageId === 'string' ? c.messageId : '';
      const ref = canal === 'wa' ? id : `tg:${id}`;
      const ts = typeof c.sentAt === 'string' ? tsCanonico(c.sentAt) : null;
      if (!id || !REF.test(ref) || ts === null) return 'resultado_incierto';
      return { status: 200, cuerpo: { ref, ts, deduplicado: c.deduplicated === true } };
    }
    if (r.status === 409 && c.failureClass === 'idempotency_key_reused') return 'idempotencia_reutilizada';
    if (r.status === 409 && c.failureClass === 'send_outcome_uncertain') return 'resultado_incierto';
    if (r.status === 403 && c.failureClass === 'disabled_sending') return 'envio_desactivado';
    return 'canal_no_responde';
  }

  return async (req, res) => {
    const objetivo = req.url ?? '/';
    const [camino, query] = objetivo.split('?', 2);
    if (camino !== '/envios') return false;

    const cuerpo = await leerCuerpo(req, CUERPO_MAX);
    const claveId = cuerpo === null ? null
      : verificarV2(opts.secretos, req.headers, req.method ?? '', objetivo, cuerpo, ahoraS());
    if (claveId === null || cuerpo === null) {
      fallo(res, 'no_autenticado');
      return true;
    }
    if (req.method !== 'POST') {
      fallo(res, 'no_encontrado');
      return true;
    }
    if (!opts.habilitado) {
      fallo(res, 'envio_desactivado');
      return true;
    }
    const canal = claveId.startsWith('wa-') ? 'wa' : 'tg';
    const envio = query === undefined ? envioValido(cuerpo, canal) : null;
    if (envio === null) {
      fallo(res, 'no_procesable');
      return true;
    }
    try {
      if (!(await conEntrante(canal, envio.destino_ref))) {
        fallo(res, 'primer_contacto');
        return true;
      }
      const r = canal === 'wa'
        ? await opts.conectores.enviarWhatsapp(envio.destino_ref, envio.texto, envio.idempotencia)
        : await opts.conectores.enviarTelegram(envio.destino_ref, envio.texto, envio.idempotencia);
      const t = traducir(canal, r);
      if (typeof t === 'string') {
        fallo(res, t);
        return true;
      }
      opts.logger.info({ ruta: 'envios', status: 200, deduplicado: (t.cuerpo as { deduplicado: boolean }).deduplicado }, 'correo.connector send');
      responder(res, 200, t.cuerpo);
    } catch (error) {
      if (!(error instanceof ConectorNoResponde)) opts.logger.error({ ruta: 'envios', err: (error as Error).name }, 'correo.connector send failed');
      fallo(res, 'canal_no_responde');
    }
    return true;
  };
}
