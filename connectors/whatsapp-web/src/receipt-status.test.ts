import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directReceiptStatus } from './receipt-status';

test('direct receipts reflect provider delivery, reading and playback evidence', () => {
  const key = { remoteJid: '123@s.whatsapp.net', fromMe: true };
  assert.equal(directReceiptStatus({ key, receipt: { receiptTimestamp: 123 } }), 'delivered');
  assert.equal(directReceiptStatus({ key, receipt: { receiptTimestamp: 123, readTimestamp: 124 } }), 'read');
  assert.equal(directReceiptStatus({ key, receipt: { playedTimestamp: 125 } }), 'read');
  assert.equal(directReceiptStatus({ key, receipt: { readTimestamp: NaN, receiptTimestamp: 0 } }), null);
  assert.equal(directReceiptStatus({ key, receipt: { readTimestamp: '123' } }), null);
  assert.equal(directReceiptStatus({ key: { ...key, fromMe: false }, receipt: { readTimestamp: 123 } }), null);
});

test('one recipient never promotes the aggregate group or broadcast status', () => {
  for (const remoteJid of ['123@g.us', 'status@broadcast', '123@broadcast']) {
    assert.equal(directReceiptStatus({ key: { remoteJid, fromMe: true }, receipt: { readTimestamp: 123 } }), null);
    assert.equal(directReceiptStatus({ key: { remoteJid, fromMe: true }, receipt: { receiptTimestamp: 123 } }), null);
  }
});
