#!/usr/bin/env node

/*
 * Browser QA for the approved WhatsApp feature inventory.
 *
 * The page is served from a loopback fixture server and every /api request is
 * fulfilled by Playwright. No connector, account, or live message is used.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  accounts,
  aiSessions,
  chats as fixtureChats,
  clone,
  contactInfo,
  gallery as fixtureGallery,
  groupInfo,
  messages as fixtureMessages,
  newChatResults,
} from './selected-features-fixtures.mjs';

const playwrightModule = process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs';
const { chromium } = await import(playwrightModule);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(process.env.UI_SOURCE_DIR || path.join(scriptDir, '..', 'public'));
const outputDir = path.resolve(process.env.UI_OUTPUT_DIR || '/data/output/socialmedia-whatsapp-selected-features');
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome';

const ACCOUNT_IDS = new Set(accounts.map(account => account.id));
const AVATAR_FIXTURE = path.join(scriptDir, 'selected-features-avatar.svg');
const GALLERY_FIXTURE = path.join(scriptDir, 'selected-features-gallery.svg');

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2',
  }[extension] || 'application/octet-stream';
}

async function readFixture(filePath) {
  return fs.readFile(filePath);
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url || '/', 'http://selected-features.local');
  const pathname = decodeURIComponent(requestUrl.pathname);
  let filePath;
  if (pathname === '/fixtures/selected-features-avatar.svg') filePath = AVATAR_FIXTURE;
  else if (pathname === '/fixtures/selected-features-gallery.svg') filePath = GALLERY_FIXTURE;
  else {
    const relative = pathname === '/' ? '/index.html' : pathname;
    filePath = path.resolve(sourceDir, `.${relative}`);
    if (filePath !== sourceDir && !filePath.startsWith(`${sourceDir}${path.sep}`)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Forbidden');
      return;
    }
  }
  try {
    const body = await readFixture(filePath);
    response.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

async function startStaticServer() {
  const server = createServer((request, response) => {
    serveStatic(request, response).catch(error => {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object' && address.port, 'fixture server did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function normalizeBody(request) {
  if (request.method() !== 'POST') return {};
  try { return request.postDataJSON() || {}; } catch { return {}; }
}

function messageFor(state, account, chat, messageId) {
  const message = (state.messages[chat] || []).find(item => String(item.id) === String(messageId));
  if (!message || message.account !== account) throw new Error('Message is not in the requested account or chat');
  return message;
}

function chatFor(state, account, chat) {
  const result = (state.chats[account] || []).find(item => String(item.id) === String(chat));
  if (!result) throw new Error('Chat is not in the requested account');
  return result;
}

function accountFrom(url, body) {
  return String(body.account || url.searchParams.get('account') || '');
}

function makeMockState() {
  return {
    chats: clone(fixtureChats),
    messages: clone(fixtureMessages),
    gallery: clone(fixtureGallery),
    privacy: new Map(),
    chatPrivacy: new Map(),
    lists: new Map(),
    starred: new Map(),
    log: [],
    unexpected: [],
    failNextPath: null,
    nextBetaChatsGate: null,
    nextActionGate: null,
    nextSearchGate: null,
    searchStarted: false,
    nextSearchPageGate: null,
    searchPageStarted: false,
    actionStarted: false,
    betaChatsStarted: false,
    dynamicMessageCounter: 0,
    nextChatCounter: 0,
    avatarFails: process.env.QA_AVATAR_404_ONLY === '1',
    directPresence: 'online',
    blockedContacts: new Map(),
    statusAuthors: { alpha: [], beta: [] },
  };
}

const REAL_SERVER_CONTRACT = [
  { key: 'chatInfo', method: 'GET', path: '/api/chat-details', request: 'account,chat query', response: ['contact', 'group', 'participants', 'presence'] },
  { key: 'contactBlock', method: 'GET', path: '/api/contact-block', request: 'account,chat query', response: ['blocked', 'confirmed'] },
  { key: 'chatMedia', method: 'GET', path: '/api/chats/media', request: 'account,chat,kind query', response: ['items', 'nextCursor'] },
  { key: 'search', method: 'GET', path: '/api/search', request: 'account,q,chat query', response: ['results'] },
  { key: 'chatRead', method: 'POST', path: '/api/chat-actions', request: 'account,chat,action=read', response: ['confirmed'] },
  { key: 'chatAction', method: 'POST', path: '/api/chat-actions', request: 'account,chat,action', response: ['confirmed'] },
  { key: 'contactBlockAction', method: 'POST', path: '/api/chat-actions', request: 'account,chat,action=block|unblock', response: ['blocked', 'confirmed'] },
  { key: 'messageReaction', method: 'POST', path: '/api/messages/react', request: 'account,chat,messageId,emoji', response: ['confirmed'] },
  { key: 'messageForward', method: 'POST', path: '/api/messages/forward', request: 'account,chat,messageId,targetChat', response: ['confirmed'] },
  { key: 'messageEdit', method: 'POST', path: '/api/messages/edit', request: 'account,chat,messageId,text', response: ['confirmed'] },
  { key: 'messageDelete', method: 'POST', path: '/api/messages/delete', request: 'account,chat,messageId,scope', response: ['confirmed'] },
  { key: 'messageStar', method: 'POST', path: '/api/chat-actions', request: 'account,chat,action=starred,messageId', response: ['source'] },
  { key: 'chatStart', method: 'POST', path: '/api/chats/new', request: 'account,phone,displayName', response: ['contact', 'confirmed'] },
  { key: 'contactCreate', method: 'POST', path: '/api/contacts', request: 'account,phone,displayName', response: ['contact', 'confirmed'] },
  { key: 'groupCreate', method: 'POST', path: '/api/groups', request: 'account,name,participants', response: ['confirmed'] },
  { key: 'groupMember', method: 'POST', path: '/api/groups/action', request: 'account,chat,action,participant', response: ['confirmed'] },
  { key: 'list', method: 'POST', path: '/api/lists', request: 'account,action=list,list,id', response: ['lists'] },
  { key: 'starred', method: 'GET', path: '/api/favorites', request: 'account query', response: ['starred'] },
  { key: 'share', method: 'POST', path: '/api/messages/compose', request: 'account,chat,kind,payload', response: ['confirmed'] },
  { key: 'chatPrivacy', method: 'POST', path: '/api/privacy', request: 'account,chat,disappearingSeconds', response: ['confirmed'] },
  { key: 'privacy', method: 'POST', path: '/api/privacy', request: 'account,profile,lastSeen,readReceipts', response: ['confirmed'] },
];

async function auditServerContract(report) {
  const source = await fs.readFile(path.join(scriptDir, '..', 'server.mjs'), 'utf8');
  report.serverContract = [];
  for (const contract of REAL_SERVER_CONTRACT) {
    const evidence = {
      key: contract.key,
      method: contract.method,
      path: contract.path,
      request: contract.request,
      response: contract.response,
      status: 'pass',
    };
    try {
      assert(source.includes(contract.path), `${contract.key}: ${contract.path} is absent from server.mjs`);
      for (const token of contract.response) assert(source.includes(token), `${contract.key}: response evidence ${token} is absent from server.mjs`);
    } catch (error) {
      evidence.status = 'fail';
      evidence.error = error.message;
      report.failures.push({ name: `server contract ${contract.key}`, error: error.message });
    }
    report.serverContract.push(evidence);
  }
  const groupInfo = report.serverContract.find(item => item.key === 'chatInfo');
  try {
    assert(source.includes('participants'), 'group info participants response is absent from server.mjs');
    assert(source.includes('capabilities'), 'group-management capabilities are absent from server.mjs response');
  } catch (error) {
    groupInfo.status = 'fail';
    groupInfo.error = error.message;
    report.failures.push({ name: 'server contract chatInfo capabilities', error: error.message });
  }
}

function logRequest(state, request, url, body) {
  const entry = {
    method: request.method(),
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    body: request.method() === 'POST' ? clone(body) : undefined,
  };
  state.log.push(entry);
  return entry;
}

function jsonResponse(route, value, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(value),
  });
}

function responseError(message, code = 'FIXTURE_ERROR') {
  return { error: message, code };
}

function accountScopedMessageItems(state, account, chat = '') {
  const allowedChats = new Set((state.chats[account] || []).map(item => String(item.id)));
  const chatIds = chat ? [String(chat)] : [...allowedChats];
  return chatIds.flatMap(chatId => (state.messages[chatId] || []).filter(item => item.account === account).map(item => ({ ...item, chat: chatId })));
}

async function fulfillApi(route, state) {
  const request = route.request();
  const url = new URL(request.url());
  const pathName = url.pathname;
  const body = normalizeBody(request);
  const account = accountFrom(url, body);
  const entry = logRequest(state, request, url, body);

  const accountRequired = !['/api/accounts', '/api/models'].includes(pathName);
  if (accountRequired && !ACCOUNT_IDS.has(account)) return jsonResponse(route, responseError('Account is not permitted', 'ACCOUNT_FORBIDDEN'), 403);
  if (state.failNextPath === pathName) {
    state.failNextPath = null;
    return jsonResponse(route, responseError('Intentional fixture operation failure'), 500);
  }

  if (pathName === '/api/accounts' && request.method() === 'GET') return jsonResponse(route, { accounts, sendingEnabled: true });
  if (pathName === '/api/novedades/status/authors' && request.method() === 'GET') return jsonResponse(route, { account, authors: clone(state.statusAuthors[account] || []) });
  if (pathName === '/api/models' && request.method() === 'GET') return jsonResponse(route, { models: [{ id: 'fixture-model' }], defaultModel: 'fixture-model' });

  if (pathName === '/api/chats' && request.method() === 'GET') {
    if (account === 'beta' && state.nextBetaChatsGate) {
      state.betaChatsStarted = true;
      const gate = state.nextBetaChatsGate;
      state.nextBetaChatsGate = null;
      await gate.promise;
    }
    const archived = url.searchParams.get('archived');
    const all = clone(state.chats[account] || []);
    const filtered = archived === 'only' ? all.filter(item => item.archived === true) : all.filter(item => item.archived !== true);
    const offset = Number(url.searchParams.get('cursor') || 0);
    const limit = Number(url.searchParams.get('limit') || 100);
    return jsonResponse(route, { account, chats: filtered.slice(offset, offset + limit), archived: archived === 'only', nextCursor: offset + limit < filtered.length ? String(offset + limit) : null });
  }

  if (pathName === '/api/messages' && request.method() === 'GET') {
    const chat = url.searchParams.get('chat') || '';
    try { chatFor(state, account, chat); } catch { return jsonResponse(route, responseError('Chat is not permitted', 'ACCOUNT_FORBIDDEN'), 403); }
    return jsonResponse(route, { account, chat, messages: clone(state.messages[chat] || []) });
  }
  if (pathName === '/api/messages/by-date' && request.method() === 'GET') {
    const chat = url.searchParams.get('chat');
    if (account !== 'alpha' || chat !== 'alpha-direct') return jsonResponse(route, responseError('Chat is not permitted', 'ACCOUNT_FORBIDDEN'), 403);
    state.dateStarted = true;
    if (state.nextDateGate) await state.nextDateGate.promise;
    const start = Date.parse(url.searchParams.get('start'));
    const end = Date.parse(url.searchParams.get('end'));
    const historicalMessage = Date.parse('2025-01-01T12:00:00Z');
    return jsonResponse(route, {account, chat, messageId: start <= historicalMessage && historicalMessage < end ? 'old-wa' : null});
  }
  if (pathName === '/api/messages/around' && request.method() === 'GET') {
    const chat = url.searchParams.get('chat');
    const messageId = url.searchParams.get('messageId');
    if (account !== 'alpha' || chat !== 'alpha-direct' || messageId !== 'old-wa') return jsonResponse(route, responseError('Message is not permitted', 'ACCOUNT_FORBIDDEN'), 403);
    return jsonResponse(route, {account, chat, targetMessageId: 'old-db', messages: [{id: 'old-db', waMessageId: 'old-wa', text: 'Mensaje antiguo fuera de los últimos 200', fromMe: false, timestamp: '2025-01-01T12:00:00.000Z'}]});
  }

  if (pathName === '/api/ai/sessions' && request.method() === 'GET') {
    const global = url.searchParams.get('global') === 'true';
    const chat = url.searchParams.get('chat') || '';
    const sessions = aiSessions.filter(item => item.account === account && (global || item.chat === chat));
    return jsonResponse(route, { account, sessions: clone(sessions) });
  }
  if (pathName === '/api/ai/session' && request.method() === 'GET') {
    return jsonResponse(route, { account, messages: [{ role: 'assistant', content: `${account} session fixture` }] });
  }

  if (pathName === '/api/chat-details' && request.method() === 'GET') {
    const chat = url.searchParams.get('chat') || '';
    try { chatFor(state, account, chat); } catch { return jsonResponse(route, responseError('Chat is not permitted', 'ACCOUNT_FORBIDDEN'), 403); }
    if (chat === 'alpha-group' && account === 'alpha') {
      const info = groupInfo[chat];
      return jsonResponse(route, {
        account,
        chat,
        name: info.name,
        isGroup: true,
        avatarUrl: '/api/chats/alpha-group/avatar?account=alpha',
        presence: { state: 'unknown', lastSeen: null, available: false },
        group: { name: info.name, description: info.description },
        participants: clone(info.participants),
        capabilities: { manageMembers: true },
      });
    }
    const info = contactInfo[chat] || { id: chat, name: state.chats[account].find(item => item.id === chat)?.name || chat, presence: 'unknown' };
    return jsonResponse(route, {
      account,
      chat,
      name: info.name,
      isGroup: false,
      avatarUrl: '/api/chats/alpha-direct/avatar?account=alpha',
      presence: { state: info.presence === 'online' ? 'online' : 'unknown', lastSeen: null, available: info.presence === 'online' },
      contact: { ...info, avatarUrl: '/api/contacts/alpha-direct/avatar?account=alpha' },
      capabilities: {},
    });
  }

  if (pathName === '/api/chats/media' && request.method() === 'GET') {
    const chat = url.searchParams.get('chat') || '';
    try { chatFor(state, account, chat); } catch { return jsonResponse(route, responseError('Chat is not permitted', 'ACCOUNT_FORBIDDEN'), 403); }
    const kind = url.searchParams.get('kind') || 'media';
    if (kind === 'gallery' || kind === 'media') return jsonResponse(route, { account, chat, items: clone(state.gallery[chat] || []) });
    if (kind === 'links') {
      const items = accountScopedMessageItems(state, account, chat).flatMap(message => {
        const matches = String(message.text || '').match(/https?:\/\/[^\s<]+/g) || [];
        return matches.map(urlValue => ({ url: urlValue, name: urlValue, messageId: message.id, timestamp: message.timestamp, kind: 'link' }));
      });
      return jsonResponse(route, { account, chat, items });
    }
    return jsonResponse(route, { account, chat, items: [] });
  }

  if (pathName === '/api/search' && request.method() === 'GET') {
    const query = (url.searchParams.get('q') || '').toLocaleLowerCase();
    if (query === 'mensaje antiguo') return jsonResponse(route, {account, results: [{chatId: 'alpha-direct', chatName: 'Ana Fixture', messageId: 'old-wa', text: 'Mensaje antiguo fuera de los últimos 200', timestamp: '2025-01-01T12:00:00.000Z'}]});
    if (query === 'paginado fixture') {
      const cursor = url.searchParams.get('cursor');
      if (cursor === 'page-2' && state.nextSearchPageGate) {
        state.searchPageStarted = true;
        await state.nextSearchPageGate.promise;
      }
      const item = cursor === 'page-2'
        ? { chatId: 'alpha-direct', chatName: 'Ana Fixture', messageId: 'old-wa', text: 'Resultado histórico página dos', timestamp: '2025-01-01T12:00:00.000Z' }
        : { chatId: 'alpha-direct', chatName: 'Ana Fixture', messageId: 'alpha-direct-outgoing', text: 'Resultado reciente página uno', timestamp: '2025-01-02T12:00:00.000Z' };
      return jsonResponse(route, { account, results: [item], nextCursor: cursor ? null : 'page-2' });
    }
    if (query === 'mensaje visible' && state.nextSearchGate) {
      state.searchStarted = true;
      await state.nextSearchGate.promise;
    }
    const scopeChat = url.searchParams.get('scope') === 'chat' ? url.searchParams.get('chat') || '' : '';
    const items = accountScopedMessageItems(state, account, scopeChat)
      .filter(item => String(item.text || item.content || '').toLocaleLowerCase().includes(query))
      .map(item => ({ ...item, chatId: item.chat, chatName: state.chats[account].find(chat => chat.id === item.chat)?.name || item.chat }));
    return jsonResponse(route, { account, results: items });
  }

  if (/^\/api\/contacts\/[^/]+\/avatar$/.test(pathName) && request.method() === 'GET') {
    const requested = pathName.split('/').at(-2);
    if (account !== 'alpha' || requested !== 'alpha-direct') return jsonResponse(route, responseError('Avatar is not permitted', 'ACCOUNT_FORBIDDEN'), 403);
    if (state.avatarFails) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Avatar unavailable' });
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: await readFixture(AVATAR_FIXTURE) });
  }
  if (/^\/api\/chats\/[^/]+\/avatar$/.test(pathName) && request.method() === 'GET') {
    return jsonResponse(route, responseError('Avatar is unavailable for this chat', 'AVATAR_UNAVAILABLE'), 404);
  }
  if (pathName === '/api/media/selected-features-gallery.svg' && request.method() === 'GET') {
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: await readFixture(GALLERY_FIXTURE) });
  }

  if (pathName === '/api/presence' && request.method() === 'GET') {
    const chat = url.searchParams.get('chat') || '';
    if (state.nextPresenceGate) {
      const gate = state.nextPresenceGate;
      state.nextPresenceGate = null;
      state.presenceStarted = true;
      await gate.promise;
    }
    return jsonResponse(route, { account, chat, state: chat === 'alpha-direct' ? state.directPresence : 'unknown', lastSeen: null, available: chat === 'alpha-direct' && state.directPresence !== 'unknown' });
  }
  if (pathName === '/api/contact-block' && request.method() === 'GET') {
    const chat = url.searchParams.get('chat') || '';
    return jsonResponse(route, {account, chat, blocked: state.blockedContacts.get(`${account}:${chat}`) === true, confirmed: true, source: 'provider'});
  }
  if (pathName === '/api/presence/subscribe' && request.method() === 'POST') {
    return jsonResponse(route, { account, chat: body.chat, subscribed: true, state: body.chat === 'alpha-direct' ? 'online' : 'unknown', lastSeen: null, available: body.chat === 'alpha-direct' });
  }

  if (pathName === '/api/notifications' && request.method() === 'GET') {
    const unread = (state.chats[account] || []).filter(item => !item.archived).reduce((sum, item) => sum + Number(item.unread || 0), 0);
    return jsonResponse(route, { account, permission: 'unknown', enabled: null, unread });
  }
  if (pathName === '/api/favorites' && request.method() === 'GET') return jsonResponse(route, { account, source: 'local', favorites: [], lists: [...(state.lists.get(account) || [])], starred: clone(state.starred.get(account) || []) });
  if (pathName === '/api/favorites/starred' && request.method() === 'GET') return jsonResponse(route, { account, items: clone(state.starred.get(account) || []), nextCursor: null });
  if (pathName === '/api/lists' && request.method() === 'GET') return jsonResponse(route, { account, lists: [...(state.lists.get(account) || [])] });
  if (pathName === '/api/starred' && request.method() === 'GET') return jsonResponse(route, { account, items: clone(state.starred.get(account) || []) });
  if (pathName === '/api/privacy' && request.method() === 'GET') return jsonResponse(route, { account, profile: 'contact_blacklist', lastSeen: 'all', online: 'match_last_seen', status: 'contact_blacklist', groupsAdd: 'contact_blacklist', readReceipts: true });

  if (pathName === '/api/chat-actions' && request.method() === 'POST') {
    if (state.nextActionGate && body.action === 'archive') {
      state.actionStarted = true;
      const gate = state.nextActionGate;
      state.nextActionGate = null;
      await gate.promise;
    }
    const chat = String(body.chat || '');
    const target = chatFor(state, account, chat);
    const action = String(body.action || '').toLowerCase();
    if (action === 'read') target.unread = 0;
    else if (action === 'unread') target.unread = 1;
    else if (action === 'archive') target.archived = true;
    else if (action === 'unarchive') target.archived = false;
    else if (action === 'pin') target.pinned = true;
    else if (action === 'unpin') target.pinned = false;
    else if (action === 'mute') target.muted = true;
    else if (action === 'unmute') target.muted = false;
    else if (action === 'favorite') target.favorite = true;
    else if (action === 'unfavorite') target.favorite = false;
    else if (action === 'block' || action === 'unblock') state.blockedContacts.set(`${account}:${chat}`, action === 'block');
    else if (action === 'starred') {
      const message = messageFor(state, account, chat, body.messageId);
      const current = state.starred.get(account) || [];
      state.starred.set(account, [...current.filter(item => item.id !== message.id), { ...clone(message), chatId: chat, chatName: target.name }]);
    } else if (action === 'unstarred') {
      state.starred.set(account, (state.starred.get(account) || []).filter(item => item.id !== String(body.messageId)));
    }
    return jsonResponse(route, { account, chat, action, confirmed: true });
  }

  if (pathName === '/api/messages/react' && request.method() === 'POST') {
    const message = messageFor(state, account, body.chat, body.messageId);
    message.reactions = [{ emoji: String(body.emoji), count: 1 }];
    return jsonResponse(route, { account, chat: body.chat, messageId: body.messageId, confirmed: true });
  }
  if (pathName === '/api/messages/poll/vote' && request.method() === 'POST') {
    const message = messageFor(state, account, body.chat, body.messageId);
    if (message.type !== 'POLL') return jsonResponse(route, responseError('Not a poll'), 400);
    if (state.pollVoteFailOnce) {
      state.pollVoteFailOnce = false;
      return jsonResponse(route, responseError('Respuesta temporalmente perdida'), 502);
    }
    const previouslyVoted = message.metadata.results.options.some(option => option.selectedByMe);
    for (const option of message.metadata.results.options) {
      const next = body.options.includes(option.name);
      if (next !== option.selectedByMe) option.count += next ? 1 : -1;
      option.selectedByMe = next;
    }
    const voted = message.metadata.results.options.some(option => option.selectedByMe);
    if (voted !== previouslyVoted) message.metadata.results.totalVoters += voted ? 1 : -1;
    return jsonResponse(route, { account, chat: body.chat, confirmed: true, messageId: 'fixture-vote' });
  }
  if (pathName === '/api/messages/forward' && request.method() === 'POST') {
    const ids = Array.isArray(body.messageIds) ? body.messageIds : [body.messageId];
    for (const id of ids) messageFor(state, account, body.chat, id);
    chatFor(state, account, body.targetChat);
    return jsonResponse(route, { account, chat: body.chat, targetChat: body.targetChat, messageIds: ids, confirmed: true });
  }
  if (pathName === '/api/messages/pins' && request.method() === 'GET') {
    const chat=url.searchParams.get('chat');
    return jsonResponse(route,{account,chat,items:state.pins?.[`${account}:${chat}`]||[]});
  }
  if (pathName === '/api/messages/pin' && request.method() === 'POST') {
    const message=messageFor(state,account,body.chat,body.messageId);
    state.pins ||= {};
    state.pins[`${account}:${body.chat}`]=body.pinned?[{id:message.id,text:message.text,expiresAtMs:Date.now()+body.duration*1000}]:[];
    return jsonResponse(route,{account,chat:body.chat,confirmed:true,messageId:'pin-action'});
  }
  if (pathName === '/api/messages/edit' && request.method() === 'POST') {
    const message = messageFor(state, account, body.chat, body.messageId);
    message.text = String(body.text || '');
    message.content = undefined;
    return jsonResponse(route, { account, chat: body.chat, messageId: body.messageId, confirmed: true });
  }
  if (pathName === '/api/messages/delete' && request.method() === 'POST') {
    const message = messageFor(state, account, body.chat, body.messageId);
    message.text = body.scope === 'everyone' ? 'Mensaje eliminado para todos' : 'Mensaje eliminado para mí';
    message.deleted = true;
    return jsonResponse(route, { account, chat: body.chat, messageId: body.messageId, scope: body.scope, confirmed: true });
  }
  if (pathName === '/api/chats/new' && request.method() === 'POST') {
    const id = `${account}-started-${++state.nextChatCounter}`;
    const chat = { id, account, name: String(body.displayName || body.phone || 'Nuevo contacto'), phone: String(body.phone || ''), preview: 'Nuevo chat fixture', unread: 0, isGroup: false, archived: false, favorite: false, pinned: false, muted: false };
    state.chats[account].push(chat);
    state.messages[id] = [];
    return jsonResponse(route, { account, chat: clone(chat), confirmed: true });
  }
  if (pathName === '/api/contacts' && request.method() === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const contacts = state.chats[account].filter(chat => !chat.isGroup).map(chat => ({
      key: chat.id, label: chat.name, kind: 'chat', chatId: chat.id, hasChat: true,
      canOpen: true, canStart: false, archived: chat.archived === true,
    })).concat({ key: `${account}-known-number`, label: 'Contacto sin chat', phone: '+34100000099',
      kind: 'contact', canOpen: false, canStart: true, hasChat: false });
    const matches = contacts.filter(contact => `${contact.label} ${contact.phone || ''}`.toLowerCase().includes(q));
    return jsonResponse(route, { account, query: q, contacts: matches, total: matches.length,
      hasMore: false, nextCursor: null, sendingEnabled: true, sync: { identities: contacts.length } });
  }
  if (pathName === '/api/contacts' && request.method() === 'POST') {
    return jsonResponse(route, { account, contact: { id: `${account}-contact`, name: body.name, address: body.address }, confirmed: true });
  }
  if (pathName === '/api/groups' && request.method() === 'POST') {
    const id = `${account}-group-${++state.nextChatCounter}`;
    const chat = { id, account, name: String(body.name || 'Nuevo grupo'), preview: 'Nuevo grupo fixture', unread: 0, isGroup: true, archived: false, favorite: false, pinned: false, muted: false };
    state.chats[account].push(chat);
    state.messages[id] = [];
    return jsonResponse(route, { account, chat: clone(chat), confirmed: true });
  }
  if (pathName === '/api/groups/action' && request.method() === 'POST') {
    const group = groupInfo[body.chat];
    if (group && body.action === 'add') group.participants.push({ id: body.participant, name: body.participant, admin: false });
    return jsonResponse(route, { account, chat: body.chat, action: body.action, participant: body.participant, confirmed: true });
  }
  if (pathName === '/api/lists' && request.method() === 'POST') {
    const current = state.lists.get(account) || [];
    if (body.action === 'list') {
      let list = current.find(item => item.name === String(body.list));
      if (!list) { list = { id: `${account}-list-${current.length + 1}`, name: String(body.list), chatIds: [] }; current.push(list); }
      if (body.id) list.chatIds = [...new Set([...list.chatIds, String(body.id)])];
    }
    state.lists.set(account, current);
    return jsonResponse(route, { account, lists: clone(current), confirmed: true });
  }
  if (pathName === '/api/messages/compose' && request.method() === 'POST') return jsonResponse(route, { account, chat: body.chat, kind: body.kind, confirmed: true });
  if (pathName === '/api/privacy' && request.method() === 'POST') return jsonResponse(route, { account, chat: body.chat || null, confirmed: true, ...body });
  if (pathName === '/api/upload' && request.method() === 'POST') return jsonResponse(route, { account, chat: body.chat, confirmed: true, messageId: 'fixture-upload' });
  if (['/api/send', '/api/messages/reply'].includes(pathName) && request.method() === 'POST') {
    const id = `${account}-sent-${Date.now()}`;
    if (body.chat && state.messages[body.chat]) state.messages[body.chat].push({ id, account, chat: body.chat, text: String(body.text || ''), fromMe: true, timestamp: new Date().toISOString(), status: 'sent', replyTo: body.messageId || null });
    return jsonResponse(route, { account, chat: body.chat, confirmed: true, messageId: id });
  }

  state.unexpected.push(entry);
  return jsonResponse(route, responseError(`Unexpected fixture route: ${request.method()} ${pathName}`), 500);
}

function assertNoOverflow(metrics, label) {
  assert(metrics.documentWidth <= metrics.viewportWidth + 1, `${label}: document overflow ${JSON.stringify(metrics)}`);
  assert(metrics.bodyWidth <= metrics.viewportWidth + 1, `${label}: body overflow ${JSON.stringify(metrics)}`);
}

async function viewportMetrics(page) {
  return page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    bodyHeight: document.body.scrollHeight,
  }));
}

async function waitForCondition(predicate, message, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(message);
}

async function waitForApp(page, expectedChatCount = 2) {
  await page.waitForFunction(() => document.querySelectorAll('#account option').length === 2);
  await page.waitForFunction(count => document.querySelectorAll('#chats .chat-item').length >= count, expectedChatCount);
  await page.waitForFunction(() => document.querySelector('#feature-new-chat') && document.querySelector('#feature-chat-info'));
}

async function openSettings(page) {
  const settings = page.locator('.rail-settings');
  const open = await settings.evaluate(element => element.open);
  if (!open) await settings.locator('summary').click();
  await page.locator('#account').waitFor({ state: 'visible' });
}

async function selectAccount(page, value, expectedName) {
  await openSettings(page);
  await page.locator('#account').selectOption(value);
  await page.waitForFunction(expected => document.querySelector('#account')?.value === expected, value);
  await page.waitForFunction(name => document.querySelector('#chats')?.textContent.includes(name), expectedName);
}

function chatLocator(page, name) {
  return page.locator('#chats .chat-item').filter({ hasText: name }).first();
}

async function openChat(page, name) {
  await closeDialog(page);
  if (await page.locator('.rail-settings').evaluate(element => element.open)) {
    await page.locator('#settings-close').click();
  }
  await chatLocator(page, name).click();
  await page.waitForFunction(expected => document.querySelector('#chat-title')?.textContent.includes(expected), name);
  await page.waitForFunction(() => document.querySelectorAll('#messages .message').length > 0);
}

async function dialog(page, title) {
  const result = page.getByRole('dialog');
  await result.waitFor({ state: 'visible' });
  if (title && !await result.locator('.feature-dialog-header').isHidden()) await assertTitle(result, title);
  else if (title) {
    const label = await result.getAttribute('aria-labelledby');
    assert(label, 'dialog must have an accessible title');
    const labelText = await page.locator(`[id=${JSON.stringify(label)}]`).textContent();
    if (title instanceof RegExp) assert.match(labelText || '', title);
    else assert.equal(labelText, title);
  }
  return result;
}

async function assertTitle(dialogLocator, title) {
  await assertText(dialogLocator.locator('h2'), title);
}

async function assertText(locator, expected) {
  await locator.waitFor({ state: 'visible' });
  const value = await locator.textContent();
  assert(value && (expected instanceof RegExp ? expected.test(value) : value.includes(expected)), `Expected ${JSON.stringify(expected)} in ${JSON.stringify(value)}`);
}

async function closeDialog(page) {
  await page.evaluate(() => document.querySelector('[role="dialog"] .feature-dialog-close')?.click());
}

function fieldLocator(dialogLocator, label) {
  return dialogLocator.locator('label.feature-field').filter({ hasText: label }).locator('input, textarea').first();
}

async function clickDialogButton(dialogLocator, name) {
  await dialogLocator.getByRole('button', { name, exact: true }).click();
}

async function clearReadOnlyDocument(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });
}

async function runDesktop(page, state, report) {
  const checks = report.checks;
  const check = async (name, operation) => {
    try {
      await operation();
      checks.push({ name, status: 'pass' });
    } catch (error) {
      checks.push({ name, status: 'fail', error: error.message });
      report.failures.push({ name, error: error.message });
    } finally {
      await closeDialog(page);
    }
  };

  await page.goto(report.baseUrl, { waitUntil: 'load' });
  await waitForApp(page);

  if (process.env.QA_AVATAR_404_ONLY === '1') {
    await check('failed chat avatar shows sidebar initials', async () => {
      const direct = chatLocator(page, 'Ana Fixture');
      await page.waitForFunction(() => {
        const avatar = [...document.querySelectorAll('#chats .chat-item')].find(chat => chat.textContent.includes('Ana Fixture'))?.querySelector('.avatar');
        return avatar && !avatar.querySelector('img') && avatar.textContent.trim() === 'AF';
      });
      const avatar = direct.locator('.avatar');
      assert.equal((await avatar.textContent())?.trim(), 'AF');
      assert.equal(await avatar.locator('img').count(), 0);
    });
    return;
  }

  if (process.env.QA_RACE_ONLY === '1') {
    await check('late archive acknowledgement cannot modify another account', async () => {
      await openChat(page, 'Ana Fixture');
      const gate = deferred();
      state.nextActionGate = gate;
      await page.locator('#feature-chat-menu').click();
      const menu = await dialog(page, /Opciones de conversaci.n/i);
      await clickDialogButton(menu, 'Archivar');
      await waitForCondition(() => state.actionStarted, 'archive request did not start');
      await selectAccount(page, 'beta', 'Bruno Fixture');
      gate.resolve();
      await sleep(250);
      const betaPrefs = await page.evaluate(() => JSON.parse(localStorage.getItem('socialmedia-wa-features:beta') || '{}'));
      assert(!betaPrefs.archivedChats?.includes('beta-direct'), `late archive changed beta preferences: ${JSON.stringify(betaPrefs)}`);
      assert(!betaPrefs.archivedChats?.includes('alpha-direct'), `alpha archive leaked into beta preferences: ${JSON.stringify(betaPrefs)}`);
      assert((await page.locator('#chats').textContent())?.includes('Bruno Fixture'), 'late archive hid active beta chat');
    });
    return;
  }

  await check('desktop viewport has no horizontal overflow', async () => {
    const metrics = await viewportMetrics(page);
    assertNoOverflow(metrics, 'desktop');
    assert.equal(metrics.viewportWidth, 1440);
    assert.equal(await page.locator('.chat-filters').count(), 0, 'legacy chat filters duplicate the feature views');
    assert.equal(await page.getByRole('navigation', { name: 'Vistas de conversaciones' }).getByRole('button').count(), 5, 'feature view navigation must contain five filters');
    assert.equal(await page.locator('#feature-archived-entry').count(), 1, 'archived chats need a separate entry');
  });

  await check('account rail reflects every configured account and switches chats', async () => {
    const rail = page.getByRole('navigation', { name: 'Cuentas de WhatsApp' });
    assert.equal(await rail.getByRole('button').count(), accounts.length);
    assert.equal(await rail.getByRole('button', { name: 'Cuenta de WhatsApp: Cuenta Alpha' }).getAttribute('aria-pressed'), 'true');
    await rail.getByRole('button', { name: 'Cuenta de WhatsApp: Cuenta Beta' }).click();
    await page.waitForFunction(() => document.querySelector('#account')?.value === 'beta' && document.querySelector('#chats')?.textContent.includes('Bruno Fixture'));
    assert.equal(await rail.getByRole('button', { name: 'Cuenta de WhatsApp: Cuenta Beta' }).getAttribute('aria-pressed'), 'true');
    await rail.getByRole('button', { name: 'Cuenta de WhatsApp: Cuenta Alpha' }).click();
    await page.waitForFunction(() => document.querySelector('#account')?.value === 'alpha' && document.querySelector('#chats')?.textContent.includes('Ana Fixture'));
  });

  await check('photo upload quality is visible and scoped to the selected account', async () => {
    await openSettings(page);
    const quality = page.locator('#settings-upload-quality');
    await quality.waitFor({ state: 'visible' });
    await quality.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(outputDir, 'upload-quality-desktop.png') });
    assert.equal(await quality.inputValue(), 'standard');
    await quality.selectOption('hd');
    await selectAccount(page, 'beta', 'Bruno Fixture');
    assert.equal(await quality.inputValue(), 'standard');
    await selectAccount(page, 'alpha', 'Ana Fixture');
    assert.equal(await quality.inputValue(), 'hd');
    if (await page.locator('.rail-settings').evaluate(element => element.open)) await page.locator('#settings-close').click();
  });

  await check('archived chats stay separate from Todos', async () => {
    const text = await page.locator('#chats').textContent();
    assert(!text.includes('Archivado Fixture'), `archived chat leaked into Todos: ${text}`);
    assert(text.includes('Ana Fixture'), `stale local archive hid a fresh provider chat: ${text}`);
    await page.getByRole('button', { name: 'Archivados', exact: true }).click();
    assert.equal(await page.locator('#feature-archived-title').isVisible(), true, 'archived view has no heading');
    assert.equal(await page.locator('#feature-archived-hint').isVisible(), true, 'archived view has no explanation');
    assert.equal(await page.locator('#feature-archived-entry').isVisible(), false, 'archived entry remains visible inside its view');
    await assertText(page.locator('#chats'), 'Archivado Fixture');
    await page.getByRole('button', { name: 'Volver a los chats', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#chats')?.textContent.includes('Ana Fixture'));
  });

  await check('avatar and fallback rendering remain same-origin', async () => {
    const direct = chatLocator(page, 'Ana Fixture');
    assert.equal(await direct.locator('.chat-avatar-image').count(), 1, 'direct avatar did not render');
    const avatarUrl = await direct.locator('.chat-avatar-image').getAttribute('src');
    assert(avatarUrl?.startsWith(report.baseUrl), `avatar escaped origin: ${avatarUrl}`);
    const group = chatLocator(page, 'Equipo Fixture');
    const fallback = group.locator('.avatar');
    assert((await fallback.textContent())?.trim(), 'group avatar has no fallback label');
  });

  await check('chat previews render semantic media icons with unchanged captions', async () => {
    const direct = chatLocator(page, 'Ana Fixture').locator('.chat-preview');
    const media = chatLocator(page, 'Equipo Fixture').locator('.chat-preview');
    assert.equal(await direct.locator('svg').count(), 0);
    assert.equal(await media.locator('svg').count(), 1);
    assert.equal(await media.textContent(), 'Grupo fixture');
    const icon = await media.locator('svg').boundingBox();
    assert(icon && icon.width === 16 && icon.height === 16);
    assert.equal(await media.locator('svg').getAttribute('aria-hidden'), 'true');
  });

  await check('visible chat marks only the selected chat as read', async () => {
    state.log.length = 0;
    await openChat(page, 'Ana Fixture');
    await waitForCondition(() => state.log.some(item => item.path === '/api/chat-actions' && item.body?.chat === 'alpha-direct' && item.body?.action === 'read'), 'visible read request was not sent');
    state.log.length = 0;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    });
    await openChat(page, 'Equipo Fixture');
    await sleep(150);
    assert.equal(state.log.filter(item => item.path === '/api/chat-actions').length, 0, 'hidden chat sent a read request');
    await clearReadOnlyDocument(page);
  });

  await check('sidebar search opens a historical message from account-scoped results', async () => {
    await page.locator('#search').fill('mensaje antiguo');
    const result = page.locator('.sidebar-message-result').filter({ hasText: 'Mensaje antiguo' });
    await result.waitFor({ state: 'visible' });
    await result.click();
    await page.waitForFunction(() => document.querySelector('#messages')?.textContent.includes('Mensaje antiguo fuera de los últimos 200'));
    await page.locator('#search').fill('');
  });

  await check('contact info exposes known presence and same-origin avatar', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-info').click();
    const info = await dialog(page, /Informaci.n del contacto/i);
    await assertText(info, 'Ana Fixture');
    await assertText(info, /En l.nea/i);
    const image = info.locator('.feature-profile-image');
    assert.equal(await image.count(), 1, 'contact avatar image missing');
    assert((await image.getAttribute('src'))?.startsWith(report.baseUrl), 'contact avatar was not same-origin');
    await closeDialog(page);
  });

  await check('contact info confirms provider block state and asks before changing it', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-info').click();
    let info = await dialog(page, /Informaci.n del contacto/i);
    await clickDialogButton(info, 'Bloquear contacto');
    let confirm = await dialog(page, /^Bloquear contacto$/i);
    await clickDialogButton(confirm, 'Cancelar');
    assert.equal(state.log.filter(item => item.path === '/api/chat-actions' && item.body?.action === 'block').length, 0);
    await page.locator('#feature-chat-info').click();
    info = await dialog(page, /Informaci.n del contacto/i);
    await clickDialogButton(info, 'Bloquear contacto');
    confirm = await dialog(page, /^Bloquear contacto$/i);
    await clickDialogButton(confirm, 'Bloquear');
    await page.waitForFunction(() => document.querySelector('.feature-dialog h2')?.textContent?.includes('Información del contacto'));
    info = await dialog(page, /Informaci.n del contacto/i);
    await info.getByRole('button', {name:'Desbloquear contacto'}).waitFor();
    assert.equal(state.log.filter(item => item.path === '/api/chat-actions' && item.body?.action === 'block').length, 1);
    await clickDialogButton(info, 'Desbloquear contacto');
    confirm = await dialog(page, /^Desbloquear contacto$/i);
    await clickDialogButton(confirm, 'Desbloquear');
    await page.waitForFunction(() => document.querySelector('.feature-dialog h2')?.textContent?.includes('Información del contacto'));
    info = await dialog(page, /Informaci.n del contacto/i);
    await info.getByRole('button', {name:'Bloquear contacto'}).waitFor();
    assert.equal(state.log.filter(item => item.path === '/api/chat-actions' && item.body?.action === 'unblock').length, 1);
    await closeDialog(page);
    state.failNextPath = '/api/contact-block';
    await page.locator('#feature-chat-info').click();
    info = await dialog(page, /Informaci.n del contacto/i);
    await info.getByRole('heading', {name:'Ana Fixture'}).waitFor();
    assert.equal(await info.getByRole('button', {name:/Bloquear contacto|Desbloquear contacto/}).count(), 0);
    await closeDialog(page);
  });

  await check('group info exposes unknown presence and members', async () => {
    await openChat(page, 'Equipo Fixture');
    await page.locator('#feature-chat-info').click();
    const info = await dialog(page, /Informaci.n del grupo/i);
    await assertText(info, 'Ana Fixture');
    await assertText(info, 'Bruno Fixture');
    await assertText(info, 'Administrador');
    assert.equal(await info.getByRole('button', {name:/Bloquear contacto|Desbloquear contacto/}).count(),0);
    await closeDialog(page);
  });

  await check('gallery photos remain account and origin scoped', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-info').click();
    const info = await dialog(page, /Informaci.n del contacto/i);
    await clickDialogButton(info, 'Fotos y vídeos');
    const gallery = await dialog(page, /Fotos y v.deos/i);
    await gallery.locator('.feature-gallery-card img').first().waitFor({ state: 'visible' });
    assert.equal(await gallery.locator('.feature-gallery-card').count(), 2);
    for (const image of await gallery.locator('.feature-gallery-card img').all()) assert((await image.getAttribute('src'))?.startsWith(report.baseUrl));
    await closeDialog(page);
  });

  await check('date navigation loads historical messages and reports empty synchronized days', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-search').click();
    let search = await dialog(page, /Buscar mensajes/i);
    await search.getByLabel('Ir a la fecha', {exact:true}).fill('2025-01-02');
    const dateResponse = page.waitForResponse(response => response.url().includes('/api/messages/by-date'));
    await search.getByRole('button', {name:'Ir',exact:true}).click();
    assert.equal((await dateResponse).status(), 200);
    await search.getByRole('status').filter({hasText:'No hay mensajes sincronizados'}).waitFor();
    await search.getByLabel('Ir a la fecha', {exact:true}).fill('2025-01-01');
    await search.getByRole('button', {name:'Ir',exact:true}).click();
    await page.locator('#messages [data-message-id="old-db"]').waitFor();
    await search.waitFor({state:'detached'});
    assert.equal(await page.locator('#messages [data-message-id="old-db"]').evaluate(node => document.activeElement === node), true);
  });

  await check('date navigation refreshes today after the panel crosses midnight', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-search').click();
    const search = await dialog(page, /Buscar mensajes/i);
    const date = search.getByLabel('Ir a la fecha', {exact:true});
    const expected = await page.evaluate(() => {
      const OriginalDate = Date;
      const tomorrow = new OriginalDate();
      tomorrow.setDate(tomorrow.getDate() + 1);
      window.restoreDateForTest = () => { window.Date = OriginalDate; };
      window.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : [tomorrow.getTime()])); }
        static now() { return tomorrow.getTime(); }
      };
      const pad = value => String(value).padStart(2, '0');
      return `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
    });
    try {
      await date.focus();
      assert.equal(await date.getAttribute('max'), expected);
      await date.fill(expected);
      assert(await date.evaluate(input => input.validity.valid));
    } finally {
      await page.evaluate(() => { window.restoreDateForTest(); delete window.restoreDateForTest; });
      await closeDialog(page);
    }
  });

  await check('late date lookup cannot navigate after the search panel closes', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-search').click();
    const search = await dialog(page, /Buscar mensajes/i);
    const gate = deferred(); state.nextDateGate = gate; state.dateStarted = false;
    try {
      await search.getByLabel('Ir a la fecha', {exact:true}).fill('2025-01-01');
      await search.getByRole('button', {name:'Ir',exact:true}).click();
      await waitForCondition(() => state.dateStarted, 'date lookup did not start');
      assert(await search.getByLabel('Ir a la fecha', {exact:true}).isDisabled());
      await closeDialog(page);
      const response = page.waitForResponse(response => response.url().includes('/api/messages/by-date'));
      gate.resolve(); state.nextDateGate = null; await response;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#messages [data-message-id="old-db"]').count(), 0);
    } finally {gate.resolve(); state.nextDateGate = null;}
  });

  await check('search returns a scoped message result', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-search').click();
    const search = await dialog(page, /Buscar mensajes/i);
    await search.locator('input[type="search"]').fill('editable fixture');
    await clickDialogButton(search, 'Buscar');
    await page.waitForFunction(() => document.querySelector('.feature-search-results')?.textContent.includes('Respuesta editable fixture'));
    await closeDialog(page);
  });

  await check('search appends cursor pages and clears them on a new query or scope', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-search').click();
    const search = await dialog(page, /Buscar mensajes/i);
    await search.locator('input[type="search"]').fill('paginado fixture');
    await clickDialogButton(search, 'Buscar');
    await search.getByRole('button', { name: 'Más resultados' }).waitFor();
    assert.equal(await search.locator('.feature-search-result').count(), 1);
    await search.getByRole('button', { name: 'Más resultados' }).click();
    await search.getByText('Resultado histórico página dos').waitFor();
    assert.equal(await search.locator('.feature-search-result').count(), 2);
    assert.equal(await search.getByRole('button', { name: 'Más resultados' }).count(), 0);
    await search.locator('input[type="search"]').fill('editable fixture');
    await clickDialogButton(search, 'Buscar');
    await search.getByText('Respuesta editable fixture').waitFor();
    assert.equal(await search.locator('.feature-search-result').count(), 1);
    await search.locator('select[name="scope"]').selectOption('all');
    assert.equal(await search.locator('.feature-search-result').count(), 0);
    await closeDialog(page);
  });

  await check('late cursor page cannot append to a newer search', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-search').click();
    const search = await dialog(page, /Buscar mensajes/i);
    const gate = deferred(); state.nextSearchPageGate = gate; state.searchPageStarted = false;
    try {
      await search.locator('input[type="search"]').fill('paginado fixture');
      await clickDialogButton(search, 'Buscar');
      await search.getByRole('button', { name: 'Más resultados' }).click();
      await waitForCondition(() => state.searchPageStarted, 'slow cursor page did not start');
      await search.locator('input[type="search"]').fill('editable fixture');
      await clickDialogButton(search, 'Buscar');
      await search.getByText('Respuesta editable fixture').waitFor();
      const oldPageResponse = page.waitForResponse(response => response.url().includes('/api/search') && new URL(response.url()).searchParams.get('cursor') === 'page-2');
      gate.resolve(); state.nextSearchPageGate = null;
      await oldPageResponse;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await search.locator('.feature-search-result').count(), 1);
      assert(!(await search.locator('.feature-search-results').textContent())?.includes('Resultado histórico página dos'));
    } finally {
      gate.resolve(); state.nextSearchPageGate = null;
      await closeDialog(page);
    }
  });

  await check('search opens an old message outside the recent page', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-search').click();
    const search = await dialog(page, /Buscar mensajes/i);
    await search.locator('input[type="search"]').fill('mensaje antiguo');
    await clickDialogButton(search, 'Buscar');
    await search.locator('.feature-search-result').first().click();
    const oldMessage = page.locator('#messages [data-message-id="old-db"]');
    await oldMessage.waitFor();
    assert.equal(await page.locator('#history-notice').isVisible(), true);
    assert.equal(await oldMessage.evaluate(element => document.activeElement === element), true);
    await page.waitForTimeout(10200);
    assert.equal(await oldMessage.count(), 1, 'recent-message polling replaced the historical window');
    await page.locator('#history-notice').getByRole('button', {name: 'Volver a recientes'}).click();
    await oldMessage.waitFor({state: 'detached'});
    assert.equal(await page.locator('#history-notice').isVisible(), false);
  });

  await check('late search cannot replace newer results or a reopened panel', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-search').click();
    let search = await dialog(page, /Buscar mensajes/i);
    const gate = deferred(); state.nextSearchGate = gate; state.searchStarted = false;
    try {
      await search.locator('input[type="search"]').fill('mensaje visible');
      await clickDialogButton(search, 'Buscar');
      await waitForCondition(() => state.searchStarted, 'slow search request did not start');
      await search.locator('input[type="search"]').fill('editable fixture');
      await clickDialogButton(search, 'Buscar');
      await page.waitForFunction(() => document.querySelector('.feature-search-results')?.textContent.includes('Respuesta editable fixture'));
      const slowResponse = page.waitForResponse(response => response.url().includes('/api/search') && new URL(response.url()).searchParams.get('q') === 'mensaje visible');
      gate.resolve(); state.nextSearchGate = null;
      await slowResponse;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert(!(await search.locator('.feature-search-results').textContent())?.includes('Mensaje visible para marcar leído.'));
      await closeDialog(page);
      await page.locator('#feature-chat-search').click();
      search = await dialog(page, /Buscar mensajes/i);
      assert.equal((await search.locator('.feature-search-results').textContent())?.trim(), '');
      const oldPanelGate = deferred(); state.nextSearchGate = oldPanelGate; state.searchStarted = false;
      await search.locator('input[type="search"]').fill('mensaje visible');
      await clickDialogButton(search, 'Buscar');
      await waitForCondition(() => state.searchStarted, 'old panel search request did not start');
      await closeDialog(page);
      await page.locator('#feature-chat-search').click();
      search = await dialog(page, /Buscar mensajes/i);
      await search.locator('input[type="search"]').fill('editable fixture');
      await clickDialogButton(search, 'Buscar');
      await page.waitForFunction(() => document.querySelector('.feature-search-results')?.textContent.includes('Respuesta editable fixture'));
      const oldPanelResponse = page.waitForResponse(response => response.url().includes('/api/search') && new URL(response.url()).searchParams.get('q') === 'mensaje visible');
      oldPanelGate.resolve(); state.nextSearchGate = null;
      await oldPanelResponse;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert(!(await search.locator('.feature-search-results').textContent())?.includes('Mensaje visible para marcar leído.'));
    } finally {
      gate.resolve(); state.nextSearchGate?.resolve(); state.nextSearchGate = null;
    }
  });

  await check('message reply stays scoped to the selected message', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('[data-message-id="alpha-direct-outgoing"] .feature-message-action').click();
    const actions = await dialog(page, /Acciones del mensaje/i);
    assert.equal(await actions.getAttribute('aria-modal'), 'false');
    await clickDialogButton(actions, 'Responder');
    await assertText(page.locator('#feature-reply-quote'), 'Respuesta editable fixture');
    await page.locator('#message').fill('Respuesta a fixture');
    await page.locator('#composer').evaluate(form => form.requestSubmit());
    await waitForCondition(() => state.log.some(item => item.path === '/api/messages/reply' && item.body?.messageId === 'alpha-direct-outgoing'), 'reply payload did not carry the selected message');
  });

  await check('image and caption send together with reply and clear the composer', async () => {
    await openChat(page, 'Ana Fixture');
    const preview = page.locator('#attachment-preview');
    assert.equal(await preview.evaluate(node => getComputedStyle(node).display), 'none');
    await page.locator('[data-message-id="alpha-direct-outgoing"] .feature-message-action').click();
    await clickDialogButton(await dialog(page, /Acciones del mensaje/i), 'Responder');
    await page.locator('#attachment').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64') });
    assert.equal(await preview.isVisible(), true);
    assert.equal(await page.locator('#attachment-thumbnail').isVisible(), true);
    await page.locator('#message').fill('Foto de prueba');
    const uploadsBefore = state.log.filter(item => item.path === '/api/upload').length;
    await page.locator('#composer').evaluate(form => form.requestSubmit());
    await waitForCondition(() => state.log.filter(item => item.path === '/api/upload').length === uploadsBefore + 1, 'one media upload was not sent');
    const uploaded = state.log.filter(item => item.path === '/api/upload').at(-1).body;
    assert.equal(uploaded.caption, 'Foto de prueba');
    assert.equal(uploaded.replyToMessageId, 'alpha-direct-outgoing');
    assert.equal(uploaded.quality, 'hd');
    await page.waitForFunction(() => document.querySelector('#attachment-preview')?.hidden && !document.querySelector('#feature-reply-quote'));
    assert.equal(await page.locator('#message').inputValue(), '');
    await page.locator('#message').evaluate(input => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([new Uint8Array([1, 2, 3])], 'pegada.png', { type: 'image/png' }));
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    assert.equal(await preview.isVisible(), true);
    assert.match(await page.locator('#attachment-label').textContent(), /pegada\.png/);
    await page.locator('#attachment-remove').click();
    assert.equal(await preview.evaluate(node => getComputedStyle(node).display), 'none');
  });

  await check('multiple selected or pasted attachments remain staged until Send', async () => {
    await openChat(page, 'Ana Fixture');
    const file = {name: 'primera.png', mimeType: 'image/png', buffer: Buffer.from([1, 2, 3])};
    await page.locator('#attachment').setInputFiles(file);
    await page.locator('#message').fill('Leyenda guardada');
    const uploadsBefore = state.log.filter(item => item.path === '/api/upload').length;
    await page.locator('#attachment').setInputFiles([file, {name: 'segunda.png', mimeType: 'image/png', buffer: Buffer.from([4, 5, 6])}]);
    assert.equal(await page.locator('.composer-media-card').count(), 3);
    assert.match(await page.locator('#attachment-label').textContent(), /primera\.png/);
    await page.locator('#message').evaluate(input => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([new Uint8Array([1])], 'tercera.png', {type: 'image/png'}));
      clipboardData.items.add(new File([new Uint8Array([2])], 'cuarta.png', {type: 'image/png'}));
      input.dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles: true, cancelable: true}));
    });
    assert.equal(await page.locator('.composer-media-card').count(), 5);
    assert.match(await page.locator('#attachment-label').textContent(), /primera\.png/);
    assert.equal(await page.locator('#message').inputValue(), 'Leyenda guardada');
    assert.equal(state.log.filter(item => item.path === '/api/upload').length, uploadsBefore);
    while (await page.locator('.composer-media-card').count()) await page.locator('#attachment-remove').click();
    await page.locator('#message').fill('');
  });

  await check('audio and typed text send as separate messages', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#attachment').setInputFiles({ name: 'audio.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from([1, 2, 3]) });
    await page.locator('#message').fill('Texto que no admite audio');
    const uploadsBefore = state.log.filter(item => item.path === '/api/upload').length;
    const sendsBefore = state.log.filter(item => item.path === '/api/send').length;
    await page.locator('#composer').evaluate(form => form.requestSubmit());
    await waitForCondition(() => state.log.filter(item => item.path === '/api/upload').length === uploadsBefore + 1, 'audio upload was not sent');
    assert.equal(state.log.filter(item => item.path === '/api/send').length, sendsBefore + 1);
    assert.equal(state.log.filter(item => item.path === '/api/upload').at(-1).body.caption, '');
    assert.equal(await page.locator('#attachment-preview').isVisible(), false);
    assert.equal(await page.locator('#message').inputValue(), '');
  });

  await check('message reaction posts the selected emoji', async () => {
    await page.locator('[data-message-id="alpha-direct-outgoing"] .feature-message-action').click();
    const actions = await dialog(page, /Acciones del mensaje/i);
    await clickDialogButton(actions, 'Reaccionar');
    const picker = await dialog(page, /Reaccionar/i);
    await picker.locator('.emoji-picker-item').first().click();
    await waitForCondition(() => state.log.some(item => item.path === '/api/messages/react' && item.body?.messageId === 'alpha-direct-outgoing'), 'reaction request missing');
  });

  await check('pin and unpin use selected duration, refresh the bar and preserve message scope', async () => {
    await page.locator('[data-message-id="alpha-direct-outgoing"] .feature-message-action').click();
    await clickDialogButton(await dialog(page,/Acciones del mensaje/i),'Fijar mensaje');
    let pin=await dialog(page,/Fijar mensaje/i);
    await pin.locator('select').selectOption('2592000');
    await clickDialogButton(pin,'Fijar');
    await page.locator('.pinned-message-link').waitFor();
    const sent=state.log.filter(item=>item.path==='/api/messages/pin').at(-1).body;
    assert.equal(sent.duration,2592000);assert.equal(sent.account,'alpha');assert.equal(sent.messageId,'alpha-direct-outgoing');assert(sent.sendToken);
    await page.locator('[data-message-id="alpha-direct-outgoing"] .feature-message-action').click();
    await clickDialogButton(await dialog(page,/Acciones del mensaje/i),'Desfijar mensaje');
    pin=await dialog(page,/Desfijar mensaje/i);await clickDialogButton(pin,'Desfijar');
    await page.locator('.pinned-message-bar').waitFor({state:'hidden'});
    assert.equal(state.log.filter(item=>item.path==='/api/messages/pin').at(-1).body.duration,0);
  });

  await check('message forward posts selected ids and destination', async () => {
    await page.locator('[data-message-id="alpha-direct-outgoing"] .feature-message-action').click();
    const actions = await dialog(page, /Acciones del mensaje/i);
    await clickDialogButton(actions, 'Reenviar');
    const forward = await dialog(page, /Reenviar mensaje/i);
    await forward.locator('select').selectOption('alpha-group');
    await clickDialogButton(forward, 'Reenviar');
    await waitForCondition(() => state.log.some(item => item.path === '/api/messages/forward' && item.body?.targetChat === 'alpha-group'), 'forward request missing destination');
  });

  await check('message edit and delete keep independent scoped dialogs', async () => {
    await page.locator('[data-message-id="alpha-direct-outgoing"] .feature-message-action').click();
    let actions = await dialog(page, /Acciones del mensaje/i);
    await clickDialogButton(actions, 'Editar');
    const edit = await dialog(page, /Editar mensaje/i);
    await edit.locator('textarea').fill('Mensaje editado fixture');
    await clickDialogButton(edit, 'Guardar cambios');
    await waitForCondition(() => state.log.some(item => item.path === '/api/messages/edit' && item.body?.text === 'Mensaje editado fixture'), 'edit request missing');
    await page.locator('[data-message-id="alpha-direct-outgoing"] .feature-message-action').click();
    actions = await dialog(page, /Acciones del mensaje/i);
    await clickDialogButton(actions, 'Eliminar');
    const remove = await dialog(page, /Eliminar mensaje/i);
    await remove.locator('select').selectOption('everyone');
    await clickDialogButton(remove, 'Eliminar');
    await waitForCondition(() => state.log.some(item => item.path === '/api/messages/delete' && item.body?.scope === 'everyone'), 'delete scope missing');
  });

  await check('failed chat operation never shows success', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-menu').click();
    const menu = await dialog(page, /Opciones de conversaci.n/i);
    state.failNextPath = '/api/chat-actions';
    await clickDialogButton(menu, 'Fijar');
    await page.locator('.feature-toast.error').waitFor({ state: 'visible' });
    const toast = await page.locator('.feature-toast').textContent();
    assert(toast?.includes('failure'), `failure toast missing: ${toast}`);
    assert(!toast?.includes('Preferencia actualizada'), `failed operation reported success: ${toast}`);
  });

  await check('archive, pin, mute, favorite and lists preserve account state', async () => {
    for (const action of ['Fijar', 'Silenciar', 'Añadir a favoritos']) {
      if (await page.getByRole('dialog').count()) await closeDialog(page);
      await page.locator('#feature-chat-menu').click();
      const menu = await dialog(page, /Opciones de conversaci.n/i);
      await clickDialogButton(menu, action);
      await waitForCondition(() => state.log.some(item => item.path === '/api/chat-actions' && item.body?.action === ({ Fijar: 'pin', Silenciar: 'mute', 'Añadir a favoritos': 'favorite', Archivar: 'archive' }[action])), `${action} request missing`);
    }
    await page.locator('#feature-lists').click();
    let lists = await dialog(page, /Favoritos y listas/i);
    await fieldLocator(lists, 'Nueva lista').fill('Lista Fixture');
    await clickDialogButton(lists, 'Crear lista');
    lists = await dialog(page, /Favoritos y listas/i);
    await clickDialogButton(lists, 'Añadir chat actual');
    await waitForCondition(() => state.log.some(item => item.path === '/api/lists' && item.body?.action === 'list' && item.body?.list), 'list membership request missing');
    await page.waitForFunction(() => document.querySelector('.feature-toast')?.textContent.includes('Chat añadido a la lista'));
    await closeDialog(page);
  });

  await check('starred view reads starred messages', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('[data-message-id="alpha-direct-outgoing"] .feature-message-action').click();
    const actions = await dialog(page, /Acciones del mensaje/i);
    await clickDialogButton(actions, 'Destacar');
    await waitForCondition(() => state.log.some(item => item.path === '/api/chat-actions' && item.body?.action === 'starred'), 'star request missing');
    await page.getByRole('button', { name: 'Destacados', exact: true }).click();
    const starred = await dialog(page, /Mensajes destacados/i);
    await assertText(starred, 'Mensaje eliminado para todos');
    await closeDialog(page);
  });

  await check('new chat, contact and group creation are separate operations', async () => {
    await page.locator('#feature-new-chat').click();
    let create = await dialog(page, /Nuevo chat/i);
    await create.getByRole('searchbox').fill('+34100000099');
    await create.getByRole('button', { name: /Contacto sin chat/ }).click();
    await waitForCondition(() => state.log.some(item => item.path === '/api/chats/new'), 'new chat request missing');

    await page.locator('#feature-new-chat').click();
    create = await dialog(page, /Nuevo chat/i);
    await create.getByRole('searchbox').fill('+34100000097');
    await create.getByRole('button', { name: /Abrir chat con \+34100000097/ }).click();
    await waitForCondition(() => state.log.some(item => item.path === '/api/chats/new' && item.body?.phone === '+34100000097'), 'unsynchronized phone could not start a chat');

    await page.locator('#feature-new-chat').click();
    create = await dialog(page, /Nuevo chat/i);
    await create.getByRole('button', { name: 'Nuevo contacto', exact: true }).click();
    create = await dialog(page, /Nuevo contacto/i);
    await fieldLocator(create, 'Nombre').fill('Contacto Nuevo');
    await fieldLocator(create, 'Número o identificador').fill('+34100000098');
    await clickDialogButton(create, 'Continuar');
    await waitForCondition(() => state.log.some(item => item.path === '/api/contacts' && item.body?.displayName === 'Contacto Nuevo'), 'new contact request missing');

    await page.locator('#feature-new-chat').click();
    create = await dialog(page, /Nuevo chat/i);
    await create.getByRole('button', { name: 'Nuevo grupo', exact: true }).click();
    create = await dialog(page, /Nuevo grupo/i);
    await fieldLocator(create, 'Nombre').fill('Grupo Nuevo');
    await fieldLocator(create, 'Miembros').fill('ana-fixture,bruno-fixture');
    await clickDialogButton(create, 'Continuar');
    await waitForCondition(() => state.log.some(item => item.path === '/api/groups' && item.body?.participants?.length === 2), 'new group request missing');
  });

  await check('group member management is scoped to the group', async () => {
    await openChat(page, 'Equipo Fixture');
    await page.locator('#feature-chat-info').click();
    const info = await dialog(page, /Informaci.n del grupo/i);
    await clickDialogButton(info, 'Añadir miembro');
    const add = await dialog(page, /A.adir miembro/i);
    await fieldLocator(add, 'Número o identificador').fill('carla-fixture');
    await clickDialogButton(add, 'Añadir');
    await waitForCondition(() => state.log.some(item => item.path === '/api/groups/action' && item.body?.chat === 'alpha-group' && item.body?.action === 'add' && item.body?.participant === 'carla-fixture'), 'group member request missing');
    await page.waitForFunction(() => document.querySelector('.feature-toast')?.textContent.includes('Miembro añadido'));
    await dialog(page, /Informaci.n del grupo/i);
  });

  await check('emoji, GIF and sticker picker controls are present', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-emoji').click();
    const picker = await dialog(page, /Emoji, GIF y stickers/i);
    await picker.getByRole('searchbox', {name:'Buscar emoji'}).fill('corazon');
    await picker.locator('.emoji-picker-item').first().click();
    assert((await page.locator('#message').inputValue()).length > 0, 'emoji was not inserted');
    await clickDialogButton(picker, 'GIF local');
    assert.equal(await picker.locator('input[aria-label="Subir GIF"]').count(), 1);
    await clickDialogButton(picker, 'Crear sticker');
    assert.equal(await picker.locator('input[aria-label="Subir sticker"]').count(), 1);
    await closeDialog(page);
  });

  await check('GIF picked from emoji panel stages with the message caption', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#message').fill('GIF con texto');
    await page.locator('#feature-emoji').click();
    const picker = await dialog(page, /Emoji, GIF y stickers/i);
    await clickDialogButton(picker, 'GIF local');
    await picker.getByLabel('Subir GIF').setInputFiles({name:'animado.gif', mimeType:'image/gif', buffer:Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00;')});
    await picker.waitFor({state:'detached'});
    await page.locator('#attachment-preview').getByText('animado.gif').waitFor();
    assert.equal(await page.locator('#message').inputValue(), 'GIF con texto');
    await page.locator('#attachment-remove').click();
    await page.locator('#message').fill('');
  });

  await check('contact, poll and event share pickers post their own type', async () => {
    for (const item of [
      { option: 'Contacto', type: 'contact', values: [['Nombre', 'Ana Compartida'], ['Número o identificador', '+34100000001']] },
      { option: 'Encuesta', type: 'poll', values: [['Pregunta', '¿Fixture?'], ['Opción 1', 'Sí'], ['Opción 2', 'No']] },
      { option: 'Evento', type: 'event', values: [['Nombre del evento', 'Evento Fixture'], ['Ubicación (opcional)', 'Sala Fixture']] },
    ]) {
      await openChat(page, 'Ana Fixture');
      await page.locator('#attach').click();
      await page.getByRole('menuitem', { name: item.option, exact: true }).click();
      const share = await dialog(page, new RegExp(item.option, 'i'));
      for (const [label, value] of item.values) await fieldLocator(share, label).fill(value);
      await share.getByRole('button', { name: item.type === 'event' ? 'Crear evento' : new RegExp(`Enviar ${item.type === 'contact' ? 'contacto' : 'encuesta'}`) }).click();
      await waitForCondition(() => state.log.some(entry => entry.path === '/api/messages/compose' && entry.body?.kind === item.type), `${item.type} share request missing`);
      await closeDialog(page);
    }
  });

  await check('poll vote can be changed and removed in the selected account', async () => {
    await openChat(page, 'Equipo Fixture');
    const poll = page.locator('#messages [data-message-id="alpha-group-poll"]');
    await poll.getByRole('button', { name: /21\.30h/ }).click();
    assert.equal(await poll.getByRole('button', { name: /21\.30h/ }).getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: path.join(outputDir, 'poll-vote-desktop.png') });
    await page.evaluate(() => { document.body.dataset.theme = 'light'; });
    await page.screenshot({ path: path.join(outputDir, 'poll-vote-light.png') });
    await page.evaluate(() => { document.body.dataset.theme = 'dark'; });
    await poll.getByRole('button', { name: 'Votar' }).click();
    await waitForCondition(() => state.log.some(entry => entry.path === '/api/messages/poll/vote'
      && entry.body?.account === 'alpha' && entry.body?.chat === 'alpha-group'
      && entry.body?.messageId === 'alpha-group-poll' && entry.body?.options?.[0] === '21.30h'), 'poll vote request missing');
    await poll.getByText('3 votos registrados en esta copia').waitFor();
    assert.equal(await poll.getByRole('button', { name: /21\.30h/ }).getAttribute('aria-pressed'), 'true');
    await poll.getByRole('button', { name: /20\.30h/ }).click();
    await poll.getByRole('button', { name: 'Cambiar voto' }).click();
    await waitForCondition(() => state.log.some(entry => entry.path === '/api/messages/poll/vote'
      && entry.body?.options?.length === 1 && entry.body.options[0] === '20.30h'), 'changed poll vote request missing');
    assert.equal(await poll.getByRole('button', { name: /20\.30h/ }).getAttribute('aria-pressed'), 'true');
    await poll.getByRole('button', { name: /20\.30h/ }).click();
    await poll.getByRole('button', { name: 'Retirar voto' }).click();
    await waitForCondition(() => state.log.some(entry => entry.path === '/api/messages/poll/vote'
      && Array.isArray(entry.body?.options) && entry.body.options.length === 0), 'removed poll vote request missing');
    await poll.getByText('2 votos registrados en esta copia').waitFor();
    const sent = state.log.filter(entry => entry.path === '/api/messages/poll/vote');
    assert.equal(new Set(sent.map(entry => entry.body.sendToken)).size, 3);
    assert.ok(sent.every(entry => /^[0-9a-f-]{36}$/i.test(entry.body.sendToken)));
    await poll.getByRole('button', { name: /21\.30h/ }).click();
    state.pollVoteFailOnce = true;
    await poll.getByRole('button', { name: 'Votar' }).click();
    await poll.getByRole('button', { name: 'Votar' }).click();
    await waitForCondition(() => state.log.filter(entry => entry.path === '/api/messages/poll/vote').length === 5, 'poll retry request missing');
    const retries = state.log.filter(entry => entry.path === '/api/messages/poll/vote').slice(-2);
    assert.equal(retries[0].body.sendToken, retries[1].body.sendToken);
    const changedElsewhere = messageFor(state, 'alpha', 'alpha-group', 'alpha-group-poll');
    for (const option of changedElsewhere.metadata.results.options) {
      const next = option.name === '20.30h';
      if (next !== option.selectedByMe) option.count += next ? 1 : -1;
      option.selectedByMe = next;
    }
    await page.waitForTimeout(15100);
    await openChat(page, 'Ana Fixture');
    await openChat(page, 'Equipo Fixture');
    const refreshed = page.locator('#messages [data-message-id="alpha-group-poll"]');
    assert.equal(await refreshed.getByRole('button', { name: /20\.30h/ }).getAttribute('aria-pressed'), 'true');
    assert.equal(await refreshed.getByRole('button', { name: /21\.30h/ }).getAttribute('aria-pressed'), 'false');
  });

  await check('search and info use usable side panels', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-search').click();
    let panel = await dialog(page, /Buscar mensajes/i);
    assert.equal(await panel.getAttribute('aria-modal'), 'false');
    assert.equal(await panel.evaluate(element => getComputedStyle(element.parentElement).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('#message').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.locator('#feature-chat-info').click();
    panel = await dialog(page, /Informaci.n del contacto/i);
    assert.equal(await panel.getAttribute('aria-modal'), 'false');
    await page.waitForFunction(() => {
      const element = document.querySelector('.feature-modal-panel .feature-dialog');
      return element && Math.abs(element.getBoundingClientRect().right - innerWidth) < 1;
    });
    assert(Math.abs(await panel.evaluate(element => element.getBoundingClientRect().right) - 1440) <= 1);
  });

  await check('attachment menu closes outside and with Escape, while inside stays interactive', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#attach').click();
    const menu = page.locator('#feature-attach-menu');
    assert.equal(await menu.isVisible(), true);
    assert.equal(await menu.getByRole('menuitem').count(), 8);
    await page.screenshot({ path: path.join(outputDir, 'attachment-menu-desktop.png') });
    await page.locator('#message').click();
    assert.equal(await menu.isVisible(), false);
    await page.locator('#attach').click();
    await page.keyboard.press('Escape');
    assert.equal(await menu.isVisible(), false);
    assert.equal(await page.locator('#attach').getAttribute('aria-expanded'), 'false');
    await page.locator('#attach').focus();
    await page.keyboard.press('Enter');
    assert.equal(await menu.isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem');
    await page.keyboard.press('Escape');
  });

  await check('header presence is scoped and unknown contacts stay neutral', async () => {
    await openChat(page, 'Ana Fixture');
    await page.waitForFunction(() => document.querySelector('#chat-subtitle')?.textContent === 'En línea');
    const streamUrl = await page.evaluate(() => window.__presenceStreams.at(-1)?.url);
    assert.match(streamUrl, /account=alpha&chat=alpha-direct/);
    await page.evaluate(() => window.__presenceStreams.at(-1).emit({chatId:'alpha-direct', status:'composing'}));
    await page.waitForFunction(() => document.querySelector('#chat-subtitle')?.textContent === 'Escribiendo…');
    const gate = deferred(); state.nextPresenceGate = gate; state.presenceStarted = false;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitForCondition(() => state.presenceStarted, 'presence fallback request did not start');
    await page.evaluate(() => window.__presenceStreams.at(-1).emit({chatId:'alpha-direct', status:'recording'}));
    const fallbackResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/presence');
    gate.resolve();
    await fallbackResponse;
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#chat-subtitle').textContent(), 'Grabando audio…');
    state.directPresence = 'unknown';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => document.querySelector('#chat-subtitle')?.textContent === 'Contacto');
    await openChat(page, 'Equipo Fixture');
    assert.equal(await page.locator('#chat-subtitle').textContent(), 'Grupo');
    assert.equal(await page.evaluate(() => window.__presenceStreams.at(-1).closed), true);
    state.directPresence = 'online';
    await openChat(page, 'Ana Fixture');
    await page.waitForFunction(() => document.querySelector('#chat-subtitle')?.textContent === 'En línea');
  });

  await check('privacy and disappearing messages remain explicit', async () => {
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-info').click();
    const info = await dialog(page, /Informaci.n del contacto/i);
    await info.locator('select[aria-label="Duración de mensajes temporales"]').selectOption('86400');
    await waitForCondition(() => state.log.some(item => item.path === '/api/privacy' && item.body?.disappearingSeconds === 86400), 'disappearing message request missing');
    await closeDialog(page);
    await page.locator('#feature-chat-menu').click();
    const menu = await dialog(page, /Opciones de conversaci.n/i);
    await clickDialogButton(menu, 'Privacidad');
    const privacy = await dialog(page, /Privacidad/i);
    await page.waitForFunction(() => document.querySelector('select[name="online"]')?.value === 'match_last_seen');
    assert.equal(await privacy.locator('select[name="profile"]').inputValue(), 'contact_blacklist');
    assert.equal(await privacy.locator('select[name="groupsAdd"]').inputValue(), 'contact_blacklist');
    assert.equal(await privacy.locator('select[name="status"]').inputValue(), 'contact_blacklist');
    assert.equal(await privacy.locator('select[name="status"] option[value="contact_blacklist"]').evaluate(option => option.disabled), true);
    const beforeSave = state.log.length;
    await privacy.locator('select[name="online"]').selectOption('all');
    await privacy.locator('select[name="groupsAdd"]').selectOption('contacts');
    await privacy.locator('select[name="status"]').selectOption('contacts');
    await clickDialogButton(privacy, 'Guardar privacidad');
    await waitForCondition(() => state.log.slice(beforeSave).filter(item => item.path === '/api/privacy' && item.method === 'POST').length === 3, 'privacy changes missing');
    const changes = state.log.slice(beforeSave).filter(item => item.path === '/api/privacy' && item.method === 'POST');
    assert.deepEqual(changes.map(item => item.body.field).sort(), ['groupsAdd', 'online', 'status']);
    assert(changes.every(item => item.body.account === 'alpha' && !item.body.chat), 'account privacy must not carry a chat');
  });

  await check('notification opt-in does not leak history across accounts', async () => {
    await openSettings(page);
    await page.locator('#feature-notifications').click();
    await page.locator('#notification-permission-request').click();
    await page.waitForFunction(() => Notification.permission === 'granted');
    await page.locator('#notification-messages-sound').uncheck();
    await page.locator('#notification-groups-enabled').uncheck();
    await closeDialog(page);
    await selectAccount(page, 'beta', 'Bruno Fixture');
    const betaText = await page.locator('body').textContent();
    assert(!betaText.includes('Ana Fixture'), 'alpha contact leaked into beta account');
    const forged = await page.evaluate(async () => {
      const response = await fetch('/api/messages?account=beta&chat=alpha-direct');
      return { status: response.status, body: await response.json() };
    });
    assert.equal(forged.status, 403);
    assert.equal(forged.body.code, 'ACCOUNT_FORBIDDEN');
    await selectAccount(page, 'alpha', 'Ana Fixture');
    await openChat(page, 'Ana Fixture');
    const notificationTimestamp = new Date(Date.now() + 1000).toISOString();
    state.messages['alpha-direct'].push({ id: `alpha-notification-${++state.dynamicMessageCounter}`, account: 'alpha', chat: 'alpha-direct', text: 'Nuevo mensaje Alpha', timestamp: notificationTimestamp, fromMe: false });
    const alphaChat = state.chats.alpha.find(item => item.id === 'alpha-direct');
    alphaChat.preview = 'Nuevo mensaje Alpha';
    alphaChat.timestamp = notificationTimestamp;
    alphaChat.unread = 2;
    alphaChat.muted = false;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    });
    try {
      await page.waitForFunction(() => (window.__fixtureNotifications || []).some(item => item.body.includes('Nuevo mensaje Alpha')), null, { timeout: 22000 });
    } catch (error) {
      const browserState = await page.evaluate(() => ({ permission: Notification.permission, hidden: document.hidden, notifications: window.__fixtureNotifications }));
      throw new Error(`${error.message}; browser=${JSON.stringify(browserState)}; alpha=${JSON.stringify(state.chats.alpha.find(chat => chat.id === 'alpha-direct'))}; recent=${JSON.stringify(state.log.slice(-8))}`);
    }
    await page.evaluate(() => {
      const stream = window.__presenceStreams.find(item => item.url.includes('/api/events?account=alpha') && !item.closed);
      if (!stream) throw new Error('Live change stream missing');
      stream.listeners.get('message')?.({data:JSON.stringify({account:'alpha', conversation_id:'alpha-direct', wa_message_id:'own-message', reason:'reaction-to-own-message'})});
    });
    await page.waitForFunction(() => (window.__fixtureNotifications || []).some(item => item.body === 'Han reaccionado a tu mensaje'));
    await waitForCondition(() => state.log.some(item => item.path === '/api/novedades/status/authors' && item.query.account === 'alpha'), 'status baseline missing');
    const statusTimestamp = new Date().toISOString();
    state.statusAuthors.alpha = [{ id: '111111111@s.whatsapp.net', name: 'Estado Fixture', own: false, count: 1, unseen: 1, latestTimestamp: statusTimestamp, latestStatusId: 'z-first-status', latestReceivedAt: '2026-09-29T10:00:01.000001Z' }];
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => (window.__fixtureNotifications || []).some(item => item.title === 'Estado Fixture' && item.body === 'Nuevo estado'));
    state.statusAuthors.alpha = [{ id: '111111111@s.whatsapp.net', name: 'Estado Fixture', own: false, count: 2, unseen: 2, latestTimestamp: statusTimestamp, latestStatusId: 'a-second-status', latestReceivedAt: '2026-09-29T10:00:01.000002Z' }];
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => (window.__fixtureNotifications || []).filter(item => item.body === 'Nuevo estado').length === 2);
    await selectAccount(page, 'beta', 'Bruno Fixture');
    const notifications = await page.evaluate(() => window.__fixtureNotifications || []);
    assert(notifications.some(item => item.title === 'Ana Fixture' && item.body.includes('Nuevo mensaje Alpha')), `alpha notification missing: ${JSON.stringify(notifications)}`);
    assert(notifications.find(item => item.body.includes('Nuevo mensaje Alpha')).silent, 'message sound preference was ignored');
    assert(notifications.find(item => item.body === 'Han reaccionado a tu mensaje')?.silent, 'reaction sound preference was ignored');
    assert.equal(notifications.filter(item => item.body === 'Nuevo estado').length, 2, 'same-second statuses should each alert once');
    assert(!notifications.some(item => item.title === 'Bruno Fixture' && item.body.includes('Nuevo mensaje Alpha')), 'alpha notification leaked to beta');
    await openSettings(page);
    await page.locator('#feature-notifications').click();
    assert(await page.locator('#notification-messages-sound').isChecked(), 'alpha sound preference leaked into beta');
    assert(await page.locator('#notification-groups-enabled').isChecked(), 'alpha group preference leaked into beta');
    await closeDialog(page);
    await clearReadOnlyDocument(page);
  });

  await check('stale account responses cannot replace the active account', async () => {
    await selectAccount(page, 'alpha', 'Ana Fixture');
    const gate = deferred();
    state.nextBetaChatsGate = gate;
    state.betaChatsStarted = false;
    await openSettings(page);
    await page.locator('#account').selectOption('beta');
    await waitForCondition(() => state.betaChatsStarted, 'delayed beta request did not start');
    await openSettings(page);
    await page.locator('#account').selectOption('alpha');
    await page.waitForFunction(() => document.querySelector('#chats')?.textContent.includes('Ana Fixture'));
    gate.resolve();
    await sleep(150);
    const text = await page.locator('#chats').textContent();
    assert(text.includes('Ana Fixture'), `stale response removed active alpha chats: ${text}`);
    assert(!text.includes('Bruno Fixture'), `stale beta response replaced alpha chats: ${text}`);
  });

  await check('bulk selection keeps failed chats selected and retries only those chats', async () => {
    await clearReadOnlyDocument(page);
    await selectAccount(page, 'alpha', 'Ana Fixture');
    await openChat(page, 'Ana Fixture');
    const original = clone(state.chats.alpha);
    await page.locator('#chat-selection-toggle').click();
    await chatLocator(page, 'Ana Fixture').click();
    await chatLocator(page, 'Equipo Fixture').click();
    assert.equal(await page.locator('#chat-title').textContent(), 'Ana Fixture');
    const bar = page.getByRole('region', {name:'Selección de conversaciones'});
    assert.equal(await bar.locator('.chat-selection-count').textContent(), '2 seleccionados');
    const start = state.log.length;
    state.failNextPath = '/api/chat-actions';
    await bar.getByRole('button', {name:'Silenciar',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('.chat-selection-status')?.textContent.includes('1 conversaciones pendientes'));
    assert.equal(await bar.locator('.chat-selection-count').textContent(), '1 seleccionados');
    await bar.getByRole('button', {name:'Silenciar',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('.chat-selection-status')?.textContent === 'Cambios aplicados.');
    const writes = state.log.slice(start).filter(item=>item.path==='/api/chat-actions' && item.body?.action==='mute');
    assert.equal(writes.length,3);
    assert(writes.every(item=>item.body.account==='alpha'));
    assert.equal(writes[2].body.chat,writes[0].body.chat);
    assert.notEqual(writes[2].body.chat,writes[1].body.chat);
    await page.keyboard.press('Escape');
    assert.equal(await bar.isVisible(),false);
    state.chats.alpha=original;
    await selectAccount(page,'beta','Bruno Fixture');
    await selectAccount(page,'alpha','Ana Fixture');
  });

  await check('more than 500 chats load and remain searchable and selectable', async () => {
    state.chats.alpha.push(...Array.from({length:650}, (_,i) => ({id:`older-${i}`,name:`Older Fixture ${i}`,preview:'Earlier conversation',timestamp:'2026-01-01T12:00:00Z',unread:0,archived:false})));
    await selectAccount(page, 'beta', 'Bruno Fixture');
    await selectAccount(page, 'alpha', 'Ana Fixture');
    await page.waitForFunction(() => document.querySelector('#chats')?.textContent.includes('Older Fixture 649'));
    assert(state.log.some(item => item.path === '/api/chats' && item.query.cursor === '600'));
    await clearReadOnlyDocument(page);
    assert.equal(await page.locator('.rail-settings').evaluate(element => element.open), false);
    await page.locator('#search').fill('Older Fixture 649');
    assert.equal(await page.locator('#chats .chat-item').count(), 1);
    await page.locator('#chats .chat-item').click();
    await page.waitForFunction(() => document.querySelector('#chat-title')?.textContent.includes('Older Fixture 649'));
    await page.locator('#search').fill('');
    state.chats.alpha = state.chats.alpha.filter(chat => !chat.id.startsWith('older-'));
    await selectAccount(page, 'beta', 'Bruno Fixture');
    await selectAccount(page, 'alpha', 'Ana Fixture');
  });

  await check('archive removes a chat from Todos and keeps it in Archivados', async () => {
    await clearReadOnlyDocument(page);
    await selectAccount(page, 'alpha', 'Ana Fixture');
    await openChat(page, 'Ana Fixture');
    await page.locator('#feature-chat-menu').click();
    const menu = await dialog(page, /Opciones de conversaci.n/i);
    await clickDialogButton(menu, 'Archivar');
    await waitForCondition(() => state.log.some(item => item.path === '/api/chat-actions' && item.body?.action === 'archive'), 'archive request missing');
    await page.waitForFunction(() => !document.querySelector('#chats')?.textContent.includes('Ana Fixture'));
    await page.getByRole('button', { name: 'Archivados', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#chats')?.textContent.includes('Ana Fixture'));
  });

  await page.screenshot({ path: path.join(outputDir, 'selected-features-desktop.png'), fullPage: false });
}

async function runMobile(browser, baseUrl, report) {
  const state = makeMockState();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    localStorage.setItem('socialmedia-wa-features:alpha', JSON.stringify({
      archivedChats: ['alpha-direct'],
      pinnedChats: ['alpha-group'],
      favoriteChats: ['alpha-group'],
      starredMessages: ['foreign-message'],
      view: 'all',
    }));
    window.__fixtureNotifications = [];
    class FixtureNotification {
      static permission = 'default';
      static async requestPermission() { FixtureNotification.permission = 'granted'; return 'granted'; }
      constructor(title, options = {}) { window.__fixtureNotifications.push({ title, body: options.body || '', tag: options.tag || '', silent: options.silent === true }); }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: FixtureNotification });
    window.__presenceStreams = [];
    class FixtureEventSource {
      constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; window.__presenceStreams.push(this); }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      emit(data) { this.listeners.get('presence')?.({data: JSON.stringify(data)}); }
      close() { this.closed = true; }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FixtureEventSource });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => report.pageErrors.push(`mobile: ${error.message}`));
  await page.route('**/api/**', route => fulfillApi(route, state).catch(error => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify(responseError(error.message)) })));
  try {
    await page.goto(baseUrl, { waitUntil: 'load' });
    await waitForApp(page);
    report.mobileMetrics = await viewportMetrics(page);
    const checks = [
      ['mobile viewport has no horizontal overflow', () => assertNoOverflow(report.mobileMetrics, 'mobile')],
      ['mobile chat opens with touch and back closes it', async () => {
        await chatLocator(page, 'Ana Fixture').tap();
        await page.waitForFunction(() => document.body.classList.contains('chat-open'));
        const avatar = page.locator('.conversation-avatar-image');
        await avatar.waitFor({ state: 'visible' });
        const bounds = await avatar.evaluate(image => ({ image: image.getBoundingClientRect().toJSON(), parent: image.parentElement.getBoundingClientRect().toJSON() }));
        assert(bounds.image.width <= bounds.parent.width + 1 && bounds.image.height <= bounds.parent.height + 1, `header avatar exceeds slot: ${JSON.stringify(bounds)}`);
        await page.locator('#back').tap();
        await page.waitForFunction(() => !document.body.classList.contains('chat-open'));
      }],
      ['mobile feature modal stays within viewport', async () => {
        await chatLocator(page, 'Ana Fixture').tap();
        await page.locator('#feature-emoji').tap();
        const modal = await dialog(page, /Emoji, GIF y stickers/i);
        const rect = await modal.evaluate(element => element.getBoundingClientRect().toJSON());
        const viewport = page.viewportSize();
        assert(viewport && rect.left >= 0 && rect.right <= viewport.width + 1, `modal escapes mobile viewport: ${JSON.stringify(rect)}`);
        await closeDialog(page);
        const metrics = await viewportMetrics(page);
        assertNoOverflow(metrics, 'mobile feature modal');
      }],
      ['mobile attachment menu opens by touch and closes outside', async () => {
        await page.locator('#attach').tap();
        const menu = page.locator('#feature-attach-menu');
        assert.equal(await menu.isVisible(), true);
        await page.screenshot({ path: path.join(outputDir, 'attachment-menu-mobile.png') });
        await page.locator('#message').tap();
        assert.equal(await menu.isVisible(), false);
      }],
    ];
    for (const [name, operation] of checks) {
      try { await operation(); report.checks.push({ name, status: 'pass' }); }
      catch (error) { report.checks.push({ name, status: 'fail', error: error.message }); report.failures.push({ name, error: error.message }); }
    }
    await page.screenshot({ path: path.join(outputDir, 'selected-features-mobile.png'), fullPage: false });
  } finally {
    await page.close();
    await context.close();
  }
}

const report = {
  baseUrl: '',
  checks: [],
  failures: [],
  pageErrors: [],
  consoleErrors: [],
  unexpectedRoutes: [],
  serverContract: [],
  mobileMetrics: null,
};

await fs.mkdir(outputDir, { recursive: true });
await auditServerContract(report);
const fixtureServer = await startStaticServer();
report.baseUrl = fixtureServer.url;
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox'],
});

try {
  const state = makeMockState();
  const context = await browser.newContext({ viewport: { width: 1440, height: 675 } });
  await context.addInitScript(() => {
    localStorage.setItem('socialmedia-wa-features:alpha', JSON.stringify({
      archivedChats: ['alpha-direct'],
      pinnedChats: ['alpha-group'],
      favoriteChats: ['alpha-group'],
      starredMessages: ['foreign-message'],
      view: 'all',
    }));
    window.__fixtureNotifications = [];
    class FixtureNotification {
      static permission = 'default';
      static async requestPermission() { FixtureNotification.permission = 'granted'; return 'granted'; }
      constructor(title, options = {}) { window.__fixtureNotifications.push({ title, body: options.body || '', tag: options.tag || '', silent: options.silent === true }); }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: FixtureNotification });
    window.__presenceStreams = [];
    class FixtureEventSource {
      constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; window.__presenceStreams.push(this); }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      emit(data) { this.listeners.get('presence')?.({data: JSON.stringify(data)}); }
      close() { this.closed = true; }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FixtureEventSource });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) report.consoleErrors.push(message.text());
  });
  await page.route('**/api/**', route => fulfillApi(route, state).catch(error => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify(responseError(error.message)) })));
  try {
    await runDesktop(page, state, report);
  } finally {
    report.unexpectedRoutes.push(...state.unexpected);
    await page.close();
    await context.close();
  }
  if (process.env.QA_RACE_ONLY !== '1' && process.env.QA_AVATAR_404_ONLY !== '1') await runMobile(browser, fixtureServer.url, report);
} finally {
  await browser.close();
  await new Promise(resolve => fixtureServer.server.close(resolve));
}

await fs.writeFile(path.join(outputDir, 'selected-features-summary.json'), `${JSON.stringify(report, null, 2)}\n`);
const failed = report.failures.length || report.pageErrors.length || report.consoleErrors.length || report.unexpectedRoutes.length;
if (failed) {
  console.error(`FAIL selected features QA: ${report.failures.length} failed checks, ${report.pageErrors.length} page errors, ${report.consoleErrors.length} console errors, ${report.unexpectedRoutes.length} unexpected routes`);
  for (const item of report.failures) console.error(`- ${item.name}: ${item.error}`);
  for (const item of report.unexpectedRoutes) console.error(`- unexpected route: ${item.method} ${item.path}`);
  process.exitCode = 1;
} else {
  console.log(`PASS selected features QA: ${report.checks.length} checks`);
}
