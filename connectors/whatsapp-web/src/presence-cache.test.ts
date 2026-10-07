import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaileysClient } from './baileys-client';

test('presence expires instead of showing a stale online status', async () => {
  const client = new BaileysClient('/tmp/unused-presence-session', 'test-key');
  const chat = '34600123456@c.us';
  const normalized = (client as any).normalizeJid((client as any).toRawJid(chat));
  const state = (client as any).presenceState as Map<string, unknown>;
  const key = `${normalized}:${normalized}`;
  state.set(key, { status: 'available', observedAt: Date.now() });
  assert.equal((await client.getCapabilityPresence(chat)).status, 'available');

  state.set(key, { status: 'available', observedAt: Date.now() - 61_000 });
  assert.equal((await client.getCapabilityPresence(chat)).status, 'unknown');
  assert.equal(state.has(key), false);

  state.set(key, { status: 'composing', observedAt: Date.now() - 8_100 });
  assert.equal((await client.getCapabilityPresence(chat)).status, 'unknown');
  assert.equal(state.has(key), false);
});

test('the capability presence alias respects the account availability gate', async () => {
  const previous = process.env.WA_PRESENCE_ALLOW_AVAILABLE;
  process.env.WA_PRESENCE_ALLOW_AVAILABLE = 'false';
  const client = new BaileysClient('/tmp/unused-presence-session', 'test-key');
  let sent = false;
  Object.assign(client, {
    ready: true,
    sock: { sendPresenceUpdate: async () => { sent = true; } },
  });
  try {
    await assert.rejects(
      client.updatePresence(undefined, 'available'),
      (error: any) => error?.status === 403 && error?.failureClass === 'presence_available_disabled'
    );
    assert.equal(sent, false);
  } finally {
    if (previous === undefined) delete process.env.WA_PRESENCE_ALLOW_AVAILABLE;
    else process.env.WA_PRESENCE_ALLOW_AVAILABLE = previous;
  }
});
