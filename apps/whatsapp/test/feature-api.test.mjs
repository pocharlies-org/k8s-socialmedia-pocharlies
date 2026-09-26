import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { AppState } from '../lib/app-state.mjs';
import { publicMessageMetadata, publicPollResults } from '../lib/message-projection.mjs';

const auth = `Basic ${Buffer.from('operator:password').toString('base64')}`;

function fixtureDatabase(calls) {
  const conversations = {
    'personal-chat': { id: 'personal-chat', account: 'personal', name: 'Personal', wa_chat_id: 'personal-chat', is_group: false, archived: false, unread: 2, avatar_url: null },
    'personal-archived': { id: 'personal-archived', account: 'personal', name: 'Archived', wa_chat_id: 'personal-archived', is_group: false, archived: true, unread: 0, avatar_url: null },
    'secondary-chat': { id: 'secondary-chat', account: 'secondary', name: 'Secondary', wa_chat_id: 'secondary-chat', is_group: false, archived: false, unread: 1, avatar_url: null },
  };
  const messages = {
    'personal-chat': [{ id: '11111111-1111-1111-1111-111111111111', wa_message_id: 'wa-personal-1', conversation_id: 'personal-chat', content: 'hello', direction: 'INBOUND', message_type: 'TEXT', is_deleted: false, wa_timestamp: '2026-09-23T08:00:00.000Z' }],
    'secondary-chat': [{ id: '22222222-2222-2222-2222-222222222222', wa_message_id: 'wa-secondary-1', conversation_id: 'secondary-chat', content: 'other', direction: 'INBOUND', message_type: 'TEXT', is_deleted: false, wa_timestamp: '2026-09-23T08:00:00.000Z' }],
  };
  return {
    conversations,
    messages,
    query: async (sql, args = []) => {
      calls.push({ sql, args });
      if (/SELECT pn\.id FROM conversations pn/.test(sql)) return { rows: Object.values(conversations)
        .filter(row => row.account === args[0] && !/@lid$/.test(row.id) && row.id.replace(/@c\.us$/, '@s.whatsapp.net') === String(args[1]).replace(/@c\.us$/, '@s.whatsapp.net'))
        .map(row => ({ id: row.id })) };
      if (/SELECT lid\.id FROM conversations lid/.test(sql)) return { rows: Object.values(conversations)
        .filter(row => row.account === args[0] && /@lid$/.test(row.id) && row.wa_chat_id?.replace(/@c\.us$/, '@s.whatsapp.net') === String(args[1]).replace(/@c\.us$/, '@s.whatsapp.net'))
        .map(row => ({ id: row.id })) };
      if (/SELECT c\.id,/.test(sql)) return { rows: Object.values(conversations)
        .filter(row => row.account === args[0])
        .map(row => ({ ...row, waChatId: row.wa_chat_id, avatarUrl: row.avatar_url })) };
      if (/UPDATE conversations SET (unread_count|archived)/.test(sql)) {
        for (const id of args[1]) {
          const row = conversations[id];
          if (!row || row.account !== args[0]) continue;
          if (/SET unread_count/.test(sql)) row.unread = id === args[3] ? args[2] : 0;
          else row.archived = args[2];
        }
        return { rows: [] };
      }
      if (/FROM conversations/.test(sql)) return { rows: conversations[args[1]]?.account === args[0] ? [conversations[args[1]]] : [] };
      if (/JOIN conversations c ON c.id=m.conversation_id/.test(sql)) return { rows: Object.values(messages).flat()
        .filter(row => conversations[row.conversation_id]?.account === args[0]
          && (`${row.conversation_id}:${row.id}` === args[1] || `${row.conversation_id}:${row.wa_message_id}` === args[1]))
        .map(row => ({ ...row, chat_name: conversations[row.conversation_id]?.name })) };
      if (/SELECT m\.id, m\.wa_timestamp FROM messages m/.test(sql)) return { rows: (Array.isArray(args[1]) ? args[1] : [args[1]])
        .flatMap(id => messages[id] || [])
        .filter(row => row.id === args[2] || row.wa_message_id === args[2])
        .map(row => ({ id: row.id, wa_timestamp: row.wa_timestamp })) };
      if (/FROM messages m/.test(sql) && /m\.id,\s*m\.wa_message_id/.test(sql)) {
        let rows = (Array.isArray(args[1]) ? args[1] : [args[1]]).flatMap(id => messages[id] || []);
        if (/AND \(m\.wa_timestamp, m\.id::text\)/.test(sql)) {
          rows = rows.filter(row => (row.wa_timestamp < args[2] || (row.wa_timestamp === args[2] && row.id <= args[3])) === sql.includes(' <= '))
            .sort((a, b) => sql.includes('ORDER BY m.wa_timestamp ASC')
              ? a.wa_timestamp.localeCompare(b.wa_timestamp) : b.wa_timestamp.localeCompare(a.wa_timestamp));
        } else {
          if (/m\.id::text=\$3 OR m\.wa_message_id=\$3/.test(sql)) rows = rows.filter(row => row.id === args[2] || row.wa_message_id === args[2]);
          rows.sort((a, b) => b.wa_timestamp.localeCompare(a.wa_timestamp));
        }
        return { rows: rows
          .map(row => ({ ...row, waMessageId: row.wa_message_id, text: row.content, type: row.message_type, fromMe: row.direction === 'OUTBOUND', timestamp: row.wa_timestamp })) };
      }
      if (/FROM whatsapp_message_reactions/.test(sql)) return { rows: [] };
      if (/FROM messages m/.test(sql) && /m\.id,/.test(sql)) return { rows: (Array.isArray(args[1]) ? args[1] : [args[1]]).flatMap(id => messages[id] || []) };
      if (/FROM attachments/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

async function fixture(t, { fetchImpl, env = {}, db } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'whatsapp-feature-test-'));
  const calls = [];
  const database = db || fixtureDatabase(calls);
  const runtimeEnv = {
    DATA_DIR: dir,
    UI_AUTH_USERNAME: 'operator',
    UI_AUTH_PASSWORD: 'password',
    APP_PUBLIC_URL: 'https://wa.example',
    APP_ENABLE_SENDING: 'true',
    PERSONAL_SECRET: 'personal-secret',
    SECONDARY_SECRET: 'secondary-secret',
    MEDIA_ALLOWED_ORIGINS: 'https://media.example',
    ...env,
  };
  const app = await createApp({
    env: runtimeEnv,
    db: database,
    registry: [
      { channel: 'whatsapp', accountId: 'personal', secretEnv: 'PERSONAL_SECRET', connectorUrl: 'http://personal-connector' },
      { channel: 'whatsapp', accountId: 'secondary', secretEnv: 'SECONDARY_SECRET', connectorUrl: 'http://secondary-connector' },
    ],
    fetchImpl: fetchImpl || (async () => Response.json({ ok: true })),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, body, headers = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: auth, ...(body === undefined ? {} : { origin: runtimeEnv.APP_PUBLIC_URL, 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, request, calls, database };
}

test('feature mutations enforce Origin and account/chat ownership before provider calls', async t => {
  const upstream = [];
  const { request, calls } = await fixture(t, { fetchImpl: async (url, options) => { upstream.push({ url, options }); return Response.json({ ok: true }); } });
  const body = { account: 'personal', chat: 'personal-chat', action: 'read' };
  assert.equal((await request('/api/chat-actions', body, { origin: 'https://evil.example' })).status, 403);
  assert.equal(upstream.length, 0);
  assert.equal((await request('/api/chat-actions', { ...body, account: 'missing' })).status, 404);
  assert.equal((await request('/api/chat-actions', { ...body, chat: 'secondary-chat' })).status, 404);
  assert.equal(calls.some(call => call.args.includes('secondary-chat')), true);
  assert.equal(upstream.length, 0);
});

test('normal chat list excludes archived rows and archived query exposes them', async t => {
  const { request, database } = await fixture(t);
  database.conversations['personal-chat'].avatar_url = 'https://private.example/avatar?token=secret';
  const normal = await request('/api/chats?account=personal');
  assert.equal(normal.status, 200);
  const normalBody = await normal.json();
  assert.deepEqual(normalBody.chats.map(chat => chat.id), ['personal-chat']);
  assert.match(normalBody.chats[0].avatarUrl, /^\/api\/chats\/personal-chat\/avatar\?account=personal$/);
  assert.doesNotMatch(JSON.stringify(normalBody), /private\.example|secret/);
  const archived = await request('/api/chats?account=personal&archived=true');
  assert.deepEqual((await archived.json()).chats.map(chat => chat.id), ['personal-archived']);
});

test('linked PN messages remain in the canonical LID chat and around lookup is account scoped', async t => {
  const outbound = [];
  const { request, database, calls } = await fixture(t, { fetchImpl: async (url, options) => {
    outbound.push({ url, body: JSON.parse(options.body || '{}') });
    return Response.json({ messageId: 'sent' });
  } });
  const lid = 'personal:777@lid';
  const pn = 'personal:34600123456@c.us';
  database.conversations[lid] = { id: lid, account: 'personal', name: 'Daniel', wa_chat_id: 'personal:34600123456@s.whatsapp.net', is_group: false };
  database.conversations[pn] = { id: pn, account: 'personal', name: '+34600123456', wa_chat_id: null, is_group: false };
  database.conversations['secondary:34600123456@c.us'] = { id: 'secondary:34600123456@c.us', account: 'secondary', name: 'Private', wa_chat_id: null, is_group: false };
  database.messages[lid] = [{ id: '33333333-3333-3333-3333-333333333333', wa_message_id: 'lid-old', conversation_id: lid, content: 'Old', direction: 'INBOUND', message_type: 'TEXT', wa_timestamp: '2026-09-23T07:00:00.000Z' }];
  database.messages[pn] = [{ id: '44444444-4444-4444-4444-444444444444', wa_message_id: 'pn-new', conversation_id: pn, content: 'New', direction: 'OUTBOUND', message_type: 'TEXT', wa_timestamp: '2026-09-23T08:00:00.000Z' }];
  const history = await request(`/api/messages?account=personal&chat=${encodeURIComponent(lid)}`);
  assert.equal(history.status, 200);
  assert.deepEqual((await history.json()).messages.map(row => row.id), database.messages[lid].concat(database.messages[pn]).map(row => row.id));
  const around = await request(`/api/messages/around?account=personal&chat=${encodeURIComponent(lid)}&messageId=pn-new`);
  assert.equal(around.status, 200);
  assert.deepEqual((await around.json()).messages.map(row => row.id), database.messages[lid].concat(database.messages[pn]).map(row => row.id));
  assert.equal((await request(`/api/messages/around?account=secondary&chat=${encodeURIComponent(lid)}&messageId=pn-new`)).status, 404);
  assert.equal((await request(`/api/messages/around?account=personal&chat=personal-chat&messageId=pn-new`)).status, 404);
  const token = '55555555-5555-4555-8555-555555555555';
  assert.equal((await request('/api/send', { account: 'personal', chat: pn, text: 'Again', sendToken: token })).status, 200);
  assert.equal(outbound.at(-1).body.conversationId, '777@lid');
  assert.equal(outbound.at(-1).body.sendToken, token);
  assert.equal(calls.some(call => Array.isArray(call.args[1]) && call.args[1].includes(lid) && call.args[1].includes(pn)), true);
});

test('Hermes reuses Daniel session and scopes current-chat capability across PN and LID', async t => {
  const secret = 'test-hermes-tool-secret';
  const lid = 'personal:777@lid';
  const pn = 'personal:34600123456@c.us';
  const lifecycle = [];
  const turns = [];
  const db = fixtureDatabase([]);
  db.conversations[lid] = { id: lid, account: 'personal', name: 'Daniel', wa_chat_id: 'personal:34600123456@s.whatsapp.net', is_group: false };
  db.conversations[pn] = { id: pn, account: 'personal', name: '+34600123456', wa_chat_id: null, is_group: false };
  db.conversations['secondary:34600123456@c.us'] = { id: 'secondary:34600123456@c.us', account: 'secondary', name: 'Other account', wa_chat_id: null, is_group: false };
  const baseQuery = db.query;
  db.query = async (sql, args) => {
    if (/SELECT m\.content, m\.direction, m\.wa_timestamp/.test(sql)) {
      assert.equal(args[0], 'personal');
      assert.deepEqual(args[1], [lid, pn]);
      return { rows: [{ content: 'LID history', direction: 'INBOUND' }, { content: 'PN history', direction: 'INBOUND' }] };
    }
    return baseQuery(sql, args);
  };
  const { app, request } = await fixture(t, { db, env: {
    HERMES_DEFAULT_MODEL: 'model-a', HERMES_API_URL: 'http://hermes:8642',
    HERMES_API_KEY: 'agent-secret', HERMES_CHAT_TOOL_SECRET: secret,
    HERMES_CHAT_TOOL_INTERNAL_URL: 'http://mcp-internal',
  }, fetchImpl: async (url, options) => {
    if (/\/api\/sessions\/[^/]+\/model$/.test(url)) {
      const {model, provider = ''} = JSON.parse(options.body);
      return Response.json({object: 'hermes.session.model_lock', runtime: {model, provider}});
    }
    if (url.startsWith('http://mcp-internal/')) {
      lifecycle.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
      return Response.json({ ok: true });
    }
    turns.push({ headers: options.headers, body: JSON.parse(options.body) });
    return Response.json({ choices: [{ message: { content: 'Daniel answer' } }] }, { headers: { 'x-hermes-session-id': 'hermes-daniel' } });
  } });
  const legacyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await app.sessions.save({ id: legacyId, account: 'personal', chat: pn, global: false, title: 'Earlier Daniel chat', messages: [
    { role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' },
  ] });
  const first = await request('/api/ai/chat', { account: 'personal', chat: pn, message: 'First' });
  assert.equal(first.status, 200);
  const firstId = (await first.json()).sessionId;
  assert.equal(firstId, legacyId);
  const second = await request('/api/ai/chat', { account: 'personal', chat: lid, message: 'Second', sessionId: firstId });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).sessionId, firstId);
  assert.equal((await (await request(`/api/ai/session?account=personal&chat=${encodeURIComponent(pn)}`)).json()).sessionId, firstId);
  assert.equal((await (await request(`/api/ai/session?account=personal&chat=${encodeURIComponent(lid)}`)).json()).messages.length, 6);
  assert.equal((await request(`/api/ai/session?account=secondary&chat=${encodeURIComponent('secondary:34600123456@c.us')}&id=${firstId}`)).status, 404);
  assert.equal(turns[1].headers['x-hermes-session-id'], 'hermes-daniel');
  for (const turn of turns) {
    const system = turn.body.messages[0].content;
    const token = system.match(/Scoped WhatsApp tool capability for this turn: ([\w.-]+)/)?.[1];
    assert.equal(JSON.parse(Buffer.from(token.split('.')[0], 'base64url')).chat, lid);
    assert.doesNotMatch(system, /LID history|PN history/);
    assert.match(turn.body.messages.at(-2).content, /LID history/);
    assert.match(turn.body.messages.at(-2).content, /PN history/);
  }
  assert.deepEqual(lifecycle.map(item => item.body.chat), [lid, lid, lid, lid]);
});

test('sendToken validation rejects malformed values before delivery', async t => {
  const outbound = [];
  const { request } = await fixture(t, { fetchImpl: async (url, options) => { outbound.push({ url, options }); return Response.json({ messageId: 'sent' }); } });
  assert.equal((await request('/api/send', { account: 'personal', chat: 'personal-chat', text: 'Hello', sendToken: 'bad' })).status, 400);
  assert.equal(outbound.length, 0);
});

test('search cursor pages tied timestamps without duplicates and stays bound to filters', async t => {
  const calls = [];
  const db = fixtureDatabase(calls);
  const originalQuery = db.query;
  const stored = Array.from({ length: 121 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    wa_message_id: `wa-${index}`,
    conversation_id: 'personal-chat',
    content: `needle ${index}`,
    direction: 'INBOUND',
    message_type: 'TEXT',
    wa_timestamp: new Date(Date.UTC(2026, 8, 23, 8, Math.floor(index / 40))).toISOString()
      .replace('.000Z', `.${String(index % 7).padStart(6, '0')}Z`),
  }));
  db.query = async (sql, args) => {
    if (!/SELECT m\.id,m\.wa_message_id,m\.conversation_id/.test(sql)) return originalQuery(sql, args);
    let rows = stored.filter(row => row.content.includes(String(args[1]).slice(1, -1)));
    if (Array.isArray(args[2])) rows = rows.filter(row => args[2].includes(row.conversation_id));
    if (/\(m\.wa_timestamp, m\.id::text\) < /.test(sql)) {
      const timestamp = args.at(-3);
      const id = args.at(-2);
      rows = rows.filter(row => row.wa_timestamp < timestamp || (row.wa_timestamp === timestamp && row.id < id));
    }
    rows.sort((a, b) => b.wa_timestamp.localeCompare(a.wa_timestamp) || b.id.localeCompare(a.id));
    return { rows: rows.slice(0, args.at(-1)).map(row => ({ ...row, cursor_timestamp: row.wa_timestamp, chat_id: row.conversation_id, chat_name: 'Personal' })) };
  };
  const { request } = await fixture(t, { db });
  const base = '/api/search?account=personal&chat=personal-chat&scope=chat&q=needle';
  const seen = [];
  let cursor = null;
  do {
    const response = await request(base + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
    assert.equal(response.status, 200);
    const page = await response.json();
    seen.push(...page.results.map(row => row.id));
    cursor = page.nextCursor;
    if (seen.length === 50) {
      assert.equal((await request(`/api/search?account=personal&chat=personal-chat&scope=chat&q=other&cursor=${encodeURIComponent(cursor)}`)).status, 400);
      assert.equal((await request(`/api/search?account=personal&scope=all&q=needle&cursor=${encodeURIComponent(cursor)}`)).status, 400);
    }
  } while (cursor);
  assert.equal(seen.length, 121);
  assert.equal(new Set(seen).size, 121);
  assert.equal(seen[0], 'wa-120');
  assert.equal(seen.at(-1), 'wa-0');
});

test('read clears the database badge only after provider confirmation', async t => {
  const order = [];
  const successful = await fixture(t, { fetchImpl: async (url) => { order.push(`provider:${url}`); return Response.json({ markedAsRead: true }); } });
  const response = await successful.request('/api/chats/personal-chat/read', { account: 'personal' });
  assert.equal(response.status, 200);
  const update = successful.calls.find(call => /UPDATE conversations SET unread_count/.test(call.sql));
  assert.ok(update);
  assert.equal(order.length, 1);

  const failed = await fixture(t, { fetchImpl: async () => { order.push('failed-provider'); return Response.json({ error: 'unsupported' }, { status: 500 }); } });
  const failedResponse = await failed.request('/api/chats/personal-chat/read', { account: 'personal' });
  assert.equal(failedResponse.status, 502);
  assert.equal(failed.calls.some(call => /UPDATE conversations SET unread_count/.test(call.sql)), false);
});

test('read, unread and archive update both linked rows after one canonical provider action', async t => {
  const provider = [];
  const { request, database, calls } = await fixture(t, { fetchImpl: async (url, options) => {
    provider.push({ url, body: JSON.parse(options.body || '{}') });
    return Response.json({ confirmed: true });
  } });
  const lid = 'personal:777@lid';
  const pn = 'personal:34600123456@c.us';
  const pnVariant = 'personal:34600123456@s.whatsapp.net';
  database.conversations[lid] = { id: lid, account: 'personal', wa_chat_id: 'personal:34600123456@s.whatsapp.net', is_group: false, unread: 2, archived: false };
  database.conversations[pn] = { id: pn, account: 'personal', wa_chat_id: null, is_group: false, unread: 3, archived: false };
  database.conversations[pnVariant] = { id: pnVariant, account: 'personal', wa_chat_id: null, is_group: false, unread: 4, archived: true };
  database.conversations['secondary:34600123456@c.us'] = { id: 'secondary:34600123456@c.us', account: 'secondary', unread: 9, archived: false };
  const action = value => request('/api/chat-actions', { account: 'personal', chat: pn, action: value });
  assert.equal((await action('read')).status, 200);
  assert.deepEqual([database.conversations[lid].unread, database.conversations[pn].unread, database.conversations[pnVariant].unread], [0, 0, 0]);
  assert.equal((await action('unread')).status, 200);
  assert.deepEqual([database.conversations[lid].unread, database.conversations[pn].unread, database.conversations[pnVariant].unread], [1, 0, 0]);
  assert.equal((await action('archive')).status, 200);
  assert.deepEqual([database.conversations[lid].archived, database.conversations[pn].archived, database.conversations[pnVariant].archived], [true, true, true]);
  assert.equal((await action('unarchive')).status, 200);
  assert.deepEqual([database.conversations[lid].archived, database.conversations[pn].archived, database.conversations[pnVariant].archived], [false, false, false]);
  assert.equal(database.conversations['secondary:34600123456@c.us'].unread, 9);
  assert.equal(provider.length, 4);
  assert.ok(provider.every(item => item.url.includes('/chats/777%40lid/modify')));
  assert.ok(calls.filter(call => /UPDATE conversations SET (unread_count|archived)/.test(call.sql))
    .every(call => call.args[0] === 'personal' && call.args[1].includes(lid) && call.args[1].includes(pn) && call.args[1].includes(pnVariant)));
});

test('reaction operation accepts an acknowledgement without a messageId', async t => {
  let outbound;
  const { request } = await fixture(t, { fetchImpl: async (url, options) => { outbound = { url, options }; return Response.json({ reacted: true, emoji: '👍' }); } });
  const response = await request('/api/messages/react', { account: 'personal', chat: 'personal-chat', messageId: '11111111-1111-1111-1111-111111111111', emoji: '👍' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).confirmed, true);
  assert.match(outbound.url, /\/api\/v1\/messages\/react$/);
  assert.equal(JSON.parse(outbound.options.body).messageId, 'wa-personal-1');
});

test('message actions return a controlled error when a historical row has no provider ID', async t => {
  let upstreamCalls = 0;
  const { request, database } = await fixture(t, { fetchImpl: async () => { upstreamCalls += 1; return Response.json({ ok: true }); } });
  database.conversations['personal-no-provider-id'] = {
    id: 'personal-no-provider-id', account: 'personal', name: 'Legacy', wa_chat_id: 'personal-no-provider-id',
    is_group: false, archived: false, unread: 0, avatar_url: null,
  };
  database.messages['personal-no-provider-id'] = [{
    id: '33333333-3333-3333-3333-333333333333', wa_message_id: null, conversation_id: 'personal-no-provider-id',
    content: 'Legacy message', direction: 'INBOUND', message_type: 'TEXT', is_deleted: false, wa_timestamp: '2026-09-23T08:00:00.000Z',
  }];
  const actions = [
    ['/api/messages/react', { emoji: '👍' }],
    ['/api/messages/reply', { text: 'Reply' }],
    ['/api/messages/forward', { targetChat: 'personal-chat' }],
    ['/api/messages/edit', { text: 'Edited' }],
    ['/api/messages/delete', { scope: 'me' }],
  ];
  for (const [path, payload] of actions) {
    const response = await request(path, { account: 'personal', chat: 'personal-no-provider-id', messageId: '33333333-3333-3333-3333-333333333333', ...payload });
    assert.equal(response.status, 409, path);
    assert.equal((await response.json()).code, 'MESSAGE_ID_UNAVAILABLE', path);
  }
  assert.equal(upstreamCalls, 0);
});

test('link gallery items expose their first safe-looking URL', async t => {
  const { request, database } = await fixture(t);
  database.messages['personal-chat'].push({
    id: '44444444-4444-4444-4444-444444444444', wa_message_id: 'wa-personal-link', conversation_id: 'personal-chat',
    content: 'Read https://example.test/article.', direction: 'INBOUND', message_type: 'TEXT', is_deleted: false, wa_timestamp: '2026-09-23T08:02:00.000Z',
  });
  const response = await request('/api/chats/media?account=personal&chat=personal-chat&kind=links');
  assert.equal(response.status, 200);
  const item = (await response.json()).items.find(entry => entry.messageId === 'wa-personal-link');
  assert.equal(item.url, 'https://example.test/article');
  assert.equal(item.name, 'https://example.test/article');
});

test('local starred state is durable and account scoped', async t => {
  const { request } = await fixture(t);
  const star = await request('/api/chat-actions', { account: 'personal', chat: 'personal-chat', action: 'starred', messageId: '11111111-1111-1111-1111-111111111111' });
  assert.equal(star.status, 200);
  const personal = await request('/api/favorites?account=personal');
  assert.deepEqual((await personal.json()).starred, ['personal-chat:wa-personal-1']);
  const secondary = await request('/api/favorites?account=secondary');
  assert.deepEqual((await secondary.json()).starred, []);
});

test('starred pages return real scoped messages with stable UUIDs', async t => {
  const { request, database } = await fixture(t);
  database.messages['personal-chat'].push({
    id: '44444444-4444-4444-4444-444444444444', wa_message_id: 'wa-personal-2',
    conversation_id: 'personal-chat', content: 'second', direction: 'OUTBOUND', message_type: 'TEXT',
    wa_timestamp: '2026-09-23T08:01:00.000Z',
  });
  for (const messageId of ['11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444']) {
    assert.equal((await request('/api/chat-actions', { account: 'personal', chat: 'personal-chat', action: 'starred', messageId })).status, 200);
  }
  const first = await (await request('/api/favorites/starred?account=personal&limit=1')).json();
  assert.equal(first.items[0].id, '11111111-1111-1111-1111-111111111111');
  assert.equal(first.items[0].chatId, 'personal-chat');
  assert.equal(first.nextCursor, '1');
  const second = await (await request(`/api/favorites/starred?account=personal&limit=1&before=${first.nextCursor}`)).json();
  assert.equal(second.items[0].text, 'second');
  assert.equal(second.nextCursor, null);
  assert.deepEqual((await (await request('/api/favorites/starred?account=secondary')).json()).items, []);
});

test('new chat uses provider start without creating a contact or sending a message', async t => {
  const upstream = [];
  const { request } = await fixture(t, { fetchImpl: async (url, options) => {
    upstream.push({ url, body: JSON.parse(options.body) });
    return Response.json({ ok: true, chat: { id: 'personal:123@s.whatsapp.net', name: '+123456789', phone: '+123456789' } });
  } });
  const response = await request('/api/chats/new', { account: 'personal', phone: '+123456789' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).chat.id, 'personal:123@s.whatsapp.net');
  assert.equal(upstream.length, 1);
  assert.match(upstream[0].url, /\/api\/v1\/chats\/start$/);
  assert.deepEqual(upstream[0].body, { phone: '+123456789' });
});

test('composed reply resolves its provider ID only within the selected account and chat', async t => {
  const upstream = [];
  const { request } = await fixture(t, { fetchImpl: async (url, options) => {
    upstream.push({ url, body: JSON.parse(options.body) });
    return Response.json({ messageId: 'sent-1' });
  } });
  const denied = await request('/api/messages/compose', {
    account: 'personal', chat: 'personal-chat', kind: 'text', text: 'reply',
    replyTo: '22222222-2222-2222-2222-222222222222',
  });
  assert.equal(denied.status, 404);
  assert.equal(upstream.length, 0);
  const allowed = await request('/api/messages/compose', {
    account: 'personal', chat: 'personal-chat', kind: 'text', text: 'reply',
    replyTo: '11111111-1111-1111-1111-111111111111',
  });
  assert.equal(allowed.status, 200);
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].body.replyToMessageId, 'wa-personal-1');
  assert.equal(upstream[0].body.conversationId, 'personal-chat');
});

test('delete for me uses its own provider route after scoped message lookup', async t => {
  const upstream = [];
  const { request } = await fixture(t, { fetchImpl: async (url, options) => {
    upstream.push({ url, method: options.method });
    return Response.json({ ok: true, deletedForMe: true });
  } });
  const response = await request('/api/messages/delete', { account: 'personal', chat: 'personal-chat', messageId: '11111111-1111-1111-1111-111111111111', scope: 'me' });
  assert.equal(response.status, 200);
  assert.match(upstream[0].url, /\/api\/v1\/messages\/personal-chat\/wa-personal-1\/for-me$/);
  assert.equal(upstream[0].method, 'DELETE');
});

test('presence remains unknown when provider does not expose a route', async t => {
  const { request } = await fixture(t, { fetchImpl: async () => Response.json({ error: 'not found' }, { status: 404 }) });
  const response = await request('/api/presence?account=personal&chat=personal-chat');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.lastSeen, null);
  assert.equal(body.state, 'unknown');
});

test('avatar proxy enforces its size cap for chunked storage responses', async t => {
  const calls = [];
  const db = fixtureDatabase(calls);
  db.conversations['personal-chat'].avatar_url = 'https://media.example/chunked-avatar';
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(3 * 1024 * 1024));
      controller.enqueue(new Uint8Array(2 * 1024 * 1024));
      controller.close();
    },
  });
  const { request } = await fixture(t, { db, fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'image/jpeg' } }) });
  const response = await request('/api/chats/personal-chat/avatar?account=personal');
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'AVATAR_TOO_LARGE');
});

