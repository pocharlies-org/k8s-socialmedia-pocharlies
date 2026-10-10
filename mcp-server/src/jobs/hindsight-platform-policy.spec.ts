import { PoolClient } from 'pg';
import { configureHindsightPlatformPolicy, excludedHindsightPlatforms } from './hindsight-platform-policy';
import { drainLegacyPending, runConversationSyncPass } from './hindsight-conversation-sync';
import { SyncClient, syncOptionsFromEnv } from './hindsight-sync-lib';

describe('Hindsight platform pause', () => {
  it('defaults to no exclusions and parses known comma-separated platforms', () => {
    expect([...excludedHindsightPlatforms({})]).toEqual([]);
    expect([...excludedHindsightPlatforms({HINDSIGHT_SYNC_EXCLUDED_PLATFORMS:' telegram, instagram,telegram '})])
      .toEqual(['telegram','instagram']);
  });

  it.each(['telegarm','Telegram','telegram,','telegram,,whatsapp'])('rejects invalid policy %s before database work', async value => {
    const query = jest.fn();
    await expect(configureHindsightPlatformPolicy({query} as unknown as PoolClient,
      {HINDSIGHT_SYNC_EXCLUDED_PLATFORMS:value})).rejects.toThrow('HINDSIGHT_SYNC_EXCLUDED_PLATFORMS');
    expect(query).not.toHaveBeenCalled();
  });

  it('upserts policy transactionally without deleting queued operations or documents', async () => {
    const query = jest.fn().mockResolvedValue({rows:[]});
    await configureHindsightPlatformPolicy({query} as unknown as PoolClient,
      {HINDSIGHT_SYNC_EXCLUDED_PLATFORMS:'telegram'});
    expect(query.mock.calls[0]).toEqual(['BEGIN']);
    expect(query.mock.calls[1][0]).toContain('ON CONFLICT(platform) DO UPDATE SET enabled=EXCLUDED.enabled');
    expect(query.mock.calls[1][1]).toEqual([['whatsapp','telegram','instagram'],[true,false,true]]);
    expect(query.mock.calls[2]).toEqual(['COMMIT']);
    expect(query.mock.calls.map(([sql])=>sql).join(' ')).not.toMatch(/DELETE|TRUNCATE|hindsight_conversation_documents|hindsight_sync_ledger/);
  });

  it('re-enables each known platform when exclusions are removed', async () => {
    const query = jest.fn().mockResolvedValue({rows:[]});
    await configureHindsightPlatformPolicy({query} as unknown as PoolClient,{});
    expect(query.mock.calls[1][1][1]).toEqual([true,true,true]);
  });

  it('rolls back and propagates failure before any provider work', async () => {
    const error = new Error('policy write failed');
    const query = jest.fn().mockResolvedValue({rows:[]}).mockImplementationOnce(async()=>({rows:[]}))
      .mockRejectedValueOnce(error);
    await expect(configureHindsightPlatformPolicy({query} as unknown as PoolClient,{})).rejects.toBe(error);
    expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
  });

  const client = (): jest.Mocked<SyncClient> => ({
    getOperation:jest.fn(),retainDocument:jest.fn(),retryOperation:jest.fn(),deleteDocument:jest.fn(),
  });

  it('filters legacy pending and remaining rows, allowing conversation work past a paused legacy backlog', async () => {
    const query = jest.fn().mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{remaining:false}]});
    const provider=client();
    const result=await drainLegacyPending({query} as unknown as PoolClient,provider,'dest',syncOptionsFromEnv({}));
    expect(result.remaining).toBe(false);
    for (const [sql] of query.mock.calls) expect(sql).toContain("hindsight_platform_enabled(payload->'scope'->>'platform')");
    for (const fn of Object.values(provider)) expect(fn).not.toHaveBeenCalled();
  });

  it('filters conversation candidates even when they have persisted pending documents', async () => {
    const query=jest.fn().mockImplementation(async(sql:string)=> {
      if(sql.includes('AS remaining')) return {rows:[{remaining:false}]};
      if(sql.includes('SELECT * FROM hindsight_conversation_destinations')) return {rows:[{seeded:true}]};
      return {rows:[]};
    });
    const provider=client();
    expect(await runConversationSyncPass({query} as unknown as PoolClient,provider,'dest',[],syncOptionsFromEnv({})))
      .toEqual({selected:0,accepted:0,completed:0,failed:0});
    const candidate=query.mock.calls.find(([sql])=>sql.includes('FROM hindsight_conversation_changes'));
    expect(candidate?.[0]).toContain("AND hindsight_platform_enabled(c.scope->>'platform')");
    for (const fn of Object.values(provider)) expect(fn).not.toHaveBeenCalled();
  });
});
