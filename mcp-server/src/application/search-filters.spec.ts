import { Pool } from 'pg';
import { useTestAccounts } from '../domain/test-accounts';
import { SearchService, type SearchOptions } from './search.service';

jest.mock('pino', () => ({
  __esModule: true,
  default: () => ({ info: jest.fn(), warn: jest.fn() }),
}));

const BRAIN = { url: 'http://brain', apiKey: 'test-key', timeoutMs: 1000, minScore: 0.2 };

function brainReply() {
  return jest.fn(async (url: string) => new Response(JSON.stringify({
    instance_id: url.includes('/skirmshop/') ? 'skirmshop' : 'personal',
    documents: [{ score: 0.9, metadata: {
      type: 'conversation_chunk', account: 'professional', message_ids: ['message-id'],
    } }],
  })));
}

beforeEach(() => {
  useTestAccounts({ whatsapp: { personal: 'http://wa-personal', professional: 'http://wa-professional' } });
});

test.each(['keywordSearch', 'semanticSearch'] as const)(
  '%s preserves account isolation and parameter order with every optional filter',
  async strategy => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const service = new SearchService({ query } as unknown as Pool, BRAIN, brainReply());
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-02T00:00:00Z');
    const options: SearchOptions = {
      account: 'professional', platform: 'whatsapp', chatId: '42@lid',
      sender: '99@lid', from, to, limit: 7,
    };
    await service[strategy]('needle', options);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params.slice(1)).toEqual([
      ['whatsapp:professional'], ['professional:42@lid'], from, to,
      ['professional:99@lid'], ['professional'], 'whatsapp',
      ...(strategy === 'keywordSearch' ? [7] : []),
    ]);
    expect(sql).toContain('m.conversation_id = ANY($3::text[])');
    expect(sql).toContain('m.wa_timestamp >= $4');
    expect(sql).toContain('m.wa_timestamp <= $5');
    expect(sql).toContain('m.sender_wa_id = ANY($6::text[])');
    expect(sql).toContain('m.account = ANY($7::text[])');
    expect(sql).toContain('m.platform = $8');
    if (strategy === 'keywordSearch') expect(sql).toContain('LIMIT $9');
    else expect(sql).toContain("m.platform IN ('whatsapp', 'telegram')");
  }
);

test.each(['keywordSearch', 'semanticSearch'] as const)(
  '%s drops chat and sender keys belonging to another account', async strategy => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const fetchImpl = brainReply();
    const service = new SearchService({ query } as unknown as Pool, BRAIN, fetchImpl);
    await service[strategy]('needle', {
      account: 'personal', platform: 'whatsapp',
      chatId: 'professional:42@lid', sender: 'professional:99@lid',
    });
    if (strategy === 'keywordSearch') {
      expect(query.mock.calls[0][1].slice(1)).toEqual([
        ['whatsapp:personal'], [], [], ['personal'], 'whatsapp', 20,
      ]);
    } else {
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    }
  }
);

test('Instagram selectors filter provider account and namespace separately', async () => {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const fetchImpl = brainReply();
  const service = new SearchService({ query } as unknown as Pool, BRAIN, fetchImpl);
  await service.searchDetailed('needle', {
    platform: 'instagram', account: 'skirmshop', chatId: '42', sender: '99',
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(query.mock.calls[0][1]).toEqual([
    'needle', ['instagram:skirmshop'], ['ig_skirmshop_thread_42'],
    ['ig_skirmshop_99'], ['professional'], 'instagram', 20,
  ]);
});

test('raw PN/LID identifiers are retained together with the provider account boundary', async () => {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const service = new SearchService({ query } as unknown as Pool, null);
  await service.keywordSearch('needle', {
    account: 'professional', platform: 'whatsapp', rawIds: true,
    chatId: '42@lid', sender: '99@s.whatsapp.net', mediaType: 'image',
  });
  expect(query.mock.calls[0][1]).toEqual([
    'needle', ['whatsapp:professional'], ['42@lid'], ['99@s.whatsapp.net'],
    ['professional'], 'whatsapp', ['IMAGE', 'PHOTO', 'ALBUM', 'ALBUMMESSAGE', 'CAROUSEL_ALBUM'], 20,
  ]);
});