test('expired stored avatar falls back to current provider photo', async t => {
  const calls = [];
  const db = fixtureDatabase(calls);
  db.conversations['personal-chat'].avatar_url = 'https://media.example/expired-avatar';
  const upstream = [];
  const { request } = await fixture(t, { db, fetchImpl: async url => {
    upstream.push(url);
    if (url.startsWith('https://media.example/')) return Response.json({ error: 'expired' }, { status: 404 });
    return Response.json({ data: Buffer.from('fresh-photo').toString('base64'), contentType: 'image/jpeg' });
  } });
  const response = await request('/api/chats/personal-chat/avatar?account=personal');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'fresh-photo');
  assert.equal(upstream.length, 2);
  assert.match(upstream[1], /\/api\/v1\/chats\/personal-chat\/photo$/);
});

test('message metadata projection allows typed fields but excludes provider secrets', () => {
  const privateFields = { raw: 'secret', mediaKey: 'secret', messageSecret: 'secret' };
  assert.deepEqual(publicMessageMetadata({ kind: 'poll', options: ['A', 'B'], selectableCount: 1, ...privateFields }),
    { kind: 'poll', options: ['A', 'B'], selectableCount: 1 });
  assert.deepEqual(publicMessageMetadata({ kind: 'contact', contacts: [{ displayName: 'Name', phone: '+123', vcard: 'secret', ...privateFields }] }),
    { kind: 'contact', contacts: [{ displayName: 'Name', phone: '+123', email: null, organization: null }] });
  assert.doesNotMatch(JSON.stringify(publicMessageMetadata({ kind: 'event', description: 'Meet', location: { name: 'Place', ...privateFields }, ...privateFields })), /secret/);
  assert.deepEqual(publicPollResults({ available: true, availability: 'local_partial', totalVoters: 2,
    options: [{ name: 'Yes', count: 2, selectedByMe: true, voters: ['private-jid'], ...privateFields }], ...privateFields }),
    { available: true, availability: 'local_partial', totalVoters: 2,
      options: [{ name: 'Yes', count: 2, selectedByMe: true }] });
});

