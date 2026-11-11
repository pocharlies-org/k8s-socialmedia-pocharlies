import {
  assertProfilePictureFailures,
  assertTimestampedPictureQuery,
} from './test-support/profile-query';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { Boom } from '@hapi/boom';
import {
  BaileysClient,
  ProfilePictureDownloadError,
  ProfilePictureTimeoutError,
} from './baileys-client';

function stubPool(rows: Record<string, unknown>[] = []): {
  calls: Array<{ sql: string; params: unknown[] }>;
  restore: () => void;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const original = pg.Pool.prototype.query;
  (pg.Pool.prototype as any).query = function (sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    return Promise.resolve({ rows });
  };
  return { calls, restore: () => ((pg.Pool.prototype as any).query = original) };
}

function durableRow() {
  return {
    message_key: JSON.stringify({ remoteJid: '34600@s.whatsapp.net', id: 'old', fromMe: false }),
    message_payload: JSON.stringify({ conversation: 'old body' }),
    message_timestamp_ms: '1700000000000',
    push_name: 'Ada',
  };
}

test('forward uses the durable original WAMessage after an in-memory restart', async () => {
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const { restore } = stubPool([durableRow()]);
  const sent: unknown[] = [];
  try {
    const client = new BaileysClient('/tmp/unused', 'key');
    Object.assign(client, {
      ready: true,
      sock: {
        sendMessage: async (_jid: string, payload: unknown) => {
          sent.push(payload);
          return {
            key: { remoteJid: '34699@s.whatsapp.net', id: 'new', fromMe: true },
            message: { conversation: 'old body' },
          };
        },
      },
    });
    const id = await client.forwardMessage('34600@c.us', 'old', '34699@c.us');
    assert.equal(id, 'new');
    const forward = (sent[0] as { forward: any }).forward;
    assert.equal(forward.key.remoteJid, '34600@s.whatsapp.net');
    assert.equal(forward.key.id, 'old');
    assert.equal(forward.key.fromMe, false);
    assert.equal(forward.message.conversation, 'old body');
    assert.equal(Number(forward.messageTimestamp), 1700000000);
    assert.equal(forward.pushName, 'Ada');
  } finally {
    restore();
  }
});

test('markAsRead sends every unread key returned for the chat', async () => {
  process.env.CONNECTOR_ACCOUNT = 'personal';
  const { restore } = stubPool([
    {
      wa_message_id: 'm2',
      remote_jid: '34600@s.whatsapp.net',
      from_me: false,
      participant_jid: '34600@s.whatsapp.net',
      message_timestamp_ms: '1700000001000',
    },
    {
      wa_message_id: 'm1',
      remote_jid: '34600@s.whatsapp.net',
      from_me: false,
      participant_jid: '34600@s.whatsapp.net',
      message_timestamp_ms: '1700000000000',
    },
  ]);
  const read: unknown[][] = [];
  try {
    const client = new BaileysClient('/tmp/unused', 'key');
    Object.assign(client, { sock: { readMessages: async (keys: unknown[]) => read.push(keys) } });
    await client.markAsRead('34600@c.us');
    assert.equal(read.length, 1);
    assert.deepEqual(
      (read[0] as any[]).map(key => key.id),
      ['m2', 'm1']
    );
  } finally {
    restore();
  }
});

