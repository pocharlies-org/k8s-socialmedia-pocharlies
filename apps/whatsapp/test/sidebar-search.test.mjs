import test from 'node:test';
import assert from 'node:assert/strict';
import {createMessageSearch, installSidebarMessageSearch} from '../public/sidebar-search.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function tick() { return new Promise(resolve => setTimeout(resolve, 0)); }

test('searches the active account and discards late responses from the old account', async () => {
  const first = deferred();
  const calls = [];
  const search = createMessageSearch({delay: 0, onChange: () => {}, request: args => {
    calls.push(args);
    return args.account === 'personal' ? first.promise : Promise.resolve({account: 'work', query: args.query, results: [{chatId: 'work-chat', messageId: 'new'}]});
  }});
  search.setQuery('invoice', 'personal');
  await tick();
  search.setQuery('invoice', 'work');
  await tick();
  await tick();
  first.resolve({account: 'personal', query: 'invoice', results: [{chatId: 'private-chat', messageId: 'old'}]});
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(search.snapshot().results.map(item => item.messageId), ['new']);
  assert.equal(search.snapshot().account, 'work');
});

test('query changes and clearing cancel stale results', async () => {
  const old = deferred();
  const search = createMessageSearch({delay: 0, onChange: () => {}, request: ({query}) => query === 'old' ? old.promise : Promise.resolve({query, results: [{chatId: 'chat', messageId: 'current'}]})});
  search.setQuery('old', 'personal');
  await tick();
  search.setQuery('new', 'personal');
  await tick();
  await tick();
  old.resolve({query: 'old', results: [{chatId: 'chat', messageId: 'stale'}]});
  await tick();
  assert.deepEqual(search.snapshot().results.map(item => item.messageId), ['current']);
  search.setQuery('', 'personal');
  assert.equal(search.snapshot().status, 'idle');
  assert.deepEqual(search.snapshot().results, []);
});

test('loads cursor pages, deduplicates overlapping messages and retries a failed page', async () => {
  let secondAttempts = 0;
  const calls = [];
  const search = createMessageSearch({delay: 0, onChange: () => {}, request: async ({account, query, cursor}) => {
    calls.push({account, query, cursor});
    if (!cursor) return {account, query, results: [{chatId: 'chat', messageId: 'first'}], nextCursor: 'page-2'};
    if (++secondAttempts === 1) throw new Error('offline');
    return {account, query, results: [{chatId: 'chat', messageId: 'first'}, {chatId: 'old-chat', messageId: 'old-message'}], nextCursor: null};
  }});
  search.setQuery('archive', 'personal');
  await tick();
  await tick();
  assert.equal(search.snapshot().nextCursor, 'page-2');
  await search.loadMore();
  assert.equal(search.snapshot().status, 'error');
  assert.deepEqual(search.snapshot().results.map(item => item.messageId), ['first']);
  await search.retry();
  assert.equal(search.snapshot().status, 'ready');
  assert.deepEqual(search.snapshot().results.map(item => item.messageId), ['first', 'old-message']);
  assert.equal(search.snapshot().nextCursor, null);
  assert.deepEqual(calls.map(call => call.cursor), [null, 'page-2', 'page-2']);
});

test('shows empty and error states and refuses mismatched account data', async () => {
  const search = createMessageSearch({delay: 0, onChange: () => {}, request: async ({query}) => query === 'empty'
    ? {query, results: []}
    : {account: 'another-account', query, results: [{chatId: 'secret', messageId: 'hidden'}]}});
  search.setQuery('empty', 'personal');
  await tick();
  await tick();
  assert.equal(search.snapshot().status, 'empty');
  search.setQuery('bad', 'personal');
  await tick();
  await tick();
  assert.equal(search.snapshot().status, 'error');
  assert.deepEqual(search.snapshot().results, []);
});

