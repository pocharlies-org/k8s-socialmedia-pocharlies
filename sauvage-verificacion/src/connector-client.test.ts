import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { ConnectorClient, descargarFoto, listarParticipantes } from './connector-client';

interface Llamada {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function fetchRegistra(captura: Llamada[], status: number, body: string) {
  return async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    captura.push({ url, ...init });
    return { status, text: async () => body };
  };
}

const TS = 1_700_000_000;

test('GET firma `{}` con la clave del conector (cabeceras de la casa)', async () => {
  const llamadas: Llamada[] = [];
  const c = new ConnectorClient({
    baseUrl: 'http://connector.local:3002/api/v1',
    sharedSecret: 's3creto',
    fetchImpl: fetchRegistra(llamadas, 200, '{"participants":[]}'),
    now: () => TS,
  });
  await c.get('/chats/x/participants?limit=1000');
  const l = llamadas[0];
  assert.equal(l.headers?.['x-connector-timestamp'], String(TS));
  assert.equal(l.headers?.['x-connector-signature'], generateHMACSignature({}, TS, 's3creto'));
  assert.ok(!l.body, 'un GET no manda cuerpo');
});

test('POST firma el cuerpo exacto que manda (el servidor verifica sobre el parseado)', async () => {
  const llamadas: Llamada[] = [];
  const c = new ConnectorClient({
    baseUrl: 'http://connector.local:3002/api/v1',
    sharedSecret: 's3creto',
    fetchImpl: fetchRegistra(llamadas, 200, '{"sent":true}'),
    now: () => TS,
  });
  const cuerpo = { text: 'hola' };
  await c.post('/messages/123', cuerpo);
  const l = llamadas[0];
  assert.equal(l.method, 'POST');
  assert.equal(l.body, JSON.stringify(cuerpo));
  assert.equal(l.headers?.['x-connector-signature'], generateHMACSignature(cuerpo, TS, 's3creto'));
});

test('sin secreto no arranca (fail-closed, igual que los conectores)', () => {
  assert.throws(() => new ConnectorClient({ baseUrl: 'http://x', sharedSecret: '' }), /CONNECTOR_SHARED_SECRET/);
});

test('barrido: parsea participants y un no-200 es error ruidoso', async () => {
  const c = new ConnectorClient({
    baseUrl: 'http://connector.local:3002/api/v1',
    sharedSecret: 's',
    fetchImpl: fetchRegistra([], 200, JSON.stringify({ participants: [{ id: '1', firstName: 'A', isBot: false }] })),
  });
  const p = await listarParticipantes(c, '-1003365295248');
  assert.equal(p[0].id, '1');

  const malo = new ConnectorClient({
    baseUrl: 'http://connector.local:3002/api/v1',
    sharedSecret: 's',
    fetchImpl: fetchRegistra([], 500, '{"error":"boom"}'),
  });
  await assert.rejects(() => listarParticipantes(malo, '-100'), /status=500/);
});

test('foto: 404 = sin_foto (dudoso), 504 = timeout (no_auditar), el resto error', async () => {
  const foto = async (status: number, body: string) =>
    descargarFoto(
      new ConnectorClient({
        baseUrl: 'http://c:3002/api/v1',
        sharedSecret: 's',
        fetchImpl: fetchRegistra([], status, body),
      }),
      '7'
    );
  assert.deepEqual(await foto(200, '{"data":"QUJD","size":3,"contentType":"image/jpeg"}'), { ok: true, base64: 'QUJD' });
  assert.deepEqual(await foto(404, '{"error":"No photo"}'), { ok: false, clase: 'sin_foto' });
  assert.deepEqual(await foto(504, '{"error":"timeout"}'), { ok: false, clase: 'timeout' });
  assert.deepEqual(await foto(503, '{"error":"Not connected"}'), { ok: false, clase: 'error', status: 503 });
});
