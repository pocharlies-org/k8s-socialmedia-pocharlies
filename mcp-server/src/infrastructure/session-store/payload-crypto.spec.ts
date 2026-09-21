/**
 * SC-705 phase 1.5: envelope encryption unit specs (payload-crypto lives in
 * shared/src/session-store/; the mcp-server jest harness is its test runner —
 * see the header of shared/src/session-store/index.ts).
 */
import { randomBytes } from 'node:crypto';
import {
  ENVELOPE_VERSION,
  credentialMasterKeyFromEnv,
  decryptCredentialPayload,
  encryptCredentialPayload,
  isEncryptedPayloadEnvelope,
  parseCredentialMasterKey,
} from '@mcp-socialmedia/shared';

const SESSION_PAYLOAD = {
  files: {
    'creds.json': Buffer.from(JSON.stringify({ noiseKey: 'SUPER-SECRET-NOISE' })).toString('base64'),
    'session-1': 'AAECAz8A',
  },
};

describe('SC-705 credential payload envelope crypto', () => {
  const masterKey = randomBytes(32);

  test('round-trips a payload through the envelope', () => {
    const envelope = encryptCredentialPayload(SESSION_PAYLOAD, masterKey);
    expect(decryptCredentialPayload(envelope, masterKey)).toEqual(SESSION_PAYLOAD);
  });

  test('the serialized envelope never contains the plaintext', () => {
    const envelope = encryptCredentialPayload(SESSION_PAYLOAD, masterKey);
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('SUPER-SECRET-NOISE');
    // base64 of the plaintext JSON must not ride along either
    expect(serialized).not.toContain(
      Buffer.from(JSON.stringify({ noiseKey: 'SUPER-SECRET-NOISE' })).toString('base64')
    );
  });

  test('envelope carries the documented v1 shape', () => {
    const envelope = encryptCredentialPayload(SESSION_PAYLOAD, masterKey);
    expect(envelope.enc).toBe(ENVELOPE_VERSION);
    expect(envelope.alg).toBe('aes-256-gcm+dek-wrap');
    for (const field of ['iv', 'ct', 'tag'] as const) {
      expect(typeof envelope[field]).toBe('string');
      expect(Buffer.from(envelope[field], 'base64').length).toBeGreaterThan(0);
    }
    // wrapped DEK: 32-byte key sealed with AES-GCM → ct is 32 bytes
    expect(Buffer.from(envelope.key.ct, 'base64').length).toBe(32);
    expect(isEncryptedPayloadEnvelope(envelope)).toBe(true);
  });

  test('two puts of the same payload produce different envelopes (random DEK + IVs)', () => {
    const a = encryptCredentialPayload(SESSION_PAYLOAD, masterKey);
    const b = encryptCredentialPayload(SESSION_PAYLOAD, masterKey);
    expect(a.ct).not.toBe(b.ct);
    expect(a.key.ct).not.toBe(b.key.ct);
  });

  test('tampering with the ciphertext fails closed (GCM auth)', () => {
    const envelope = encryptCredentialPayload(SESSION_PAYLOAD, masterKey);
    const ct = Buffer.from(envelope.ct, 'base64');
    ct[0] ^= 0xff;
    expect(() => decryptCredentialPayload({ ...envelope, ct: ct.toString('base64') }, masterKey)).toThrow();
  });

  test('tampering with the wrapped DEK fails closed', () => {
    const envelope = encryptCredentialPayload(SESSION_PAYLOAD, masterKey);
    const keyCt = Buffer.from(envelope.key.ct, 'base64');
    keyCt[0] ^= 0xff;
    expect(() =>
      decryptCredentialPayload({ ...envelope, key: { ...envelope.key, ct: keyCt.toString('base64') } }, masterKey)
    ).toThrow();
  });

  test('the wrong master key fails closed, never returns garbage', () => {
    const envelope = encryptCredentialPayload(SESSION_PAYLOAD, masterKey);
    expect(() => decryptCredentialPayload(envelope, randomBytes(32))).toThrow();
  });

  test('master key parsing: base64 of exactly 32 bytes or throw', () => {
    expect(parseCredentialMasterKey(masterKey.toString('base64')).length).toBe(32);
    expect(() => parseCredentialMasterKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseCredentialMasterKey(randomBytes(48).toString('base64'))).toThrow(/32 bytes/);
  });

  test('credentialMasterKeyFromEnv: absent/blank → null, set → key, malformed → throw', () => {
    expect(credentialMasterKeyFromEnv({})).toBeNull();
    expect(credentialMasterKeyFromEnv({ CREDENTIAL_STORE_MASTER_KEY: '  ' })).toBeNull();
    expect(
      credentialMasterKeyFromEnv({ CREDENTIAL_STORE_MASTER_KEY: masterKey.toString('base64') })
    ).toEqual(masterKey);
    expect(() => credentialMasterKeyFromEnv({ CREDENTIAL_STORE_MASTER_KEY: 'not-key-material' })).toThrow();
  });

  test('isEncryptedPayloadEnvelope rejects plaintext and malformed payloads', () => {
    expect(isEncryptedPayloadEnvelope({ files: {} })).toBe(false);
    expect(isEncryptedPayloadEnvelope({ enc: 'v1' })).toBe(false);
    expect(isEncryptedPayloadEnvelope(null)).toBe(false);
    expect(isEncryptedPayloadEnvelope('x')).toBe(false);
  });
});
