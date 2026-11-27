/**
 * DGX-1938: Telegram hands the messages of Saved Messages (the chat with
 * ourselves) over with out=false, so every own message there ingested as
 * INBOUND and /messages showed each send twice (its optimistic bubble only
 * pairs with an outbound echo). parseMessage now marks a non-forwarded message
 * of that chat as ours, TDLib's rule; a forward and any other chat keep
 * Telegram's flag.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramClientWrapper } from './telegram-client';

const SELF = 33285833;
const me = { type: 'user', id: SELF, firstName: 'Dani' };
const contact = { type: 'user', id: 777, firstName: 'Ana' };

async function isOutbound(message: Record<string, unknown>): Promise<boolean | undefined> {
  const wrapper = Object.assign(Object.create(TelegramClientWrapper.prototype), {
    selfId: String(SELF),
  }) as unknown as { parseMessage(m: unknown): Promise<{ isOutbound: boolean } | null> };
  const parsed = await wrapper.parseMessage({
    id: 229636,
    date: new Date('2026-11-27T18:43:44Z'),
    text: 'prueba',
    media: null,
    forward: null,
    replyToMessage: null,
    markup: null,
    isOutgoing: false,
    ...message,
  });
  return parsed?.isOutbound;
}

test('Saved Messages: our own message, delivered with out=false, is outbound', async () => {
  assert.equal(await isOutbound({ chat: me, sender: me }), true);
});

test('Saved Messages: a forwarded message keeps Telegram flag (inbound, as the apps show it)', async () => {
  assert.equal(
    await isOutbound({ chat: me, sender: me, forward: { date: new Date(0), sender: contact } }),
    false
  );
});

test('a normal chat is unchanged: out=false is inbound, out=true is outbound', async () => {
  assert.equal(await isOutbound({ chat: contact, sender: contact }), false);
  assert.equal(await isOutbound({ chat: contact, sender: me, isOutgoing: true }), true);
});