test('poll results and votes stay within the selected account and poll', async t => {
  const calls = [];
  const db = fixtureDatabase(calls);
  db.messages['personal-chat'].push({
    id: '33333333-3333-3333-3333-333333333333', wa_message_id: 'personal:poll-1',
    conversation_id: 'personal-chat', content: 'Taxi hoy', direction: 'INBOUND', message_type: 'POLL',
    metadata: { kind: 'poll', options: ['20.30h', '21.30h'], selectableCount: 1 },
    wa_timestamp: '2026-09-23T09:00:00.000Z',
  });
  const upstream = [];
  const { request } = await fixture(t, { db, fetchImpl: async (url, options) => {
    upstream.push({ url, body: JSON.parse(options.body || '{}') });
    if (url.endsWith('/messages/poll/results')) return Response.json({ ok: true, polls: [{
      pollMessageId: 'poll-1', available: true, availability: 'local_partial', totalVoters: 2,
      options: [{ name: '20.30h', count: 2, selectedByMe: false, voters: ['private-jid'] }],
    }] });
    if (url.endsWith('/messages/poll/vote')) return Response.json({ ok: true, messageId: 'vote-1' });
    return Response.json({ ok: true });
  } });
  const history = await request('/api/messages?account=personal&chat=personal-chat');
  assert.equal(history.status, 200);
  const poll = (await history.json()).messages.find(message => message.type === 'POLL');
  assert.deepEqual(poll.metadata.results.options, [{ name: '20.30h', count: 2, selectedByMe: false }]);
  assert.equal(upstream.find(call => call.url.endsWith('/messages/poll/results')).body.conversationId, 'personal-chat');
  assert.deepEqual(upstream.find(call => call.url.endsWith('/messages/poll/results')).body.pollMessageIds, ['poll-1']);
  assert.equal((await request('/api/messages/poll/vote', { account: 'secondary', chat: 'personal-chat', messageId: poll.id, options: ['20.30h'] })).status, 404);
  assert.equal((await request('/api/messages/poll/vote', { account: 'personal', chat: 'personal-chat', messageId: poll.id, options: [] })).status, 400);
  assert.equal((await request('/api/messages/poll/vote', { account: 'personal', chat: 'personal-chat', messageId: poll.id, options: ['20.30h'] })).status, 200);
  assert.deepEqual(upstream.find(call => call.url.endsWith('/messages/poll/vote')).body,
    { conversationId: 'personal-chat', pollMessageId: 'poll-1', options: ['20.30h'] });
});