test('delete for me uses the durable key and only persists after provider ack', async () => {
  const { calls, restore } = stubPool([
    {
      wa_message_id: 'm1',
      remote_jid: '34600@s.whatsapp.net',
      from_me: false,
      participant_jid: null,
      message_timestamp_ms: '1700000000000',
    },
  ]);
  let rejectProvider = true;
  const modified: unknown[] = [];
  try {
    const client = new BaileysClient('/tmp/unused', 'key') as any;
    client.sock = {
      chatModify: async (payload: unknown, jid: string) => {
        modified.push([payload, jid]);
        if (rejectProvider) throw new Error('provider rejected');
      },
    };
    await assert.rejects(
      client.deleteCapabilityMessageForMe('34600@c.us', 'm1'),
      /provider rejected/
    );
    assert.equal(
      calls.some(call => /UPDATE messages/.test(call.sql)),
      false
    );
    rejectProvider = false;
    await client.deleteCapabilityMessageForMe('34600@c.us', 'm1');
    assert.deepEqual(modified[1], [
      {
        deleteForMe: {
          deleteMedia: true,
          key: {
            remoteJid: '34600@s.whatsapp.net',
            id: 'm1',
            fromMe: false,
            participant: undefined,
          },
          timestamp: 1700000000,
        },
      },
      '34600@s.whatsapp.net',
    ]);
    const update = calls.find(call => /UPDATE messages/.test(call.sql));
    assert.equal(update?.params[2], '34600@c.us');
  } finally {
    restore();
  }
});

test('start chat validates recipient and persists an empty conversation without sending or saving contact', async () => {
  const { calls, restore } = stubPool([]);
  const client = new BaileysClient('/tmp/unused', 'key') as any;
  let exists = false;
  client.ready = true;
  client.sock = {
    onWhatsApp: async () => (exists ? [{ exists: true, jid: '34600111222@s.whatsapp.net' }] : []),
    sendMessage: () => {
      throw new Error('unexpected send');
    },
    addOrEditContact: () => {
      throw new Error('unexpected contact write');
    },
  };
  try {
    await assert.rejects(client.startChat('+34600111222'), /not on WhatsApp/);
    assert.equal(calls.length, 0);
    exists = true;
    const chat = await client.startChat('+34600111222');
    assert.equal(chat.id, '34600111222@c.us');
    assert.match(calls[0].sql, /INSERT INTO conversations/);
    assert.doesNotMatch(calls[0].sql, /last_message_at/);
  } finally {
    restore();
  }
});

test('group capabilities follow the account participant admin role and restrict setting', async () => {
  const { restore } = stubPool([{ jid: '34622@s.whatsapp.net', name: 'Saved member' }]);
  const client = new BaileysClient('/tmp/unused', 'key') as any;
  client.sock = {
    user: { id: '34600:1@s.whatsapp.net', lid: '100@lid' },
    signalRepository: { lidMapping: { getLIDForPN: async () => '100@lid' } },
  };
  client.profilePictureUrlIfAvailable = async () => null;
  let admin: 'admin' | null = null;
  let restrict = true;
  client.fetchGroupMetadata = async () => ({
    id: '123@g.us',
    subject: 'Team',
    owner: '999@lid',
    restrict,
    participants: [
      { id: '100@lid', phoneNumber: '34600@s.whatsapp.net', admin },
      { id: '34622@s.whatsapp.net' },
    ],
  });
  try {
    let group = await client.getGroupInfo('123@g.us');
    assert.deepEqual(group.capabilities, { manageMembers: false, editInfo: false });
    assert.equal(group.hasPhoto, null);
    assert.equal(group.photoLookupStatus, 'unavailable');
    assert.equal(group.participants[1].name, 'Saved member');
    restrict = false;
    group = await client.getGroupInfo('123@g.us');
    assert.deepEqual(group.capabilities, { manageMembers: false, editInfo: true });
    admin = 'admin';
    restrict = true;
    group = await client.getGroupInfo('123@g.us');
    assert.deepEqual(group.capabilities, { manageMembers: true, editInfo: true });
  } finally {
    restore();
  }
});

test('group info and participants reject direct JIDs before querying Baileys', async () => {
  const client = new BaileysClient('/tmp/unused', 'key') as any;
  let metadataCalls = 0;
  client.sock = {
    groupMetadata: async () => {
      metadataCalls += 1;
      return {};
    },
  };
  await assert.rejects(client.getGroupInfo('34600@s.whatsapp.net'), /group JID is required/);
  await assert.rejects(
    client.getGroupParticipants('34600@s.whatsapp.net'),
    /group JID is required/
  );
  assert.equal(metadataCalls, 0);
});

