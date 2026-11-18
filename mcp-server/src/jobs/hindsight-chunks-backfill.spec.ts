jest.mock('pino', () => ({
  __esModule: true,
  default: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('./brain-windows-lib');

import {
  FatalWriterError,
  RUN_ID,
  chunkItems,
  configFromEnv,
  retain,
  runBackfill,
  type BackfillConfig,
} from './hindsight-chunks-backfill';
import {
  chunkWindow,
  getBackfillCursor,
  loadWindowForLlm,
  setBackfillCursor,
} from './brain-windows-lib';

// Keys the boundary writer accepts (k8s-hindsight-pocharlies boundary/writer/server.py).
const WRITER_ITEM_FIELDS = [
  'document_id',
  'content',
  'timestamp',
  'context',
  'tags',
  'metadata',
  'strategy',
];
const WRITER_METADATA = [
  'agent',
  'host',
  'source_host',
  'cwd',
  'session_id',
  'source',
  'offset_start',
  'offset_end',
  'kind',
];

const window = {
  account: 'personal',
  platform: 'telegram',
  end_ts: new Date('2026-10-08T09:00:00Z'),
};
const chunk = (n: number, id = 'win:telegram:personal:c:1') => ({
  index: n,
  source_id: `${id}#c${n}`,
  message_ids: [`m${n}`],
  content: `chunk ${n}`,
});
const ok = () => new Response('{}', { status: 200 });
const cfg: BackfillConfig = {
  writerUrl: 'https://w:8443',
  token: 't'.repeat(40),
  accounts: ['personal'],
  pageWindows: 2,
  maxItems: 0,
  maxRuntimeMs: 60_000,
  concurrency: 2,
};
const rows = (...ids: string[]) =>
  ids.map(source_id => ({
    source_id,
    account: 'personal',
    platform: 'telegram',
    end_ts: window.end_ts,
  }));

beforeEach(() => {
  jest.clearAllMocks();
  (getBackfillCursor as jest.Mock).mockResolvedValue(null);
  (loadWindowForLlm as jest.Mock).mockResolvedValue({ built: true });
  (chunkWindow as jest.Mock).mockReturnValue([chunk(1), chunk(2)]);
});

describe('configFromEnv', () => {
  it('falla cerrado sin token y limita la concurrencia a 2 (slots compartidos del escritor)', () => {
    expect(() => configFromEnv({})).toThrow('HINDSIGHT_WRITER_TOKEN');
    expect(configFromEnv({ HINDSIGHT_WRITER_TOKEN: 'x', CONCURRENCY: '9' }).concurrency).toBe(2);
    expect(configFromEnv({ HINDSIGHT_WRITER_TOKEN: 'x' })).toMatchObject({
      accounts: ['personal'],
      maxItems: 0,
    });
  });
});

describe('chunkItems', () => {
  it('usa el source_id del chunk como document_id y solo claves que admite el escritor', () => {
    const [item] = chunkItems(window, [chunk(1)]);
    expect(item).toMatchObject({
      document_id: 'win:telegram:personal:c:1#c1',
      strategy: 'vector',
      timestamp: '2026-10-08T09:00:00.000Z',
      tags: ['type:conversation_chunk', 'account:personal', 'platform:telegram'],
    });
    expect(Object.keys(item).every(k => WRITER_ITEM_FIELDS.includes(k))).toBe(true);
    expect(Object.keys(item.metadata as object).every(k => WRITER_METADATA.includes(k))).toBe(true);
    // Account, conversation and message ids are recovered by the reader, never sent.
    expect(JSON.stringify(item)).not.toContain('m1');
  });
});

describe('retain', () => {
  const noWait = jest.fn(async () => undefined);

  it('un 403 es el token que no casa: para al instante, sin reintentos', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 403 }));
    await expect(retain(fetchImpl as any, cfg, [{}], noWait)).rejects.toBeInstanceOf(
      FatalWriterError
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reintenta un 429 (escritor ocupado) con espera y termina en 200', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(ok());
    await retain(fetchImpl as any, cfg, [{}], noWait);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(noWait).toHaveBeenCalledWith(2000);
  });

  it('manda async:false con el Bearer y se rinde tras 5 intentos', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 502 }));
    await expect(retain(fetchImpl as any, cfg, [{ a: 1 }], noWait)).rejects.toThrow(
      'writer 502 after 5 tries'
    );
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe('https://w:8443/v1/default/banks/personal/memories');
    expect(init.headers.authorization).toBe(`Bearer ${cfg.token}`);
    expect(JSON.parse(init.body)).toEqual({ items: [{ a: 1 }], async: false });
  });

  it('un 400 no se reintenta', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 400 }));
    await expect(retain(fetchImpl as any, cfg, [{}], noWait)).rejects.toThrow('writer 400');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('runBackfill', () => {
  const pool = (pages: unknown[][]) => {
    const query = jest.fn();
    pages.forEach(p => query.mockResolvedValueOnce({ rows: p }));
    query.mockResolvedValue({ rows: [] });
    return { query } as any;
  };

  it('recorre el ledger por páginas, avanza el cursor solo tras confirmar y acaba', async () => {
    const fetchImpl = jest.fn(async () => ok());
    const p = pool([rows('win:a', 'win:b'), rows('win:c')]);
    const totals = await runBackfill(p, cfg, fetchImpl as any);
    expect(totals).toEqual({ windows: 3, items: 6, requests: 2, done: true });
    expect(setBackfillCursor).toHaveBeenNthCalledWith(1, p, RUN_ID, 'hindsight', {
      last_source_id: 'win:b',
    });
    expect(setBackfillCursor).toHaveBeenNthCalledWith(2, p, RUN_ID, 'hindsight', {
      last_source_id: 'win:c',
    });
    expect(p.query.mock.calls[1][1]).toEqual([['personal'], 'win:b', 2]);
  });

  it('reanuda desde el cursor guardado', async () => {
    (getBackfillCursor as jest.Mock).mockResolvedValue({ last_source_id: 'win:m' });
    const p = pool([]);
    expect((await runBackfill(p, cfg, jest.fn() as any)).done).toBe(true);
    expect(p.query.mock.calls[0][1]).toEqual([['personal'], 'win:m', 2]);
  });

  it('con MAX_ITEMS para tras la página que lo alcanza y no marca done', async () => {
    const fetchImpl = jest.fn(async () => ok());
    const p = pool([rows('win:a', 'win:b'), rows('win:c')]);
    const totals = await runBackfill(p, { ...cfg, maxItems: 3 }, fetchImpl as any);
    expect(totals).toMatchObject({ windows: 2, items: 4, done: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('un lote que falla no avanza el cursor', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 403 }));
    await expect(runBackfill(pool([rows('win:a')]), cfg, fetchImpl as any)).rejects.toBeInstanceOf(
      FatalWriterError
    );
    expect(setBackfillCursor).not.toHaveBeenCalled();
  });

  it('una ventana que ya no existe se salta sin escribir', async () => {
    (loadWindowForLlm as jest.Mock).mockResolvedValue(null);
    const fetchImpl = jest.fn(async () => ok());
    const totals = await runBackfill(pool([rows('win:gone')]), cfg, fetchImpl as any);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ windows: 1, items: 0, requests: 0 });
  });

  it('parte las páginas grandes en lotes de 32 items, el máximo del escritor', async () => {
    (chunkWindow as jest.Mock).mockReturnValue(Array.from({ length: 40 }, (_, i) => chunk(i + 1)));
    const fetchImpl = jest.fn(async () => ok());
    await runBackfill(pool([rows('win:a')]), cfg, fetchImpl as any);
    const sizes = fetchImpl.mock.calls.map(c => JSON.parse((c as any)[1].body).items.length);
    expect(sizes.sort((a, b) => a - b)).toEqual([8, 32]);
  });
});
