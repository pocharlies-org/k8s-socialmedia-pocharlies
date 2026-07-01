import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { randomBytes } from 'node:crypto';
import { SessionRecord } from 'libsignal';
import { scrubSignalSessionLogs } from './signal-log-scrub';

/**
 * F0.8 regression tests: libsignal SessionEntry console dumps must never
 * render private key material once the scrub is installed. We build a real
 * SessionEntry (via SessionRecord.createEntry) shaped like a live session —
 * the exact object session_record.js passes to console.info on open/close.
 */

interface MutableEntry {
  registrationId: number;
  currentRatchet: {
    ephemeralKeyPair: { pubKey: Buffer; privKey: Buffer };
    lastRemoteEphemeralKey: Buffer;
    previousCounter: number;
    rootKey: Buffer;
  };
  indexInfo: {
    baseKey: Buffer;
    baseKeyType: number;
    closed: number;
    used: number;
    created: number;
    remoteIdentityKey: Buffer;
  };
  addChain(key: Buffer, value: unknown): void;
  toString(): string;
}

function makeLiveLikeEntry(): MutableEntry {
  const record = SessionRecord as unknown as { createEntry(): MutableEntry };
  const entry = record.createEntry();
  const now = Date.now();
  entry.registrationId = 12345;
  entry.currentRatchet = {
    ephemeralKeyPair: { pubKey: randomBytes(33), privKey: randomBytes(32) },
    lastRemoteEphemeralKey: randomBytes(33),
    previousCounter: 0,
    rootKey: randomBytes(32),
  };
  entry.indexInfo = {
    baseKey: randomBytes(33),
    baseKeyType: 2,
    closed: -1,
    used: now,
    created: now,
    remoteIdentityKey: randomBytes(33),
  };
  entry.addChain(entry.currentRatchet.ephemeralKeyPair.pubKey, {
    chainKey: { counter: -1, key: randomBytes(32) },
    chainType: 1,
    messageKeys: { 0: randomBytes(32) },
  });
  return entry;
}

test('scrubSignalSessionLogs installs and reports success (idempotent)', () => {
  assert.equal(scrubSignalSessionLogs(), true, 'first install must succeed');
  assert.equal(scrubSignalSessionLogs(), true, 're-install must be a no-op success');
});

test('inspected SessionEntry redacts to the safe toString form', () => {
  assert.equal(scrubSignalSessionLogs(), true);
  const entry = makeLiveLikeEntry();
  const rendered = inspect(entry); // exactly what console.info(...) renders
  assert.equal(rendered, entry.toString(), 'must render the <SessionEntry [baseKey=…]> form');
  assert.match(rendered, /^<SessionEntry \[baseKey=/);
  for (const secret of ['privKey', 'rootKey', 'chainKey', 'messageKeys', '<Buffer']) {
    assert.equal(
      rendered.includes(secret),
      false,
      `inspect output must not contain "${secret}"`
    );
  }
});

test('console formatting of a SessionEntry arg is redacted too', () => {
  assert.equal(scrubSignalSessionLogs(), true);
  const entry = makeLiveLikeEntry();
  // console.* uses util.format → util.inspect for non-string args; simulate
  // the exact libsignal call shape: console.info("Closing session:", session).
  const formatted = inspect(entry, { depth: null, colors: false });
  assert.equal(formatted.includes('privKey'), false);
  assert.equal(formatted.includes('<Buffer'), false);
});

test('session crypto shape is untouched (serialize round-trip still works)', () => {
  assert.equal(scrubSignalSessionLogs(), true);
  const entry = makeLiveLikeEntry();
  const serialized = (entry as unknown as { serialize(): unknown }).serialize();
  const json = JSON.stringify(serialized);
  // The DATA still contains the keys (storage must keep working) — only the
  // console/inspect rendering is redacted.
  assert.match(json, /"privKey"/);
  const record = SessionRecord as unknown as {
    createEntry(): { constructor: { deserialize(d: unknown): MutableEntry } };
  };
  const revived = record.createEntry().constructor.deserialize(serialized);
  assert.equal(revived.registrationId, 12345);
  assert.equal(inspect(revived).includes('privKey'), false, 'revived entries redacted too');
});
