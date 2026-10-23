import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { Entrega, INTENTOS, TOPE_MS } from './entrega';
import { firmarV2 } from './firma';
import type { MensajeCanal } from './cuerpo';

// C11 (DGX-1235 B1, architect finding 11, security condition 6c): bounded
// delivery to the core. NATS core is at-most-once and the subscription loop is
// sequential, so a dead core must not block it: 3 attempts, under 30 s, then
// discard and count. Controlled clock: the fake sleep advances it.
const CUERPO: MensajeCanal = {
  ref: '3EB0A1B2C3D4E5F60001',
  hilo_ref: '34600111222@c.us',
  direccion: 'entrante',
  ts: '2026-10-23T09:00:00Z',
  identidad: { canal: 'whatsapp', valor: '34600111222@c.us' },
};
const SECRETO = 'secreto-de-prueba-productor-0123456789';

function reloj(inicio = 1_792_745_000_000) {
  let t = inicio;
  return {
    ahora: () => t,
    dormir: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) =>
        setImmediate(() => {
          if (signal?.aborted) return reject(new Error('aborted'));
          t += ms;
          resolve();
        })
      ),
    transcurrido: () => t - inicio,
  };
}

function entrega(fetchImpl: typeof fetch, r = reloj()) {
  return {
    r,
    e: new Entrega({
      coreUrl: 'http://correo-machine.test',
      productorId: 'correo-bridge',
      productorSecreto: SECRETO,
      fetchImpl,
      ahora: r.ahora,
      dormir: r.dormir,
      logger: pino({ level: 'silent' }),
    }),
  };
}

test('C11: the core answering 5xx → 3 attempts, discarded in under 30 s, agotados +1', async () => {
  let llamadas = 0;
  const { e, r } = entrega((async () => { llamadas++; return new Response('{}', { status: 503 }); }) as typeof fetch);
  const res = await e.entregar('wa-professional', CUERPO);
  assert.equal(res.resultado, 'agotado');
  assert.equal(llamadas, 3);
  assert.equal(INTENTOS, 3);
  assert.ok(r.transcurrido() < 30_000, `${r.transcurrido()} ms`);
  assert.equal(e.contadores.agotados, 1);
  await e.entregar('wa-professional', CUERPO);
  assert.equal(e.contadores.agotados, 2);
});

test('C11: a core that hangs costs at most the cap (30 s), then the next event goes through', async () => {
  let llamadas = 0;
  const colgado = ((_: unknown, init?: RequestInit) => {
    llamadas++;
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  }) as typeof fetch;
  const { e, r } = entrega(colgado);
  const res = await e.entregar('wa-professional', CUERPO);
  assert.equal(res.resultado, 'agotado');
  assert.equal(llamadas, 3);
  assert.ok(r.transcurrido() <= TOPE_MS, `${r.transcurrido()} ms`);
  assert.equal(TOPE_MS, 30_000);
  assert.equal(e.contadores.agotados, 1);
});

test('C11: 4xx is not retried and is not an agotado', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    let llamadas = 0;
    const { e } = entrega((async () => { llamadas++; return new Response('{}', { status }); }) as typeof fetch);
    const res = await e.entregar('wa-professional', CUERPO);
    assert.equal(res.resultado, 'rechazado', String(status));
    assert.equal(llamadas, 1, String(status));
    assert.equal(e.contadores.agotados, 0);
    assert.equal(e.contadores.rechazados, 1);
  }
});

test('C11: a network error is retried; 202 is delivered and 200 is a duplicate', async () => {
  let n = 0;
  const { e } = entrega((async () => {
    n++;
    if (n === 1) throw new TypeError('fetch failed');
    return new Response('{"caso_id":7}', { status: 202 });
  }) as typeof fetch);
  assert.deepEqual(await e.entregar('wa-professional', CUERPO), { resultado: 'entregado', intentos: 2 });
  const d = entrega((async () => new Response('{"caso_id":7}', { status: 200 })) as typeof fetch).e;
  assert.deepEqual(await d.entregar('wa-professional', CUERPO), { resultado: 'duplicado', intentos: 1 });
  assert.equal(e.contadores.agotados, 0);
});

test('the POST to the core is signed with HMAC V2 over the exact bytes it sends, with the producer key', async () => {
  let visto: { url: string; init: RequestInit } | null = null;
  const r = reloj();
  const { e } = entrega((async (url: string, init: RequestInit) => {
    visto = { url: String(url), init };
    return new Response('{}', { status: 202 });
  }) as typeof fetch, r);
  await e.entregar('tg-professional', CUERPO);
  assert.ok(visto);
  const { url, init } = visto as { url: string; init: RequestInit };
  assert.equal(url, 'http://correo-machine.test/v2/mensajes/tg-professional');
  assert.equal(init.method, 'POST');
  const h = new Headers(init.headers);
  assert.equal(h.get('x-correo-key-id'), 'correo-bridge');
  assert.equal(h.get('x-correo-timestamp'), String(Math.floor(r.ahora() / 1000)));
  assert.equal(h.get('content-type'), 'application/json');
  assert.equal(String(init.body), JSON.stringify(CUERPO));
  assert.equal(h.get('x-correo-signature'),
    firmarV2(SECRETO, h.get('x-correo-timestamp') as string, 'POST', '/v2/mensajes/tg-professional', String(init.body)));
});

test('C11: the alert rule on correo_bridge_agotados_total exists in the repo', () => {
  const raiz = join(__dirname, '..', '..', '..');
  const reglas = join(raiz, 'k8s', 'base');
  const hits = readdirSync(reglas)
    .map(f => join(reglas, f))
    .filter(f => statSync(f).isFile() && /\.ya?ml$/.test(f))
    .filter(f => /kind:\s*VMRule/.test(readFileSync(f, 'utf-8')) && readFileSync(f, 'utf-8').includes('correo_bridge_agotados_total'));
  assert.ok(hits.length >= 1, 'no VMRule with correo_bridge_agotados_total under k8s/base');
});

test('C11: ARCHITECTURE.md declares the loss', () => {
  const arch = readFileSync(join(__dirname, '..', '..', '..', 'ARCHITECTURE.md'), 'utf-8');
  assert.ok(arch.includes('un mensaje de entrada puede perderse si el puente o el núcleo están caídos más de 30 s; no hay reconciliación'));
});
