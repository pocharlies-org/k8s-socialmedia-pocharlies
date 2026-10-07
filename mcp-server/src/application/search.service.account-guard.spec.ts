/**
 * SKIRM-107 C4: the cross-account guard in accountKey and the two searches that
 * walk EVERY namespace when no account is given (keyword: inEveryNamespace;
 * semantic: brainScopes). An id that already names an account is that
 * account's alone: it neither throws nor widens to the other namespaces.
 */
jest.mock('pino', () => ({
  __esModule: true,
  default: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { join } from 'node:path';
import { resetAccountRegistryCache } from '../domain/account-registry';
import { SearchService } from './search.service';

const BRAIN = { url: 'http://brain', apiKey: 'k', timeoutMs: 1000, minScore: 0.2 };

function useRegistry(file?: string): void {
  if (file) process.env.SOCIAL_ACCOUNTS_FILE = file;
  else delete process.env.SOCIAL_ACCOUNTS_FILE;
  resetAccountRegistryCache();
}

function keyword() {
  const query = jest.fn(async (_sql: string, _params: unknown[]) => ({ rows: [] }));
  return { query, svc: new SearchService({ query } as any, null) };
}

afterAll(() => useRegistry());

describe('keywordSearch without an account (inEveryNamespace)', () => {
  beforeAll(() => useRegistry());

  it('a bare id is looked up under every declared namespace, as before', async () => {
    const { query, svc } = keyword();
    await svc.keywordSearch('hola', { chatId: '42@s.whatsapp.net', sender: '42@s.whatsapp.net' });
    const params = query.mock.calls[0][1];
    const every = [
      '42@s.whatsapp.net',
      'professional:42@s.whatsapp.net',
      'leila:42@s.whatsapp.net',
    ];
    expect(params[1]).toEqual(every);
    expect(params[2]).toEqual(every);
  });

  it("an id that already names an account is that account's alone: no throw, no widening", async () => {
    const { query, svc } = keyword();
    await svc.keywordSearch('hola', {
      chatId: 'professional:42@s.whatsapp.net',
      sender: 'leila:42@s.whatsapp.net',
    });
    const params = query.mock.calls[0][1];
    expect(params[1]).toEqual(['professional:42@s.whatsapp.net']);
    expect(params[2]).toEqual(['leila:42@s.whatsapp.net']);
  });

  it('with an account, an id namespaced to ANOTHER account is refused, not searched', async () => {
    const { query, svc } = keyword();
    await expect(
      svc.keywordSearch('hola', { account: 'professional', chatId: 'leila:42@s.whatsapp.net' })
    ).rejects.toThrow('Cross-account identifier');
    await expect(
      svc.keywordSearch('hola', { account: 'professional', sender: 'leila:42@s.whatsapp.net' })
    ).rejects.toThrow('Cross-account identifier');
    expect(query).not.toHaveBeenCalled();
  });

  it('with an account, its own prefix is idempotent and a bare id is namespaced', async () => {
    const { query, svc } = keyword();
    await svc.keywordSearch('hola', {
      account: 'professional',
      chatId: 'professional:42@s.whatsapp.net',
      sender: '42@s.whatsapp.net',
    });
    const params = query.mock.calls[0][1];
    expect(params).toContain('professional:42@s.whatsapp.net');
    expect(params.filter(p => p === 'professional:42@s.whatsapp.net')).toHaveLength(2);
  });
});

describe('keywordSearch without an account, registry with a DISABLED account', () => {
  beforeAll(() => useRegistry(join(__dirname, '../domain/accounts.fixture.json')));
  afterAll(() => useRegistry());

  it('walks the disabled namespace too (its historical rows keep their prefix) and never throws', async () => {
    const { query, svc } = keyword();
    await svc.keywordSearch('hola', { chatId: '42@s.whatsapp.net' });
    expect(query.mock.calls[0][1][1]).toEqual(
      expect.arrayContaining([
        '42@s.whatsapp.net',
        'secondary:42@s.whatsapp.net',
        'disabled:42@s.whatsapp.net',
      ])
    );
  });

  it('an id of the disabled namespace is looked up as is', async () => {
    const { query, svc } = keyword();
    await svc.keywordSearch('hola', { chatId: 'disabled:42@s.whatsapp.net' });
    expect(query.mock.calls[0][1][1]).toEqual(['disabled:42@s.whatsapp.net']);
  });
});

describe('semanticSearch without an account (brainScopes)', () => {
  beforeAll(() => useRegistry());

  function brainSvc() {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({ documents: [], instance_id: url.split('/instances/')[1].split('/')[0] }),
        {
          status: 200,
        }
      );
    });
    const svc = new SearchService(
      { query: jest.fn(async () => ({ rows: [] })) } as any,
      BRAIN,
      fetchImpl
    );
    return { calls, svc };
  }

  it('a bare chat id asks every account, each with its own namespaced id, as before', async () => {
    const { calls, svc } = brainSvc();
    await svc.semanticSearch('hola', { chatId: '42@s.whatsapp.net' });
    const byAccount = Object.fromEntries(
      calls.map(c => [c.body.filters.account, c.body.filters.conversation_ids])
    );
    expect(byAccount).toEqual({
      personal: ['42@s.whatsapp.net'],
      professional: ['professional:42@s.whatsapp.net'],
      leila: ['leila:42@s.whatsapp.net'],
    });
  });

  it("a chat id that names an account asks only that account's instance, without throwing", async () => {
    const { calls, svc } = brainSvc();
    await svc.semanticSearch('hola', { chatId: 'professional:42@s.whatsapp.net' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://brain/instances/skirmshop/search');
    expect(calls[0].body.filters).toMatchObject({
      account: 'professional',
      conversation_ids: ['professional:42@s.whatsapp.net'],
    });
  });

  it('resolves the rows of its hit with that id alone (messagesById), not under every namespace', async () => {
    const query = jest.fn(async (_sql: string, _params: unknown[]) => ({ rows: [] }));
    const fetchImpl = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            documents: [
              {
                text: 'fragmento',
                score: 0.9,
                metadata: {
                  type: 'conversation_chunk',
                  account: 'professional',
                  message_ids: ['3EB0A'],
                  conversation_id: 'professional:42@s.whatsapp.net',
                },
              },
            ],
            instance_id: 'skirmshop',
          }),
          { status: 200 }
        )
    );
    await new SearchService({ query } as any, BRAIN, fetchImpl).semanticSearch('hola', {
      chatId: 'professional:42@s.whatsapp.net',
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('m.conversation_id = ANY(');
    expect(params).toContainEqual(['professional:42@s.whatsapp.net']);
  });

  it('searchDetailed does not turn that into a text fallback with a guard error', async () => {
    const { svc } = brainSvc();
    const out = await svc.searchDetailed('hola', { chatId: 'professional:42@s.whatsapp.net' });
    expect(out.fallbackReason ?? '').not.toContain('Cross-account');
  });
});
