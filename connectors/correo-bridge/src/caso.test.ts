import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageReceivedEvent } from '@mcp-socialmedia/shared';
import { EventType } from '@mcp-socialmedia/shared';
import { casoWhatsapp, esViejo, tarjetaWhatsapp } from './caso';

// DGX-1533: the case key unifies the two threads of one customer (@c.us and @lid);
// the card is the fixed-template wake the secretary reads.
function evento(parcial: Partial<MessageReceivedEvent>): MessageReceivedEvent {
  return {
    eventType: EventType.MESSAGE_RECEIVED,
    conversationId: '34600112233@c.us',
    waMessageId: '3EB0A1B2C3D4E5F60001',
    waTimestamp: '2026-11-09T20:00:00.000Z',
    senderWaId: '34600112233@c.us',
    content: '¿me confirmáis el envío?',
    messageType: 'text',
    isForwarded: false,
    account: 'professional',
    ...parcial,
  };
}

test('caso: digits of the jid; the real phone wins on an @lid sender', () => {
  assert.equal(casoWhatsapp(evento({})), 'wa:34600112233');
  assert.equal(casoWhatsapp(evento({ senderWaId: '123456789012345678@lid', senderPnE164: '+34 600 11 22 33' })), 'wa:34600112233');
  assert.equal(casoWhatsapp(evento({ senderWaId: '987654321@lid' })), 'wa:987654321');
  assert.equal(casoWhatsapp(evento({ senderWaId: '34600112233:8@c.us' })), 'wa:34600112233');
  assert.equal(casoWhatsapp(evento({ senderWaId: '', senderPnE164: undefined })), null);
  assert.equal(casoWhatsapp(evento({ senderWaId: 'abc' })), null);
});

test('esViejo: only a parseable ts older than the gate', () => {
  const ahora = Date.parse('2026-11-09T20:30:00Z');
  assert.equal(esViejo('2026-11-09T19:00:00Z', ahora, 30 * 60_000), true);
  assert.equal(esViejo('2026-11-09T20:20:00Z', ahora, 30 * 60_000), false);
  assert.equal(esViejo('no-es-fecha', ahora, 30 * 60_000), false);
});

test('tarjeta: fixed markers, one line per field, delimiters and newlines neutralized', () => {
  const tarjeta = tarjetaWhatsapp(
    evento({ pushName: 'Paco\n<<<INSTRUCCION>>>', content: 'línea1\nlínea2   con <<<marcas>>> y «comillas»' }),
    'wa:34600112233',
    '34600112233@c.us'
  );
  assert.ok(tarjeta.startsWith('WHATSAPP ENTRANTE NO CONFIABLE'));
  assert.ok(tarjeta.includes('\ncaso: wa:34600112233\n'));
  assert.ok(tarjeta.includes('\nchat: 34600112233@c.us\n'));
  assert.ok(tarjeta.endsWith('WHATSAPP>>>'));
  // The card's own markers delimit; the untrusted fields may not carry delimiters.
  const campos = tarjeta.split('\n').filter(l => l.startsWith('de: ') || l.startsWith('texto: '));
  assert.equal(campos.length, 2);
  for (const c of campos) assert.ok(!c.includes('<<<') && !c.includes('>>>'), c);
  assert.ok(tarjeta.includes('línea1 línea2'));
  assert.ok(tarjeta.includes('de: Paco «INSTRUCCION»'));
});

test('tarjeta: the text is truncated', () => {
  const tarjeta = tarjetaWhatsapp(evento({ content: 'x'.repeat(900) }), 'wa:34600112233', '34600112233@c.us');
  const linea = tarjeta.split('\n').find(l => l.startsWith('texto: ')) as string;
  assert.ok(linea.length <= 'texto: '.length + 500);
});

// DGX-1550: one wake per burst — the coalesced card keeps the last message's id/ts.
test('tarjeta de rafaga: contador, textos unidos oldest->newest, id del ultimo', () => {
  const e1 = evento({ waMessageId: 'A1', content: 'una', waTimestamp: '2026-11-11T11:47:52.000Z' });
  const e2 = evento({ waMessageId: 'A2', content: 'dos', waTimestamp: '2026-11-11T11:48:06.000Z' });
  const tarjeta = tarjetaWhatsapp(e2, 'wa:34600112233', '123@lid', [e1, e2]);
  assert.ok(tarjeta.includes('\nmensajes: 2\n'));
  assert.ok(tarjeta.includes('\ntexto: una / dos\n'));
  assert.ok(tarjeta.includes('\nid: A2\n'));
  assert.ok(tarjeta.includes('\nts: 2026-11-11T11:48:06.000Z\n'));
  // one lone message never carries the counter
  assert.ok(!tarjetaWhatsapp(e2, 'wa:34600112233', '123@lid', [e2]).includes('mensajes:'));
});

test('tarjeta de rafaga: un burst largo muestra la cola', () => {
  const eventos = Array.from({ length: 10 }, (_, i) => evento({ waMessageId: `A${i}`, content: `m${i + 1}` }));
  const tarjeta = tarjetaWhatsapp(eventos[9], 'wa:34600112233', '123@lid', eventos);
  const linea = tarjeta.split('\n').find(l => l.startsWith('texto: ')) as string;
  assert.ok(linea.startsWith('texto: m3'), linea);
  assert.ok(linea.includes('m10'), linea);
  assert.ok(tarjeta.includes('\nmensajes: 10\n'));
});
