import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { AvisoHermes, firmarWebhookHermes } from './hermes';

// DGX-1533: the wake of the Skirmshop secretary. Scheme fixed by
// synapse-adapter-gmail/notify_profile.py; the signature vector is precomputed
// with the same rule Hermes validates: hex(HMAC(secret, "<ts>." + body)).
const SECRETO = 'secreto-webhook-hermes-de-prueba-0123456789';
const AHORA_MS = 1762000000000;
const FIRMA_ESPERADA = 'd7cc3b704ae6b623c19e239576441c4a5751ec5e8a463bba925019334069a38f';

test('firmarWebhookHermes: the precomputed vector', () => {
  assert.equal(firmarWebhookHermes(SECRETO, '1762000000', JSON.stringify({ mensaje: 'hola' })), FIRMA_ESPERADA);
});

interface Llamada { headers: Record<string, string>; body: string }

function montar(secuencia: Array<{ status: number; headers?: Record<string, string> }>) {
  const llamadas: Llamada[] = [];
  let n = 0;
  let ahora = AHORA_MS;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const paso = secuencia[Math.min(n, secuencia.length - 1)];
    n++;
    llamadas.push({
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body),
    });
    return new Response('', { status: paso.status, headers: paso.headers });
  }) as unknown as typeof fetch;
  const avisos = new AvisoHermes({
    url: 'http://hermes-webhook.hermes.svc:8644/p/secretaria-skirmshop/webhooks/whatsapp-skirmshop',
    secreto: SECRETO,
    logger: pino({ level: 'silent' }),
    fetchImpl,
    ahora: () => ahora,
    // Same fake clock as entrega.test.ts: an aborted signal rejects, so the per-attempt
    // budget race behaves like the real sleep.
    dormir: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) =>
        setImmediate(() => {
          if (signal?.aborted) return reject(new Error('aborted'));
          ahora += ms;
          resolve();
        })
      ),
  });
  return { avisos, llamadas };
}

test('202: enviado, with the V2 signature and the request id', async () => {
  const { avisos, llamadas } = montar([{ status: 202 }]);
  assert.equal(await avisos.avisar('hola', 'whatsapp-skirmshop:34600112233@c.us:3EB01'), 'enviado');
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].headers['x-webhook-timestamp'], '1762000000');
  assert.equal(llamadas[0].headers['x-webhook-signature-v2'], FIRMA_ESPERADA);
  assert.equal(llamadas[0].headers['x-request-id'], 'whatsapp-skirmshop:34600112233@c.us:3EB01');
  assert.equal(llamadas[0].body, JSON.stringify({ mensaje: 'hola' }));
});

test('200 is a duplicate, fine and not retried', async () => {
  const { avisos, llamadas } = montar([{ status: 200 }]);
  assert.equal(await avisos.avisar('hola', 'r'), 'duplicado');
  assert.equal(llamadas.length, 1);
});

test('4xx (not 429) is rejected without retry', async () => {
  const { avisos, llamadas } = montar([{ status: 400 }]);
  assert.equal(await avisos.avisar('hola', 'r'), 'rechazado');
  assert.equal(llamadas.length, 1);
});

test('5xx is retried up to 3 attempts, then agotado', async () => {
  const { avisos, llamadas } = montar([{ status: 500 }]);
  assert.equal(await avisos.avisar('hola', 'r'), 'agotado');
  assert.equal(llamadas.length, 3);
});

test('5xx then 202: the second attempt delivers', async () => {
  const { avisos, llamadas } = montar([{ status: 500 }, { status: 202 }]);
  assert.equal(await avisos.avisar('hola', 'r'), 'enviado');
  assert.equal(llamadas.length, 2);
});

test('429 honours Retry-After and retries within the budget', async () => {
  const { avisos, llamadas } = montar([{ status: 429, headers: { 'Retry-After': '2' } }, { status: 202 }]);
  assert.equal(await avisos.avisar('hola', 'r'), 'enviado');
  assert.equal(llamadas.length, 2);
});