test('group info survives an optional photo lookup failure without claiming the photo is absent', async () => {
  const { restore } = stubPool([]);
  const client = new BaileysClient('/tmp/unused', 'key') as any;
  client.sock = { user: { id: '34600@s.whatsapp.net' } };
  client.fetchGroupMetadata = async () => ({
    id: '123@g.us',
    subject: 'Team',
    restrict: true,
    participants: [{ id: '34600@s.whatsapp.net', admin: 'admin' }],
  });
  client.profilePictureUrlIfAvailable = async () => {
    throw new ProfilePictureTimeoutError();
  };
  try {
    const group = await client.getGroupInfo('123@g.us');
    assert.equal(group.photoLookupStatus, 'unavailable');
    assert.equal(group.hasPhoto, null);
    assert.deepEqual(group.capabilities, { manageMembers: true, editInfo: true });
  } finally {
    restore();
  }
});

test('profile picture provider timeout stays distinct from private or missing photos', async () => {
  await assertProfilePictureFailures(new BaileysClient('/tmp/unused', 'key'), [403]);
});

test('profile picture lookup deadline also bounds token preparation before Baileys IQ', async () => {
  const client = new BaileysClient('/tmp/unused', 'key') as any;
  client.sock = { profilePictureUrl: () => new Promise(() => {}) };
  const started = Date.now();
  await assert.rejects(client.getProfilePictureBytes('34600@c.us'), ProfilePictureTimeoutError);
  assert.ok(Date.now() - started < 10_000);
});

test('patched Baileys nests timestamped tc token inside the picture query', async () => {
  await assertTimestampedPictureQuery();
});

