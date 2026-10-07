import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from '../connectors/whatsapp-web/node_modules/express/index.js';
import { createRouter } from '../connectors/whatsapp-web/src/api/controller';
import { createApp } from '../apps/whatsapp/server.mjs';

// Both HTTP layers and their HMAC middleware are real. Only WhatsApp and the
// database are fixtures: no real message, receipt or group mutation is emitted.
test('browser API uses the real connector route and payload contracts', async t => {
  const previousSending = process.env.ENABLE_SENDING;
  const previousEmergency = process.env.EMERGENCY_DISABLE_SENDING;
  process.env.ENABLE_SENDING = 'true';
  process.env.EMERGENCY_DISABLE_SENDING = 'false';
  const calls: Array<{ method: string; args: any[] }> = [];
  const chat = '12025550100@c.us';
  const group = '12025550101@g.us';
  const messageId = '11111111-1111-1111-1111-111111111111';
  const providerId = 'PROVIDER-MESSAGE-1';
  const secret = 'synthetic-contract-secret';
  const validators: Record<string, (...args: any[]) => any> = {
    getPresence: () => ({ status: 'available', lastSeen: 1790000000 }),
    getPrivacySettings: () => ({ profile: 'contacts', last: 'none', readreceipts: 'none' }),
    getProfilePictureBytes: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    subscribePresence: () => ({ status: 'unknown' }),
    modifyChat: (_chat, action) => { assert.ok(action); return { action }; },
    markAsRead: () => undefined,
    shareContact: (destination, value) => {
      assert.equal(destination, chat);
      assert.equal(value.displayName, 'Fixture contact');
      assert.equal(value.phone, '+12025550102');
      return 'CONTACT-SENT';
    },
    sendPoll: (destination, value) => {
      assert.equal(destination, chat);
      assert.equal(value.name, 'Question?');
      assert.deepEqual(value.values, ['One', 'Two']);
      return 'POLL-SENT';
    },
    sendEvent: (destination, value) => {
      assert.equal(destination, chat);
      assert.equal(value.name, 'Fixture event');
      assert.ok(value.startDate instanceof Date && Number.isFinite(value.startDate.getTime()));
      return 'EVENT-SENT';
    },
    createContact: value => {
      assert.equal(value.phone || value.phoneE164, '+12025550102');
      assert.equal(value.name, 'Fixture contact');
      return { id: '12025550102@c.us', name: 'Fixture contact' };
    },
    startChat: value => {
      const phone = typeof value === 'string' ? value : value.phone;
      assert.equal(phone, '+12025550100');
      return { id: chat, name: phone, phone };
    },
    createGroup: (subject, participants) => {
      assert.equal(subject, 'Fixture group');
      assert.deepEqual(participants, ['12025550102@s.whatsapp.net']);
      return { id: group, subject, participants };
    },
    updateGroupParticipants: (id, participants, action) => {
      assert.equal(id, group);
      assert.deepEqual(participants, ['12025550102@s.whatsapp.net']);
      assert.equal(action, 'add');
      return [{ jid: participants[0], status: '200' }];
    },
    updatePrivacy: (field, value) => { assert.ok(field); assert.ok(value); return { field, value }; },
    setDisappearing: (id, expiration) => { assert.equal(id, chat); assert.equal(expiration, 86400); return { expiration }; },
    deleteMessage: (id, providerMessageId) => { assert.equal(id, chat); assert.equal(providerMessageId, providerId); },
    deleteMessageForMe: (id, providerMessageId) => { assert.equal(id, chat); assert.equal(providerMessageId, providerId); },
    editMessage: (id, providerMessageId, content) => {
      assert.equal(id, chat); assert.equal(providerMessageId, providerId); assert.equal(content, 'Edited'); return providerId;
    },
    reactToMessage: (id, original, emoji) => {
      assert.equal(id, chat); assert.equal(original, providerId); assert.equal(emoji, '\u{1f44d}');
    },
    forwardMessage: (id, original, destination) => {
      assert.equal(id, chat); assert.equal(original, providerId); assert.equal(destination, group); return 'FORWARDED-MESSAGE';
    },
    getGroupInfo: () => ({ id: group, subject: 'Fixture group', participants: [], capabilities: { manageMembers: true, editInfo: true } }),
    getGroupParticipants: () => [{ id: '12025550102@s.whatsapp.net', name: 'Fixture admin', admin: 'admin' }],
  };
  const client = new Proxy({}, { get: (_target, method: string) => (...args: any[]) => {
    calls.push({ method, args });
    assert.ok(validators[method], `Unexpected client method ${method}`);
    return validators[method](...args);
  } });
  const connector = express();
  connector.use(express.json());
  connector.post('/api/v1/contacts/seed', (_req, res) => {
    res.status(409).json({ error: 'Legacy Shopify contact probing is not ordinary contact creation' });
  });
  connector.use('/api/v1', createRouter(client as any, {} as any, secret));
  const connectorServer = connector.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => connectorServer.once('listening', resolve));
  const connectorPort = (connectorServer.address() as any).port;
  const directory = await mkdtemp(join(tmpdir(), 'wa-real-contract-'));
  const db = { query: async (sql: string, values: any[] = []) => {
    if (/FROM conversations/.test(sql)) return { rows: values[0] === 'fixture' && [chat, group].includes(values[1]) ? [{
      id: values[1], account: 'fixture', wa_chat_id: values[1], is_group: values[1] === group, name: 'Fixture', archived: false,
    }] : [] };
    if (/FROM messages/.test(sql)) return { rows: [{ id: messageId, wa_message_id: providerId,
      account: 'fixture', conversation_id: chat, direction: 'OUTBOUND', content: 'Original', is_deleted: false,
    }] };
    return { rows: [] };
  } };
  const app = await createApp({
    env: { DATA_DIR: directory, UI_AUTH_USERNAME: 'fixture', UI_AUTH_PASSWORD: 'test', APP_AUTH_MODE: 'basic',
      APP_PUBLIC_URL: 'https://fixture.invalid', APP_ENABLE_SENDING: 'true', CONNECTOR_SECRET: secret },
    db,
    registry: [{ accountId: 'fixture', channel: 'whatsapp', connectorUrl: `http://127.0.0.1:${connectorPort}`, secretEnv: 'CONNECTOR_SECRET' }],
  });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    await new Promise<void>(resolve => connectorServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    if (previousSending === undefined) delete process.env.ENABLE_SENDING; else process.env.ENABLE_SENDING = previousSending;
    if (previousEmergency === undefined) delete process.env.EMERGENCY_DISABLE_SENDING; else process.env.EMERGENCY_DISABLE_SENDING = previousEmergency;
  });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  async function request(path: string, body?: Record<string, unknown>, allowedStatuses: number[] = []) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Basic ${Buffer.from('fixture:test').toString('base64')}`,
        ...(body ? { origin: 'https://fixture.invalid', 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify({ account: 'fixture', chat, ...body }) } : {}),
    });
    const result = await response.json();
    assert.ok(response.ok || allowedStatuses.includes(response.status), `${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
    return result;
  }
  for (const action of ['read', 'unread', 'archive', 'unarchive', 'pin', 'unpin', 'mute', 'unmute', 'starred', 'unstarred']) {
    await t.test(`chat action ${action}`, async () => {
      const before = calls.length;
      await request('/api/chat-actions', { action, messageId });
      assert.ok(calls.length > before, `${action} must reach WhatsApp`);
    });
  }
  await t.test('presence subscription and response', async () => {
    await request('/api/presence/subscribe', {});
    const value = await request(`/api/presence?account=fixture&chat=${encodeURIComponent(chat)}`);
    assert.ok(['available', 'online'].includes(value.state || value.status), JSON.stringify(value));
  });
  for (const [kind, payload] of [
    ['contact', { name: 'Fixture contact', address: '+12025550102' }],
    ['poll', { question: 'Question?', options: ['One', 'Two'] }],
    ['event', { title: 'Fixture event', dateTime: '2026-10-01T10:00', location: 'Fixture place' }],
  ] as const) {
    await t.test(`compose ${kind} from the UI form`, async () => {
      await request('/api/messages/compose', { kind, payload });
    });
  }
  await t.test('contact creation', async () => {
    await request('/api/contacts', { phone: '+12025550102', displayName: 'Fixture contact' });
  });
  await t.test('starting a chat requires no name and does not create a contact', async () => {
    const before = calls.length;
    const value = await request('/api/chats/new', { phone: '+12025550100' });
    assert.equal(value.chat.id, chat);
    assert.deepEqual(calls.slice(before).map(call => call.method), ['startChat']);
  });
  await t.test('nested shared content cannot override the scoped destination', async () => {
    await request('/api/messages/compose', { kind: 'contact', payload: {
      name: 'Fixture contact', address: '+12025550102', conversationId: 'foreign-chat', account: 'foreign', chatId: 'foreign-chat',
    } });
  });
  await t.test('group details preserve administrator information', async () => {
    const value = await request(`/api/chat-details?account=fixture&chat=${encodeURIComponent(group)}`);
    assert.equal(value.participants[0].name, 'Fixture admin');
    assert.equal(value.participants[0].isAdmin, true);
    assert.equal(value.capabilities.manageMembers, true);
  });
  await t.test('privacy reads reflect existing settings instead of permissive defaults', async () => {
    const value = await request('/api/privacy?account=fixture');
    const privacy = value.privacy || value;
    assert.equal(privacy.profile, 'contacts');
    assert.equal(privacy.lastSeen, 'none');
    assert.equal(privacy.readReceipts, false);
  });
  await t.test('avatar retrieval works without an already stored photo URL', async () => {
    const response = await fetch(`${base}/api/chats/${encodeURIComponent(chat)}/avatar?account=fixture`, {
      headers: { authorization: `Basic ${Buffer.from('fixture:test').toString('base64')}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });
  await t.test('reactions and forwarding identify the original and destination', async () => {
    await request('/api/messages/react', { messageId, emoji: '\u{1f44d}' });
    await request('/api/messages/forward', { messageId, targetChat: group });
  });
  await t.test('group creation and member action', async () => {
    await request('/api/groups', { name: 'Fixture group', participants: ['12025550102@s.whatsapp.net'] });
    await request('/api/groups/action', { chat: group, action: 'add', participant: '12025550102@s.whatsapp.net' });
  });
  await t.test('privacy and disappearing messages', async () => {
    await request('/api/privacy', { profile: 'contacts', lastSeen: 'contacts', readReceipts: true });
    await request('/api/privacy', { disappearingSeconds: 86400 });
  });
  await t.test('edit reaches the intended original message', async () => {
    await request('/api/messages/edit', { messageId, text: 'Edited' });
  });
  await t.test('delete for me never revokes for everyone', async () => {
    const before = calls.filter(x => x.method === 'deleteMessage').length;
    await request('/api/messages/delete', { messageId, scope: 'me' });
    assert.equal(calls.filter(x => x.method === 'deleteMessage').length, before);
    assert.equal(calls.at(-1)?.method, 'deleteMessageForMe');
  });
  await t.test('delete for everyone explicitly invokes revocation', async () => {
    await request('/api/messages/delete', { messageId, scope: 'everyone' });
    assert.equal(calls.at(-1)?.method, 'deleteMessage');
  });
});
