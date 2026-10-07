import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {filterEmojis, emojiVariant, readEmojiPreferences, rememberEmoji, writeEmojiPreferences} from '../public/emoji-picker.mjs';

const catalog = JSON.parse(await readFile(new URL('../public/emoji/catalog-es.json', import.meta.url)));
test('catalog supports Spanish without accents, English and literal emoji search', () => {
  assert(catalog.items.length > 1900);
  const heart = catalog.items.find(item => item.emoji === '\u2764\ufe0f');
  for (const query of ['corazon', 'corazón', 'heart', heart.emoji]) assert(filterEmojis(catalog.items, query).includes(heart));
  assert.equal(filterEmojis(catalog.items, 'no-existe-esta-palabra').length, 0);
  assert(filterEmojis(catalog.items, '', 9).every(item => item.group === 9));
});
test('skin choices preserve Unicode sequences and use base for unmodified emojis', () => {
  const hand = catalog.items.find(item => item.emoji === '\ud83d\udc4b');
  assert.equal(emojiVariant(hand, 3).emoji, '\ud83d\udc4b\ud83c\udffd');
  assert.equal(emojiVariant(hand, 0), hand);
  const face = catalog.items.find(item => item.emoji === '\ud83d\ude00');
  assert.equal(emojiVariant(face, 4), face);
});
test('recents and tones are isolated by account, bounded and tolerate broken storage', () => {
  const values = new Map();
  const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
  let a = rememberEmoji({tone: 2, recents: ['a', 'b']}, 'b');
  assert.deepEqual(a.recents, ['b', 'a']);
  for (let i = 0; i < 100; i++) a = rememberEmoji(a, String(i));
  assert.equal(a.recents.length, 48);
  writeEmojiPreferences(storage, 'personal', a);
  assert.deepEqual(readEmojiPreferences(storage, 'personal'), a);
  assert.deepEqual(readEmojiPreferences(storage, 'secondary'), {tone: 0, recents: []});
  const broken = {getItem() {throw new Error('blocked');}, setItem() {throw new Error('blocked');}};
  assert.deepEqual(readEmojiPreferences(broken, 'a'), {tone: 0, recents: []});
  assert.doesNotThrow(() => writeEmojiPreferences(broken, 'a', a));
});