test('profile picture stream stops above 10 MB and reports download failure', async () => {
  const client = new BaileysClient('/tmp/unused', 'key') as any;
  client.sock = { profilePictureUrl: async () => 'https://mmg.whatsapp.net/photo' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1));
        },
      })
    ) as any;
  try {
    await assert.rejects(client.getProfilePictureBytes('34600@c.us'), ProfilePictureDownloadError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('photo CDN network failure is not misreported as a missing private photo', async () => {
  const client = new BaileysClient('/tmp/unused', 'key') as any;
  client.sock = { profilePictureUrl: async () => 'https://mmg.whatsapp.net/photo' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  try {
    await assert.rejects(client.getProfilePictureBytes('34600@c.us'), ProfilePictureDownloadError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('presence read remains unknown when provider has not emitted state', async () => {
  const client = new BaileysClient('/tmp/unused', 'key');
  const snapshot = await client.getCapabilityPresence('34600@c.us');
  assert.equal(snapshot.status, 'unknown');
  assert.equal('lastSeen' in snapshot, false);
});

test('provider calls strip the connector account prefix before building a WhatsApp jid', () => {
  const previous = process.env.CONNECTOR_ACCOUNT;
  try {
    process.env.CONNECTOR_ACCOUNT = 'professional';
    const client = new BaileysClient('/tmp/unused', 'key') as any;
    assert.equal(client.toRawJid('professional:34600@c.us'), '34600@s.whatsapp.net');
    assert.equal(client.toRawJid('professional:120@g.us'), '120@g.us');
  } finally {
    if (previous === undefined) delete process.env.CONNECTOR_ACCOUNT;
    else process.env.CONNECTOR_ACCOUNT = previous;
  }
});

test('disappearing mode reads the Baileys USync duration field', async () => {
  const client = new BaileysClient('/tmp/unused', 'key') as any;
  client.sock = {
    fetchDisappearingDuration: async () => [
      { id: '34600@s.whatsapp.net', disappearing_mode: { duration: 86_400 } },
    ],
  };
  const result = await client.getCapabilityDisappearing('34600@c.us');
  assert.deepEqual(result, { chatId: '34600@c.us', expiration: 86_400, known: true });
});

test('received capability metadata is structured without raw provider payloads', () => {
  const client = new BaileysClient('/tmp/unused', 'key') as any;
  const base = {
    key: { remoteJid: '34600@s.whatsapp.net', id: 'm1', fromMe: false },
    messageTimestamp: 1,
  };
  const poll = client.convertMessage({
    ...base,
    message: {
      pollCreationMessageV2: {
        name: 'Availability',
        selectableOptionsCount: 0,
        options: [{ optionName: 'Yes' }, { optionName: 'No' }],
      },
    },
  });
  assert.deepEqual(poll.metadata, {
    kind: 'poll',
    options: ['Yes', 'No'],
    selectableCount: 0,
  });

  const event = client.convertMessage({
    ...base,
    key: { ...base.key, id: 'm2' },
    message: {
      eventMessage: {
        name: 'Release',
        startTime: 1_700_000_000,
        endTime: 1_700_003_600,
        isCanceled: true,
        extraGuestsAllowed: true,
        location: { degreesLatitude: 40.4, degreesLongitude: -3.7, name: 'Madrid' },
      },
    },
  });
  assert.deepEqual(event.metadata, {
    kind: 'event',
    description: null,
    startTime: 1_700_000_000,
    endTime: 1_700_003_600,
    location: { degreesLatitude: 40.4, degreesLongitude: -3.7, name: 'Madrid' },
    isCancelled: true,
    extraGuestsAllowed: true,
  });

  const contact = client.convertMessage({
    ...base,
    key: { ...base.key, id: 'm3' },
    message: {
      contactMessage: {
        displayName: 'Ada',
        vcard:
          'BEGIN:VCARD\\nTEL;type=CELL:+34600111222\\nORG:Example\\nEMAIL:ada@example.test\\nEND:VCARD',
      },
    },
  });
  assert.deepEqual(contact.metadata, {
    kind: 'contact',
    contacts: [
      {
        displayName: 'Ada',
        phone: '+34600111222',
        organization: 'Example',
        email: 'ada@example.test',
      },
    ],
  });
});

test('control-only WhatsApp envelopes do not become empty chat bubbles', () => {
  const client = new BaileysClient('/tmp/unused', 'key') as any;
  const base = {
    key: { remoteJid: '34600@s.whatsapp.net', id: 'control', fromMe: false },
    messageTimestamp: 1,
  };
  assert.equal(
    client.convertMessage({ ...base, message: { senderKeyDistributionMessage: {} } }),
    null
  );
  assert.equal(client.convertMessage({ ...base, message: { messageContextInfo: {} } }), null);
  assert.equal(
    client.convertMessage({
      ...base,
      message: {
        messageContextInfo: {},
        conversation: 'Visible text',
      },
    })?.content,
    'Visible text'
  );
});

test('media replies preserve the quoted message ID', () => {
  const client = new BaileysClient('/tmp/unused', 'key') as any;
  const message = client.convertMessage({
    key: { remoteJid: '34600@s.whatsapp.net', id: 'media-reply', fromMe: false },
    messageTimestamp: 1,
    message: {
      imageMessage: { caption: 'Photo', contextInfo: { stanzaId: 'quoted', isForwarded: true } },
    },
  });
  assert.equal(message?.replyToWaId, 'quoted');
  assert.equal(message?.isForwarded, true);
  assert.equal(message?.messageType, 'IMAGE');
  const wrapped = client.convertMessage({
    key: { remoteJid: '34600@s.whatsapp.net', id: 'wrapped-reply', fromMe: false },
    messageTimestamp: 1,
    message: {
      ephemeralMessage: {
        message: {
          imageMessage: { caption: 'Temporary photo', contextInfo: { stanzaId: 'older' } },
        },
      },
    },
  });
  assert.equal(wrapped?.replyToWaId, 'older');
  assert.equal(wrapped?.messageType, 'IMAGE');
});
