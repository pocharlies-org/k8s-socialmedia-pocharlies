import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsearVeredicto, veredictoDeVision, type VisionOptions } from './vision';
import type { FetchResponse, FetchFn } from './connector-client';

const sinEspera = async (): Promise<void> => {};

function fetchQueDevuelve(status: number, body: string, contador: { n: number }): FetchFn {
  return async () => {
    contador.n++;
    const res: FetchResponse = { status, text: async () => body };
    return res;
  };
}

function opciones(parciales: Partial<VisionOptions> & { fetchImpl: FetchFn }): VisionOptions {
  return {
    url: 'http://litellm.local/v1/chat/completions',
    apiKey: 'clave-de-prueba',
    model: 'qwen38-flash-next-uncensored',
    photoBase64: 'aW1hZ2Vu',
    prompt: 'criterio',
    reintentos: 3,
    esperarMs: sinEspera,
    ...parciales,
  };
}

function completion(texto: string): string {
  return JSON.stringify({ choices: [{ message: { content: texto } }] });
}

test('504 de vision: no_auditar, nunca sin_cara (y reintenta hasta el tope)', async () => {
  const c = { n: 0 };
  const r = await veredictoDeVision(opciones({ fetchImpl: fetchQueDevuelve(504, 'Gateway Timeout', c) }));
  assert.equal(r.verdict, 'no_auditar');
  assert.equal(r.fallo, 'vision_http_504');
  assert.equal(r.intentos, 3);
  assert.equal(c.n, 3);
});

test('error del modelo (500) y error de red: no_auditar', async () => {
  const c500 = { n: 0 };
  const r500 = await veredictoDeVision(opciones({ fetchImpl: fetchQueDevuelve(500, 'boom', c500) }));
  assert.equal(r500.verdict, 'no_auditar');
  assert.equal(r500.fallo, 'vision_http_500');

  const rRed = await veredictoDeVision(
    opciones({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })
  );
  assert.equal(rRed.verdict, 'no_auditar');
  assert.match(rRed.fallo ?? '', /^vision_error_/);
});

test('403 de clave sin el alias: no_auditar con el status grabado (evidencia para devops)', async () => {
  const c = { n: 0 };
  const r = await veredictoDeVision(
    opciones({ fetchImpl: fetchQueDevuelve(403, '{"error":{"code":"403"}}', c) })
  );
  assert.equal(r.verdict, 'no_auditar');
  assert.equal(r.fallo, 'vision_http_403');
});

test('salida no parseable: no_auditar con el texto bruto conservado', async () => {
  const c = { n: 0 };
  const r = await veredictoDeVision(
    opciones({ fetchImpl: fetchQueDevuelve(200, completion('no sé qué decirte, la foto es rara'), c) })
  );
  assert.equal(r.verdict, 'no_auditar');
  assert.equal(r.fallo, 'no_parseable');
  assert.match(r.rawText, /no sé qué decirte/);
});

test('JSON del modelo: cara / sin_cara / dudoso salen como se leen', async () => {
  for (const v of ['cara', 'sin_cara', 'dudoso'] as const) {
    const c = { n: 0 };
    const r = await veredictoDeVision(
      opciones({ fetchImpl: fetchQueDevuelve(200, completion(`{"veredicto": "${v}", "motivo": "x"}`), c) })
    );
    assert.equal(r.verdict, v);
    assert.equal(r.intentos, 1);
  }
});

test('palabra desnuda aceptada; texto que solo menciona una palabra no lo es', () => {
  assert.equal(parsearVeredicto('sin_cara'), 'sin_cara');
  assert.equal(parsearVeredicto('yo diría que sin_cara, en general'), null);
  assert.equal(parsearVeredicto(''), null);
});

test('recupera tras un intento fallido: el segundo intento manda el veredicto', async () => {
  let n = 0;
  const fetchImpl: FetchFn = async () => {
    n++;
    const body = n === 1 ? 'timeout' : completion('{"veredicto": "cara"}');
    const res: FetchResponse = { status: n === 1 ? 502 : 200, text: async () => body };
    return res;
  };
  const r = await veredictoDeVision(opciones({ fetchImpl }));
  assert.equal(r.verdict, 'cara');
  assert.equal(r.intentos, 2);
});
