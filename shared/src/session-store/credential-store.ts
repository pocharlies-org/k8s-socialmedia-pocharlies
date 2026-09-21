/**
 * SC-552 multi-user socialmedia: the single per-user credential store.
 *
 * CTO ruling (13-09-2026, SC-552 comment): WhatsApp (baileys), Telegram
 * (mtcute) and Instagram (Graph token) have three different pairing
 * mechanisms but one common problem — persisting a session credential keyed by
 * the real user's `sub` (the JWT claim the AgentGateway already verifies and
 * forwards as `x-user-sub`). ONE store keyed by `sub`, three channel adapters
 * on top; three parallel stores would be three places where another user's
 * account could leak.
 *
 * The payload is opaque jsonb: the store never interprets it. Channel
 * adapters (./adapters/) own serialization per channel.
 *
 * SC-705 phase 1.5: the payload is stored ENCRYPTED (./payload-crypto.ts —
 * envelope AES-256-GCM with a per-row data key wrapped by the master key from
 * CREDENTIAL_STORE_MASTER_KEY). put() encrypts, get() decrypts: the DB never
 * sees plaintext and callers keep exchanging the plain channel payload. The
 * module lives in `shared/` because both the mcp-server (resolver path) and
 * the whatsapp-web connector (session load + saveCreds write-back) speak to
 * this store — one implementation, one place credentials could leak.
 *
 * Rollout safety: everything gated behind CREDENTIAL_STORE_ENABLED (default
 * "false"). While the flag is off, no code path reads or writes this table
 * and the legacy per-deployment credentials remain the only source.
 */
import { Pool } from 'pg';
import {
  credentialMasterKeyFromEnv,
  decryptCredentialPayload,
  encryptCredentialPayload,
  isEncryptedPayloadEnvelope,
} from './payload-crypto';

export type CredentialChannel = 'whatsapp' | 'telegram' | 'instagram';

export const CREDENTIAL_CHANNELS: readonly CredentialChannel[] = [
  'whatsapp',
  'telegram',
  'instagram',
] as const;

export interface StoredCredential {
  sessionKey: string;
  channel: CredentialChannel;
  /** Opaque channel payload, decrypted for the caller (encrypted on disk). */
  payload: Record<string, unknown>;
  updatedAt: Date;
}

export interface CredentialStore {
  get(sessionKey: string, channel: CredentialChannel): Promise<StoredCredential | null>;
  put(
    sessionKey: string,
    channel: CredentialChannel,
    payload: Record<string, unknown>
  ): Promise<void>;
  /**
   * Remove a row — used when the session itself dies (baileys `loggedOut`:
   * the user unlinked the device from their phone, the stored credential is
   * dead and must not resurrect on the next start).
   */
  delete(sessionKey: string, channel: CredentialChannel): Promise<void>;
}

/** Feature flag for the whole credential-store plumbing. OFF unless explicitly "true". */
export function credentialStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CREDENTIAL_STORE_ENABLED === 'true';
}

/**
 * Postgres-backed store (DB `whatsappmcp`, same DATABASE_URL as the server and
 * connectors). Persistence = the DB: rows survive gateway and pod restarts.
 * Table created by migration 007_user_channel_credentials.sql. It is NOT
 * applied yet: the `whatsapp-mcp-migrate` PreSync Job rides PR2 together
 * with the image re-pin (k8s/base/manifest.yaml carries the deferral note;
 * migrate.ts keeps the `_migrations` ledger that makes the chain idempotent).
 *
 * Encryption: the master key is resolved once at construction from
 * `opts.masterKey` (test seam) or CREDENTIAL_STORE_MASTER_KEY in the
 * environment. put()/get() of an envelope fail closed when it is missing —
 * see payload-crypto.ts for the envelope format.
 */
export class PostgresCredentialStore implements CredentialStore {
  private readonly masterKey: Buffer | null;

  constructor(
    private readonly pool: Pool,
    opts?: { masterKey?: Buffer | null }
  ) {
    this.masterKey = opts?.masterKey !== undefined ? opts.masterKey : credentialMasterKeyFromEnv();
  }

  async get(sessionKey: string, channel: CredentialChannel): Promise<StoredCredential | null> {
    const result = await this.pool.query(
      `SELECT session_key, channel, payload, updated_at
         FROM user_channel_credentials
        WHERE session_key = $1 AND channel = $2`,
      [sessionKey, channel]
    );
    const row = result.rows[0];
    if (!row) return null;
    const stored = row.payload as unknown;
    let payload: Record<string, unknown>;
    if (isEncryptedPayloadEnvelope(stored)) {
      if (!this.masterKey) {
        throw new Error(
          'credential store row is encrypted but CREDENTIAL_STORE_MASTER_KEY is not set'
        );
      }
      payload = decryptCredentialPayload(stored, this.masterKey);
    } else {
      // Fail closed: this table has never held plaintext (it shipped with
      // encryption). A non-envelope row means someone wrote around the app —
      // serving it would silently bypass the encryption guarantee.
      throw new Error(
        `credential store row ${sessionKey}/${channel} is not an encryption envelope; refusing plaintext`
      );
    }
    return {
      sessionKey: row.session_key as string,
      channel: row.channel as CredentialChannel,
      payload,
      updatedAt: row.updated_at as Date,
    };
  }

  async put(
    sessionKey: string,
    channel: CredentialChannel,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.masterKey) {
      throw new Error(
        'CREDENTIAL_STORE_MASTER_KEY is not set: refusing to write credentials in plaintext'
      );
    }
    const envelope = encryptCredentialPayload(payload, this.masterKey);
    await this.pool.query(
      `INSERT INTO user_channel_credentials (session_key, channel, payload, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (session_key, channel)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [sessionKey, channel, JSON.stringify(envelope)]
    );
  }

  async delete(sessionKey: string, channel: CredentialChannel): Promise<void> {
    await this.pool.query(
      `DELETE FROM user_channel_credentials WHERE session_key = $1 AND channel = $2`,
      [sessionKey, channel]
    );
  }
}
