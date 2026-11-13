import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { PublicadorWake, ROUTING_KEY, firmarEventos } from './eventos';

// SC-5382: el wake sale por POST /eventos del gateway (contrato
// http.gateway.eventos.v1), no a Hermes. La firma es hex(HMAC(secret, body crudo))
// con el prefijo `sha256=`; el vector está precomputado con esa misma regla.
const SECRETO = 'secreto-eventos-synapse-de-prueba-0123456789';
const AHORA_MS = 1762000000000;
const FIRMA_ESPERADA = 'sha256=e22cfe5fabd40833fb9616c21859800383a7b6aff9bda9bddd31f2cdc28a79d6';
const URL_GATEWAY = 'http://synapse-gateway.synapse.svc.cluster.local:8000';

test('firmarEventos: el vector precomputado', () => {
  assert.equal(firmarEventos(SECRETO, JSON.stringify({ mensaje: 'hola' })), FIRMA_ESPERADA);
});

interface Llamada { url: string; headers: Record<string, string>; body: string }

function montar(secuencia: Array<{ status: number }>) {
  const llamadas: Llamada[] = [];
  let n = 0;
  let ahora = AHORA_MS;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const paso = secuencia[Math.min(n, secuencia.length - 1)];
    n++;
    llamadas.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body),
    });
    return new Response('', { status: paso.status });
  }) as unknown as typeof fetch;
  const publicador = new PublicadorWake({
    eventosUrl: URL_GATEWAY,
    secreto: SECRETO,
    logger: pino({ level: 'silent' }),
    fetchImpl,
    ahora: () => ahora,
    // El mismo reloj falso que entrega.test.ts: una señal abortada rechaza, así
    // la carrera del presupuesto por intento se comporta como el sleep real.
    dormir: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) =>
        setImmediate(() => {
          if (signal?.aborted) return reject(new Error('aborted'));
          ahora += ms;
          resolve();
        })
      ),
  });
  return { publicador, llamadas };
}

test('202: publicado, con el comando entero y la firma del body crudo', async () => {
  const { publicador, llamadas } = montar([{ status: 202 }]);
  const id = 'whatsapp-skirmshop:34600112233@c.us:3EB01';
  assert.equal(await publicador.publicar('hola', id), 'publicado');
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].url, `${URL_GATEWAY}/eventos`);
  assert.equal(llamadas[0].headers['x-synapse-producer'], 'correo');
  assert.equal(llamadas[0].headers['x-hub-signature-256'], firmarEventos(SECRETO, llamadas[0].body));
  // El comando que consume wake.py del adapter gmail: ni una URL ni un secreto dentro.
  assert.deepEqual(JSON.parse(llamadas[0].body), {
    routing_key: ROUTING_KEY,
    tenant: 'skirmshop',
    profile: 'secretaria-skirmshop',
    route: 'whatsapp-skirmshop',
    request_id: id,
    payload: { mensaje: 'hola' },
  });
  assert.equal(publicador.contadores.publicados, 1);
});

test('el request_id de la ráfaga viaja tal cual: es la dedup de Hermes', async () => {
  const { publicador, llamadas } = montar([{ status: 202 }, { status: 202 }]);
  await publicador.publicar('uno', 'whatsapp-skirmshop:34600112233@c.us:3EB01');
  await publicador.publicar('dos', 'whatsapp-skirmshop:34600112233@c.us:3EB02');
  assert.deepEqual(llamadas.map(l => JSON.parse(l.body).request_id), [
    'whatsapp-skirmshop:34600112233@c.us:3EB01',
    'whatsapp-skirmshop:34600112233@c.us:3EB02',
  ]);
});

test('4xx: rechazado y no se reintenta (credencial o allowlist mal puestas)', async () => {
  for (const status of [401, 403, 413]) {
    const { publicador, llamadas } = montar([{ status }]);
    assert.equal(await publicador.publicar('hola', 'r'), 'rechazado');
    assert.equal(llamadas.length, 1);
    assert.equal(publicador.contadores.rechazados, 1);
  }
});

test('5xx: tres intentos y agotado, contado y visible (no un descarte en silencio)', async () => {
  const { publicador, llamadas } = montar([{ status: 503 }]);
  assert.equal(await publicador.publicar('hola', 'r'), 'agotado');
  assert.equal(llamadas.length, 3);
  assert.equal(publicador.contadores.agotados, 1);
});

test('5xx y luego 202: el segundo intento publica', async () => {
  const { publicador, llamadas } = montar([{ status: 503 }, { status: 202 }]);
  assert.equal(await publicador.publicar('hola', 'r'), 'publicado');
  assert.equal(llamadas.length, 2);
});

test('el gateway caído (red) no lanza: el mensaje del cliente ya fue al núcleo', async () => {
  let ahora = AHORA_MS;
  const publicador = new PublicadorWake({
    eventosUrl: URL_GATEWAY,
    secreto: SECRETO,
    logger: pino({ level: 'silent' }),
    fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    ahora: () => ahora,
    dormir: async (ms: number) => { ahora += ms; },
  });
  assert.equal(await publicador.publicar('hola', 'r'), 'agotado');
  assert.equal(publicador.contadores.agotados, 1);
});
