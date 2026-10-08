/**
 * SKIRM-102 (C1, C1b): the one verifier of Meta's `x-hub-signature-256`.
 * Cases adapted from the fork's webhook-access.test.ts (jibanez-staticduo):
 * the signature is over the original bytes, never over re-serialised JSON.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mock, test } from 'node:test';
import { verifyMetaSignature } from './meta-signature';

const sign = (body: string | Buffer, key: string): string =>
  'sha256=' + crypto.createHmac('sha256', key).update(body).digest('hex');

const RAW = '{ "object": "instagram", "entry": [] }';
const BODY = Buffer.from(RAW);
const SECRET = 'fb-app-secret';
const OTHER = 'ig-login-secret';

test('valid signature with the only secret, or with any of several → true', () => {
  assert.equal(verifyMetaSignature(BODY, sign(RAW, SECRET), [SECRET]), true);
  assert.equal(verifyMetaSignature(BODY, sign(RAW, OTHER), [SECRET, OTHER]), true);
  assert.equal(verifyMetaSignature(BODY, sign(RAW, SECRET), [SECRET, OTHER]), true);
});

test('upper-case hex is the same digest, so it passes (the old whatsapp-cloud copy refused it)', () => {
  const upper = 'sha256=' + sign(RAW, SECRET).slice('sha256='.length).toUpperCase();
  assert.equal(verifyMetaSignature(BODY, upper, [SECRET]), true);
  assert.equal(verifyMetaSignature(BODY, upper, [OTHER]), false);
});

test('missing header, wrong secret, other body or re-serialised JSON → false', () => {
  assert.equal(verifyMetaSignature(BODY, undefined, [SECRET]), false);
  assert.equal(verifyMetaSignature(BODY, '', [SECRET]), false);
  assert.equal(verifyMetaSignature(BODY, sign(RAW, 'not-a-secret'), [SECRET, OTHER]), false);
  assert.equal(verifyMetaSignature(BODY, sign('{"object":"page"}', SECRET), [SECRET]), false);
  const reserialised = JSON.stringify(JSON.parse(RAW));
  assert.notEqual(reserialised, RAW);
  assert.equal(verifyMetaSignature(BODY, sign(reserialised, SECRET), [SECRET]), false);
});

test('empty secret list → false, even with a well-formed signature', () => {
  assert.equal(verifyMetaSignature(BODY, sign(RAW, SECRET), []), false);
});

test('empty secrets are dropped before comparing (F2-1)', () => {
  const emptyKey = sign(RAW, '');
  assert.equal(verifyMetaSignature(BODY, emptyKey, ['']), false);
  assert.equal(verifyMetaSignature(BODY, emptyKey, ['', SECRET]), false);
  assert.equal(verifyMetaSignature(BODY, sign(RAW, SECRET), ['', SECRET]), true);
});

test('only sha256=<64 hex> is a signature; anything else is false and never reaches timingSafeEqual (F2-3)', () => {
  const good = sign(RAW, SECRET);
  const hex = good.slice('sha256='.length);
  const spy = mock.method(crypto, 'timingSafeEqual');
  try {
    const malformed = [
      hex, // no prefix
      `sha1=${hex}`,
      `SHA256=${hex}`,
      `sha256=${hex.slice(1)}`, // 63
      `sha256=${hex}0`, // 65
      'sha256=',
      `sha256=${'z'.repeat(64)}`, // right length, not hex
      ` ${good}`,
      `${good} `,
    ];
    for (const header of malformed) {
      assert.equal(verifyMetaSignature(BODY, header, [SECRET]), false, JSON.stringify(header));
    }
    assert.equal(spy.mock.callCount(), 0, 'malformed headers must not reach timingSafeEqual');

    // positive control: the spy does see the call when the shape is right
    assert.equal(verifyMetaSignature(BODY, good, [SECRET]), true);
    assert.ok(spy.mock.callCount() >= 1, 'spy is wired to the function the verifier uses');
  } finally {
    spy.mock.restore();
  }
});
