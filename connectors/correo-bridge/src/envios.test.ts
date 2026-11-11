import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { generateHMACSignature } from '@mcp-socialmedia/shared';
import { crearEnvios } from './envios';
import { ClienteConectores, RUTAS_ENVIO } from './conectores';
import { firmarV2 } from './firma';

// C5 (DGX-1235 B2 (ii)): POST /envios of correo.connector.v1 only translates
// and passes the key as Idempotency-Key; the connector keeps the idempotency.
// The vectors are the exact requests correo-core's CanalHttp.enviar sends
// (scripts/generar-envios-vectores.py, run against correo-core main).
interface Vector {
  clave_id: string; secreto: string; ts: string; metodo: string; objetivo: string; cuerpo: string; firma: string;
  texto: string; destino_ref: string; idempotencia: string; sha256: string;
}
const vectores = (JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'envios_vectores.json'), 'utf-8')) as { vectores: Vector[] }).vectores;
const WA = vectores.find(v => v.destino_ref === '34600111222@c.us') as Vector;
const LID = vectores.find(v => v.destino_ref.endsWith('@lid')) as Vector;
const TG = vectores.find(v => v.clave_id.startsWith('tg-')) as Vector;
const AHORA_S = Number(WA.ts);
const JID_PROPIO = '34999000111@c.us';
const SECRETO_CONECTORES = 'secreto-compartido-de-prueba';

interface Envio { canal: 'wa' | 'tg'; ruta: string; cuerpo: any; clave: string | null; firmaOk: boolean }

/** Fake connectors: their history decides «primer contacto»; their send keeps the idempotency, like the real ones. */
async function montar(opciones: { habilitado?: boolean; sinHistoria?: boolean; caido?: boolean; respuesta?: (e: Envio) => Response | undefined } = {}) {
  const envios: Envio[] = [];
  const lecturas: string[] = [];
  const registro = new Map<string, { cuerpo: string; id: string }>();
  let n = 0;
  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const metodo = init?.method ?? 'GET';
    if (opciones.caido) throw new TypeError('fetch failed');
    if (metodo === 'GET') {
      lecturas.push(url.pathname);
      const entrante = { id: '3EB0A1B2C3D4E5F60001', from: '34600111222@c.us', body: 'hola', timestamp: AHORA_S - 30, fromMe: false };
      const propio = { id: '3EB0A1B2C3D4E5F60002', from: JID_PROPIO, body: 'nuestro', timestamp: AHORA_S - 20, fromMe: false };
      if (url.host === 'wa.test') return Response.json({ messages: opciones.sinHistoria ? [propio] : [propio, entrante] });
      const tgEntrante = { telegramMessageId: '4242', telegramTimestamp: new Date().toISOString(), isOutbound: false };
      const tgSaliente = { telegramMessageId: '4243', telegramTimestamp: new Date().toISOString(), isOutbound: true };
      return Response.json({ messages: opciones.sinHistoria ? [tgSaliente] : [tgSaliente, tgEntrante] });
    }
    const headers = new Headers(init?.headers);
    const cuerpo = JSON.parse(String(init?.body));
    const ts = Number(headers.get('x-connector-timestamp'));
    const e: Envio = {
      canal: url.host === 'wa.test' ? 'wa' : 'tg',
      ruta: url.pathname,
      cuerpo,
      clave: headers.get('idempotency-key'),
      firmaOk: headers.get('x-connector-signature') === generateHMACSignature(cuerpo, ts, SECRETO_CONECTORES),
    };
    envios.push(e);
    const forzada = opciones.respuesta?.(e);
    if (forzada) return forzada;
    const texto = e.canal === 'wa' ? cuerpo.content : cuerpo.text;
    const previo = e.clave ? registro.get(e.clave) : undefined;
    if (previo && previo.cuerpo !== texto) {
      return Response.json({ error: 'reused', failureClass: 'idempotency_key_reused' }, { status: 409 });
    }
    const id = previo?.id ?? (e.canal === 'wa' ? `3EB0${String(++n).padStart(18, '0')}` : String(9000 + ++n));
    if (e.clave && !previo) registro.set(e.clave, { cuerpo: texto, id });
    const sentAt = '2026-10-23T09:06:00.123Z';
    return e.canal === 'wa'
      ? Response.json({ messageId: id, sentAt, ...(previo ? { deduplicated: true } : {}) })
      : Response.json({ success: true, messageId: id, sentAt, deduplicated: !!previo });
  }) as typeof fetch;
  const conectores = new ClienteConectores({
    whatsappUrl: 'http://wa.test',
    telegramUrl: 'http://tg.test',
    secreto: SECRETO_CONECTORES,
    fetchImpl: fakeFetch,
  });
  const lineas: string[] = [];
  const logger = pino({ level: 'info' }, new Writable({ write(c, _e, cb) { lineas.push(String(c)); cb(); } }));
  const manejar = crearEnvios({
    secretos: new Map([[WA.clave_id, WA.secreto], [TG.clave_id, TG.secreto]]),
    conectores,
    jidPropio: async () => JID_PROPIO,
    habilitado: opciones.habilitado ?? true,
    ahoraS: () => AHORA_S,
    logger,
  });
  const server: Server = createServer((req, res) => {
    void manejar(req, res).then(atendida => {
      if (!atendida) { res.writeHead(418); res.end(); }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { envios, lecturas, lineas, port, cerrar: () => new Promise<void>(r => server.close(() => r())) };
}

function pedir(port: number, ruta: string, cabeceras: Record<string, string>, metodo = 'POST', cuerpo = ''):
  Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: ruta, method: metodo, headers: { ...cabeceras, 'Content-Length': String(Buffer.byteLength(cuerpo)) } }, res => {
      let datos = '';
      res.on('data', c => (datos += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: datos ? JSON.parse(datos) : null }));
    });
    req.on('error', reject);
    req.end(cuerpo);
  });
}

