import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { connectorFixture, TEST_CONNECTOR_SECRET as SECRET, TEST_GROUP_ID as CHAT } from '../test-harness';
import { generateHMACSignature } from '@mcp-socialmedia/shared';

// Paginacion de GET /chats/:id/participants (INFRA-745): `offset` llega al
// cliente, `total` es el count real de Telegram, el filtro es `all` (con
// `recent` Telegram se topa a 200) y sin `offset` la v1 responde igual.

class FakeMtcute {
  readonly calls: Array<{ peer: unknown; params: Record<string, unknown> }> = [];
  page: unknown[] = [];
  total = 0;

  async getChatMembers(peer: unknown, params: Record<string, unknown>): Promise<unknown[]> {
    this.calls.push({ peer, params });
    const ret = this.page as unknown[] & { total?: number };
    ret.total = this.total;
    return ret;
  }
}

function member(id: number) {
  return { user: { id: { toString: () => String(id) }, firstName: `P${id}`, isBot: false } };
}

const serve = connectorFixture(SECRET, afterEach);

async function get(base: string, path: string) {
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(`${base}${path}`, {
    headers: {
      'x-connector-timestamp': String(ts),
      'x-connector-signature': generateHMACSignature({}, ts, SECRET),
    },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test('offset viaja al cliente y la respuesta lleva total (v2)', async () => {
  const fake = new FakeMtcute();
  fake.page = Array.from({ length: 146 }, (_, i) => member(201 + i));
  fake.total = 346; // el count real de Telegram, mayor que la pagina
  const base = await serve(fake);

  const r = await get(base, `/api/v1/chats/${CHAT}/participants?limit=200&offset=200`);
  assert.equal(r.status, 200);
  assert.equal((r.body.participants as unknown[]).length, 146);
  assert.equal(r.body.total, 346, 'total = count real, no longitud de pagina');

  const call = fake.calls[0];
  assert.equal(call.params.offset, 200, 'offset propagado a getChatMembers');
  assert.equal(call.params.limit, 200);
  assert.equal(call.params.type, 'all', "filtro 'all': 'recent' se topa a 200 sea cual sea el offset");
});

test('sin offset (v1): offset=0 y el array participants sigue igual (no regresion)', async () => {
  const fake = new FakeMtcute();
  fake.page = Array.from({ length: 200 }, (_, i) => member(1 + i));
  fake.total = 346;
  const base = await serve(fake);

  const r = await get(base, `/api/v1/chats/${CHAT}/participants?limit=100`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.participants), 'los consumidores v1 siguen encontrando participants');
  assert.equal((r.body.participants as unknown[]).length, 200);
  assert.equal(fake.calls[0].params.offset, 0, 'sin offset la ruta pregunta desde 0');
});

test('limit topado a 200 por llamada (el tope de MTProto) y offset negativo a 0', async () => {
  const fake = new FakeMtcute();
  fake.page = [];
  fake.total = 0;
  const base = await serve(fake);

  await get(base, `/api/v1/chats/${CHAT}/participants?limit=1000`);
  assert.equal(fake.calls[0].params.limit, 200, 'limit pedido topado al maximo por llamada');

  await get(base, `/api/v1/chats/${CHAT}/participants?limit=100&offset=-5`);
  assert.equal(fake.calls[1].params.offset, 0, 'offset negativo no puede pedir atras');
});
