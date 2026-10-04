/**
 * La búsqueda semántica vive en el brain (INFRA-486/487, decisión de Dani
 * 04-10-2026): un solo índice vectorial para WhatsApp y Telegram, el que ya
 * alimenta `brain-windows`. Este servicio ya no embebe nada: pregunta al brain
 * por los fragmentos de conversación que casan, con el alcance de la tool, y
 * resuelve sus `message_ids` contra `messages`.
 */
jest.mock('pino', () => ({
  __esModule: true,
  default: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { useTestAccounts } from '../domain/test-accounts';
import { brainSearchConfigFromEnv, DEFAULT_SEMANTIC_MIN_SCORE, SearchService } from './search.service';

const BRAIN = { url: 'http://brain', apiKey: 'k', timeoutMs: 1000, minScore: 0.2 };

function chunk(account: string, score: number, ids: string[], conversationId = 'c1') {
  return {
    text: 'fragmento',
    score,
    metadata: { type: 'conversation_chunk', account, message_ids: ids, conversation_id: conversationId },
  };
}

function brainReplying(byInstance: Record<string, unknown[]>) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const instance = decodeURIComponent(url.split('/instances/')[1].split('/')[0]);
    return new Response(JSON.stringify({ documents: byInstance[instance] ?? [] }), { status: 200 });
  });
  return { fetchImpl, calls };
}

function row(waMessageId: string, ts: string, extra: Record<string, unknown> = {}) {
  return {
    message_id: `id-${waMessageId}`,
    wa_message_id: waMessageId,
    conversation_id: '68642335125543@lid',
    content: `texto ${waMessageId}`,
    sender_wa_id: '34659695630@c.us',
    wa_timestamp: new Date(ts),
    platform: 'whatsapp',
    account: 'personal',
    message_type: 'TEXT',
    ...extra,
  };
}

beforeEach(() => {
  useTestAccounts({
    whatsapp: { personal: 'http://wa', professional: 'http://wa-pro', leila: 'http://wa-leila' },
    telegram: { personal: 'http://tg', professional: 'http://tg-pro' },
  });
});

it('pregunta al brain de la instancia de la cuenta, con su alcance, y resuelve los message_ids', async () => {
  const { fetchImpl, calls } = brainReplying({
    personal: [chunk('personal', 0.91, ['3EB0B', '3EB0A']), chunk('personal', 0.4, ['3EB0C'])],
  });
  const query = jest.fn(async () => ({
    rows: [row('3EB0C', '2026-10-01T10:00:00Z'), row('3EB0A', '2026-10-03T22:40:00Z'), row('3EB0B', '2026-10-03T22:42:00Z')],
  }));
  const svc = new SearchService({ query } as any, BRAIN, fetchImpl);

  const results = await svc.semanticSearch('el gestor de contraseñas no me deja acceder a mis claves', {
    account: 'personal',
    platform: 'whatsapp',
    chatId: '68642335125543@lid',
    from: new Date('2026-10-02T00:00:00Z'),
    to: new Date('2026-10-04T00:00:00Z'),
    limit: 20,
  });

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('http://brain/instances/personal/search');
  expect(calls[0].headers['X-API-Key']).toBe('k');
  expect(calls[0].body).toMatchObject({
    expand_windows: false,
    include_internal: true,
    limit: 20,
    filters: {
      account: 'personal',
      platform: 'whatsapp',
      types: ['conversation_chunk'],
      conversation_ids: ['68642335125543@lid'],
      // un día antes: el fragmento lleva la hora de su primer mensaje
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-04T00:00:00.000Z',
    },
  });

  // los ids de los fragmentos van a Postgres, con los filtros exactos de la tool
  const [sql, params] = (query.mock.calls[0] as unknown) as [string, unknown[]];
  expect(sql).toContain('m.wa_message_id = ANY($1::text[])');
  expect(sql).toContain('m.wa_timestamp >= $3');
  expect(params[0]).toEqual(expect.arrayContaining(['3EB0A', '3EB0B', '3EB0C']));

  // orden: fragmento mejor primero, y dentro de él por hora; similarity = la del fragmento
  expect(results.map(r => r.messageId)).toEqual(['id-3EB0A', 'id-3EB0B', 'id-3EB0C']);
  expect(results.map(r => r.similarity)).toEqual([0.91, 0.91, 0.4]);
});

it('cada cuenta en su espacio: professional va a skirmshop y leila a la suya', async () => {
  const { fetchImpl, calls } = brainReplying({});
  const svc = new SearchService({ query: jest.fn(async () => ({ rows: [] })) } as any, BRAIN, fetchImpl);

  await svc.semanticSearch('hola', { account: 'professional', chatId: '120363424380631708@g.us' });
  await svc.semanticSearch('hola', { account: 'leila' });

  expect(calls[0].url).toBe('http://brain/instances/skirmshop/search');
  expect(calls[0].body.filters).toMatchObject({
    account: 'professional',
    conversation_ids: ['professional:120363424380631708@g.us'],
  });
  expect(calls[1].url).toBe('http://brain/instances/leila/search');
  expect(calls[1].body.filters.account).toBe('leila');
});

