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
 * Rollout safety: everything gated behind CREDENTIAL_STORE_ENABLED (default
 * "false"). While the flag is off, no code path reads or writes this table
 * and the legacy per-deployment credentials remain the only source.
 */
import { Pool } from 'pg';

export type CredentialChannel = 'whatsapp' | 'telegram' | 'instagram';

export const CREDENTIAL_CHANNELS: readonly CredentialChannel[] = [
  'whatsapp',
  'telegram',
  'instagram',
] as const;

export interface StoredCredential {
  sessionKey: string;
  channel: CredentialChannel;
  /** Opaque channel payload as persisted (jsonb). */
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
}

/** Feature flag for the whole credential-store plumbing. OFF unless explicitly "true". */
export function credentialStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CREDENTIAL_STORE_ENABLED === 'true';
}

/**
 * Postgres-backed store (DB `whatsappmcp`, same DATABASE_URL as the server and
 * connectors). Persistence = the DB: rows survive gateway and pod restarts.
 * Table created by migration 007_user_channel_credentials.sql.
 */
export class PostgresCredentialStore implements CredentialStore {
  constructor(private readonly pool: Pool) {}

  async get(sessionKey: string, channel: CredentialChannel): Promise<StoredCredential | null> {
    const result = await this.pool.query(
      `SELECT session_key, channel, payload, updated_at
         FROM user_channel_credentials
        WHERE session_key = $1 AND channel = $2`,
      [sessionKey, channel]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      sessionKey: row.session_key as string,
      channel: row.channel as CredentialChannel,
      payload: row.payload as Record<string, unknown>,
      updatedAt: row.updated_at as Date,
    };
  }

  async put(
    sessionKey: string,
    channel: CredentialChannel,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_channel_credentials (session_key, channel, payload, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (session_key, channel)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [sessionKey, channel, JSON.stringify(payload)]
    );
  }
}