test('messages endpoint projects reply, edit, reactions and safe content metadata', async t => {
  const calls = [];
  const db = fixtureDatabase(calls);
  const originalQuery = db.query;
  db.query = async (sql, args) => {
    calls.push({ sql, args });
    if (/FROM whatsapp_message_reactions/.test(sql)) return { rows: [{
      target_wa_message_id: 'wa-personal-1', reactor_jid: 'personal:member@s.whatsapp.net', emoji: '👍',
    }] };
    if (/FROM messages m/.test(sql) && /m\.metadata/.test(sql)) return { rows: [{
      id: '11111111-1111-1111-1111-111111111111', waMessageId: 'wa-personal-1', text: 'Poll',
      fromMe: false, timestamp: '2026-09-23T08:00:00.000Z', type: 'POLL',
      metadata: { kind: 'poll', options: ['Yes'], selectableCount: 1, mediaKey: 'private', raw: { messageSecret: 'private' } },
      replyToMessageId: 'personal:previous', isEdited: true,
      replyType: 'IMAGE', replyText: 'A photo https://private.example/token', replySenderName: 'Saved member', replyAvailable: true,
    }] };
    return originalQuery(sql, args);
  };
  const { request } = await fixture(t, { db });
  const response = await request('/api/messages?account=personal&chat=personal-chat');
  assert.equal(response.status, 200);
  const message = (await response.json()).messages[0];
  assert.equal(message.replyToMessageId, 'personal:previous');
  assert.deepEqual(message.replyPreview, { type: 'IMAGE', text: 'A photo https://private.example/token', senderName: 'Saved member', available: true });
  assert.equal(message.isEdited, true);
  assert.deepEqual(message.reactions, [{ emoji: '👍', reactorId: 'personal:member@s.whatsapp.net' }]);
  assert.deepEqual(message.metadata, { kind: 'poll', options: ['Yes'], selectableCount: 1 });
  assert.doesNotMatch(JSON.stringify(message.metadata), /private|mediaKey|messageSecret/);
  const messageQuery = calls.find(call => /reply\.message_type AS "replyType"/.test(call.sql));
  assert.match(messageQuery.sql, /target\.account = m\.account/);
  assert.match(messageQuery.sql, /target\.conversation_id = ANY\(\$2::text\[\]\)/);
  assert.match(messageQuery.sql, /m\.account \|\| ':' \|\| m\.reply_to_message_id/);
  assert.match(messageQuery.sql, /regexp_replace\(m\.reply_to_message_id, '\^\[\^:\]\+:', ''\)/);
  assert.match(messageQuery.sql, /m\.message_type NOT IN \('SENDERKEYDISTRIBUTIONMESSAGE', 'MESSAGECONTEXTINFO', 'POLL_VOTE', 'POLL_RESULT', 'REACTION'\)/);
});

