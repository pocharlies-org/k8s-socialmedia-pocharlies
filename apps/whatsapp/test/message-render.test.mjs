import test from 'node:test';
import assert from 'node:assert/strict';
import * as renderer from '../public/message-render.mjs';
import { writeMediaSettings } from '../public/settings-ui.mjs';
import {
  decorateMessages,
  appendRichText,
  createAttachmentElement,
  clearDraftIfUnchanged,
  formatDateSeparator,
  formatChatListTime,
  formatMessageTime,
  getAttachmentKind,
  isLatestRequest,
  parseRichText,
  reconcileMessageList,
  renderMessage,
  renderMessageList,
  reevaluatePendingMedia,
  safeMessageUrl,
  stopMediaTracks,
} from '../public/message-render.mjs';

function values(tokens) {
  return tokens.map(token => token.type === 'text' || token.type === 'code' || token.type === 'code-block'
    ? token.value
    : token.type === 'link'
      ? token.label
      : values(token.children || [])).join('');
}

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.childNodes = this.children;
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.movedExisting = [];
  }

  append(...nodes) {
    for (const node of nodes) {
      const children = node?.tagName === '#FRAGMENT' ? [...node.children] : node ? [node] : [];
      for (const child of children) {
        child.parentNode = this;
        this.children.push(child);
      }
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
  }
  addEventListener() {}
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const className = selector.match(/\.([\w-]+)/)?.[1];
    const attribute = selector.match(/\[data-([\w-]+)\]/)?.[1];
    const matches = node => (!className || node.className?.split(' ').includes(className))
      && (!attribute || node.dataset?.[attribute.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] !== undefined);
    const result = [];
    const visit = node => {
      for (const child of node.children || []) {
        if (matches(child)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.childNodes = this.children;
    this.append(...nodes);
  }
  insertBefore(node, reference) {
    if (node.parentNode === this) this.movedExisting.push(node);
    if (node.parentNode) {
      const oldIndex = node.parentNode.children.indexOf(node);
      if (oldIndex >= 0) node.parentNode.children.splice(oldIndex, 1);
    }
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    node.parentNode = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
  }
  replaceWith(...nodes) {
    if (!this.parentNode) return;
    let index = this.parentNode.children.indexOf(this);
    if (index < 0) return;
    this.parentNode.children.splice(index, 1);
    for (const node of nodes) {
      node.parentNode = this.parentNode;
      this.parentNode.children.splice(index++, 0, node);
    }
  }
  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentNode = null;
  }
  focus() { this.ownerDocument.activeElement = this; }
}

const fakeDocument = {
  activeElement: null,
  createElement: tagName => new FakeNode(tagName),
  createElementNS: (_, tagName) => new FakeNode(tagName),
  createTextNode: value => Object.assign(new FakeNode('#text'), { textContent: String(value) }),
  createDocumentFragment: () => new FakeNode('#fragment'),
};

function treeText(node) {
  return node.children?.reduce((text, child) => text + (child.tagName === '#TEXT' ? child.textContent : child.textContent || treeText(child)), node.textContent || '') || node.textContent || '';
}

test('chat preview icons follow message type, preserve captions and never infer media from text', () => {
  assert.equal(typeof renderer.renderChatPreview, 'function');
  for (const previewType of ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER', 'CONTACT', 'EVENT', 'POLL', 'LOCATION']) {
    const preview = renderer.renderChatPreview({ previewType, preview: '<b>recuerdo</b>' }, { document: fakeDocument });
    assert(preview.querySelector('.message-kind-icon'));
    assert.equal(treeText(preview), '<b>recuerdo</b>');
  }
  const text = renderer.renderChatPreview({ previewType: 'TEXT', preview: 'Imagen' }, { document: fakeDocument });
  assert.equal(text.querySelector('.message-kind-icon'), null);
  assert.equal(treeText(text), 'Imagen');
  const empty = renderer.renderChatPreview({ previewType: 'AUDIO', preview: '' }, { document: fakeDocument });
  assert.equal(treeText(empty), 'Audio');
});

test('parseRichText renders supported WhatsApp formatting without treating HTML as markup', () => {
  const tokens = parseRichText('*negrita* _cursiva_ ~tachado~ `codigo` ```bloque```');

  assert.deepEqual(tokens.map(token => token.type), ['strong', 'text', 'em', 'text', 'del', 'text', 'code', 'text', 'code-block']);
  assert.equal(tokens[0].children[0].value, 'negrita');
  assert.equal(tokens[2].children[0].value, 'cursiva');
  assert.equal(tokens[4].children[0].value, 'tachado');
  assert.equal(tokens[6].value, 'codigo');
  assert.equal(tokens[8].value, 'bloque');
  assert.equal(values(parseRichText('<img src=x onerror=alert(1)>')), '<img src=x onerror=alert(1)>');
});

test('quoted messages expose an accessible target without changing the preview text', () => {
  const bubble = renderMessage({ id: 'answer', text: 'Respuesta', replyToMessageId: 'original', replyPreview: { available: true, type: 'TEXT', text: 'Hola', senderName: 'Ana' } }, { document: fakeDocument });
  const quote = bubble.querySelector('.message-reply-reference');
  assert.equal(quote.tagName, 'BUTTON');
  assert.equal(quote.type, 'button');
  assert.equal(quote.dataset.replyToMessageId, 'original');
  assert.equal(quote.attributes.get('aria-label'), 'Ir al mensaje citado');
  assert.match(treeText(quote), /Ana/);
  assert.match(treeText(quote), /Hola/);
});

test('parseRichText preserves unmatched and boundary delimiters', () => {
  assert.equal(values(parseRichText('2 * 3, foo_bar_baz, *sin cierre')), '2 * 3, foo_bar_baz, *sin cierre');
  assert.equal(values(parseRichText('* valido *')), '* valido *');
  assert.equal(values(parseRichText('**dos asteriscos**')), '**dos asteriscos**');
});

test('parseRichText recognizes safe web and mail links while leaving unsafe schemes as text', () => {
  const tokens = parseRichText('https://example.test/a?q=1, www.example.test, user@example.test, javascript:alert(1)');
  const links = tokens.filter(token => token.type === 'link');

  assert.deepEqual(links.map(token => token.href), [
    'https://example.test/a?q=1',
    'https://www.example.test/',
    'mailto:user@example.test',
  ]);
  assert.match(values(tokens), /javascript:alert\(1\)/);
  assert.equal(safeMessageUrl('javascript:alert(1)'), null);
  assert.equal(safeMessageUrl('data:text/html,alert(1)'), null);
  assert.equal(safeMessageUrl('ftp://example.test/file'), null);
});

test('date helpers distinguish today, yesterday and older dates', () => {
  const now = new Date(2026, 8, 23, 15, 4);

  assert.equal(formatDateSeparator(new Date(2026, 8, 23, 8), now), 'Hoy');
  assert.equal(formatDateSeparator(new Date(2026, 8, 22, 23), now), 'Ayer');
  assert.equal(formatDateSeparator(new Date(2026, 0, 5, 23), now), '05/01/2026');
  assert.equal(formatMessageTime(new Date(2026, 8, 23, 8, 7).toISOString()), '08:07');
  assert.equal(formatMessageTime('no es una fecha'), '');
});

test('formatChatListTime follows WhatsApp today, yesterday and older-date labels', () => {
  const now = new Date(2026, 8, 23, 15, 4);

  assert.equal(formatChatListTime(new Date(2026, 8, 23, 8, 7).toISOString(), now), '08:07');
  assert.equal(formatChatListTime(new Date(2026, 8, 22, 23), now), 'Ayer');
  assert.equal(formatChatListTime(new Date(2026, 0, 5, 23), now), '05/01/2026');
  assert.equal(formatChatListTime('no es una fecha', now), '');
});

test('decorateMessages adds date separators and reliable adjacent sender groups', () => {
  const messages = [
    { id: '1', fromMe: false, senderName: 'Ana', timestamp: '2026-09-23T10:00:00Z' },
    { id: '2', fromMe: false, senderName: 'Ana', timestamp: '2026-09-23T10:02:00Z' },
    { id: '3', fromMe: true, timestamp: '2026-09-23T10:03:00Z' },
    { id: '4', fromMe: true, timestamp: '2026-09-23T10:20:00Z' },
    { id: '5', fromMe: false, senderName: 'Ana', timestamp: '2026-09-22T10:00:00Z' },
  ];

  const decorated = decorateMessages(messages, { now: new Date('2026-09-23T12:00:00Z') });

  assert.deepEqual(decorated.map(message => [message.id, message.showDateSeparator, message.isFirstInGroup, message.isLastInGroup]), [
    ['1', true, true, false],
    ['2', false, false, true],
    ['3', false, true, true],
    ['4', false, true, true],
    ['5', true, true, true],
  ]);
  assert.equal(decorated[0].dateLabel, 'Hoy');
  assert.equal(decorated[4].dateLabel, 'Ayer');
});

test('decorateMessages does not merge adjacent incoming messages without sender identity', () => {
  const decorated = decorateMessages([
    { id: 'unknown-1', fromMe: false, timestamp: '2026-09-23T10:00:00Z' },
    { id: 'unknown-2', fromMe: false, timestamp: '2026-09-23T10:01:00Z' },
  ], { now: new Date('2026-09-23T12:00:00Z') });

  assert.equal(decorated[0].isLastInGroup, true);
  assert.equal(decorated[1].isFirstInGroup, true);
});

test('getAttachmentKind handles native media and incomplete attachments safely', () => {
  assert.equal(getAttachmentKind({ mimeType: 'image/jpeg' }), 'image');
  assert.equal(getAttachmentKind({ mimeType: 'audio/ogg' }), 'audio');
  assert.equal(getAttachmentKind({ mimeType: 'video/mp4' }), 'video');
  assert.equal(getAttachmentKind({ mimeType: 'application/pdf' }), 'document');
  assert.equal(getAttachmentKind({ type: 'image', mimeType: '' }), 'image');
  assert.equal(getAttachmentKind(null), 'document');
  assert.equal(getAttachmentKind({}), 'document');
});

test('DOM rendering keeps hostile text literal and creates only allowlisted links', () => {
  const parent = new FakeNode('div');

  appendRichText(parent, '<img src=x onerror=alert(1)> https://example.test', fakeDocument);

  assert.equal(parent.children.some(child => child.tagName === 'IMG'), false);
  assert.match(treeText(parent), /<img src=x onerror=alert\(1\)>/);
  assert.equal(parent.children.find(child => child.tagName === 'A')?.href, 'https://example.test/');
});

test('attachment rendering falls back safely when URL data is absent or unsafe', () => {
  const missing = createAttachmentElement({}, { document: fakeDocument });
  const unsafe = createAttachmentElement({ url: 'javascript:alert(1)', mimeType: 'image/png' }, { document: fakeDocument });

  assert.match(treeText(missing), /Adjunto no disponible/);
  assert.match(treeText(unsafe), /Adjunto no disponible/);
  assert.equal(missing.children.some(child => child.tagName === 'IMG' || child.tagName === 'A'), false);
});

test('sent image attachment remains visible with its caption', () => {
  const mediaPolicy = stubPolicy({ enabled: () => true, cachedUrl: () => 'blob:sent-photo' });
  const sent = renderMessage({
    id: 'sent-photo', fromMe: true, text: '',
    attachments: [{ mime_type: 'image/jpeg', file_name: 'foto.jpg', file_url: '/api/media/photo', caption: 'Nos vemos' }],
  }, { document: fakeDocument, mediaPolicy });

  assert.equal(sent.querySelector('.attachment-image')?.src, 'blob:sent-photo');
  assert.match(treeText(sent.querySelector('.attachment-caption')), /Nos vemos/);

  const withMessageCaption = renderMessage({
    id: 'sent-photo-text', fromMe: true, text: 'Nos vemos',
    attachments: [{ mime_type: 'image/jpeg', file_url: '/api/media/photo', caption: 'Nos vemos' }],
  }, { document: fakeDocument, mediaPolicy });
  assert.equal(withMessageCaption.querySelectorAll('.attachment-image').length, 1);
  assert.equal(withMessageCaption.querySelectorAll('.attachment-caption').length, 0);
  assert.match(treeText(withMessageCaption.querySelector('.message-text')), /Nos vemos/);
});

test('message ticks are absent without API status and appear only for an explicit status', () => {
  const withoutStatus = renderMessage({ id: 'a', fromMe: true, text: 'hola', timestamp: '2026-09-23T10:00:00Z' }, { document: fakeDocument });
  const withStatus = renderMessage({ id: 'b', fromMe: true, text: 'hola', status: 'delivered', timestamp: '2026-09-23T10:00:00Z' }, { document: fakeDocument });

  assert.equal(treeText(withoutStatus).includes('\u2713'), false);
  assert.match(treeText(withStatus), /\u2713\u2713/);
});

test('quoted messages show the real sender and excerpt without treating markup as HTML', () => {
  const message = renderMessage({
    id: 'quoted', text: 'Respuesta', replyToMessageId: 'original',
    replyPreview: { type: 'TEXT', text: '<img src=x onerror=alert(1)>', senderName: 'Bel', available: true },
  }, { document: fakeDocument });
  const quote = message.querySelector('.message-reply-reference');

  assert.equal(quote.querySelector('.message-reply-sender').textContent, 'Bel');
  assert.equal(quote.querySelector('.message-kind-label').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(quote.querySelectorAll('.message-kind-icon').length, 0);
  assert.equal(quote.querySelectorAll('.message-kind-line').length, 1);
  assert.equal(quote.querySelectorAll('.message-kind-label')[0].children.length, 0);
});

test('quoted media and empty media bubbles use a type icon and honest label', () => {
  for (const [type, label] of Object.entries({ IMAGE: 'Imagen', VIDEO: 'Video', AUDIO: 'Audio', DOCUMENT: 'Documento', STICKER: 'Sticker', POLL: 'Encuesta', LOCATION: 'Ubicacion' })) {
    const quoted = renderMessage({
      id: `quote-${type}`, text: 'Respuesta', replyToMessageId: 'original',
      replyPreview: { type, text: '', senderName: 'Ana', available: true },
    }, { document: fakeDocument });
    const quote = quoted.querySelector('.message-reply-reference');
    assert.equal(quote.querySelector('.message-kind-label').textContent, label, type);
    assert.equal(quote.querySelector('.message-kind-icon').tagName, 'SVG', type);
    assert.equal(quote.querySelector('.message-kind-icon').attributes.get('aria-hidden'), 'true', type);

    const empty = renderMessage({ id: `empty-${type}`, type, text: '' }, { document: fakeDocument });
    assert.equal(empty.querySelector('.message-kind-label').textContent, label, type);
    assert.equal(empty.querySelector('.message-kind-icon').tagName, 'SVG', type);
  }
});

test('missing targets and unknown empty messages show an unavailable icon, never invented text', () => {
  for (const preview of [undefined, { type: 'IMAGE', text: 'stale caption', senderName: 'Ana', available: false }]) {
    const quoted = renderMessage({ id: 'missing', text: 'Respuesta', replyToMessageId: 'missing-id', replyPreview: preview }, { document: fakeDocument });
    const quote = quoted.querySelector('.message-reply-reference');
    assert.equal(quote.querySelector('.message-kind-label').textContent, 'Mensaje no disponible');
    assert.equal(quote.querySelector('.message-kind-icon').tagName, 'SVG');
    assert.equal(treeText(quote).includes('stale caption'), false);
    assert.equal(treeText(quote).includes('Respuesta a otro mensaje'), false);
  }
  const empty = renderMessage({ id: 'unknown', type: 'UNKNOWN', text: '' }, { document: fakeDocument });
  assert.equal(empty.querySelector('.message-kind-label').textContent, 'Mensaje no disponible');
  assert.equal(empty.querySelector('.message-kind-icon').tagName, 'SVG');
});

test('reconciliation updates a quote when its preview arrives', () => {
  const host = new FakeNode('section');
  const base = { id: 'reply', text: 'Respuesta', replyToMessageId: 'original' };
  reconcileMessageList(host, [base], { document: fakeDocument });
  assert.equal(host.querySelector('.message-kind-label').textContent, 'Mensaje no disponible');

  reconcileMessageList(host, [{ ...base, replyPreview: { type: 'TEXT', text: 'Original', senderName: 'Bel', available: true } }], { document: fakeDocument });
  assert.equal(host.querySelector('.message-kind-label').textContent, 'Original');
  assert.equal(host.querySelector('.message-reply-sender').textContent, 'Bel');
});

test('renderMessageList exposes a real document fragment and sender names are opt-in for groups', () => {
  const direct = renderMessage({ id: 'direct', senderName: 'Ana', text: 'directo' }, { document: fakeDocument, showSenderNames: false });
  const group = renderMessage({ id: 'group', senderName: 'Ana', text: 'grupo', isFirstInGroup: true }, { document: fakeDocument, showSenderNames: true });
  const rendered = renderMessageList([
    { id: 'one', senderName: 'Ana', text: 'uno', timestamp: '2026-09-23T10:00:00Z' },
    { id: 'two', senderName: 'Ana', text: 'dos', timestamp: '2026-09-23T10:01:00Z' },
  ], { document: fakeDocument, showSenderNames: true, now: new Date('2026-09-23T12:00:00Z') });

  assert.equal(direct.children.some(child => child.tagName === 'STRONG'), false);
  assert.equal(group.children.some(child => child.tagName === 'STRONG'), true);
  assert.equal(rendered.fragment.tagName, '#FRAGMENT');
  assert.equal(rendered.fragment.children.filter(child => child.tagName === 'ARTICLE').length, 2);
  assert.equal(rendered.fragment.children.some(child => child.textContent === '[object Object]'), false);
});

test('clearDraftIfUnchanged removes only the draft confirmed by the send response', () => {
  const drafts = new Map([
    ['alpha:chat', 'original'],
    ['beta:chat', 'other'],
  ]);

  assert.equal(clearDraftIfUnchanged(drafts, 'alpha:chat', 'original'), true);
  assert.equal(drafts.has('alpha:chat'), false);
  assert.equal(clearDraftIfUnchanged(drafts, 'beta:chat', 'stale'), false);
  assert.equal(drafts.get('beta:chat'), 'other');
});

test('latest request tokens reject stale session responses', () => {
  assert.equal(isLatestRequest(4, 4), true);
  assert.equal(isLatestRequest(3, 4), false);
});

test('stopMediaTracks stops every track even when recorder setup fails', () => {
  const stopped = [];
  const stream = { getTracks: () => [{ stop: () => stopped.push('audio') }, { stop: () => stopped.push('video') }] };

  stopMediaTracks(stream);

  assert.deepEqual(stopped, ['audio', 'video']);
});

test('reconcileMessageList reuses unchanged media nodes when new messages arrive', () => {
  const host = new FakeNode('section');
  const mediaPolicy = stubPolicy({ enabled: () => true, cachedUrl: () => 'blob:audio' });
  const audioMessage = { id: 'audio', text: 'audio', timestamp: '2026-09-23T10:00:00Z', attachments: [{ url: '/audio.ogg', mimeType: 'audio/ogg', name: 'audio.ogg' }] };
  reconcileMessageList(host, [audioMessage], { document: fakeDocument, mediaPolicy });
  const audio = host.querySelector('.audio-element');
  audio.currentTime = 17;
  audio.paused = false;

  reconcileMessageList(host, [audioMessage, { id: 'new', text: 'new', timestamp: '2026-09-23T10:01:00Z' }], { document: fakeDocument, mediaPolicy });

  assert.strictEqual(host.querySelector('.audio-element'), audio);
  assert.equal(audio.currentTime, 17);
  assert.equal(audio.paused, false);
  assert.equal(host.querySelectorAll('.message').length, 2);
});

test('reconcileMessageList removes dropped messages and date chips before appending', () => {
  const host = new FakeNode('section');
  const mediaPolicy = stubPolicy({ enabled: () => true, cachedUrl: () => 'blob:audio' });
  const now = new Date('2026-09-23T12:00:00Z');
  const dropped = { id: 'dropped', text: 'old', timestamp: '2026-09-22T10:00:00Z' };
  const audioMessage = { id: 'audio', text: 'audio', timestamp: '2026-09-23T10:00:00Z', attachments: [{ url: '/audio.ogg', mimeType: 'audio/ogg', name: 'audio.ogg' }] };
  const tail = { id: 'tail', text: 'tail', timestamp: '2026-09-23T10:01:00Z' };
  reconcileMessageList(host, [dropped, audioMessage, tail], { document: fakeDocument, now, mediaPolicy });
  const audio = host.querySelector('.audio-element');
  audio.currentTime = 23;
  audio.paused = false;
  host.movedExisting = [];

  reconcileMessageList(host, [audioMessage, tail, { id: 'new', text: 'new', timestamp: '2026-09-23T10:02:00Z' }], { document: fakeDocument, now, mediaPolicy });

  assert.strictEqual(host.querySelector('.audio-element'), audio);
  assert.equal(audio.currentTime, 23);
  assert.equal(audio.paused, false);
  assert.equal(host.movedExisting.includes(audio), false);
  assert.equal(host.querySelectorAll('.message-date').length, 1);
  assert.equal(host.querySelectorAll('.message').length, 3);
  assert.equal(host.children.some(child => child.dataset?.messageId === 'dropped'), false);
});

test('reconcileMessageList removes an edited earlier bubble before preserving later media', () => {
  const host = new FakeNode('section');
  const mediaPolicy = stubPolicy({ enabled: () => true, cachedUrl: () => 'blob:audio' });
  const now = new Date('2026-09-23T12:00:00Z');
  const earlier = { id: 'earlier', text: 'before', timestamp: '2026-09-23T10:00:00Z' };
  const audioMessage = { id: 'audio', text: 'audio', timestamp: '2026-09-23T10:01:00Z', attachments: [{ url: '/audio.ogg', mimeType: 'audio/ogg', name: 'audio.ogg' }] };
  reconcileMessageList(host, [earlier, audioMessage], { document: fakeDocument, now, mediaPolicy });
  const audio = host.querySelector('.audio-element');
  audio.currentTime = 31;
  host.movedExisting = [];

  reconcileMessageList(host, [{ ...earlier, text: 'after' }, audioMessage], { document: fakeDocument, now, mediaPolicy });

  assert.strictEqual(host.querySelector('.audio-element'), audio);
  assert.equal(audio.currentTime, 31);
  assert.equal(host.movedExisting.includes(audio), false);
  assert.match(treeText(host.children.find(child => child.dataset?.messageId === 'earlier')), /after/);
});

test('reconcileMessageList adds a sender header when a reused bubble becomes a group start', () => {
  const host = new FakeNode('section');
  const now = new Date('2026-09-23T12:00:00Z');
  const first = { id: 'first', senderName: 'Ana', text: 'primero', timestamp: '2026-09-23T10:00:00Z' };
  const second = { id: 'second', senderName: 'Ana', text: 'segundo', timestamp: '2026-09-23T10:01:00Z', attachments: [{ url: '/audio.ogg', mimeType: 'audio/ogg', name: 'audio.ogg' }] };
  reconcileMessageList(host, [first, second], { document: fakeDocument, now, showSenderNames: true });
  const audio = host.querySelector('.audio-element');
  host.movedExisting = [];

  reconcileMessageList(host, [second], { document: fakeDocument, now, showSenderNames: true });

  assert.strictEqual(host.querySelector('.audio-element'), audio);
  assert.equal(host.movedExisting.includes(audio), false);
  assert.equal(host.children.find(child => child.dataset?.messageId === 'second')?.querySelector('.message-sender')?.textContent, 'Ana');
});

function stubPolicy(overrides = {}) {
  const calls = { loadBytes: [], release: [] };
  return {
    calls,
    autoMaxBytes: overrides.autoMaxBytes ?? 1024 * 1024,
    explicitMaxBytes: overrides.explicitMaxBytes ?? 16 * 1024 * 1024,
    enabled: overrides.enabled ?? (() => false),
    cachedUrl: overrides.cachedUrl ?? (() => null),
    loadBytes: async (url, options = {}) => {
      calls.loadBytes.push({ url, maxBytes: options.maxBytes });
      if (overrides.reject) throw overrides.reject;
      return overrides.loaded ?? { objectUrl: 'blob:cargado', size: 10, mime: 'application/octet-stream', cached: true };
    },
    release: objectUrl => { calls.release.push(objectUrl); return true; },
    sweep: () => ({}),
    cacheStats: () => ({ entries: 0, uncachedEntries: 0, bytes: 0 }),
    isLive: () => true,
  };
}

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };

test('gated video and image attachments request no bytes and expose an explicit action with the caption', () => {
  const policy = stubPolicy();
  const video = createAttachmentElement({ url: 'http://nas/api/media/v1?account=personal&chat=c', mimeType: 'video/mp4', name: 'playa.mp4', size: 4_000_000 }, { document: fakeDocument, mediaPolicy: policy });
  assert.equal(video.querySelector('.attachment-video'), null);
  assert.equal(video.querySelector('.attachment-image'), null);
  assert.equal(video.querySelector('.media-image-button'), null);
  const wrap = video.querySelector('.attachment-pending');
  assert.ok(wrap);
  assert.equal(video.dataset.mediaKind, 'video');
  assert.equal(video.dataset.mediaAccount, 'personal');
  assert.equal(wrap.dataset.mediaState, 'manual');
  const button = wrap.querySelector('.attachment-load');
  assert.equal(button.textContent, 'Descargar video');
  assert.equal(wrap.querySelector('.document-size').textContent, '3.8 MB');
  const image = createAttachmentElement({ url: 'http://nas/api/media/i1?account=personal&chat=c', mimeType: 'image/jpeg', caption: 'en la playa' }, { document: fakeDocument, mediaPolicy: policy });
  assert.equal(image.querySelector('.attachment-image'), null);
  assert.ok(image.querySelector('.attachment-pending'));
  assert.equal(treeText(image.querySelector('.attachment-caption')), 'en la playa');
  assert.deepEqual(policy.calls.loadBytes, []);
});

test('tapping the gated video fetches once with the explicit cap and mounts the blob-backed player', async () => {
  const policy = stubPolicy();
  const container = createAttachmentElement({ url: 'http://nas/api/media/v2?account=personal&chat=c', mimeType: 'video/mp4', name: 'playa.mp4' }, { document: fakeDocument, mediaPolicy: policy });
  const button = container.querySelector('.attachment-load');
  button.onclick();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Descargando…');
  await flush();
  assert.equal(policy.calls.loadBytes.length, 1);
  assert.equal(policy.calls.loadBytes[0].maxBytes, 16 * 1024 * 1024);
  assert.equal(container.querySelector('.attachment-video').src, 'blob:cargado');
  assert.equal(container.dataset.mediaState, 'loaded');
});

test('explicit media too large for any cap falls back to a browser download without mounting', async () => {
  const policy = stubPolicy({ reject: Object.assign(new Error('grande'), { code: 'MEDIA_TOO_LARGE' }) });
  const container = createAttachmentElement({ url: 'http://nas/api/media/v3?account=personal&chat=c', mimeType: 'video/mp4', name: 'grandecito.mp4' }, { document: fakeDocument, mediaPolicy: policy });
  const wrap = container.querySelector('.attachment-pending');
  wrap.querySelector('.attachment-load').onclick();
  await flush();
  assert.equal(container.querySelector('.attachment-video'), null);
  assert.equal(wrap.dataset.mediaState, 'manual');
  assert.equal(wrap.dataset.mediaReason, 'too-large');
});

test('enabled video loads bounded bytes while a declared oversized file waits for the explicit tap', async () => {
  const policy = stubPolicy({ enabled: () => true });
  const small = createAttachmentElement({ url: 'http://nas/api/media/v4?account=personal&chat=c', mimeType: 'video/mp4' }, { document: fakeDocument, mediaPolicy: policy });
  assert.equal(small.querySelector('.attachment-video'), null);
  await flush();
  assert.equal(small.querySelector('.attachment-video').src, 'blob:cargado');
  assert.equal(policy.calls.loadBytes[0].maxBytes, policy.autoMaxBytes);
  const big = createAttachmentElement({ url: 'http://nas/api/media/v5?account=personal&chat=c', mimeType: 'video/mp4', size: 64 * 1024 * 1024 }, { document: fakeDocument, mediaPolicy: policy });
  assert.equal(big.querySelector('.attachment-video'), null);
  assert.equal(big.dataset.mediaReason, 'size-limit');
  big.querySelector('.attachment-load').onclick();
  await flush();
  assert.equal(big.querySelector('.attachment-video').src, 'blob:cargado');
});

test('a cached copy is remounted without a second fetch, within the auto cap and registered to the mount', () => {
  let cachedOptions = null;
  const policy = stubPolicy({
    enabled: () => true,
    cachedUrl: (url, options = {}) => { cachedOptions = options; return url.includes('v6') ? 'blob:cacheado' : null; },
  });
  const container = createAttachmentElement({ url: 'http://nas/api/media/v6?account=personal&chat=c', mimeType: 'image/png' }, { document: fakeDocument, mediaPolicy: policy });
  assert.equal(container.querySelector('.attachment-image').src, 'blob:cacheado');
  assert.equal(container.querySelector('.media-image-button').dataset.viewerUrl, 'blob:cacheado');
  assert.equal(container.dataset.mediaState, 'loaded');
  assert.deepEqual(policy.calls.loadBytes, []);
  assert.equal(cachedOptions.maxBytes, 1024 * 1024, 'the auto remount must be cap-checked too');
  assert.equal(cachedOptions.owner, container, 'the copy must be claimed by its mount');
});

test('documents never auto-request by default and only memory-prefetch when enabled', async () => {
  const off = stubPolicy();
  const gated = createAttachmentElement({ url: 'http://nas/api/media/d1?account=personal&chat=c', mimeType: 'application/pdf', name: 'informe.pdf' }, { document: fakeDocument, mediaPolicy: off });
  assert.equal(gated.dataset.mediaState, 'manual');
  assert.match(gated.querySelector('.attachment-download').href, /\/api\/media\/d1/);
  assert.deepEqual(off.calls.loadBytes, []);
  const on = stubPolicy({ enabled: (type, account) => type === 'document' && account === 'personal' });
  const prefetched = createAttachmentElement({ url: 'http://nas/api/media/d2?account=personal&chat=c', mimeType: 'application/pdf', name: 'informe.pdf', caption: 'Informe final' }, { document: fakeDocument, mediaPolicy: on });
  assert.equal(prefetched.dataset.mediaState, 'loading');
  await flush();
  assert.equal(prefetched.dataset.mediaState, 'loaded');
  assert.equal(prefetched.querySelector('.attachment-download').href, 'blob:cargado');
  assert.equal(treeText(prefetched.querySelector('.attachment-caption')), 'Informe final');
  assert.equal(on.calls.loadBytes.length, 1);
  assert.equal(on.calls.loadBytes[0].maxBytes, 1024 * 1024);
  const other = createAttachmentElement({ url: 'http://nas/api/media/d3?account=secundaria&chat=c', mimeType: 'application/pdf', name: 'otro.pdf' }, { document: fakeDocument, mediaPolicy: on });
  assert.equal(other.dataset.mediaState, 'manual');
  assert.equal(on.calls.loadBytes.length, 1, 'account scope must not trigger the other account prefetch');
});

test('a declared document above the auto cap keeps the manual card without fetching', () => {
  const policy = stubPolicy({ enabled: () => true });
  const container = createAttachmentElement({ url: 'http://nas/api/media/d4?account=personal&chat=c', mimeType: 'application/pdf', name: 'gordo.pdf', size: 4 * 1024 * 1024 }, { document: fakeDocument, mediaPolicy: policy });
  assert.equal(container.dataset.mediaState, 'manual');
  assert.equal(container.dataset.mediaReason, 'size-limit');
  assert.deepEqual(policy.calls.loadBytes, []);
});

test('enabling videos in settings auto-loads only the placeholders of the toggled account', async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  let fetchCalls = 0;
  const bytes = new Uint8Array([1, 2, 3]);
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  globalThis.fetch = async url => {
    fetchCalls += 1;
    return { ok: true, status: 200, headers: { get: name => name === 'content-type' ? 'video/webm' : name === 'content-length' ? String(bytes.byteLength) : null }, body: null, arrayBuffer: async () => bytes.buffer.slice(0) };
  };
  try {
    const one = createAttachmentElement({ url: 'http://nas/api/media/va?account=uno', mimeType: 'video/webm', name: 'uno.mp4' }, { document: fakeDocument });
    const two = createAttachmentElement({ url: 'http://nas/api/media/vb?account=dos', mimeType: 'video/webm', name: 'dos.mp4' }, { document: fakeDocument });
    assert.ok(one.querySelector('.attachment-pending') && two.querySelector('.attachment-pending'));
    assert.equal(fetchCalls, 0);
    writeMediaSettings(undefined, 'uno', { video: true });
    const host = fakeDocument.createElement('main');
    host.append(one, two);
    assert.equal(reevaluatePendingMedia(host, { mediaType: 'video', enabled: true, account: 'uno' }), 1);
    await flush();
    assert.equal(fetchCalls, 1);
    assert.ok(one.querySelector('.attachment-video').src.startsWith('blob:'));
    assert.equal(two.querySelector('.attachment-video'), null);
    assert.ok(two.querySelector('.attachment-pending'));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    else delete globalThis.localStorage;
  }
});

