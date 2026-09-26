import test from 'node:test';
import assert from 'node:assert/strict';
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
  const sent = renderMessage({
    id: 'sent-photo', fromMe: true, text: '',
    attachments: [{ mime_type: 'image/jpeg', file_name: 'foto.jpg', file_url: '/api/media/photo', caption: 'Nos vemos' }],
  }, { document: fakeDocument });

  assert.equal(new URL(sent.querySelector('.attachment-image')?.src).pathname, '/api/media/photo');
  assert.match(treeText(sent.querySelector('.attachment-caption')), /Nos vemos/);

  const withMessageCaption = renderMessage({
    id: 'sent-photo-text', fromMe: true, text: 'Nos vemos',
    attachments: [{ mime_type: 'image/jpeg', file_url: '/api/media/photo', caption: 'Nos vemos' }],
  }, { document: fakeDocument });
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
  const audioMessage = { id: 'audio', text: 'audio', timestamp: '2026-09-23T10:00:00Z', attachments: [{ url: '/audio.ogg', mimeType: 'audio/ogg', name: 'audio.ogg' }] };
  reconcileMessageList(host, [audioMessage], { document: fakeDocument });
  const audio = host.querySelector('.audio-element');
  audio.currentTime = 17;
  audio.paused = false;

  reconcileMessageList(host, [audioMessage, { id: 'new', text: 'new', timestamp: '2026-09-23T10:01:00Z' }], { document: fakeDocument });

  assert.strictEqual(host.querySelector('.audio-element'), audio);
  assert.equal(audio.currentTime, 17);
  assert.equal(audio.paused, false);
  assert.equal(host.querySelectorAll('.message').length, 2);
});

test('reconcileMessageList removes dropped messages and date chips before appending', () => {
  const host = new FakeNode('section');
  const now = new Date('2026-09-23T12:00:00Z');
  const dropped = { id: 'dropped', text: 'old', timestamp: '2026-09-22T10:00:00Z' };
  const audioMessage = { id: 'audio', text: 'audio', timestamp: '2026-09-23T10:00:00Z', attachments: [{ url: '/audio.ogg', mimeType: 'audio/ogg', name: 'audio.ogg' }] };
  const tail = { id: 'tail', text: 'tail', timestamp: '2026-09-23T10:01:00Z' };
  reconcileMessageList(host, [dropped, audioMessage, tail], { document: fakeDocument, now });
  const audio = host.querySelector('.audio-element');
  audio.currentTime = 23;
  audio.paused = false;
  host.movedExisting = [];

  reconcileMessageList(host, [audioMessage, tail, { id: 'new', text: 'new', timestamp: '2026-09-23T10:02:00Z' }], { document: fakeDocument, now });

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
  const now = new Date('2026-09-23T12:00:00Z');
  const earlier = { id: 'earlier', text: 'before', timestamp: '2026-09-23T10:00:00Z' };
  const audioMessage = { id: 'audio', text: 'audio', timestamp: '2026-09-23T10:01:00Z', attachments: [{ url: '/audio.ogg', mimeType: 'audio/ogg', name: 'audio.ogg' }] };
  reconcileMessageList(host, [earlier, audioMessage], { document: fakeDocument, now });
  const audio = host.querySelector('.audio-element');
  audio.currentTime = 31;
  host.movedExisting = [];

  reconcileMessageList(host, [{ ...earlier, text: 'after' }, audioMessage], { document: fakeDocument, now });

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