test('missing quoted message has an explicit unavailable preview on paginated reads', async t => {
  const calls = [];
  const db = fixtureDatabase(calls);
  const originalQuery = db.query;
  db.query = async (sql, args) => {
    calls.push({ sql, args });
    return /reply\.message_type AS "replyType"/.test(sql)
      ? { rows: [{
      id: '11111111-1111-1111-1111-111111111111', waMessageId: 'wa-personal-1', text: 'Answer',
      fromMe: false, timestamp: '2026-09-23T08:00:00.000Z', type: 'TEXT',
      replyToMessageId: 'missing', replyAvailable: false,
      }] }
      : originalQuery(sql, args);
  };
  const { request } = await fixture(t, { db });
  const response = await request('/api/messages?account=personal&chat=personal-chat&before=2026-09-24T00%3A00%3A00.000Z&limit=1');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).messages[0].replyPreview,
    { type: null, text: '', senderName: null, available: false });
  const sql = calls.find(call => /reply\.message_type AS "replyType"/.test(call.sql)).sql;
  assert.match(sql, /LEFT JOIN LATERAL/);
  assert.match(sql, /m\.message_type NOT IN \('SENDERKEYDISTRIBUTIONMESSAGE', 'MESSAGECONTEXTINFO', 'POLL_VOTE', 'POLL_RESULT', 'REACTION'\)/);
});

