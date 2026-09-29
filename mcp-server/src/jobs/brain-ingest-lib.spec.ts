import {
  adapterForPlatform,
  instanceForAccount,
  replayCursorTableName,
  sourceId,
  toDoc,
  liveCursorTableName,
  pushToBrain,
} from './brain-ingest-lib';

describe('brain ingest lib', () => {
  it('keeps source ids stable across live ingest and replay', () => {
    expect(sourceId('whatsapp', 'wa1')).toBe('wa:wa1');
    expect(sourceId('telegram', 'tg1')).toBe('tg:tg1');
    expect(sourceId('instagram', 'ig1')).toBe('ig:ig1');
  });

  it('routes account and platform to Brain instance and adapter', () => {
    expect(instanceForAccount('personal')).toBe('personal');
    expect(instanceForAccount('professional')).toBe('skirmshop');
    // SC-1144 fase 2: leila ingesta en la instancia personal hasta que el CTO
    // decida otra; su PVC arranca vacío, así que no hay filas que mover.
    expect(instanceForAccount('leila')).toBe('personal');
    expect(adapterForPlatform('telegram')).toBe('telegram');
    expect(adapterForPlatform('instagram')).toBe('instagram');
    expect(adapterForPlatform('whatsapp')).toBe('whatsapp');
  });

  it('uses a separate cursor table for replay', () => {
    expect(liveCursorTableName()).toBe('brain_ingest_cursor');
    expect(replayCursorTableName()).toBe('brain_ingest_replay_cursor');
    expect(replayCursorTableName()).not.toBe(liveCursorTableName());
  });

  it('builds Brain docs with account and conversation metadata', () => {
    const doc = toDoc({
      id: '1',
      wa_message_id: 'tg1',
      content: 'hola',
      platform: 'telegram',
      account: 'personal',
      direction: 'inbound',
      message_type: 'text',
      metadata: { custom: 'value' },
      wa_timestamp: new Date('2026-06-01T10:00:00Z'),
      created_at: new Date('2026-06-01T10:00:01Z'),
      sender_wa_id: 'sender1',
      conversation_id: 'conv1',
      conversation_name: 'Familia',
    });

    expect(doc.source_id).toBe('tg:tg1');
    expect(doc.metadata.account).toBe('personal');
    expect(doc.metadata.conversation_id).toBe('conv1');
    expect(doc.metadata.custom).toBe('value');
  });
});

describe('registry-driven namespaces and brain instances', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const lib = require('./brain-ingest-lib');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useTestAccounts } = require('../domain/test-accounts');

  it('ingests every registry namespace, routed to its brainInstance', () => {
    useTestAccounts({
      whatsapp: { personal: 'http://wa', professional: 'http://wa-pro', leila: 'http://wa-l' },
    });
    const ns: string[] = lib.ingestNamespaces();
    expect(ns).toEqual(expect.arrayContaining(['personal', 'professional', 'leila']));
    expect(lib.instanceForAccount('professional')).toBe('skirmshop');
    expect(lib.instanceForAccount('personal')).toBe('personal');
    expect(lib.instanceForAccount('leila')).toBe('personal');
    expect(() => lib.instanceForAccount('ghost')).toThrow(/not declared/);
  });
});

describe('pushToBrain: ventana de reintento', () => {
  const cfg = { brainUrl: 'http://brain', apiKey: 'k' };
  const saved = { ...process.env };
  const realFetch = global.fetch;
  let clock: number;
  const opts = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
  const res = (status: number, body: unknown = {}) =>
    ({ ok: status < 400, status, text: async () => 'x', json: async () => body }) as unknown as Response;

  beforeEach(() => {
    jest.useFakeTimers();
    clock = 0;
    process.env.BRAIN_PUSH_RETRIES = '1000';
    process.env.BRAIN_PUSH_BUDGET_MS = '240000';
    delete process.env.BRAIN_INGEST_MAX_RUNTIME_MS;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    global.fetch = realFetch;
    process.env = { ...saved };
  });

  it('ventana: 502 durante 240 s y luego 200 resuelve', async () => {
    global.fetch = jest.fn(async () => (clock < 240000 ? res(502) : res(200, { chunks_ingested: 7 })));
    const p = pushToBrain(cfg, 'personal', 'wa', [], opts);
    await jest.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe(7);
  });

  it('ventana: 502 durante 241 s lanza con reintentos y tiempo', async () => {
    global.fetch = jest.fn(async () => (clock < 241000 ? res(502) : res(200, { chunks_ingested: 7 })));
    const p = pushToBrain(cfg, 'personal', 'wa', [], opts);
    const assertion = expect(p).rejects.toThrow(/502.*reintentos.*240000 ms/);
    await jest.advanceTimersByTimeAsync(0);
    await assertion;
  });

  it('ventana: 4xx no se reintenta y el error de red sí', async () => {
    global.fetch = jest.fn(async () => res(400));
    await expect(pushToBrain(cfg, 'personal', 'wa', [], opts)).rejects.toThrow(/400/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    let n = 0;
    global.fetch = jest.fn(async () => {
      if (n++ < 2) throw new Error('ECONNRESET');
      return res(200, { chunks_ingested: 3 });
    });
    await expect(pushToBrain(cfg, 'personal', 'wa', [], opts)).resolves.toBe(3);
  });

  it('ventana: BRAIN_INGEST_MAX_RUNTIME_MS recorta el presupuesto', async () => {
    process.env.BRAIN_INGEST_MAX_RUNTIME_MS = '100000';
    global.fetch = jest.fn(async () => res(503));
    await expect(pushToBrain(cfg, 'personal', 'wa', [], opts)).rejects.toThrow(/70000 ms\)/);
    expect(clock).toBe(70000);
  });
});
