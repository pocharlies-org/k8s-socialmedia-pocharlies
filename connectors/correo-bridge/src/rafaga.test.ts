import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'timers/promises';
import pino from 'pino';
import type { MessageReceivedEvent } from '@mcp-socialmedia/shared';
import { EventType } from '@mcp-socialmedia/shared';
import { DespertarRafaga } from './rafaga';

// DGX-1550: a burst of messages of one caso = ONE wake card, flushed when the window closes.
function evento(waMessageId: string, content: string): MessageReceivedEvent {
  return {
    eventType: EventType.MESSAGE_RECEIVED,
    conversationId: '34600112233@c.us',
    waMessageId,
    waTimestamp: '2026-11-11T11:47:52.000Z',
    senderWaId: '34600112233@c.us',
    content,
    messageType: 'text',
    isForwarded: false,
    account: 'professional',
  };
}

function colector(): { avisar: (t: string, id: string) => Promise<'enviado'>; llamadas: { tarjeta: string; id: string }[] } {
  const llamadas: { tarjeta: string; id: string }[] = [];
  return {
    llamadas,
    avisar: async (tarjeta: string, id: string) => {
      llamadas.push({ tarjeta, id });
      return 'enviado';
    },
  };
}

const logger = pino({ level: 'silent' });

test('rafaga: los mensajes de una ventana salen en un solo wake, con el id del ultimo', async () => {
  const c = colector();
  const d = new DespertarRafaga(30, c.avisar, logger);
  d.despertar('wa:34600112233', evento('A1', 'una'), '123@lid', 'ref1');
  d.despertar('wa:34600112233', evento('A2', 'dos'), '123@lid', 'ref2');
  assert.equal(c.llamadas.length, 0, 'nada sale antes de cerrar la ventana');
  await sleep(120);
  assert.equal(c.llamadas.length, 1);
  assert.ok(c.llamadas[0].tarjeta.includes('\nmensajes: 2\n'));
  assert.ok(c.llamadas[0].tarjeta.includes('\nid: A2\n'));
  assert.ok(c.llamadas[0].id.endsWith(':ref2'));
});

test('rafaga: cada caso abre su propia ventana', async () => {
  const c = colector();
  const d = new DespertarRafaga(30, c.avisar, logger);
  d.despertar('wa:34600112233', evento('A1', 'uno'), '1@lid', 'ref1');
  d.despertar('wa:34699888777', evento('B1', 'otro'), '2@lid', 'ref2');
  await sleep(120);
  assert.equal(c.llamadas.length, 2);
  assert.ok(c.llamadas.every(l => !l.tarjeta.includes('mensajes:')));
});

test('rafaga: tras cerrar, lo que llega abre una ventana nueva', async () => {
  const c = colector();
  const d = new DespertarRafaga(30, c.avisar, logger);
  d.despertar('wa:34600112233', evento('A1', 'primera'), '1@lid', 'ref1');
  await sleep(120);
  d.despertar('wa:34600112233', evento('A2', 'segunda rafaga'), '1@lid', 'ref2');
  await sleep(120);
  assert.equal(c.llamadas.length, 2);
  assert.ok(c.llamadas[1].tarjeta.includes('segunda rafaga'));
});
