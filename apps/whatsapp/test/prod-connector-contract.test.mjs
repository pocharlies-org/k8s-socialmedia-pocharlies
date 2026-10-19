import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

// Load the production TypeScript router from the connector's own dependencies.
const requireConnector = createRequire(new URL('../../../connectors/whatsapp-web/package.json', import.meta.url));
await import(requireConnector.resolve('tsx'));
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
process.env.CONNECTOR_ACCOUNT = 'personal';
process.env.ENABLE_SENDING = 'true';
process.env.EMERGENCY_DISABLE_SENDING = 'false';
const express = requireConnector('express');
const { createRouter } = await import('../../../connectors/whatsapp-web/src/api/controller.ts');
const { installSendAttemptStore } = await import('../../../connectors/whatsapp-web/src/test-support/send-attempt-store.ts');
const { resetSendIdempotencyStateForTests } = await import('../../../connectors/whatsapp-web/src/send-idempotency.ts');

const DIRECT = '34600000001@s.whatsapp.net';
const GROUP = '120363000001@g.us';
const COMMUNITY = '120363000002@g.us';
const MESSAGE = '56cd55b5-e62b-45fc-8a76-4584b6b6abf2';
const POLL = '3EB0POLL';
const BLOCKED_LID = '156000000000001@lid';
const PINNED_AT = new Date(Date.now() - 60000).toISOString();
const PIN_EXPIRES_AT = new Date(Date.now() + 86400000).toISOString();
const SECRET = 'contract-fixture-secret';
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==', 'base64');
const AUTH = `Basic ${Buffer.from('contract:fixture').toString('base64')}`;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wa-prod-contract-'));
  const store = installSendAttemptStore();
  resetSendIdempotencyStateForTests();
  const calls = [];
  const sdk = [];
  let name = 'Fixture Name';
  let about = 'Available';
  let photo = true;
  let blocked = false;
  let blockedListOverrides = {};
  let loseAcknowledgment = false;
  const privacy = { settings: { profilePicture: 'contacts', lastSeen: 'contacts', readReceipts: 'all' } };
  const ownProfile = () => ({ jid: DIRECT, phone: '34600000001', name, about,
    aboutKnown: true, photoKnown: true, photo: { available: photo },
    capabilities: { name: true, about: true, photo: true, photoRemove: true } });
  const outcome = (field, value) => ({ [field]: { requested: value, current: value,
    accepted: true, confirmed: true, reason: 'READBACK_MATCHED' }, applied: [field], failed: [], partial: false });
  // The fake stops at the SDK boundary: neither HTTP server nor auth is mocked.
  const client = {
    ownJid: DIRECT,
    isConnected: () => true,
    isIngestEnabled: () => true,
    getCachedState: () => 'CONNECTED',
    getOwnProfile: async () => ownProfile(),
    updateOwnProfile: async input => {
      sdk.push({ method: 'updateOwnProfile', input });
      if (input.name !== undefined) name = input.name;
      if (input.about !== undefined) about = input.about;
      return input.name !== undefined ? outcome('name', name) : outcome('about', about);
    },
    setOwnProfilePhoto: async input => {
      sdk.push({ method: 'setOwnProfilePhoto', input }); photo = true;
      return { photo: { available: true, accepted: true, confirmed: true, reason: 'READBACK_MATCHED' } };
    },
    removeOwnProfilePhoto: async () => {
      sdk.push({ method: 'removeOwnProfilePhoto' }); photo = false;
      return { photo: { available: false, accepted: true, confirmed: true, reason: 'READBACK_MATCHED' } };
    },
    getOwnProfilePhotoBytes: async () => JPEG,
    getPrivacySettings: async () => privacy,
    updatePrivacySetting: async (setting, value) => {
      sdk.push({ method: 'updatePrivacySetting', setting, value });
      privacy.settings[setting] = value;
      return { setting, value, changed: true, privacy };
    },
    sendMessage: async (chat, content, options = {}) => {
      await options.beforeSend?.();
      sdk.push({ method: 'sendMessage', chat, content });
      return options.messageId || '3EB0TEXT';
    },
    sendPoll: async (chat, poll, options = {}) => {
      await options.beforeSend?.(); sdk.push({ method: 'sendPoll', chat, poll });
      return { messageId: options.messageId || '3EB0NEWPOLL', conversationId: chat };
    },
    sendPollVote: async (chat, messageId, options, sendOptions = {}) => {
      await sendOptions.beforeSend?.(); sdk.push({ method: 'sendPollVote', chat, messageId, options });
      return { messageId: sendOptions.messageId || '3EB0VOTE', pollMessageId: messageId,
        conversationId: chat, options, retracted: !options.length, votedAt: '2026-10-07T10:00:00Z', persisted: true };
    },
    getPollResults: async (chat, ids) => {
      sdk.push({ method: 'getPollResults', chat, ids });
      if (Array.isArray(ids)) return ids.map(pollMessageId => ({ pollMessageId, question: 'Lunch?',
        selectableCount: 1, totalVoters: 1, available: true, availability: 'local_full',
        options: [{ name: 'Pizza', count: 1, selectedByMe: true }, { name: 'Sushi', count: 0, selectedByMe: false }] }));
      return { messageId: ids, conversationId: chat, question: 'Lunch?', selectableCount: 1,
        totalVoters: 1, myVote: ['Pizza'], persisted: true,
        options: [{ name: 'Pizza', votes: 1, voters: [DIRECT] }, { name: 'Sushi', votes: 0, voters: [] }] };
    },
    getGroupInfo: async () => ({ id: GROUP, subject: 'Contract Group', description: 'Group description',
      participants: [{ id: DIRECT, admin: 'admin' }] }),
    getGroupParticipants: async () => [{ id: DIRECT, admin: 'admin' }],
    listBlockedContacts: async () => ({ blocked: [{ id: DIRECT, jids: [DIRECT, BLOCKED_LID],
      blockedJids: [DIRECT, BLOCKED_LID], phone: '34600000001', name: null, pushName: null,
      conversationId: DIRECT }], count: 1, readAt: '2026-10-07T10:00:00.000Z', cached: false,
      ...blockedListOverrides }),
    listPinnedMessages: async chat => ({ conversationId: chat, limit: 3, persisted: true,
      pinned: [{ messageId: POLL, conversationId: chat, pinnedAt: PINNED_AT,
        expiresAt: PIN_EXPIRES_AT, durationSeconds: 86400, pinnedBy: DIRECT, source: 'live' }] }),
    listCommunities: async () => ({ communities: [{ communityId: COMMUNITY, subject: 'Contract Community',
      description: 'Community description', size: 1, createdAt: 1700000000,
      capabilities: { editInfo: true, manageGroups: true, leave: true }, linkedGroups: [], linkedGroupsComplete: true }] }),
    getCommunity: async () => ({ community: { id: COMMUNITY, name: 'Contract Community',
      description: 'Community description', participantCount: 1, createdAt: 1700000000,
      capabilities: { editInfo: true, manageGroups: true, leave: true } }, linkedGroups: [] }),
    getContactBlockState: async () => ({ blocked, confirmed: true }),
    setContactBlockState: async (_jid, value) => { blocked = value; return { blocked, confirmed: true }; },
    contactBlocked: async () => blocked,
    blockContact: async (_jid, value) => { blocked = value; return { blocked, confirmed: true }; },
    setContactBlock: async input => {
      blocked = input.action === 'block'; sdk.push({ method: 'setContactBlock', input });
      return { blocked, confirmed: true, action: input.action, jid: DIRECT, jids: [DIRECT] };
    },
  };
  const connector = express();
  connector.use(express.json());
  connector.use((req, _res, next) => {
    calls.push({ path: req.path, method: req.method, body: req.body, headers: { ...req.headers } });
    next();
  });
  connector.use('/api/v1', createRouter(client, { getCurrentQR: () => null }, SECRET));
  const connectorServer = createServer(connector);
  const connectorBase = await listen(connectorServer);
  const query = async (sql, params = []) => {
    if (/FROM conversations c/.test(sql) && /c\.id=\$2/.test(sql)) {
      return { rows: [{ id: params[1], wa_chat_id: params[1], name: 'Stored Chat', is_group: params[1] === GROUP }] };
    }
    if (/FROM messages m/.test(sql) && /m\.id::text=\$3/.test(sql) && [MESSAGE, POLL].includes(params[2])) {
      return { rows: [{ id: MESSAGE, wa_message_id: POLL, conversation_id: DIRECT,
        message_type: 'POLL', content: 'Lunch?', is_deleted: false }] };
    }
    if (/FROM messages m/.test(sql) && /AS "waMessageId"/.test(sql)) {
      return { rows: [{ id: MESSAGE, waMessageId: POLL, type: 'POLL', text: 'Lunch?',
        timestamp: '2026-10-07T10:00:00Z', direction: 'INBOUND', metadata: {}, fromMe: false }] };
    }
    return { rows: [] };
  };
  const app = await createApp({ env: { DATA_DIR: dir, APP_PUBLIC_URL: 'https://wa.example',
    UI_AUTH_USERNAME: 'contract', UI_AUTH_PASSWORD: 'fixture', APP_ENABLE_SENDING: 'true',
    PERSONAL_SECRET: SECRET }, db: { query }, registry: [{ channel: 'whatsapp', accountId: 'personal',
      secretEnv: 'PERSONAL_SECRET', connectorUrl: connectorBase }],
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).origin, connectorBase, 'fixture refuses provider/network access');
      const response = await fetch(url, options);
      if (loseAcknowledgment && new URL(url).pathname.endsWith('/messages/send')) {
        loseAcknowledgment = false;
        await response.text();
        throw new Error('Fixture lost acknowledgment after connector committed send');
      }
      return response;
    },
  });
  const appBase = await listen(app.server);
  t.after(async () => {
    await app.close();
    await new Promise(resolve => connectorServer.close(resolve));
    store.restore();
    await rm(dir, { recursive: true, force: true });
  });
  const request = (path, body, method = body === undefined ? 'GET' : 'POST') => fetch(appBase + path, {
    method, headers: { authorization: AUTH,
      ...(body === undefined ? {} : { origin: 'https://wa.example', 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async response => {
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  return { request, json, calls, sdk, connectorBase,
    setBlockedListOverrides: value => { blockedListOverrides = value; },
    loseNextAcknowledgment: () => { loseAcknowledgment = true; } };
}

test('real app and production WhatsApp router preserve account contracts', async t => {
  const f = await fixture(t);
  await t.test('signed UUID send survives a lost acknowledgment and manual retry without a second send', async () => {
    const token = randomUUID();
    const payload = { account: 'personal', chat: DIRECT, text: 'Contract message', sendToken: token };
    assert.equal((await fetch(f.connectorBase + '/api/v1/profile/me')).status, 401);
    f.loseNextAcknowledgment();
    assert.equal((await f.request('/api/send', payload)).status, 502);
    const retried = await f.json(await f.request('/api/send', payload));
    assert.ok(retried.messageId);
    assert.equal(f.sdk.filter(call => call.method === 'sendMessage').length, 1);
    const requests = f.calls.filter(call => call.path === '/api/v1/messages/send');
    assert.equal(requests.length, 2);
    for (const call of requests) {
      assert.equal(call.body.idempotencyKey, token);
      assert.equal(call.body.sendToken, token);
      assert.match(call.headers['x-connector-signature'], /^(?:sha256=)?[a-f0-9]{64}$/);
    }
  });
  await t.test('profile read, update and photo use confirmed production requests and app envelopes', async () => {
    const read = await f.json(await f.request('/api/profile?account=personal'));
    assert.equal(read.profile.name, 'Fixture Name');
    const updated = await f.json(await f.request('/api/profile', { account: 'personal', name: 'New Name' }));
    assert.equal(updated.confirmed, true);
    assert.equal(updated.profile.name, 'New Name');
    const set = await f.json(await f.request('/api/profile/photo', { account: 'personal', data: JPEG.toString('base64'), mimeType: 'image/jpeg' }));
    assert.equal(set.confirmed, true);
    assert.equal(set.profile.photo.available, true);
    const removed = await f.json(await f.request('/api/profile/photo/remove', { account: 'personal' }));
    assert.equal(removed.confirmed, true);
    assert.equal(removed.profile.photo.available, false);
    for (const call of f.calls.filter(call => call.path.startsWith('/api/v1/profile/me') && call.method !== 'GET')) {
      assert.equal(call.body.confirm, true, `${call.method} ${call.path} requires explicit production confirmation`);
    }
  });
  await t.test('privacy writes map app field alias to confirmed production setting', async () => {
    const result = await f.json(await f.request('/api/privacy', { account: 'personal', field: 'profilePicture', value: 'none' }));
    assert.equal(result.confirmed, true);
    assert.deepEqual(f.sdk.find(call => call.method === 'updatePrivacySetting'),
      { method: 'updatePrivacySetting', setting: 'profilePicture', value: 'none' });
    const call = f.calls.find(call => call.path === '/api/v1/privacy' && call.method === 'POST');
    assert.equal(call.body.setting, 'profilePicture');
    assert.equal(call.body.confirm, true);
  });
  await t.test('app contact block action reaches the production-backed legacy endpoint', async () => {
    const result = await f.json(await f.request('/api/chat-actions', { account: 'personal', chat: DIRECT, action: 'block' }));
    assert.equal(result.blocked, true);
    assert.equal(result.confirmed, true);
  });
  await t.test('canonical blocked list flattens rich identities while rejecting a wrong account and invalid envelope', async () => {
    const result = await f.json(await f.request('/api/blocked-contacts?account=personal'));
    assert.equal(result.account, 'personal');
    assert.equal(result.confirmed, true);
    assert.equal(result.count, 2);
    assert.deepEqual(result.contacts.map(contact => contact.jid), [DIRECT, BLOCKED_LID].sort());
    try {
      f.setBlockedListOverrides({ account: 'secondary' });
      assert.equal((await f.request('/api/blocked-contacts?account=personal')).status, 502);
      f.setBlockedListOverrides({ ok: false, error: { code: 'BAD_REPLY', message: 'Invalid fixture envelope' } });
      assert.equal((await f.request('/api/blocked-contacts?account=personal')).status, 502);
    } finally {
      f.setBlockedListOverrides({});
    }
  });
  await t.test('canonical pinned list resolves messages and converts ISO dates to app timestamps', async () => {
    const result = await f.json(await f.request(`/api/messages/pins?account=personal&chat=${encodeURIComponent(DIRECT)}`));
    assert.equal(result.account, 'personal');
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0], { id: MESSAGE, text: 'Lunch?', type: 'POLL',
      timestampMs: Date.parse(PINNED_AT), expiresAtMs: Date.parse(PIN_EXPIRES_AT) });
  });
  await t.test('group and community reads expose usable app shapes from production views', async () => {
    const group = await f.json(await f.request(`/api/group-details?account=personal&chat=${encodeURIComponent(GROUP)}`));
    assert.equal(group.group.subject, 'Contract Group');
    assert.equal(group.participants[0].id, DIRECT);
    const list = await f.json(await f.request('/api/communities?account=personal'));
    assert.equal(list.communities[0].id, COMMUNITY);
    assert.equal(list.communities[0].name, 'Contract Community');
    const detail = await f.json(await f.request(`/api/communities/${encodeURIComponent(COMMUNITY)}?account=personal`));
    assert.equal(detail.community.id, COMMUNITY);
  });
  await t.test('poll creation, vote and displayed results preserve production/fork contracts', async () => {
    const created = await f.json(await f.request('/api/compose', { account: 'personal', chat: DIRECT,
      kind: 'poll', sendToken: randomUUID(), payload: { question: 'Lunch?', options: ['Pizza', 'Sushi'], selectableCount: 1 } }));
    assert.ok(created.messageId);
    const voted = await f.json(await f.request('/api/messages/poll/vote', { account: 'personal', chat: DIRECT,
      messageId: MESSAGE, options: ['Pizza'], sendToken: randomUUID() }));
    assert.equal(voted.confirmed, true);
    assert.ok(voted.messageId);
    const messages = await f.json(await f.request(`/api/messages?account=personal&chat=${encodeURIComponent(DIRECT)}`));
    assert.equal(messages.messages[0].metadata.results.totalVoters, 1);
    assert.equal(messages.messages[0].metadata.results.options[0].count, 1);
  });
});
