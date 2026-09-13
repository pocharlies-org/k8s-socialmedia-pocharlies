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
}

export function serializeInstagramToken(input: {
  accessToken: string;
  businessAccountId: string;
  appId?: string;
  appSecret?: string;
  fbAccessToken?: string;
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
  for (const optional of ['appId', 'appSecret', 'fbAccessToken'] as const) {
    if (typeof value[optional] === 'string' && value[optional] !== '') {
      result[optional] = value[optional] as string;
    }
  }
  return result;
}
