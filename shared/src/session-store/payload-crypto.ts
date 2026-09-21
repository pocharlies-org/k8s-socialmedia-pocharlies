/**
 * SC-705 phase 1.5: envelope encryption of the credential-store payload.
 *
 * Hard rule (CTO 13-09, SC-552 / SC-705): the DB NEVER sees plaintext. The
 * `user_channel_credentials.payload` column holds only the envelope below —
 * a baileys auth dir is Signal key material in base64, which is encoding,
 * not encryption, so it must not be written raw.
 *
 * Envelope format (what the jsonb `payload` column contains):
 *
 *   {
 *     "enc": "v1",                                  // envelope marker
 *     "alg": "aes-256-gcm+dek-wrap",                // construction, see below
 *     "key": { "iv": "<b64>", "ct": "<b64>", "tag": "<b64>" }, // DEK wrapped with master key
 *     "iv":  "<b64>",                               // payload IV (12 bytes)
 *     "ct":  "<b64>",                               // AES-256-GCM(JSON.stringify(payload))
 *     "tag": "<b64>"                                // payload GCM tag (16 bytes)
 *   }
 *
 * Construction (standard envelope / "data key" pattern, node crypto only):
 *  - each payload gets a fresh random 256-bit data key (DEK) and encrypts its
 *    JSON with AES-256-GCM (random 12-byte IV, 16-byte tag). GCM authenticates:
 *    any tampering with ct/tag/iv makes decrypt throw, never return garbage.
 *  - the DEK is wrapped with the master key (AES-256-GCM, fresh IV). The
 *    master key therefore only ever encrypts 32-byte DEKs, never payload data.
 *  - master key = env CREDENTIAL_STORE_MASTER_KEY, base64 of exactly 32 bytes.
 *    It arrives through external-secrets: the 1Password item `whatsapp-mcp`
 *    is propagated whole (`dataFrom.extract`) into the `whatsapp-mcp-secrets`
 *    Secret and reaches every pod via the existing `envFrom` — no per-pod
 *    manifest reference, so a missing field can never break pod startup; the
 *    store fails closed at put()/get() instead.
 *  - why envelope and not direct AES-GCM with the master key: rotating the
 *    master key then re-wraps only the stored DEK per row (a 32-byte
 *    re-encryption), and a leaked payload dump without the env never even
 *    exposes how many bytes of key material each row holds under the master
 *    key. Cost is one extra GCM pair per row — negligible for this table.
 *
 * Fail-closed: put() without a master key throws (no plaintext write); get()
 * of an envelope without a master key throws; get() of a NON-envelope row
 * throws too — no plaintext row has ever existed (the table shipped with
 * encryption), and silently serving one would defeat the whole point.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const CREDENTIAL_STORE_MASTER_KEY_ENV = 'CREDENTIAL_STORE_MASTER_KEY';
export const ENVELOPE_MARKER = 'enc' as const;
export const ENVELOPE_VERSION = 'v1' as const;
export const ENVELOPE_ALG = 'aes-256-gcm+dek-wrap' as const;

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedPayloadEnvelope {
  enc: typeof ENVELOPE_VERSION;
  alg: typeof ENVELOPE_ALG;
  key: { iv: string; ct: string; tag: string };
  iv: string;
  ct: string;
  tag: string;
}

/** Parse the master key material: base64 of exactly 32 bytes. Throws otherwise. */
export function parseCredentialMasterKey(raw: string): Buffer {
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `${CREDENTIAL_STORE_MASTER_KEY_ENV} must be base64 of exactly ${KEY_BYTES} bytes (got ${buf.length})`
    );
  }
  return buf;
}

/** Master key from env; null when the variable is absent/blank, throws when malformed. */
export function credentialMasterKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[CREDENTIAL_STORE_MASTER_KEY_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  return parseCredentialMasterKey(raw.trim());
}

/** True when a stored payload is an encryption envelope written by this module. */
export function isEncryptedPayloadEnvelope(value: unknown): value is EncryptedPayloadEnvelope {
  const v = value as EncryptedPayloadEnvelope | undefined;
  return Boolean(
    v &&
    typeof v === 'object' &&
    v.enc === ENVELOPE_VERSION &&
    typeof v.ct === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.tag === 'string' &&
    v.key &&
    typeof v.key.ct === 'string' &&
    typeof v.key.iv === 'string' &&
    typeof v.key.tag === 'string'
  );
}

function aesGcmSeal(key: Buffer, plaintext: Buffer): { iv: string; ct: string; tag: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) throw new Error('unexpected GCM tag length');
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64') };
}

function aesGcmOpen(key: Buffer, sealed: { iv: string; ct: string; tag: string }): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
}

/** Encrypt a channel payload into the envelope the DB stores. */
export function encryptCredentialPayload(
  payload: Record<string, unknown>,
  masterKey: Buffer
): EncryptedPayloadEnvelope {
  if (!masterKey || masterKey.length !== KEY_BYTES) {
    throw new Error(`credential master key must be ${KEY_BYTES} bytes`);
  }
  const dek = randomBytes(KEY_BYTES);
  try {
    const sealed = aesGcmSeal(dek, Buffer.from(JSON.stringify(payload), 'utf-8'));
    const wrapped = aesGcmSeal(masterKey, dek);
    return { enc: ENVELOPE_VERSION, alg: ENVELOPE_ALG, key: wrapped, ...sealed };
  } finally {
    dek.fill(0);
  }
}

/** Decrypt a stored envelope back to the channel payload. Throws on tamper/wrong key. */
export function decryptCredentialPayload(
  envelope: EncryptedPayloadEnvelope,
  masterKey: Buffer
): Record<string, unknown> {
  if (!masterKey || masterKey.length !== KEY_BYTES) {
    throw new Error(`credential master key must be ${KEY_BYTES} bytes`);
  }
  const dek = aesGcmOpen(masterKey, envelope.key);
  try {
    const plaintext = aesGcmOpen(dek, envelope);
    return JSON.parse(plaintext.toString('utf-8')) as Record<string, unknown>;
  } finally {
    dek.fill(0);
  }
}