/** What CanalHttp sends: json.dumps of the four fields, signed over those exact bytes. */
function envio(v: { clave_id: string; secreto: string }, campos: Record<string, unknown>, ts = AHORA_S) {
  const cuerpo = JSON.stringify(campos);
  return {
    cuerpo,
    cabeceras: {
      'Content-Type': 'application/json',
      'X-Correo-Key-Id': v.clave_id,
      'X-Correo-Timestamp': String(ts),
      'X-Correo-Signature': firmarV2(v.secreto, String(ts), 'POST', '/envios', cuerpo),
    },
  };
}
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const campos = (destino: string, texto: string, idem: string) => ({ destino_ref: destino, texto, sha256: sha(texto), idempotencia: idem });
const delVector = (v: Vector) => ({
  cuerpo: v.cuerpo,
  cabeceras: { 'Content-Type': 'application/json', 'X-Correo-Key-Id': v.clave_id, 'X-Correo-Timestamp': v.ts, 'X-Correo-Signature': v.firma },
});

test('C5: the exact bytes correo-core CanalHttp.enviar sends verify and reach the connector in the form it accepts', async () => {
  for (const v of vectores) {
    const s = await montar();
    try {
      const { cuerpo, cabeceras } = delVector(v);
      const r = await pedir(s.port, v.objetivo, cabeceras, v.metodo, cuerpo);
      assert.equal(r.status, 200, `${v.destino_ref}: ${JSON.stringify(r.json)}`);
      assert.equal(r.json.deduplicado, false);
      assert.match(r.json.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.equal(s.envios.length, 1);
      const e = s.envios[0];
      assert.ok(e.firmaOk, 'signed with the house connector HMAC over the body it sends');
      assert.equal(e.clave, v.idempotencia, 'the key travels as Idempotency-Key, untouched');
      if (v.clave_id.startsWith('wa-')) {
        // Measured: POST /api/v1/messages/send takes the canonical id as conversationId (@c.us and @lid as is).
        assert.equal(e.ruta, '/api/v1/messages/send');
        assert.equal(e.cuerpo.conversationId, v.destino_ref);
        assert.equal(e.cuerpo.content, v.texto);
        assert.equal(typeof e.cuerpo.sendToken, 'string');
        assert.match(r.json.ref, /^3EB0/);
      } else {
        assert.equal(e.ruta, `/api/v1/messages/${v.destino_ref}`);
        assert.deepEqual(e.cuerpo, { text: v.texto });
        assert.match(r.json.ref, /^tg:[1-9][0-9]*$/);
      }
    } finally {
      await s.cerrar();
    }
  }
});

test('C5: the same idempotencia twice → the connector gets the same key and the bridge answers the same ref, deduplicado', async () => {
  const s = await montar();
  try {
    const { cuerpo, cabeceras } = delVector(WA);
    const a = await pedir(s.port, '/envios', cabeceras, 'POST', cuerpo);
    const b = await pedir(s.port, '/envios', cabeceras, 'POST', cuerpo);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(b.json.ref, a.json.ref);
    assert.equal(b.json.deduplicado, true);
    assert.deepEqual(s.envios.map(e => e.clave), [WA.idempotencia, WA.idempotencia]);
  } finally {
    await s.cerrar();
  }
});

test('C5: another idempotencia with the same body sends again (another ref)', async () => {
  const s = await montar();
  try {
    const a = envio(WA, campos(WA.destino_ref, 'Hola', 'resp-1'));
    const b = envio(WA, campos(WA.destino_ref, 'Hola', 'resp-2'));
    const ra = await pedir(s.port, '/envios', a.cabeceras, 'POST', a.cuerpo);
    const rb = await pedir(s.port, '/envios', b.cabeceras, 'POST', b.cuerpo);
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    assert.notEqual(ra.json.ref, rb.json.ref);
    assert.equal(rb.json.deduplicado, false);
  } finally {
    await s.cerrar();
  }
});

test('C5: the same idempotencia with another text → 409 idempotencia_reutilizada (WhatsApp and Telegram)', async () => {
  for (const v of [WA, TG]) {
    const s = await montar();
    try {
      const a = envio(v, campos(v.destino_ref, 'primero', 'resp-9'));
      const b = envio(v, campos(v.destino_ref, 'segundo', 'resp-9'));
      assert.equal((await pedir(s.port, '/envios', a.cabeceras, 'POST', a.cuerpo)).status, 200);
      const r = await pedir(s.port, '/envios', b.cabeceras, 'POST', b.cuerpo);
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'idempotencia_reutilizada');
    } finally {
      await s.cerrar();
    }
  }
});

