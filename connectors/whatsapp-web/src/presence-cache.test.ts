import './test-env';
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

test('capability presence resolves PN/LID aliases and selects the newest observation', async () => {
  const client = new BaileysClient('/tmp/unused-presence-session', 'test-key');
  const pn = '34600123456@c.us';
  const lid = '900001@lid';
  Object.assign(client, {
    sock: { signalRepository: { lidMapping: {
      getLIDForPN: async () => lid,
      getPNForLID: async () => '34600123456@s.whatsapp.net',
    } } },
  });
  const state = (client as any).presenceState as Map<string, unknown>;
  state.set(`${lid}:${lid}`, { status: 'available', participantId: lid, observedAt: Date.now() - 1000 });
  assert.equal((await client.getCapabilityPresence(pn)).status, 'available');
  assert.equal(await client.matchesPresenceChat(pn, lid), true);
  assert.equal(await client.matchesPresenceChat(pn, 'unrelated@lid'), false);
  state.set(`${pn}:${pn}`, { status: 'unavailable', participantId: pn, observedAt: Date.now() });
  assert.equal((await client.getCapabilityPresence(lid)).status, 'unavailable');
  assert.equal((await client.getCapabilityPresence(lid, pn)).status, 'unavailable');
  assert.equal((await client.getCapabilityPresence(lid)).lastSeen, undefined);
});

test('capability presence does not leak another participant into a requested group member', async () => {
  const client = new BaileysClient('/tmp/unused-presence-session', 'test-key');
  const state = (client as any).presenceState as Map<string, unknown>;
  state.set('123@g.us:456@c.us', { status: 'available', participantId: '456@c.us', observedAt: Date.now() });
  assert.equal((await client.getCapabilityPresence('123@g.us', '789@c.us')).status, 'unknown');
});
