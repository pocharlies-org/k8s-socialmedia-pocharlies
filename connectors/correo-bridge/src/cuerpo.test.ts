import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonica, cuerpoTelegram, cuerpoWhatsapp, tsCanonico } from './cuerpo';
import type { MessageReceivedEvent, TelegramMessageReceivedEvent } from '@mcp-socialmedia/shared';

// C2 (DGX-1235 B1): the body the core receives is closed and has no text.
const vectores = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'identidades_vectores.json'), 'utf-8')) as {
  vectores: Array<{ canal: string; entrada: string; canonica: string | null }>;
};

const wa = {
  eventType: 'MessageReceived',
  account: 'professional',
  conversationId: '34600111222@s.whatsapp.net',
  waMessageId: '3EB0A1B2C3D4E5F60001',
  waTimestamp: '2026-10-23T09:00:00.123Z',
  senderWaId: '34600111222:3@s.whatsapp.net',
  content: 'TEXTO-SECRETO-DEL-CLIENTE',
  messageType: 'IMAGE',
  attachments: [{ type: 'image', url: 'https://media.example/1', metadata: {} }],
  isForwarded: false,
  pushName: 'NOMBRE-SECRETO',
  senderPnE164: '+34600111222',
} as unknown as MessageReceivedEvent;

const tg = {
  eventType: 'TelegramMessageReceived',
  account: 'professional',
  conversationId: '777000111',
  telegramMessageId: '42',
  telegramTimestamp: '2026-10-23T09:00:01.000Z',
  senderTelegramId: '777000111',
  senderUsername: 'USUARIO-SECRETO',
  senderFirstName: 'NOMBRE-SECRETO',
  content: 'TEXTO-SECRETO-DEL-CLIENTE',
  messageType: 'TEXT',
  isForwarded: false,
  isOutbound: false,
  chatType: 'private',
} as unknown as TelegramMessageReceivedEvent;

test('C2: the body keys are exactly ref, hilo_ref, direccion, ts, identidad', () => {
  for (const r of [cuerpoWhatsapp(wa, 'entrante'), cuerpoTelegram(tg, 'entrante'), cuerpoWhatsapp(wa, 'saliente')]) {
    assert.ok('cuerpo' in r, JSON.stringify(r));
    assert.deepEqual(Object.keys(r.cuerpo).sort(), ['direccion', 'hilo_ref', 'identidad', 'ref', 'ts']);
    const json = JSON.stringify(r.cuerpo);
    for (const prohibido of ['SECRETO', 'content', 'pushName', 'senderPnE164', '+34600111222', 'media.example', 'attachments']) {
      assert.ok(!json.includes(prohibido), `${prohibido} in ${json}`);
    }
  }
});

test('C2: WhatsApp body in canonical form', () => {
  const r = cuerpoWhatsapp(wa, 'entrante');
  assert.ok('cuerpo' in r);
  assert.deepEqual(r.cuerpo, {
    ref: '3EB0A1B2C3D4E5F60001',
    hilo_ref: '34600111222@c.us',
    direccion: 'entrante',
    ts: '2026-10-23T09:00:00Z',
    identidad: { canal: 'whatsapp', valor: '34600111222@c.us' },
  });
  const saliente = cuerpoWhatsapp(wa, 'saliente');
  assert.ok('cuerpo' in saliente);
  assert.equal(saliente.cuerpo.identidad, null);
});

test('C2: the Telegram ref is tg:<id> and the thread tg:<chat id>', () => {
  const r = cuerpoTelegram(tg, 'entrante');
  assert.ok('cuerpo' in r);
  assert.deepEqual(r.cuerpo, {
    ref: 'tg:42',
    hilo_ref: 'tg:777000111',
    direccion: 'entrante',
    ts: '2026-10-23T09:00:01Z',
    identidad: { canal: 'telegram', valor: '777000111' },
  });
  assert.match(r.cuerpo.ref, /^[A-Za-z0-9_.:@-]{3,120}$/);
});

test('C2: the normalization vectors of correo-core give the same canonical form', () => {
  let n = 0;
  for (const v of vectores.vectores) {
    if (v.canal !== 'whatsapp' && v.canal !== 'telegram') continue;
    assert.equal(canonica(v.canal, v.entrada), v.canonica, `${v.canal} ${JSON.stringify(v.entrada)}`);
    n++;
  }
  assert.equal(n, 22);
});

test('ts is ISO in UTC with Z and no milliseconds, the form the core parses', () => {
  assert.equal(tsCanonico('2026-10-23T11:00:00.999+02:00'), '2026-10-23T09:00:00Z');
  assert.equal(tsCanonico(1792745000 * 1000), '2026-10-22T07:23:20Z');
  assert.equal(tsCanonico('no es una fecha'), null);
});

test('a non-canonical identity is a reason, not a body', () => {
  const r = cuerpoWhatsapp({ ...wa, senderWaId: '+34600111222@c.us' } as MessageReceivedEvent, 'entrante');
  assert.deepEqual(r, { motivo: 'identidad-no-canonica' });
  const t = cuerpoTelegram({ ...tg, senderTelegramId: '-100123' } as TelegramMessageReceivedEvent, 'entrante');
  assert.deepEqual(t, { motivo: 'identidad-no-canonica' });
});
