import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldForward, normalizeJid } from './filter';
import { EventType, MessageReceivedEvent } from '@mcp-socialmedia/shared';

const OWN_JID = '34600000000@c.us';

function makeEvent(overrides: Partial<MessageReceivedEvent> = {}): MessageReceivedEvent {
  return {
    eventType: EventType.MESSAGE_RECEIVED,
    conversationId: '34699999999@c.us',
    waMessageId: 'WAMSG-1',
    waTimestamp: '2026-06-23T00:00:00.000Z',
    senderWaId: '34699999999@c.us',
    content: 'hola',
    messageType: 'TEXT',
    isForwarded: false,
    account: 'professional',
    ...overrides,
  } as MessageReceivedEvent;
}

// Dedup stub: configurable hit.
const neverSeen = { has: (): boolean => false };
const alwaysSeen = { has: (): boolean => true };

test('normalizeJid converts @s.whatsapp.net -> @c.us and strips device suffix', () => {
  assert.equal(normalizeJid('34600000000@s.whatsapp.net'), '34600000000@c.us');
  assert.equal(normalizeJid('34600000000:3@c.us'), '34600000000@c.us');
  assert.equal(normalizeJid('34600000000:42@s.whatsapp.net'), '34600000000@c.us');
  assert.equal(normalizeJid('174869610295503@lid'), '174869610295503@lid');
  assert.equal(normalizeJid(''), '');
  assert.equal(normalizeJid(undefined), '');
});

interface Case {
  name: string;
  event: MessageReceivedEvent;
  ownJid?: string;
  dedup?: { has(k: string): boolean };
  forward: boolean;
  reason: string;
  /** Expected FilterResult.fromMe (undefined for drops and normal forwards). */
  fromMe?: boolean;
}

const cases: Case[] = [
  // ── DROPS ──────────────────────────────────────────────────────────────
  {
    name: 'personal account dropped',
    event: makeEvent({ account: 'personal' }),
    forward: false,
    reason: 'account-not-professional',
  },
  {
    name: 'missing account dropped (defaults are not professional)',
    event: makeEvent({ account: undefined }),
    forward: false,
    reason: 'account-not-professional',
  },
  {
    name: 'group @g.us dropped',
    event: makeEvent({ conversationId: '120363000000000000@g.us' }),
    forward: false,
    reason: 'group-or-broadcast-or-newsletter',
  },
  {
    name: 'broadcast dropped',
    event: makeEvent({ conversationId: '12345@broadcast' }),
    forward: false,
    reason: 'group-or-broadcast-or-newsletter',
  },
  {
    name: 'newsletter dropped',
    event: makeEvent({ conversationId: '120363000@newsletter' }),
    forward: false,
    reason: 'group-or-broadcast-or-newsletter',
  },
  {
    name: 'status@broadcast dropped',
    event: makeEvent({ conversationId: 'status@broadcast' }),
    forward: false,
    reason: 'status-broadcast',
  },
  {
    name: 'unknown suffix dropped (fail-closed allowlist)',
    event: makeEvent({ conversationId: '12345@unknown.domain' }),
    forward: false,
    reason: 'not-1to1-allowlisted',
  },
  {
    name: 'missing waMessageId dropped',
    event: makeEvent({ waMessageId: '' }),
    forward: false,
    reason: 'missing-wa-message-id',
  },
  {
    name: 'fromMe on personal account still dropped (account gate first)',
    event: makeEvent({ fromMe: true, account: 'personal' }),
    forward: false,
    reason: 'account-not-professional',
  },
  {
    name: 'fromMe in a group still dropped (group gate before fromMe)',
    event: makeEvent({ fromMe: true, conversationId: '120363000000000000@g.us' }),
    forward: false,
    reason: 'group-or-broadcast-or-newsletter',
  },
  {
    name: 'own-JID unknown => drop everything',
    event: makeEvent(),
    ownJid: '',
    forward: false,
    reason: 'own-jid-unknown',
  },
  {
    name: 'own-JID unknown => drop even explicit fromMe (degraded mode)',
    event: makeEvent({ fromMe: true }),
    ownJid: '',
    forward: false,
    reason: 'own-jid-unknown',
  },
  {
    name: 'duplicate waMessageId dropped',
    event: makeEvent(),
    dedup: alwaysSeen,
    forward: false,
    reason: 'duplicate',
  },
  {
    name: 'duplicate fromMe waMessageId dropped (dedup applies to team touches)',
    event: makeEvent({ fromMe: true }),
    dedup: alwaysSeen,
    forward: false,
    reason: 'duplicate',
  },
  // ── FROM-ME FORWARDS (F0.5: team touch, flagged not dropped) ───────────
  {
    name: 'explicit fromMe flag forwarded flagged',
    event: makeEvent({ fromMe: true }),
    forward: true,
    reason: 'forward-from-me',
    fromMe: true,
  },
  {
    name: 'sender == own JID forwarded flagged (normalization-safe, device suffix)',
    event: makeEvent({ senderWaId: '34600000000:7@s.whatsapp.net' }),
    ownJid: OWN_JID,
    forward: true,
    reason: 'forward-from-me',
    fromMe: true,
  },
  {
    name: 'sender == own JID forwarded flagged (raw @s.whatsapp.net own jid)',
    event: makeEvent({ senderWaId: '34600000000@c.us' }),
    ownJid: '34600000000@s.whatsapp.net',
    forward: true,
    reason: 'forward-from-me',
    fromMe: true,
  },
  {
    name: 'explicit fromMe=false with third-party sender is a normal forward',
    event: makeEvent({ fromMe: false }),
    forward: true,
    reason: 'forward',
  },
  // ── FORWARDS ───────────────────────────────────────────────────────────
  {
    name: 'valid professional @c.us forwarded',
    event: makeEvent({ conversationId: '34699999999@c.us', senderWaId: '34699999999@c.us' }),
    forward: true,
    reason: 'forward',
  },
  {
    name: 'valid professional @s.whatsapp.net forwarded',
    event: makeEvent({
      conversationId: '34699999999@s.whatsapp.net',
      senderWaId: '34699999999@s.whatsapp.net',
    }),
    forward: true,
    reason: 'forward',
  },
  {
    name: 'valid professional @lid forwarded',
    event: makeEvent({
      conversationId: '174869610295503@lid',
      senderWaId: '174869610295503@lid',
    }),
    forward: true,
    reason: 'forward',
  },
];

for (const c of cases) {
  test(`shouldForward: ${c.name}`, () => {
    const result = shouldForward(c.event, c.ownJid ?? OWN_JID, c.dedup ?? neverSeen);
    assert.equal(result.forward, c.forward, `forward mismatch for ${c.name}`);
    assert.equal(result.reason, c.reason, `reason mismatch for ${c.name}`);
    assert.equal(result.fromMe, c.fromMe, `fromMe mismatch for ${c.name}`);
  });
}

test('malformed event dropped', () => {
  const result = shouldForward(null as unknown as MessageReceivedEvent, OWN_JID, neverSeen);
  assert.equal(result.forward, false);
  assert.equal(result.reason, 'malformed-event');
});
