import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidBase64, uploadBytes } from '../lib/security.mjs';

test('base64 validation preserves the previous alphabet and padding semantics', () => {
  const previous = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  const alphabet = ['A', 'z', '0', '+', '/', '=', '\n', '-', '\0'];
  const compare = value => assert.equal(isValidBase64(value), previous.test(value), JSON.stringify(value));
  const visit = value => {
    compare(value);
    if (value.length < 5) for (const character of alphabet) visit(value + character);
  };
  visit('');
  for (const value of ['AB==', 'ABC=', 'AAAA', 'AAAAAB==', 'AAAAABC=', 'AAAAAAAA',
    'AAAA====', 'AAAAAA=A', 'AAAAAAA=', 'AAAAAAAA\r', 'AAAA AAA', 'AAAA\tAAA', 'AAAé', 'AAA_']) compare(value);
  for (const value of [null, undefined, 4, {}, Buffer.from('AAAA')]) assert.equal(isValidBase64(value), false);
});

test('base64 validation handles multi-MiB strings and malformed tails without exhausting the stack', () => {
  for (const size of [4 * 1024 * 1024, 10 * 1024 * 1024]) {
    const bytes = Buffer.alloc(size, 0x61);
    const data = bytes.toString('base64');
    assert.equal(isValidBase64(data), true);
    assert.deepEqual(uploadBytes({ name: 'image.png', mimeType: 'image/png', data }), bytes);
    assert.equal(isValidBase64(data.slice(0, -4) + 'AA=A'), false);
  }
});