test('stickers mount natively regardless of the Fotos switch and never touch the policy cache', async () => {
  const policy = stubPolicy();
  const sticker = createAttachmentElement(
    { url: 'http://nas/api/media/s1?account=personal&chat=c', type: 'STICKER', mimeType: 'image/webp', name: 'baile.webp' },
    { document: fakeDocument, mediaPolicy: policy },
  );
  assert.equal(sticker.dataset.mediaKind, 'image');
  assert.equal(sticker.dataset.mediaState, 'auto');
  assert.equal(sticker.dataset.mediaReason, undefined);
  assert.equal(sticker.querySelector('.attachment-pending'), null);
  const button = sticker.querySelector('.media-image-button');
  assert.ok(button);
  assert.equal(button.dataset.viewerUrl, 'http://nas/api/media/s1?account=personal&chat=c');
  assert.equal(sticker.querySelector('.attachment-image').src, 'http://nas/api/media/s1?account=personal&chat=c');
  assert.deepEqual(policy.calls.loadBytes, [], 'stickers must never fetch through the bounded path');
  // The renderer also honors the defensive kind field used by older payloads.
  const viaKind = createAttachmentElement(
    { url: 'http://nas/api/media/s2?account=personal&chat=c', kind: 'STICKER', mimeType: 'image/webp' },
    { document: fakeDocument, mediaPolicy: policy },
  );
  assert.equal(viaKind.querySelector('.media-image-button')?.dataset.viewerUrl, 'http://nas/api/media/s2?account=personal&chat=c');
  assert.equal(viaKind.querySelector('.attachment-pending'), null);
  assert.deepEqual(policy.calls.loadBytes, []);
  // A regular photo with the same disabled policy stays gated, so the
  // sticker exemption is not accidentally disabling the gate for images.
  const photo = createAttachmentElement(
    { url: 'http://nas/api/media/s3?account=personal&chat=c', mimeType: 'image/jpeg', name: 'playa.jpg' },
    { document: fakeDocument, mediaPolicy: policy },
  );
  assert.ok(photo.querySelector('.attachment-pending'));
  assert.equal(photo.querySelector('.media-image-button'), null);
});