it('sin cuenta busca en todas, cada una con su filtro de cuenta', async () => {
  const { fetchImpl, calls } = brainReplying({
    personal: [chunk('personal', 0.5, ['a'])],
    skirmshop: [chunk('professional', 0.8, ['professional:b'])],
  });
  const query = jest.fn(async () => ({
    rows: [row('a', '2026-10-01T00:00:00Z'), row('professional:b', '2026-10-01T00:00:00Z', { account: 'professional' })],
  }));
  const svc = new SearchService({ query } as any, BRAIN, fetchImpl);

  const results = await svc.semanticSearch('hola');

  const pedidos = calls.map(c => `${c.url.split('/instances/')[1].split('/')[0]}:${c.body.filters.account}`).sort();
  expect(pedidos).toEqual(['leila:leila', 'personal:personal', 'skirmshop:professional']);
  expect(results.map(r => r.account)).toEqual(['professional', 'personal']); // por puntuación
});

it('nunca devuelve un fragmento de otra cuenta aunque el brain lo mande', async () => {
  const { fetchImpl } = brainReplying({ personal: [chunk('leila', 0.99, ['leila:x'])] });
  const query = jest.fn(async () => ({ rows: [] }));
  const svc = new SearchService({ query } as any, BRAIN, fetchImpl);

  expect(await svc.semanticSearch('hola', { account: 'personal' })).toEqual([]);
  expect(query).not.toHaveBeenCalled();
});

it('por debajo del corte no hay coincidencia semántica y responde la de texto, diciéndolo', async () => {
  const { fetchImpl } = brainReplying({ personal: [chunk('personal', 0.05, ['a'])] });
  const query = jest.fn(async () => ({ rows: [] }));
  const svc = new SearchService({ query } as any, BRAIN, fetchImpl);

  const out = await svc.searchDetailed('hola', { account: 'personal' });

  expect(out.mode).toBe('text');
  expect(out.fallbackReason).toBe('sin coincidencias semánticas');
  expect(String((query.mock.calls[0] as unknown as [string])[0])).toContain('to_tsvector');
});

it('si el brain falla cae a texto y dice por qué', async () => {
  const fetchImpl = jest.fn(async () => new Response('upstream down', { status: 502 }));
  const query = jest.fn(async () => ({ rows: [] }));
  const svc = new SearchService({ query } as any, BRAIN, fetchImpl);

  const out = await svc.searchDetailed('hola', { account: 'personal' });

  expect(out.mode).toBe('text');
  expect(out.fallbackReason).toContain('brain personal 502');
});

it('con resultados semánticos dice que respondió el brain', async () => {
  const { fetchImpl } = brainReplying({ personal: [chunk('personal', 0.7, ['a'])] });
  const query = jest.fn(async () => ({ rows: [row('a', '2026-10-01T00:00:00Z')] }));
  const svc = new SearchService({ query } as any, BRAIN, fetchImpl);

  const out = await svc.searchDetailed('hola', { account: 'personal' });

  expect(out).toMatchObject({ mode: 'semantic' });
  expect(out.fallbackReason).toBeUndefined();
});

it('Instagram no pasa por el brain', async () => {
  const fetchImpl = jest.fn();
  const svc = new SearchService({ query: jest.fn() } as any, BRAIN, fetchImpl as any);
  expect(await svc.semanticSearch('hola', { platform: 'instagram' })).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('sin URL o sin la clave de mensajería no hay búsqueda semántica', async () => {
  expect(brainSearchConfigFromEnv({})).toBeNull();
  expect(brainSearchConfigFromEnv({ BRAIN_SEARCH_URL: 'http://brain' })).toBeNull();
  // la compartida no sirve: el brain no abre mensajería con ella
  expect(brainSearchConfigFromEnv({ BRAIN_SEARCH_URL: 'http://brain', BRAIN_API_KEY: 'compartida' })).toBeNull();
  expect(brainSearchConfigFromEnv({ BRAIN_SEARCH_URL: 'http://brain/', BRAIN_MESSAGING_SEARCH_KEY: 'k' })).toEqual({
    url: 'http://brain',
    apiKey: 'k',
    timeoutMs: 8000,
    minScore: DEFAULT_SEMANTIC_MIN_SCORE,
  });
  expect(
    brainSearchConfigFromEnv({ BRAIN_SEARCH_URL: 'http://b', BRAIN_MESSAGING_SEARCH_KEY: 'k', SEMANTIC_MIN_SCORE: '0.35' })
      ?.minScore
  ).toBe(0.35);

  const query = jest.fn(async () => ({ rows: [] }));
  const out = await new SearchService({ query } as any, null).searchDetailed('hola');
  expect(out.mode).toBe('text');
  expect(out.fallbackReason).toContain('BRAIN_MESSAGING_SEARCH_KEY');
});