test('C5: send_outcome_uncertain from the connector → 409 resultado_incierto (WhatsApp and Telegram)', async () => {
  for (const v of [WA, TG]) {
    const s = await montar({ respuesta: () => Response.json({ error: 'unknown', failureClass: 'send_outcome_uncertain', messageId: '3EB0X' }, { status: 409 }) });
    try {
      const { cuerpo, cabeceras } = delVector(v);
      const r = await pedir(s.port, '/envios', cabeceras, 'POST', cuerpo);
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'resultado_incierto');
    } finally {
      await s.cerrar();
    }
  }
});

test('C5: a sha256 that does not match the text → 422 without calling the connector', async () => {
  const s = await montar();
  try {
    const { cuerpo, cabeceras } = envio(WA, { ...campos(WA.destino_ref, 'Hola', 'resp-3'), sha256: sha('Adiós') });
    const r = await pedir(s.port, '/envios', cabeceras, 'POST', cuerpo);
    assert.equal(r.status, 422);
    assert.equal(r.json.error, 'no_procesable');
    assert.equal(s.envios.length, 0);
    assert.equal(s.lecturas.length, 0);
  } finally {
    await s.cerrar();
  }
});

test('C5: a conversation with no inbound message → 422 primer_contacto, nothing sent (WhatsApp and Telegram)', async () => {
  for (const v of [WA, TG]) {
    const s = await montar({ sinHistoria: true });
    try {
      const { cuerpo, cabeceras } = delVector(v);
      const r = await pedir(s.port, '/envios', cabeceras, 'POST', cuerpo);
      assert.equal(r.status, 422);
      assert.equal(r.json.error, 'primer_contacto');
      assert.equal(s.envios.length, 0);
      assert.equal(s.lecturas.length, 1);
    } finally {
      await s.cerrar();
    }
  }
});

