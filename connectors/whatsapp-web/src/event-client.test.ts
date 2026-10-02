import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { decryptEventResponse } from '@whiskeysockets/baileys';
import { BaileysClient } from './baileys-client';
import { serializeDurableValue } from './whatsapp-capabilities';

test('RSVP relays only after claiming and remains accepted if local persistence fails', async () => {
  const original = pg.Pool.prototype.query;
  const key = { id: 'event', remoteJid: '123@g.us', participant: '20000@s.whatsapp.net' };
  const secret = Buffer.alloc(32, 5);
  const message = {
    eventMessage: { name: 'Fixture' },
    messageContextInfo: { messageSecret: secret },
  };
  (pg.Pool.prototype as any).query = async () => ({
    rows: [
      { message_key: serializeDurableValue(key), message_payload: serializeDurableValue(message) },
    ],
  });
  const client = new BaileysClient('/tmp/unused-event-test', 'fixture') as any;
  const order: string[] = [];
  let relayed: any;
  Object.assign(client, {
    ready: true,
    meJid: '10000@s.whatsapp.net',
    logger: { warn: () => {} },
    sock: {
      relayMessage: async (_jid: string, content: any, options: any) => {
        order.push('relay');
        relayed = content;
        assert.equal(options.messageId, 'stable-id');
      },
    },
    persistSentMessage: async () => {
      order.push('persist');
      throw new Error('fixture storage unavailable');
    },
  });
  const input = {
    token: 'fixture',
    conversationId: '123@g.us',
    eventMessageId: 'event',
    attendance: 'going' as const,
    extraGuestCount: 0,
  };
  try {
    const id = await client.sendEventResponse(input, 'stable-id', async () => {
      order.push('claim');
    });
    assert.equal(id, 'stable-id');
    assert.deepEqual(order, ['claim', 'relay', 'persist']);
    const decoded = decryptEventResponse(relayed.encEventResponseMessage, {
      eventCreatorJid: key.participant,
      eventMsgId: 'event',
      eventEncKey: secret,
      responderJid: '10000@s.whatsapp.net',
    });
    assert.equal(decoded.response, 1);
    order.length = 0;
    await assert.rejects(
      client.sendEventResponse({ ...input, extraGuestCount: 1 }, 'stable-id', async () => {
        order.push('claim');
      }),
      { code: 'EVENT_GUESTS_DISABLED' }
    );
    assert.deepEqual(order, []);
  } finally {
    (pg.Pool.prototype as any).query = original;
  }
});

test('incoming RSVP is stored as ciphertext without appearing as a chat message or changing its preview', async () => {
  const original = pg.Pool.prototype.query;
  const queries: string[] = [];
  (pg.Pool.prototype as any).query = async (sql: string) => {
    queries.push(sql);
    return { rows: [] };
  };
  const client = new BaileysClient('/tmp/unused-event-test', 'fixture') as any;
  let emitted = false;
  client.on('message', () => {
    emitted = true;
  });
  try {
    const result = await client.ingestMessage({
      key: { id: 'reply', remoteJid: '123@g.us' },
      message: {
        encEventResponseMessage: {
          eventCreationMessageKey: { id: 'event' },
          encIv: Buffer.alloc(12),
          encPayload: Buffer.alloc(20),
        },
      },
    });
    assert.equal(result.inserted, false);
    assert.equal(emitted, false);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /INSERT INTO whatsapp_message_payloads/);
  } finally {
    (pg.Pool.prototype as any).query = original;
  }
});

const eventSecret = Buffer.alloc(32, 5);
const eventFixture = {
  eventMessage: { name: 'Fixture' },
  messageContextInfo: { messageSecret: eventSecret },
};
const eventInput = {
  token: 'fixture',
  conversationId: '123@g.us',
  eventMessageId: 'event',
  attendance: 'going' as const,
  extraGuestCount: 0,
};

function rsvpFixture(key: any, identity: Record<string, unknown>) {
  (pg.Pool.prototype as any).query = async () => ({
    rows: [
      {
        message_key: serializeDurableValue(key),
        message_payload: serializeDurableValue(eventFixture),
      },
    ],
  });
  const client = new BaileysClient('/tmp/unused-event-test', 'fixture') as any;
  const order: string[] = [];
  const holder: any = { relayed: undefined };
  Object.assign(client, {
    ready: true,
    meJid: '10000@s.whatsapp.net',
    logger: { warn: () => {} },
    sock: {
      relayMessage: async (_jid: string, content: any) => {
        order.push('relay');
        holder.relayed = content;
      },
    },
    persistSentMessage: async () => {
      order.push('persist');
    },
    ...identity,
  });
  return { client, order, holder };
}

