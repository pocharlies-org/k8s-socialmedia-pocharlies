/**
 * SC-552 channel adapter — Instagram / Graph API.
 *
 * The instagram connector (connectors/instagram/src/main.ts) loads accounts
 * from the indexed env `INSTAGRAM_ACCOUNTS` + `INSTAGRAM_<N>_*`: a
 * (long-lived, non-expiring) system-user access token plus the business
 * account id and optional app credentials. This adapter keeps that shape as
 * the store payload.
 */
export interface InstagramTokenPayload {
  accessToken: string;
  businessAccountId: string;
  appId?: string;
  appSecret?: string;
  fbAccessToken?: string;
  /**
   * SC-1194 P1 — Instagram Login (graph.instagram.com) long-lived tokens are
   * 60-day tokens that must be refreshed, unlike the non-expiring Facebook
   * Login system-user tokens the house accounts use. Pairing records the
   * identity (`username`, `instagramUserId`) and the lifetime
   * (`expiresAt`/`issuedAt`, epoch ms) so the connector can refresh on use.
   * All optional: legacy/env-shaped payloads stay valid.
   */
  username?: string;
  instagramUserId?: string;
  expiresAt?: number;
  issuedAt?: number;
}

export function serializeInstagramToken(input: {
  accessToken: string;
  businessAccountId: string;
  appId?: string;
  appSecret?: string;
  fbAccessToken?: string;
  username?: string;
  instagramUserId?: string;
  expiresAt?: number;
  issuedAt?: number;
}): InstagramTokenPayload {
  if (typeof input.accessToken !== 'string' || input.accessToken.trim() === '') {
    throw new Error('invalid instagram credential: empty access token');
  }
  if (typeof input.businessAccountId !== 'string') {
    throw new Error('invalid instagram credential: missing businessAccountId');
  }
  const payload: InstagramTokenPayload = {
    accessToken: input.accessToken,
    businessAccountId: input.businessAccountId,
  };
  if (input.appId) payload.appId = input.appId;
  if (input.appSecret) payload.appSecret = input.appSecret;
  if (input.fbAccessToken) payload.fbAccessToken = input.fbAccessToken;
  if (input.username) payload.username = input.username;
  if (input.instagramUserId) payload.instagramUserId = input.instagramUserId;
  if (typeof input.expiresAt === 'number') payload.expiresAt = input.expiresAt;
  if (typeof input.issuedAt === 'number') payload.issuedAt = input.issuedAt;
  return payload;
}

export function deserializeInstagramToken(payload: unknown): InstagramTokenPayload {
  const value = payload as InstagramTokenPayload | undefined;
  if (!value || typeof value.accessToken !== 'string' || value.accessToken.trim() === '') {
    throw new Error('invalid instagram payload: missing `accessToken`');
  }
  if (typeof value.businessAccountId !== 'string') {
    throw new Error('invalid instagram payload: missing `businessAccountId`');
  }
  const result: InstagramTokenPayload = {
    accessToken: value.accessToken,
    businessAccountId: value.businessAccountId,
  };
  for (const optional of [
    'appId',
    'appSecret',
    'fbAccessToken',
    'username',
    'instagramUserId',
  ] as const) {
    if (typeof value[optional] === 'string' && value[optional] !== '') {
      result[optional] = value[optional];
    }
  }
  for (const numeric of ['expiresAt', 'issuedAt'] as const) {
    if (typeof value[numeric] === 'number' && Number.isFinite(value[numeric])) {
      result[numeric] = value[numeric];
    }
  }
  return result;
}
