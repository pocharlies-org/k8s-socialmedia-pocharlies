import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import Redis from 'ioredis';
import {
  activateCurrentChatTurn, revokeCurrentChatTurn, requireCurrentChatTurn,
  createCurrentChatProposal, listCurrentChatProposals, consumeCurrentChatProposal,
} from './current-chat-proposals';
import type { CurrentChatCapability } from './current-chat-capability';

const available = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0;
const run = available ? describe : describe.skip;
const account = 'personal';
const chat = 'personal:123456789@s.whatsapp.net';
const turn = '11111111-1111-4111-8111-111111111111';
const nextTurn = '22222222-2222-4222-8222-222222222222';

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

run('current-chat proposals with Redis', () => {
  let processHandle: ChildProcess;
  let redis: Redis;

  beforeAll(async () => {
    const port = await unusedPort();
    processHandle = spawn('redis-server', [
      '--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no',
    ], { stdio: 'ignore' });
    redis = new Redis(port, '127.0.0.1', { retryStrategy: () => 50, maxRetriesPerRequest: 10 });
    await redis.ping();
  });

  afterAll(async () => {
    if (redis) await redis.quit();
    if (processHandle) processHandle.kill('SIGTERM');
  });

  test('turn replacement revokes old capability and old finally cannot revoke the new turn', async () => {
    const scope: CurrentChatCapability = {
      account, chat, turn, exp: Math.floor(Date.now() / 1000) + 120, ops: ['read', 'propose'],
    };
    await activateCurrentChatTurn(redis, account, chat, turn, 300);
    await requireCurrentChatTurn(redis, scope);
    await activateCurrentChatTurn(redis, account, chat, nextTurn, 300);
    await expect(requireCurrentChatTurn(redis, scope)).rejects.toThrow();
    await revokeCurrentChatTurn(redis, account, chat, turn);
    await requireCurrentChatTurn(redis, { ...scope, turn: nextTurn });
    await revokeCurrentChatTurn(redis, account, chat, nextTurn);
    await expect(requireCurrentChatTurn(redis, { ...scope, turn: nextTurn })).rejects.toThrow();
  });

  test('proposal is scoped, idempotent, one-time and expires from pending list', async () => {
    const scope: CurrentChatCapability = {
      account, chat, turn, exp: Math.floor(Date.now() / 1000) + 120, ops: ['propose'],
    };
    await activateCurrentChatTurn(redis, account, chat, turn, 300);
    const first = await createCurrentChatProposal(redis, scope, 'Exact text', 'request-1');
    const replay = await createCurrentChatProposal(redis, scope, 'Exact text', 'request-1');
    expect(replay).toMatchObject({ replayed: true, proposal: { id: first.proposal.id } });
    await expect(createCurrentChatProposal(redis, scope, 'Changed', 'request-1')).rejects.toThrow('conflict');
    expect(await listCurrentChatProposals(redis, account, chat)).toContainEqual(first.proposal);
    expect(await consumeCurrentChatProposal(redis, first.proposal.id, account,
      'personal:999999999@s.whatsapp.net', turn)).toBeNull();
    expect(await consumeCurrentChatProposal(redis, first.proposal.id, account, chat,
      nextTurn)).toBeNull();
    expect(await consumeCurrentChatProposal(redis, first.proposal.id, account, chat,
      turn)).toEqual(first.proposal);
    expect(await consumeCurrentChatProposal(redis, first.proposal.id, account, chat,
      turn)).toBeNull();
    await expect(createCurrentChatProposal(redis, scope, 'Exact text', 'request-1')).rejects.toThrow('gone');

    const expiring = await createCurrentChatProposal(redis, scope, 'Soon gone', 'request-2');
    await redis.expire(`social:hermes:proposal:${expiring.proposal.id}`, 1);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(await listCurrentChatProposals(redis, account, chat)).toEqual([]);
  });
});
