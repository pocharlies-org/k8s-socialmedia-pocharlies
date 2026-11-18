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
  return { query, service: new SearchService({ query } as any) };
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

describe('semantic search sin backend (SC-5827: el Brain murio)', () => {
  it('semanticSearch throws when Hindsight no esta configurado (searchDetailed cae a texto)', async () => {
    const { query, service } = keywordService();
    await expect(service.semanticSearch('hola', { chatId: '34600@s.whatsapp.net' })).rejects.toThrow(
      /Hindsight sin configurar/
    );
    // searchDetailed no deja de responder: el fallback de texto consulta Postgres.
    const out = await service.searchDetailed('hola', { chatId: '34600@s.whatsapp.net' });
    expect(out.mode).toBe('text');
    expect(out.fallbackReason).toMatch(/Hindsight sin configurar/);
    expect(query).toHaveBeenCalled();
  });
});
