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
  assert.equal((await client.getPresence(chat)).status, 'available');

  state.set(key, { status: 'available', observedAt: Date.now() - 61_000 });
  assert.equal((await client.getPresence(chat)).status, 'unknown');
  assert.equal(state.has(key), false);
});