class FakeElement {
  constructor(tag, document) {
    this.tagName = tag;
    this.document = document;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this._text = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) { this[name] = value; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) {
    const focused = this.document.activeElement;
    if (focused === this || this.querySelectorAll('*').includes(focused)) this.document.activeElement = null;
    this.children = []; this._text = ''; this.append(...children);
  }
  before(element) { const index = this.parent.children.indexOf(this); element.parent = this.parent; this.parent.children.splice(index, 0, element); }
  after(element) { const index = this.parent.children.indexOf(this); element.parent = this.parent; this.parent.children.splice(index + 1, 0, element); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  focus() { this.document.activeElement = this; }
  click() { return this.onclick?.(); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(part => part.trim());
    const matches = element => selectors.some(part => part === '*'
      ? true : part === '[data-search-key]'
      ? Boolean(element.dataset.searchKey)
      : part.startsWith('.') && element.className.split(/\s+/).includes(part.slice(1)));
    const visit = element => element.children.flatMap(child => [...(matches(child) ? [child] : []), ...visit(child)]);
    return visit(this);
  }
}

test('sidebar UI shows message pages, opens a chat absent from the loaded list, and supports keyboard navigation', async () => {
  const document = {activeElement: null, createElement(tag) { return new FakeElement(tag, this); }};
  const sidebar = document.createElement('aside'); sidebar.className = 'chat-sidebar';
  document.querySelector = () => sidebar;
  const input = document.createElement('input');
  const chats = document.createElement('div'); chats.id = 'chats';
  sidebar.append(input, chats);
  const opened = [];
  const ui = installSidebarMessageSearch({documentRef: document, input, chatList: chats,
    getAccount: () => 'personal', getChats: () => [], delay: 0,
    request: async ({cursor}) => cursor
      ? {results: [{chatId: 'old-chat', chatName: 'Archive', messageId: 'old-message', text: 'Historic result'}]}
      : {results: [{chatId: 'chat-1', chatName: 'Current', messageId: 'first', text: 'Recent result'}], nextCursor: 'page-2'},
    openMessage: async (...args) => opened.push(args), showError: error => assert.fail(error),
  });
  input.value = 'result'; ui.changed();
  await tick(); await tick();
  const section = sidebar.querySelector('.sidebar-message-search');
  assert.equal(section.hidden, false);
  assert.equal(section.querySelectorAll('.sidebar-message-result').length, 1);
  await section.querySelector('.sidebar-search-more').click();
  assert.equal(section.querySelectorAll('.sidebar-message-result').length, 2);
  const oldRow = section.querySelectorAll('.sidebar-message-result')[1];
  await oldRow.click();
  assert.deepEqual(opened[0], [{id: 'old-chat', name: 'Archive', isGroup: false}, 'old-message', 'personal']);
  let prevented = false;
  input.listeners.get('keydown')({key: 'ArrowDown', preventDefault() { prevented = true; }});
  assert.equal(document.activeElement, section.querySelector('.sidebar-message-result'));
  assert.equal(prevented, true);
});

test('archive view clears and aborts global search, then allows a new editable query', async () => {
  const document = {activeElement: null, createElement(tag) { return new FakeElement(tag, this); }};
  const sidebar = document.createElement('aside'); sidebar.className = 'chat-sidebar';
  document.querySelector = () => sidebar;
  const input = document.createElement('input');
  const chats = document.createElement('div'); sidebar.append(input, chats);
  const old = deferred();
  const calls = [];
  const ui = installSidebarMessageSearch({documentRef: document, input, chatList: chats,
    getAccount: () => 'personal', getChats: () => [], delay: 0,
    request: args => { calls.push(args); return args.query === 'old' ? old.promise : Promise.resolve({results: [{chatId: 'chat', messageId: 'fresh'}]}); },
    openMessage: async () => {}, showError: assert.fail,
  });
  input.value = 'old'; ui.changed();
  await tick();
  ui.viewChanged(true);
  assert.equal(input.value, '');
  assert.equal(ui.snapshot().status, 'idle');
  assert.equal(sidebar.querySelector('.sidebar-message-search').hidden, true);
  assert.equal(calls[0].signal.aborted, true);
  old.resolve({results: [{chatId: 'normal-chat', messageId: 'old'}]});
  await tick();
  assert.deepEqual(ui.snapshot().results, []);
  ui.viewChanged(false);
  input.value = 'new'; ui.changed();
  await tick(); await tick();
  assert.equal(sidebar.querySelector('.sidebar-message-search').hidden, false);
  assert.deepEqual(ui.snapshot().results.map(item => item.messageId), ['fresh']);
});

test('load-more keeps keyboard focus during loading and moves it to the last result at the end', async () => {
  const document = {activeElement: null, createElement(tag) { return new FakeElement(tag, this); }};
  const sidebar = document.createElement('aside'); sidebar.className = 'chat-sidebar';
  document.querySelector = () => sidebar;
  const input = document.createElement('input');
  const chats = document.createElement('div'); sidebar.append(input, chats);
  const next = deferred();
  const ui = installSidebarMessageSearch({documentRef: document, input, chatList: chats,
    getAccount: () => 'personal', getChats: () => [], delay: 0,
    request: ({cursor}) => cursor ? next.promise : Promise.resolve({results: [{chatId: 'chat', messageId: 'first'}], nextCursor: 'page-2'}),
    openMessage: async () => {}, showError: assert.fail,
  });
  input.value = 'term'; ui.changed();
  await tick(); await tick();
  const section = sidebar.querySelector('.sidebar-message-search');
  const more = section.querySelector('.sidebar-search-more');
  more.focus();
  more.click();
  assert.equal(document.activeElement, section.querySelector('.sidebar-search-more'));
  assert.equal(document.activeElement['aria-disabled'], 'true');
  next.resolve({results: [{chatId: 'chat', messageId: 'second'}], nextCursor: null});
  await tick();
  assert.equal(section.querySelector('.sidebar-search-more'), null);
  assert.equal(document.activeElement.dataset.searchKey, 'chat:second');
});

test('retry after a failed first page keeps focus through loading and completion', async t => {
  for (const {label, finalPage, expectedKey} of [
    {label: 'results', finalPage: {results: [{chatId: 'chat', messageId: 'recovered'}]}, expectedKey: 'chat:recovered'},
    {label: 'empty', finalPage: {results: []}, expectedKey: 'status'},
  ]) {
    await t.test(label, async () => {
      const document = {activeElement: null, createElement(tag) { return new FakeElement(tag, this); }};
      const sidebar = document.createElement('aside'); sidebar.className = 'chat-sidebar';
      document.querySelector = () => sidebar;
      const input = document.createElement('input');
      const chats = document.createElement('div'); sidebar.append(input, chats);
      const retryResponse = deferred();
      let attempts = 0;
      const ui = installSidebarMessageSearch({documentRef: document, input, chatList: chats,
        getAccount: () => 'personal', getChats: () => [], delay: 0,
        request: () => ++attempts === 1 ? Promise.reject(new Error('offline')) : retryResponse.promise,
        openMessage: async () => {}, showError: assert.fail,
      });
      input.value = 'term'; ui.changed();
      await tick(); await tick();
      const section = sidebar.querySelector('.sidebar-message-search');
      const retry = section.querySelector('.sidebar-search-more');
      assert.equal(retry.textContent, 'Reintentar');
      retry.focus();
      retry.click();
      assert.equal(document.activeElement, section.querySelector('.sidebar-search-more'));
      assert.equal(document.activeElement['aria-disabled'], 'true');
      retryResponse.resolve(finalPage);
      await tick();
      if (expectedKey === 'status') {
        assert.equal(document.activeElement, section.querySelector('.sidebar-search-status'));
        assert.equal(document.activeElement.textContent, 'No se encontraron mensajes.');
      } else assert.equal(document.activeElement.dataset.searchKey, expectedKey);
    });
  }
});
