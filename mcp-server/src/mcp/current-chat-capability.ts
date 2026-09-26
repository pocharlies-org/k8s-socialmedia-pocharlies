import { createHmac, timingSafeEqual } from 'node:crypto';
import { requireAccount } from '../domain/account-registry';
import { stripAccount } from '../domain/account';

export type CurrentChatOperation = 'read' | 'propose' | 'send';
export interface CurrentChatCapability {
  account: string;
  chat: string;
  exp: number;
  ops: CurrentChatOperation[];
  requestId?: string;
  turn: string;
}

const MAX_TTL_SECONDS = 300;

export function verifyCurrentChatCapability(
  token: unknown,
  operation: CurrentChatOperation,
  nowSeconds = Math.floor(Date.now() / 1000)
): CurrentChatCapability {
  const secret = process.env.HERMES_CHAT_TOOL_SECRET;
  if (!secret || typeof token !== 'string' || token.length > 2048) {
    throw new Error('Invalid current-chat capability');
  }
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) throw new Error('Invalid current-chat capability');

  const [, encodedPayload, encodedSignature] = match;
  const expected = createHmac('sha256', secret).update(encodedPayload).digest();
  const supplied = Buffer.from(encodedSignature, 'base64url');
  if (
    supplied.length !== expected.length ||
    supplied.toString('base64url') !== encodedSignature ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new Error('Invalid current-chat capability');
  }

  let payload: unknown;
  try {
    const bytes = Buffer.from(encodedPayload, 'base64url');
    if (bytes.toString('base64url') !== encodedPayload) throw new Error('Invalid encoding');
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Invalid current-chat capability');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid current-chat capability');
  }
  const value = payload as Record<string, unknown>;
  if (
    !['account,chat,exp,ops,turn', 'account,chat,exp,ops,requestId,turn'].includes(
      Object.keys(value).sort().join(',')
    ) ||
    typeof value.account !== 'string' ||
    !value.account ||
    typeof value.chat !== 'string' ||
    !value.chat ||
    value.chat.length > 256 ||
    typeof value.turn !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.turn) ||
    !Number.isSafeInteger(value.exp) ||
    (value.exp as number) <= nowSeconds ||
    (value.exp as number) > nowSeconds + MAX_TTL_SECONDS ||
    !Array.isArray(value.ops) ||
    value.ops.length === 0 ||
    value.ops.some(op => op !== 'read' && op !== 'propose' && op !== 'send') ||
    (value.requestId !== undefined &&
      (typeof value.requestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value.requestId
        ))) ||
    (operation === 'send' && !value.requestId) ||
    !value.ops.includes(operation)
  ) {
    throw new Error('Invalid current-chat capability');
  }

  requireAccount('whatsapp', value.account);
  const parsed = stripAccount(value.chat);
  if (parsed.id !== value.chat && parsed.account !== value.account) {
    throw new Error('Invalid current-chat capability');
  }
  if (!/^[^\s@]+@(?:s\.whatsapp\.net|c\.us|g\.us|lid|hosted\.lid)$/.test(parsed.id)) {
    throw new Error('Invalid current-chat capability');
  }
  return value as unknown as CurrentChatCapability;
}