test('group details retain provider permissions and account-scoped saved member names', async t => {
  const calls = [];
  const db = fixtureDatabase(calls);
  const groupId = 'personal:group@g.us';
  db.conversations[groupId] = { id: groupId, account: 'personal', name: 'Group', wa_chat_id: 'personal:wrong@s.whatsapp.net', is_group: true, archived: false, unread: 0 };
  const originalQuery = db.query;
  db.query = async (sql, args) => /SELECT id, wa_user_id, name, push_name FROM participants/.test(sql)
    ? { rows: [{ id: 'personal:member@s.whatsapp.net', wa_user_id: 'personal:member@s.whatsapp.net', name: 'Saved member', push_name: null }] }
    : originalQuery(sql, args);
  const upstream = [];
  const { request } = await fixture(t, { db, fetchImpl: async url => {
    upstream.push(url);
    return Response.json(url.endsWith('/info')
      ? { capabilities: { manageMembers: true, editInfo: false }, participants: [{ id: 'member@s.whatsapp.net', name: 'member@s.whatsapp.net' }] }
      : url.endsWith('/photo') ? { data: Buffer.from('group-photo').toString('base64') }
        : { participants: [{ id: 'member@s.whatsapp.net', name: 'member@s.whatsapp.net', isAdmin: true }] });
  } });
  const response = await request(`/api/chat-details?account=personal&chat=${encodeURIComponent(groupId)}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.capabilities, { manageMembers: true, editInfo: false });
  assert.equal(body.participants[0].name, 'Saved member');
  assert.equal(body.participants[0].isAdmin, true);
  assert.deepEqual(body.participants[0].presence, { state: 'unknown', lastSeen: null, available: false });
  assert.equal((await request(`/api/chats/${encodeURIComponent(groupId)}/avatar?account=personal`)).status, 200);
  assert.equal((await request('/api/groups/action', { account: 'personal', chat: groupId, action: 'subject', value: 'New' })).status, 200);
  assert.equal((await request('/api/chats?account=personal')).status, 200);
  assert.ok(upstream.some(url => url.includes(encodeURIComponent(groupId)) && url.endsWith('/info')));
  assert.ok(upstream.some(url => url.includes(encodeURIComponent(groupId)) && url.endsWith('/photo')));
  assert.ok(upstream.every(url => !url.includes('wrong%40s.whatsapp.net')));
});

test('direct chats preserve their stored provider JID', async t => {
  const upstream = [];
  const db = fixtureDatabase([]);
  db.conversations['personal-chat'].wa_chat_id = 'personal:resolved@s.whatsapp.net';
  const { request } = await fixture(t, { db, fetchImpl: async url => {
    upstream.push(url);
    return Response.json({ state: 'unknown' });
  } });
  assert.equal((await request('/api/presence?account=personal&chat=personal-chat')).status, 200);
  assert.ok(upstream[0].includes('personal%3Aresolved%40s.whatsapp.net'));
});

test('sending from a LID conversation uses its canonical LID, including a namespaced account', async t => {
  const db = fixtureDatabase([]);
  db.conversations['12345@lid'] = { id: '12345@lid', account: 'personal', name: 'Contact', wa_chat_id: '34600@s.whatsapp.net', is_group: false };
  db.conversations['secondary:67890@lid'] = { id: 'secondary:67890@lid', account: 'secondary', name: 'Other', wa_chat_id: 'secondary:34700@s.whatsapp.net', is_group: false };
  const outbound = [];
  const { request } = await fixture(t, { db, fetchImpl: async (_url, options) => {
    outbound.push(JSON.parse(options.body));
    return Response.json({ messageId: 'confirmed' });
  } });
  assert.equal((await request('/api/send', { account: 'personal', chat: '12345@lid', text: 'hello' })).status, 200);
  assert.equal((await request('/api/send', { account: 'secondary', chat: 'secondary:67890@lid', text: 'hello' })).status, 200);
  assert.deepEqual(outbound.map(item => item.conversationId), ['12345@lid', '67890@lid']);
});

test('normal send routes group messages to the group JID and permits an empty new chat', async t => {
  const db = fixtureDatabase([]);
  const groupId = 'personal:group@g.us';
  const emptyId = 'personal:new@s.whatsapp.net';
  db.conversations[groupId] = { id: groupId, account: 'personal', wa_chat_id: 'personal:wrong@s.whatsapp.net', is_group: true, name: 'Group' };
  db.conversations[emptyId] = { id: emptyId, account: 'personal', wa_chat_id: emptyId, is_group: false, name: '+123456789' };
  const upstream = [];
  const { request } = await fixture(t, { db, fetchImpl: async (url, options) => {
    upstream.push({ url, body: JSON.parse(options.body) });
    return Response.json({ messageId: 'provider-confirmed' });
  } });
  assert.equal((await request('/api/send', { account: 'personal', chat: groupId, text: 'Group text' })).status, 200);
  assert.equal((await request('/api/send', { account: 'personal', chat: emptyId, text: 'First text' })).status, 200);
  assert.deepEqual(upstream.map(call => call.body.conversationId), [groupId, emptyId]);
  assert.ok(upstream.every(call => call.url.endsWith('/messages/send')));
});

test('AppState serializes concurrent account updates and recovers its queue after a write failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'whatsapp-state-test-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  let failWrite = true;
  const state = new AppState(dir, {
    writeFile: async (...args) => { if (failWrite) { failWrite = false; throw new Error('simulated write failure'); } return (await import('node:fs/promises')).writeFile(...args); },
  });
  await state.init();
  await assert.rejects(() => state.update('personal', current => { current.favorites.push('first'); return current; }), /simulated write failure/);
  await Promise.all([
    state.update('personal', current => { current.favorites.push('second'); return current; }),
    state.update('personal', current => { current.favorites.push('third'); return current; }),
  ]);
  assert.deepEqual(state.get('personal').favorites, ['second', 'third']);
});

test('AppState rejects corrupt JSON without replacing the existing file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'whatsapp-state-corrupt-test-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const file = join(dir, 'app-state.json');
  await writeFile(file, '{not-json', { mode: 0o600 });
  await assert.rejects(() => new AppState(dir).init(), /Invalid app state file/);
  assert.equal(await readFile(file, 'utf8'), '{not-json');
});
