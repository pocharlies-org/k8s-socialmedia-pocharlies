/**
 * El job de embeddings tiene que acertar la fila de `messages` con la clave opaca
 * real: `personal` sin prefijo y las demás cuentas namespaceadas por el `account`
 * que estampa el conector (migración 002), y Telegram como `tg_<chat>_<mensaje>`.
 * Con el id pelado del evento solo acertaba el WhatsApp personal: professional y
 * todo Telegram se quedaban sin embedding en silencio (medido 04-10).
 */
import { EmbeddingJob } from './embedding-job';

type Event = Parameters<typeof EmbeddingJob.messageKeyFor>[0];

it('WhatsApp personal: la clave va sin prefijo (compat con las filas históricas)', () => {
  const e: Event = { eventType: 'MessageReceived', conversationId: '123@c.us', waMessageId: '3EB0AA' };
  expect(EmbeddingJob.messageKeyFor(e)).toBe('3EB0AA');
});

it('WhatsApp professional: la clave lleva el prefijo de la cuenta del evento', () => {
  const e: Event = {
    eventType: 'MessageReceived',
    conversationId: '123@c.us',
    waMessageId: '3EB0AA',
    account: 'professional',
  };
  expect(EmbeddingJob.messageKeyFor(e)).toBe('professional:3EB0AA');
});

it('Telegram: tg_<chat>_<mensaje>, con su cuenta cuando no es la default', () => {
  const personal: Event = {
    eventType: 'TelegramMessageReceived',
    conversationId: '-1004409526898',
    telegramMessageId: '8972',
    account: 'personal',
  };
  const pro: Event = { ...personal, account: 'professional' };
  expect(EmbeddingJob.messageKeyFor(personal)).toBe('tg_-1004409526898_8972');
  expect(EmbeddingJob.messageKeyFor(pro)).toBe('professional:tg_-1004409526898_8972');
});

it('un evento sin id util no manda una consulta vacía', () => {
  const e: Event = { eventType: 'MessageReceived', conversationId: '123@c.us' };
  expect(EmbeddingJob.messageKeyFor(e)).toBe('');
});
