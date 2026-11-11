/**
 * SKIRM-107: accountKey rechaza un id namespaced a otra cuenta. La búsqueda sin
 * cuenta recorre los namespaces habilitados con
 * un id que el cliente pudo devolver ya prefijado (`leila:...`, como lo guarda la
 * BD): eso no puede lanzar, y tampoco ensancharse a otras cuentas.
 */
jest.mock('pino', () => ({
  __esModule: true,
  default: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetAccountRegistryCache } from '../domain/account-registry';
import { SearchService } from './search.service';

const BRAIN = { url: 'http://brain', apiKey: 'k', timeoutMs: 1000, minScore: 0.2 };
const wa = (accountId: string, extra: object = {}) => ({
  channel: 'whatsapp',
  accountId,
  connectorUrl: `http://wa-${accountId}:3001`,
  ...extra,
});

let dir: string;
const previous = process.env.SOCIAL_ACCOUNTS_FILE;

/** personal + professional + leila, and `old`, a disabled account with history. */
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-namespaces-'));
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(
    file,
    JSON.stringify([wa('personal'), wa('professional'), wa('leila'), wa('old', { enabled: false })])
  );
  process.env.SOCIAL_ACCOUNTS_FILE = file;
  resetAccountRegistryCache();
});
afterAll(() => {
  if (previous === undefined) delete process.env.SOCIAL_ACCOUNTS_FILE;
  else process.env.SOCIAL_ACCOUNTS_FILE = previous;
  resetAccountRegistryCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

function keywordService() {
  const query = jest.fn(async () => ({ rows: [] }));
  return { query, service: new SearchService({ query } as any, null) };
}
const paramsOf = (query: jest.Mock) => (query.mock.calls[0] as unknown as [string, unknown[]])[1];

describe('text search account isolation', () => {
  it('a bare chat id is looked up under enabled namespaces only', async () => {
    const { query, service } = keywordService();
    await service.keywordSearch('hola', { chatId: '34600@s.whatsapp.net' });
    expect(paramsOf(query)[1]).toEqual([
      'whatsapp:personal',
      'whatsapp:professional',
      'whatsapp:leila',
    ]);
    expect(paramsOf(query)[2]).toEqual([
      '34600@s.whatsapp.net',
      'professional:34600@s.whatsapp.net',
      'leila:34600@s.whatsapp.net',
    ]);
  });

  it('an id already namespaced is looked up as given, not widened to the other accounts', async () => {
    const { query, service } = keywordService();
    await service.keywordSearch('hola', {
      chatId: 'leila:34600@s.whatsapp.net',
      sender: 'old:34600@s.whatsapp.net',
    });
    const params = paramsOf(query);
    expect(params[1]).toEqual(['whatsapp:personal', 'whatsapp:professional', 'whatsapp:leila']);
    expect(params[2]).toEqual(['leila:34600@s.whatsapp.net']);
    expect(params[3]).toEqual([]);
  });

  it('a native JID colon is not an account: it is still looked up under every namespace', async () => {
    const { query, service } = keywordService();
    await service.keywordSearch('hola', { chatId: '34600:12@s.whatsapp.net' });
    expect(paramsOf(query)[1]).toEqual([
      'whatsapp:personal',
      'whatsapp:professional',
      'whatsapp:leila',
    ]);
    expect(paramsOf(query)[2]).toEqual([
      '34600:12@s.whatsapp.net',
      'professional:34600:12@s.whatsapp.net',
      'leila:34600:12@s.whatsapp.net',
    ]);
  });

  it('with an explicit account, a foreign namespace produces an empty candidate set', async () => {
    const { query, service } = keywordService();
    await service.keywordSearch('hola', {
      account: 'professional',
      chatId: 'leila:34600@s.whatsapp.net',
    });
    expect(query).toHaveBeenCalled();
    expect(paramsOf(query)[1]).toEqual(['whatsapp:professional']);
    expect(paramsOf(query)[2]).toEqual([]);
  });

  it('with an explicit account, its own prefix is idempotent', async () => {
    const { query, service } = keywordService();
    await service.keywordSearch('hola', {
      account: 'leila',
      chatId: 'leila:34600@s.whatsapp.net',
    });
    expect(paramsOf(query)[1]).toEqual(['whatsapp:leila']);
    expect(paramsOf(query)[2]).toEqual(['leila:34600@s.whatsapp.net']);
  });
});

describe('account-less semantic search (brain scopes)', () => {
  function brainService() {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const instance = decodeURIComponent(url.split('/instances/')[1].split('/')[0]);
      return new Response(JSON.stringify({ documents: [], instance_id: instance }), {
        status: 200,
      });
    });
    const query = jest.fn(async () => ({ rows: [] }));
    return { calls, service: new SearchService({ query } as any, BRAIN, fetchImpl) };
  }
  const scopesOf = (calls: Array<{ body: any }>) =>
    calls.map(c => `${c.body.filters.account}=${c.body.filters.conversation_ids}`).sort();

  it('a bare chat id is asked in every account scope with that account namespace', async () => {
    const { calls, service } = brainService();
    await service.semanticSearch('hola', { chatId: '34600@s.whatsapp.net' });
    expect(scopesOf(calls)).toEqual([
      'leila=leila:34600@s.whatsapp.net',
      'personal=34600@s.whatsapp.net',
      'professional=professional:34600@s.whatsapp.net',
    ]);
  });

  it('an id namespaced to one account is asked only in that account scope', async () => {
    const { calls, service } = brainService();
    await expect(
      service.semanticSearch('hola', { chatId: 'leila:34600@s.whatsapp.net' })
    ).resolves.toEqual({ results: [], failures: [] });
    expect(scopesOf(calls)).toEqual(['leila=leila:34600@s.whatsapp.net']);
  });

  it('with an explicit account, a foreign namespace makes no semantic request', async () => {
    const { calls, service } = brainService();
    await service.semanticSearch('hola', {
      account: 'professional',
      chatId: 'leila:34600@s.whatsapp.net',
    });
    expect(calls).toHaveLength(0);
  });
});
