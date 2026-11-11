jest.mock('pino', () => ({
  __esModule: true,
  default: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('./hindsight-chunks');

import { SearchService } from './search.service';
import { chunkMessageIds, resolveChunks } from './hindsight-chunks';
import { useTestAccounts } from '../domain/test-accounts';

const row = (extra: Record<string, unknown> = {}) => ({
  message_id: 'uuid-1',
  wa_message_id: 'WA1',
  conversation_id: 'personal:chat',
  content: 'Original exacto de PostgreSQL',
  sender_wa_id: 'sender',
  wa_timestamp: new Date('2026-10-08T09:00:00Z'),
  platform: 'whatsapp',
  account: 'personal',
  message_type: 'TEXT',
  ...extra,
});

const recaller = (hits: Array<{ documentId: string; score: number }>) => ({
  minScore: 0.2,
  writerIdentities: ['synapse-personal'],
  recall: jest.fn(async () => hits),
});

beforeEach(() => {
  useTestAccounts({
    whatsapp: { personal: 'http://wa', professional: 'http://wa-pro' },
    telegram: { personal: 'http://tg' },
  });
  (resolveChunks as jest.Mock).mockResolvedValue(new Map());
  (chunkMessageIds as jest.Mock).mockResolvedValue(
    new Map([
      ['writer:a', ['WA1', 'WA2']],
      ['writer:b', ['WA3']],
    ])
  );
});

const service = (hindsight: unknown, rows: unknown[] = [row()]) => {
  const query = jest.fn(async () => ({ rows }));
  return { query, svc: new SearchService({ query } as any, null, jest.fn(), hindsight as any) };
};

it('pide solo chunks de la cuenta y plataforma, y devuelve filas de Postgres con cuenta y conversación', async () => {
  const hindsight = recaller([{ documentId: 'writer:a', score: 0.9 }]);
  const { query, svc } = service(hindsight, [
    row(),
    row({
      message_id: 'uuid-2',
      wa_message_id: 'WA2',
      wa_timestamp: new Date('2026-10-08T09:01:00Z'),
    }),
  ]);
  const outcome = await svc.searchDetailed('una parafrasis', {
    account: 'personal',
    platform: 'whatsapp',
  });
  expect(hindsight.recall).toHaveBeenCalledWith('una parafrasis', [
    'type:conversation_chunk',
    'account:personal',
    'platform:whatsapp',
  ]);
  expect(resolveChunks).toHaveBeenCalledWith(expect.anything(), ['writer:a'], 'personal', [
    'synapse-personal',
  ]);
  const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
  expect(sql).toContain('m.wa_message_id = ANY($1::text[])');
  expect(params[0]).toEqual(['WA1', 'WA2']);
  expect(outcome.mode).toBe('semantic');
  expect(
    outcome.results.map(r => [r.messageId, r.account, r.conversationId, r.similarity])
  ).toEqual([
    ['uuid-1', 'personal', 'personal:chat', 0.9],
    ['uuid-2', 'personal', 'personal:chat', 0.9],
  ]);
});

it('ordena por el mejor chunk y descarta los que no llegan al umbral de score', async () => {
  const hindsight = recaller([
    { documentId: 'writer:b', score: 0.5 },
    { documentId: 'writer:a', score: 0.8 },
    { documentId: 'writer:c', score: 0.05 },
  ]);
  const { query, svc } = service(hindsight, [
    row({ message_id: 'uuid-3', wa_message_id: 'WA3' }),
    row(),
  ]);
  const { results } = await svc.semanticSearch('x', { account: 'personal' });
  expect((query.mock.calls[0] as unknown as [string, unknown[]])[1][0]).toEqual([
    'WA1',
    'WA2',
    'WA3',
  ]);
  expect(resolveChunks).toHaveBeenCalledWith(
    expect.anything(),
    ['writer:a', 'writer:b'],
    'personal',
    ['synapse-personal']
  );
  expect(results.map(r => r.messageId)).toEqual(['uuid-1', 'uuid-3']);
});

it('no clasifica una fila bajo el chunk de otra cuenta', async () => {
  const { svc } = service(recaller([{ documentId: 'writer:a', score: 0.9 }]), [
    row({ account: 'professional' }),
  ]);
  expect((await svc.semanticSearch('x', { account: 'personal' })).results).toEqual([]);
});

it('professional no tiene banco: avisa por failures, no consulta Hindsight y cae a texto', async () => {
  const hindsight = recaller([{ documentId: 'writer:a', score: 0.9 }]);
  const { svc } = service(hindsight, []);
  const semantic = await svc.semanticSearch('x', { account: 'professional' });
  expect(semantic.results).toEqual([]);
  expect(semantic.failures).toEqual([
    { accountId: 'professional', message: 'la cuenta professional no tiene banco en Hindsight' },
  ]);
  expect(hindsight.recall).not.toHaveBeenCalled();
  const outcome = await svc.searchDetailed('x', { account: 'professional' });
  expect(outcome.mode).toBe('text');
  expect(outcome.fallbackReason).toContain('professional no tiene banco');
});

it('Instagram no tiene chunks: no pregunta a Hindsight', async () => {
  const hindsight = recaller([]);
  const { svc } = service(hindsight);
  expect(await svc.semanticSearch('x', { platform: 'instagram' })).toEqual({
    results: [],
    failures: [],
  });
  expect(hindsight.recall).not.toHaveBeenCalled();
});

it('un fallo de Hindsight se reporta por cuenta y la búsqueda cae a texto', async () => {
  const hindsight = recaller([]);
  hindsight.recall.mockRejectedValueOnce(new Error('hindsight token: HTTP 401'));
  const { svc } = service(hindsight, []);
  const outcome = await svc.searchDetailed('x', { account: 'personal' });
  expect(outcome.mode).toBe('text');
  expect(outcome.fallbackReason).toContain('hindsight token: HTTP 401');
});