test('C5: ENABLE_OUTBOUND=false → 403 envio_desactivado, the connector is not called', async () => {
  const s = await montar({ habilitado: false });
  try {
    const { cuerpo, cabeceras } = delVector(WA);
    const r = await pedir(s.port, '/envios', cabeceras, 'POST', cuerpo);
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'envio_desactivado');
    assert.equal(s.envios.length + s.lecturas.length, 0);
  } finally {
    await s.cerrar();
  }
});

test('C5: unsigned, signed over other bytes or out of the window → 401, even with the send off', async () => {
  for (const habilitado of [true, false]) {
    const s = await montar({ habilitado });
    try {
      const { cuerpo, cabeceras } = delVector(WA);
      assert.equal((await pedir(s.port, '/envios', { 'Content-Type': 'application/json' }, 'POST', cuerpo)).status, 401);
      assert.equal((await pedir(s.port, '/envios', cabeceras, 'POST', cuerpo.replace('resp-41', 'resp-40'))).status, 401);
      const viejo = envio(WA, campos(WA.destino_ref, 'Hola', 'resp-4'), AHORA_S - 120);
      assert.equal((await pedir(s.port, '/envios', viejo.cabeceras, 'POST', viejo.cuerpo)).status, 401);
      // The key of the other connector does not open this one's channel.
      const cruzada = envio({ clave_id: WA.clave_id, secreto: TG.secreto }, campos(WA.destino_ref, 'Hola', 'resp-5'));
      assert.equal((await pedir(s.port, '/envios', cruzada.cabeceras, 'POST', cruzada.cuerpo)).status, 401);
      assert.equal(s.envios.length, 0);
    } finally {
      await s.cerrar();
    }
  }
});

test('C5: the body is closed: an extra field, a missing one or a destino of the other channel → 422', async () => {
  const s = await montar();
  try {
    const malos = [
      envio(WA, { ...campos(WA.destino_ref, 'Hola', 'resp-6'), cc: 'x' }),
      envio(WA, { destino_ref: WA.destino_ref, texto: 'Hola', sha256: sha('Hola') }),
      envio(WA, campos('777000111', 'Hola', 'resp-7')),
      envio(TG, campos('34600111222@c.us', 'Hola', 'resp-8')),
      envio(WA, campos('34600111222@s.whatsapp.net', 'Hola', 'resp-9')),
      envio(WA, campos(WA.destino_ref, '', 'resp-10')),
      envio(WA, campos(WA.destino_ref, 'x'.repeat(4097), 'resp-11')),
      envio(WA, campos(WA.destino_ref, 'Hola', 'con espacio')),
    ];
    for (const m of malos) {
      const r = await pedir(s.port, '/envios', m.cabeceras, 'POST', m.cuerpo);
      assert.equal(r.status, 422, m.cuerpo.slice(0, 80));
      assert.equal(r.json.error, 'no_procesable');
    }
    assert.equal(s.envios.length, 0);
  } finally {
    await s.cerrar();
  }
});

test('C5: 4096 characters of emoji (the longest body CanalHttp can send) are accepted', async () => {
  const s = await montar();
  try {
    const texto = '📦'.repeat(4096);
    const { cuerpo, cabeceras } = envio(WA, campos(WA.destino_ref, texto, 'resp-largo'));
    // json.dumps(ensure_ascii) escapes each emoji as two \\u escapes: 12 bytes per character.
    const python = cuerpo.replace(/📦/g, '\\ud83d\\udce6');
    const firmado = { ...cabeceras, 'X-Correo-Signature': firmarV2(WA.secreto, String(AHORA_S), 'POST', '/envios', python) };
    const r = await pedir(s.port, '/envios', firmado, 'POST', python);
    assert.equal(r.status, 200);
    assert.equal(s.envios[0].cuerpo.content, texto);
  } finally {
    await s.cerrar();
  }
});

