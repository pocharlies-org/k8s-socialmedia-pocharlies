// SC-2185: after a valkey sentinel failover a client pinned to REDIS_URL keeps
// writing to the demoted master (READONLY). With REDIS_SENTINELS +
// REDIS_MASTER_NAME the client must be built in sentinel mode instead.
const RedisCtor = jest.fn().mockImplementation(() => ({}));
jest.mock('ioredis', () => ({ __esModule: true, default: RedisCtor }));

import { createRedisClient } from './redis-client';

const URL = 'redis://socialmedia:sec%23ret@shared-valkey-master.databases.svc.cluster.local:6379/0';

describe('createRedisClient (SC-2185)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    RedisCtor.mockClear();
  });

  it('without sentinel vars keeps the plain-URL behaviour', () => {
    delete process.env.REDIS_SENTINELS;
    delete process.env.REDIS_MASTER_NAME;
    createRedisClient(URL, { maxRetriesPerRequest: 2 });
    expect(RedisCtor).toHaveBeenCalledWith(URL, { maxRetriesPerRequest: 2 });
  });

  it('with sentinel vars builds a sentinel client carrying the URL credentials', () => {
    process.env.REDIS_SENTINELS =
      'shared-valkey-sentinel.databases.svc.cluster.local:26379';
    process.env.REDIS_MASTER_NAME = 'shared-cache-master';
    createRedisClient(URL, {});
    expect(RedisCtor).toHaveBeenCalledWith({
      sentinels: [{ host: 'shared-valkey-sentinel.databases.svc.cluster.local', port: 26379 }],
      name: 'shared-cache-master',
      username: 'socialmedia',
      password: 'sec#ret',
      db: 0,
    });
  });

  it('parses several sentinels and defaults the port', () => {
    process.env.REDIS_SENTINELS = 'a:26379,b';
    process.env.REDIS_MASTER_NAME = 'shared-cache-master';
    createRedisClient('redis://h:6379/1', {});
    const opts = RedisCtor.mock.calls[0][0];
    expect(opts.sentinels).toEqual([
      { host: 'a', port: 26379 },
      { host: 'b', port: 26379 },
    ]);
    expect(opts.db).toBe(1);
    expect(opts.password).toBeUndefined();
  });

  it('only one of the two vars falls back to the plain URL', () => {
    process.env.REDIS_SENTINELS = 'a:26379';
    createRedisClient(URL, {});
    expect(RedisCtor).toHaveBeenCalledWith(URL, {});
  });
});
