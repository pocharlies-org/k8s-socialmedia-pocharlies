import { createHash, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { requireAccount } from '../domain/account-registry';
import { stripAccount } from '../domain/account';
import type { CurrentChatCapability } from './current-chat-capability';

export interface CurrentChatProposal {
  id: string;
  account: string;
  chat: string;
  turn: string;
  text: string;
  createdAt: string;
  expiresAt: string;
}

const PROPOSAL_TTL_SECONDS = 600;
const TURN_TTL_SECONDS = 300;

export function validateCurrentChatScope(account: unknown, chat: unknown, turn?: unknown): void {
  if (typeof account !== 'string' || typeof chat !== 'string' || !chat || chat.length > 256) {
    throw new Error('Invalid current-chat scope');
  }
  requireAccount('whatsapp', account);
  const parsed = stripAccount(chat);
  if (
    (parsed.id !== chat && parsed.account !== account) ||
    !/^[^\s@]+@(?:s\.whatsapp\.net|c\.us|g\.us|lid|hosted\.lid)$/.test(parsed.id)
  ) {
    throw new Error('Invalid current-chat scope');
  }
  if (
    turn !== undefined &&
    (typeof turn !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(turn))
  ) {
    throw new Error('Invalid current-chat turn');
  }
}

function scopeHash(account: string, chat: string): string {
  return createHash('sha256').update(`${account}\0${chat}`).digest('hex');
}

function keys(account: string, chat: string) {
  const hash = scopeHash(account, chat);
  return {
    active: `social:hermes:active:${hash}`,
    index: `social:hermes:proposals:${hash}`,
  };
}

const REVOKE_TURN = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

const CREATE_PROPOSAL = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {'inactive', ''} end
local prior = redis.call('GET', KEYS[4])
if prior then
  local item = cjson.decode(prior)
  if item.hash ~= ARGV[2] then return {'conflict', ''} end
  if redis.call('EXISTS', 'social:hermes:proposal:' .. item.id) == 0 then return {'gone', item.id} end
  return {'replayed', item.id}
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[6])
if redis.call('ZCARD', KEYS[2]) >= 100 then return {'limit', ''} end
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4], 'NX')
redis.call('ZADD', KEYS[2], ARGV[7], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[4])
redis.call('SET', KEYS[4], cjson.encode({id=ARGV[5], hash=ARGV[2]}), 'EX', ARGV[4])
return {'created', ARGV[5]}`;

const CONSUME_PROPOSAL = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local item = cjson.decode(raw)
if item.account ~= ARGV[1] or item.chat ~= ARGV[2] or item.turn ~= ARGV[3] then
  return nil
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], item.id)
return raw`;

export async function activateCurrentChatTurn(
  redis: Redis,
  account: string,
  chat: string,
  turn: string,
  ttl: number
): Promise<void> {
  validateCurrentChatScope(account, chat, turn);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > TURN_TTL_SECONDS) {
    throw new Error('Invalid current-chat turn TTL');
  }
  await redis.set(keys(account, chat).active, turn, 'EX', ttl);
}

export async function revokeCurrentChatTurn(
  redis: Redis,
  account: string,
  chat: string,
  turn: string
): Promise<void> {
  validateCurrentChatScope(account, chat, turn);
  await redis.eval(REVOKE_TURN, 1, keys(account, chat).active, turn);
}

export async function requireCurrentChatTurn(
  redis: Redis,
  scope: CurrentChatCapability
): Promise<void> {
  if ((await redis.get(keys(scope.account, scope.chat).active)) !== scope.turn) {
    throw new Error('Current-chat turn is no longer active');
  }
}

export async function createCurrentChatProposal(
  redis: Redis,
  scope: CurrentChatCapability,
  text: string,
  idempotencyKey: string
): Promise<{ proposal: CurrentChatProposal; replayed: boolean }> {
  const id = randomUUID();
  const now = Date.now();
  const proposal: CurrentChatProposal = {
    id,
    account: scope.account,
    chat: scope.chat,
    turn: scope.turn,
    text,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PROPOSAL_TTL_SECONDS * 1000).toISOString(),
  };
  const scopeKeys = keys(scope.account, scope.chat);
  const contentHash = createHash('sha256').update(text).digest('hex');
  const idemHash = createHash('sha256')
    .update(`${scope.account}\0${scope.chat}\0${scope.turn}\0${idempotencyKey}`)
    .digest('hex');
  const result = await redis.eval(
    CREATE_PROPOSAL,
    4,
    scopeKeys.active,
    scopeKeys.index,
    `social:hermes:proposal:${id}`,
    `social:hermes:proposal-idem:${idemHash}`,
    scope.turn,
    contentHash,
    JSON.stringify(proposal),
    PROPOSAL_TTL_SECONDS,
    id,
    now,
    now + PROPOSAL_TTL_SECONDS * 1000
  );
  const [status, actualId] = result as [string, string];
  if (status === 'replayed') {
    const stored = await redis.get(`social:hermes:proposal:${actualId}`);
    if (!stored) throw new Error('Proposal is no longer pending');
    return { proposal: JSON.parse(stored) as CurrentChatProposal, replayed: true };
  }
  if (status !== 'created') throw new Error(`Proposal rejected: ${status}`);
  return { proposal, replayed: false };
}

export async function listCurrentChatProposals(
  redis: Redis,
  account: string,
  chat: string
): Promise<CurrentChatProposal[]> {
  validateCurrentChatScope(account, chat);
  const ids = await redis.zrevrange(keys(account, chat).index, 0, 99);
  if (!ids.length) return [];
  const values = await redis.mget(ids.map(id => `social:hermes:proposal:${id}`));
  return values
    .filter((value): value is string => value !== null)
    .map(value => JSON.parse(value) as CurrentChatProposal)
    .filter(item => item.account === account && item.chat === chat);
}

export async function consumeCurrentChatProposal(
  redis: Redis,
  id: string,
  account: string,
  chat: string,
  turn: string
): Promise<CurrentChatProposal | null> {
  validateCurrentChatScope(account, chat, turn);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid proposal id');
  const raw = await redis.eval(
    CONSUME_PROPOSAL,
    2,
    `social:hermes:proposal:${id}`,
    keys(account, chat).index,
    account,
    chat,
    turn
  );
  return raw ? (JSON.parse(String(raw)) as CurrentChatProposal) : null;
}