test('C5: a connector that does not answer → 502 canal_no_responde (the core treats it as uncertain)', async () => {
  const s = await montar({ caido: true });
  try {
    const { cuerpo, cabeceras } = delVector(WA);
    const r = await pedir(s.port, '/envios', cabeceras, 'POST', cuerpo);
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'canal_no_responde');
  } finally {
    await s.cerrar();
  }
});

test('C5: a send the connector failed or refused (5xx, disabled) is never answered as sent', async () => {
  const casos: Array<[Response, number, string]> = [
    [Response.json({ error: 'Failed to send message' }, { status: 500 }), 502, 'canal_no_responde'],
    [Response.json({ error: 'Sending is disabled', failureClass: 'disabled_sending' }, { status: 403 }), 403, 'envio_desactivado'],
    [Response.json({ success: true }), 409, 'resultado_incierto'],
  ];
  for (const [respuesta, status, error] of casos) {
    const s = await montar({ respuesta: () => respuesta.clone() });
    try {
      const { cuerpo, cabeceras } = delVector(TG);
      const r = await pedir(s.port, '/envios', cabeceras, 'POST', cuerpo);
      assert.equal(r.status, status, error);
      assert.equal(r.json.error, error);
    } finally {
      await s.cerrar();
    }
  }
});

test('C5: neither the answers nor the logs carry the text or the identity', async () => {
  const s = await montar();
  try {
    for (const v of [WA, LID, TG]) {
      const { cuerpo, cabeceras } = delVector(v);
      const r = await pedir(s.port, '/envios', cabeceras, 'POST', cuerpo);
      assert.equal(r.status, 200);
      assert.ok(!JSON.stringify(r.json).includes(v.destino_ref));
    }
    const sinHistoria = await montar({ sinHistoria: true });
    try {
      const { cuerpo, cabeceras } = delVector(WA);
      await pedir(sinHistoria.port, '/envios', cabeceras, 'POST', cuerpo);
      s.lineas.push(...sinHistoria.lineas);
    } finally {
      await sinHistoria.cerrar();
    }
    const todo = s.lineas.join('\n');
    assert.ok(s.lineas.length > 0);
    for (const v of [WA, LID, TG]) {
      assert.ok(!todo.includes(v.destino_ref), 'no identity in the logs');
      assert.ok(!todo.includes(v.texto.slice(0, 10)), 'no text in the logs');
      assert.ok(!todo.includes(v.idempotencia), 'no key in the logs');
    }
  } finally {
    await s.cerrar();
  }
});

test('C5: only POST /envios is the send route; anything else is left to the caller', async () => {
  const s = await montar();
  try {
    const { cuerpo, cabeceras } = delVector(WA);
    const conQuery = { ...cabeceras, 'X-Correo-Signature': firmarV2(WA.secreto, WA.ts, 'POST', '/envios?x=1', cuerpo) };
    assert.equal((await pedir(s.port, '/envios?x=1', conQuery, 'POST', cuerpo)).status, 422);
    assert.equal((await pedir(s.port, '/hilos/34600111222@c.us', cabeceras, 'GET')).status, 418);
    const get = { ...cabeceras, 'X-Correo-Signature': firmarV2(WA.secreto, WA.ts, 'GET', '/envios', '') };
    assert.equal((await pedir(s.port, '/envios', get, 'GET')).status, 404);
    assert.equal(s.envios.length, 0);
  } finally {
    await s.cerrar();
  }
});

test('C5: the send routes towards the connectors are the closed list, POST only', () => {
  assert.deepEqual([...RUTAS_ENVIO].sort(), ['/api/v1/messages/', '/api/v1/messages/send']);
});

test('C5: the bridge opens no Postgres connection: no pg dependency and no import of it', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  assert.ok(!('pg' in (pkg.dependencies ?? {})) && !('pg' in (pkg.devDependencies ?? {})));
  for (const f of readdirSync(__dirname).filter(x => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
    assert.doesNotMatch(readFileSync(join(__dirname, f), 'utf-8'), /from ['"]pg['"]|require\(['"]pg['"]\)|DATABASE_URL/, f);
  }
});
