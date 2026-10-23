import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { procesar } from './filter';
import { DedupCache } from './dedup';

// C1 (DGX-1235 B1): every event of the fixture, in order, through the same
// pipeline main.ts runs (decode -> fail-closed filter -> canonical body).
const fixture = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'eventos.json'), 'utf-8')) as {
  jidPropio: string;
  eventos: Array<{
    nombre: string;
    subject: string;
    evento?: unknown;
    crudo?: string;
    sinJidPropio?: boolean;
    esperado: string;
    cuerpo?: unknown;
  }>;
};

test('C1: the 6 forwarded events and every dropped one with its reason', () => {
  const previous = process.env.TRACKING_OPT_IN_BASE_URL;
  process.env.TRACKING_OPT_IN_BASE_URL = 'https://seguimiento.example.org';
  try {
    const dedup = new DedupCache(86_400_000, 50_000);
    let forwarded = 0;
    for (const e of fixture.eventos) {
      const data = new TextEncoder().encode(e.crudo ?? JSON.stringify(e.evento));
      const r = procesar(e.subject, data, e.sinJidPropio ? '' : fixture.jidPropio, dedup);
      if (e.esperado === 'forward') {
        assert.equal(r.forward, true, `${e.nombre}: ${r.reason}`);
        if (r.forward) assert.deepEqual(r.cuerpo, e.cuerpo, e.nombre);
        forwarded++;
      } else {
        assert.equal(r.forward, false, e.nombre);
        assert.equal(r.reason, e.esperado, e.nombre);
      }
    }
    assert.equal(forwarded, 6);
  } finally {
    if (previous === undefined) delete process.env.TRACKING_OPT_IN_BASE_URL;
    else process.env.TRACKING_OPT_IN_BASE_URL = previous;
  }
});

test('C1: the canal of a forwarded event follows its subject', () => {
  const dedup = new DedupCache(86_400_000, 50_000);
  const [wa, , , , tg] = fixture.eventos;
  const a = procesar(wa.subject, new TextEncoder().encode(JSON.stringify(wa.evento)), fixture.jidPropio, dedup);
  const b = procesar(tg.subject, new TextEncoder().encode(JSON.stringify(tg.evento)), fixture.jidPropio, dedup);
  assert.equal(a.forward && a.canal, 'whatsapp');
  assert.equal(b.forward && b.canal, 'telegram');
});

test('the drop reason never carries the identity or the text', () => {
  const dedup = new DedupCache(86_400_000, 50_000);
  for (const e of fixture.eventos) {
    const r = procesar(e.subject, new TextEncoder().encode(e.crudo ?? JSON.stringify(e.evento)), fixture.jidPropio, dedup);
    assert.match(r.reason, /^[a-z0-9-]+$/, e.nombre);
  }
});