test('unresolvable own or creator identity raises a typed 409 before the send token is claimed', async () => {
  const original = pg.Pool.prototype.query;
  const mustNotClaim = async () => {
    throw new Error('must not claim');
  };
  const mustNotRelay = async () => {
    throw new Error('must not relay');
  };
  const identityError = { code: 'EVENT_IDENTITY_UNAVAILABLE', status: 409 };
  try {
    // Own identity missing while the creator is a plain phone number.
    const missingOwn = rsvpFixture(
      { id: 'event', remoteJid: '123@g.us', participant: '20000@s.whatsapp.net' },
      { meJid: null, sock: { relayMessage: mustNotRelay } }
    );
    await assert.rejects(
      missingOwn.client.sendEventResponse(eventInput, 'stable-id', mustNotClaim),
      identityError
    );
    assert.deepEqual(missingOwn.order, []);
    // Creator is a LID but the device exposes no signal repository mapping at all.
    const noMapping = rsvpFixture(
      { id: 'event', remoteJid: '123@g.us', participant: '20000@lid' },
      { sock: { relayMessage: mustNotRelay } }
    );
    await assert.rejects(
      noMapping.client.sendEventResponse(eventInput, 'stable-id', mustNotClaim),
      identityError
    );
    assert.deepEqual(noMapping.order, []);
    // The LID lookup itself fails: a generic TypeError must not escape as a 500.
    const mappingThrows = rsvpFixture(
      { id: 'event', remoteJid: '123@g.us', participant: '20000@lid' },
      {
        sock: {
          relayMessage: mustNotRelay,
          signalRepository: {
            lidMapping: {
              getPNForLID: async () => {
                throw new Error('signal repository offline');
              },
            },
          },
        },
      }
    );
    await assert.rejects(
      mappingThrows.client.sendEventResponse(eventInput, 'stable-id', mustNotClaim),
      identityError
    );
    assert.deepEqual(mappingThrows.order, []);
    // Own identity is an unmapped LID.
    const unmappedOwn = rsvpFixture(
      { id: 'event', remoteJid: '123@g.us', participant: '20000@s.whatsapp.net' },
      {
        meJid: '10000@lid',
        sock: {
          relayMessage: mustNotRelay,
          signalRepository: { lidMapping: { getPNForLID: async () => null } },
        },
      }
    );
    await assert.rejects(
      unmappedOwn.client.sendEventResponse(eventInput, 'stable-id', mustNotClaim),
      identityError
    );
    assert.deepEqual(unmappedOwn.order, []);
    const invalidMapping = rsvpFixture(
      { id: 'event', remoteJid: '123@g.us', participant: '20000@lid' },
      {
        sock: {
          relayMessage: mustNotRelay,
          signalRepository: { lidMapping: { getPNForLID: async () => 'not-a-phone@lid' } },
        },
      }
    );
    await assert.rejects(
      invalidMapping.client.sendEventResponse(eventInput, 'stable-id', mustNotClaim),
      identityError
    );
    assert.deepEqual(invalidMapping.order, []);
  } finally {
    (pg.Pool.prototype as any).query = original;
  }
});

test('RSVP resolves LID identities to phone numbers before encrypting the response', async () => {
  const original = pg.Pool.prototype.query;
  try {
    const fixture = rsvpFixture(
      { id: 'event', remoteJid: '123@g.us', participant: '20000@lid' },
      {
        meJid: '10000:1@lid',
        sock: {
          relayMessage: async (_jid: string, content: any, options: any) => {
            fixture.order.push('relay');
            fixture.holder.relayed = content;
            assert.equal(options.messageId, 'stable-id');
          },
          signalRepository: {
            lidMapping: {
              getPNForLID: async (lid: string) =>
                lid === '20000@lid'
                  ? '20000@s.whatsapp.net'
                  : lid === '10000@lid'
                    ? '10000@s.whatsapp.net'
                    : null,
            },
          },
        },
      }
    );
    const id = await fixture.client.sendEventResponse(eventInput, 'stable-id', async () => {
      fixture.order.push('claim');
    });
    assert.equal(id, 'stable-id');
    assert.deepEqual(fixture.order, ['claim', 'relay', 'persist']);
    const decoded = decryptEventResponse(fixture.holder.relayed.encEventResponseMessage, {
      eventCreatorJid: '20000@s.whatsapp.net',
      eventMsgId: 'event',
      eventEncKey: eventSecret,
      responderJid: '10000@s.whatsapp.net',
    });
    assert.equal(decoded.response, 1);
  } finally {
    (pg.Pool.prototype as any).query = original;
  }
});
