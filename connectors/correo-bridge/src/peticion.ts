/**
 * SC-5382: el POST con presupuesto que comparten la entrega al núcleo (entrega.ts)
 * y la publicación del wake en el bus (eventos.ts). Antes estaba copiado en los
 * dos (y en el hermes.ts que se borró): el bucle de NATS es secuencial, así que
 * un destino caído no puede bloquearlo más de `presupuesto` ms.
 */

/** El estado HTTP, o 'timeout' / 'red'. Nunca lanza. */
export async function postConPresupuesto(
  url: URL,
  cabeceras: Record<string, string>,
  datos: string,
  presupuesto: number,
  io: { fetchImpl: typeof fetch; dormir: (ms: number, signal?: AbortSignal) => Promise<void> }
): Promise<number | 'timeout' | 'red'> {
  const peticion = new AbortController();
  const reloj = new AbortController();
  const tiempo = io.dormir(presupuesto, reloj.signal).then(() => 'timeout' as const, () => 'cancelado' as const);
  const llamada = io.fetchImpl(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cabeceras },
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
