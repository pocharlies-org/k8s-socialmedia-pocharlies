import type { IncomingMessage, ServerResponse } from 'http';

/**
 * What the two handlers of correo.connector.v1 (lectura.ts, envios.ts) share:
 * the error codes of the contract (`CodigoError`) with their status and a fixed
 * detail (never the text, the identity or the key), the bounded body read and
 * the JSON answer.
 */
export type CodigoError = 'no_autenticado' | 'no_encontrado' | 'no_procesable' | 'primer_contacto' | 'envio_desactivado'
  | 'idempotencia_reutilizada' | 'resultado_incierto' | 'canal_no_responde';

export const ERRORES: Record<CodigoError, [number, string]> = {
  no_autenticado: [401, 'Sin firma, firma mala o fuera de plazo.'],
  no_encontrado: [404, 'No existe en este conector.'],
  no_procesable: [422, 'La petición no cumple el contrato.'],
  primer_contacto: [422, 'La conversación no tiene ningún mensaje entrante.'],
  envio_desactivado: [403, 'El envío no está encendido en este puente.'],
  idempotencia_reutilizada: [409, 'Esa clave ya se usó con otro cuerpo.'],
  resultado_incierto: [409, 'No se sabe si el envío anterior salió.'],
  canal_no_responde: [502, 'El canal no responde.'],
};

/** The raw body, or null past `max` bytes or on a broken request. */
export function leerCuerpo(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise(resolve => {
    const trozos: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > max) {
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

export function responder(res: ServerResponse, status: number, cuerpo: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(cuerpo));
}
