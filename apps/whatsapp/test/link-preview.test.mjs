import test from 'node:test';
import assert from 'node:assert/strict';
import { linkPreviewFromPayload } from '../lib/link-preview.mjs';
import { renderMessage } from '../public/message-render.mjs';

test('uses stored Baileys metadata only when it describes a URL in the message', () => {
  assert.deepEqual(linkPreviewFromPayload('Mira https://example.com/a', { extendedTextMessage: {
    matchedText: 'https://example.com/a', title: ' Page title ', description: ' Description ', jpegThumbnail: { type: 'Buffer', data: [255, 216, 255, 217] },
  } }), {
    url: 'https://example.com/a', site: 'example.com', title: 'Page title', description: 'Description', hasThumbnail: true,
  });
  const spoofed = linkPreviewFromPayload('https://example.com/a', { extendedTextMessage: {
    matchedText: 'https://other.example/', title: 'Wrong title', jpegThumbnail: 'abcd',
  } });
  assert.equal(spoofed.title, 'example.com');
  assert.equal(spoofed.hasThumbnail, false);
});

test('Google Maps short links get a useful local card without network access', () => {
  const preview = linkPreviewFromPayload('https://maps.app.goo.gl/LTUWNkEEM7eNZkJx6?g_st=aw', null);
  assert.equal(preview.title, 'Google Maps');
  assert.equal(preview.site, 'Google Maps');
  assert.equal(preview.hasThumbnail, false);
  assert.equal(linkPreviewFromPayload('javascript:alert(1)', null), null);
  assert.equal(linkPreviewFromPayload('https://user:pass@example.com', null), null);
});

test('uses the URL carrying Baileys preview when a message has two links', () => {
  const text = 'Primero https://first.example/a y luego https://maps.app.goo.gl/place';
  const preview = linkPreviewFromPayload(text, { extendedTextMessage: {
    matchedText: 'https://maps.app.goo.gl/place', title: 'Lugar', description: 'Direccion',
  } });
  assert.equal(preview.url, 'https://maps.app.goo.gl/place');
  assert.equal(preview.title, 'Lugar');
  assert.equal(preview.site, 'Google Maps');

  const canonical = linkPreviewFromPayload(text, { extendedTextMessage: {
    canonicalUrl: 'https://maps.app.goo.gl/place', title: 'Otro lugar',
  } });
  assert.equal(canonical.url, 'https://maps.app.goo.gl/place');
  assert.equal(canonical.title, 'Otro lugar');

  const fallback = linkPreviewFromPayload(text, { extendedTextMessage: {
    matchedText: 'https://missing.example/', title: 'No corresponde',
  } });
  assert.equal(fallback.url, 'https://first.example/a');
  assert.equal(fallback.title, 'first.example');
});

test('renderer keeps provider title literal and opens only an HTTP link', () => {
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.textContent = ''; }
    append(...children) { for (const child of children) this.children.push(...(child.tagName === '#fragment' ? child.children : [child])); }
    insertBefore(child, reference) {
      const index = this.children.indexOf(reference);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
    }
    querySelector(selector) { return this.children.find(child => child.className === selector.slice(1)) || null; }
    setAttribute() {}
  }
  const document = {
    createElement: tag => new Node(tag),
    createTextNode: text => Object.assign(new Node('#text'), { textContent: text }),
    createDocumentFragment: () => new Node('#fragment'),
  };
  const message = renderMessage({ text: 'https://example.com', linkPreview: {
    url: 'https://example.com', title: '<script>alert(1)</script>', site: 'example.com',
  } }, { document });
  const card = message.children.find(child => child.className === 'message-link-preview');
  assert.equal(card.tagName, 'a');
  assert.equal(card.href, 'https://example.com/');
  assert.equal(card.rel, 'noopener noreferrer');
  assert.equal(card.children[0].children[0].textContent, '<script>alert(1)</script>');
  assert.equal(message.children.indexOf(card) < message.children.findIndex(child => child.className === 'message-text'), true);
  assert.equal(message.children.some(child => child.tagName === 'script'), false);
});
