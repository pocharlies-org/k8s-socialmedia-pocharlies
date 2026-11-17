/**
 * Integration-ish specs for the brain-windows jobs: fake pool + recording
 * WindowSink + fake LLM (global.fetch), exercising the real diff/push/delete/
 * LLM choreography of recomputeChat and processLlmWindow without Postgres.
 * The sink is the seam: the Synapse publisher (brain-windows-synapse.spec)
 * and the LLM HTTP are the only real I/O in production.
 */
import { useTestAccounts } from '../domain/test-accounts';
import {
  BrainDoc,
  ChatRef,
  PendingLlmWindow,
  WindowMessage,
  buildWindows,
  DEFAULT_WINDOWS_CONFIG,
  WindowSink,
} from './brain-windows-lib';
import {
  recomputeChat,
  processLlmWindow,
  groupAffectedChats,
  passMetricsText,
  WindowsWorker,
  WorkerHooks,
  changedAccount,
} from './brain-windows';
import { LlmConfig } from './brain-window-llm';

useTestAccounts({ whatsapp: { personal: 'http://wa' } });

const CFG = DEFAULT_WINDOWS_CONFIG;

// Recording sink (SC-5827: el push/delete al Brain murio; el unico sink real
// es brain-windows-synapse.ts, probado en su propio spec).
let pushedDocs: { account: string; docs: BrainDoc[] }[] = [];
let removedDocs: { account: string; platform: string; sourceId: string; chunkCount: number }[] = [];
let failNextPush = false;
const SINK: WindowSink = {
  async push(account, docs) {
    if (failNextPush) throw new Error('sink push failed');
    pushedDocs.push({ account, docs });
  },
  async remove(account, platform, sourceId, chunkCount) {
    removedDocs.push({ account, platform, sourceId, chunkCount });
  },
};
beforeEach(() => {
  pushedDocs = [];
  removedDocs = [];
  failNextPush = false;
});
const LLM: LlmConfig = {
  baseUrl: 'http://litellm:4000/v1',
  apiKey: 'sk',
  model: 'tooling',
  timeoutMs: 240000,
  retries: 0,
  maxTokens: 1200,
};

interface Handler {
  match: string;
  rows: ((params: unknown[]) => unknown[]) | unknown[];
}

class FakePool {
  queries: { sql: string; params: unknown[] }[] = [];
  constructor(private handlers: Handler[]) {}
  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    for (const h of this.handlers) {
      if (sql.includes(h.match))
        return { rows: typeof h.rows === 'function' ? h.rows(params) : h.rows };
    }
    return { rows: [] };
  }
  sqlLike(sub: string): unknown[][] {
    return this.queries.filter(q => q.sql.includes(sub)).map(q => q.params);
  }
}

function msg(i: number, over: Partial<WindowMessage> = {}): WindowMessage {
  return {
    id: String(i),
    wa_message_id: `w${i}`,
    content: `texto real del mensaje ${i} sobre la reforma del salon y su presupuesto`,
    wa_timestamp: new Date(Date.parse('2026-03-14T09:00:00Z') + i * 60_000),
    direction: 'INBOUND',
    sender_wa_id: '34600000001@c.us',
    sender_name: 'Ana',
    sender_push_name: null,
    message_type: 'TEXT',
    is_forwarded: false,
    ...over,
  };
}

const CHAT: ChatRef = {
  account: 'personal',
  platform: 'whatsapp',
  conversation_id: 'reforma@g.us',
  conversation_name: 'Reforma casa',
  conv_kind: 'group',
};

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

// (el push ya no es HTTP: se registra en SINK; mockBrainFetch desaparece)

const META = [{ id: 'reforma@g.us', name: 'Reforma casa', type: 'GROUP', is_group: true }];

function recomputeRange(pool: FakePool, minTs: Date, maxTs: Date) {
  return recomputeChat(
    pool as never,
    SINK,
    CFG,
    { pushDocsCap: 400, maxDeletesPerChat: 50 },
    'personal',
    { platform: 'whatsapp', conversation_id: 'reforma@g.us', minTs, maxTs }
  );
}

function ledgerRows(rows: Handler['rows']): Handler {
  return { match: 'content_hash, chunk_count, llm_status', rows };
}

describe('recomputeChat', () => {
  it('pushes parents + children for new windows and records the ledger', async () => {
    const msgs = [msg(1), msg(2), msg(3), msg(4), msg(5)];
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'wa_timestamp < ', rows: [] },
      { match: 'wa_timestamp > ', rows: [] },
      { match: 'LEFT JOIN participants', rows: msgs },
      ledgerRows([]),
      { match: 'INSERT INTO brain_windows', rows: [] },
    ]);
    const r = await recomputeRange(pool, msgs[0].wa_timestamp, msgs[4].wa_timestamp);
    expect(r.chats).toBe(1);
    expect(r.pushed).toBe(1);
    const push = pushedDocs[0];
    expect(push.account).toBe('personal');
    const docs = push.docs;
    expect(docs[0].metadata.type).toBe('conversation_window');
    expect(docs.length).toBeGreaterThan(1); // at least one child
    expect(docs.slice(1).every(d => d.metadata.type === 'conversation_chunk')).toBe(true);
    const inserts = pool.sqlLike('INSERT INTO brain_windows');
    expect(inserts.length).toBe(1);
    // pushed_hash = content_hash, llm_status pending (closed, eligible, group)
    expect(inserts[0][13]).toBe(inserts[0][12]);
    expect(inserts[0][15]).toBe('pending');
  });

  it('a trivial window goes up alone, skipped, without children', async () => {
    const msgs = [
      msg(1, { content: 'ok' }),
      msg(2, { content: 'vale' }),
      msg(3, { content: 'gracias' }),
    ];
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'LEFT JOIN participants', rows: msgs },
      ledgerRows([]),
      { match: 'INSERT INTO brain_windows', rows: [] },
    ]);
    await recomputeRange(pool, msgs[0].wa_timestamp, msgs[2].wa_timestamp);
    const docs = pushedDocs[0].docs;
    expect(docs.length).toBe(1);
    expect(docs[0].metadata.llm_status).toBe('skipped');
  });

  it('unchanged windows are neither pushed nor written', async () => {
    const msgs = [msg(1), msg(2), msg(3), msg(4)];
    const built = buildWindows(CHAT, msgs, CFG);
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'LEFT JOIN participants', rows: msgs },
      {
        match: 'content_hash, chunk_count, llm_status',
        rows: built.map(w => ({
          source_id: w.source_id,
          content_hash: w.content_hash,
          chunk_count: 1,
          llm_status: 'done',
        })),
      },
    ]);
    const r = await recomputeRange(pool, msgs[0].wa_timestamp, msgs[3].wa_timestamp);
    expect(r.pushed).toBe(0);
    expect(pushedDocs.length).toBe(0);
  });

  it('vanished windows are removed through the sink (parent + chunkCount) and the ledger', async () => {
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'LEFT JOIN participants', rows: [] },
      {
        match: 'content_hash, chunk_count, llm_status',
        rows: [{ source_id: 'win:gone', content_hash: 'h', chunk_count: 2, llm_status: 'done' }],
      },
      { match: 'DELETE FROM brain_windows', rows: [] },
    ]);
    const r = await recomputeRange(
      pool,
      new Date('2026-03-14T09:00:00Z'),
      new Date('2026-03-14T09:05:00Z')
    );
    expect(r.deleted).toBe(1);
    expect(removedDocs).toEqual([
      { account: 'personal', platform: 'whatsapp', sourceId: 'win:gone', chunkCount: 2 },
    ]);
    expect(pool.sqlLike('DELETE FROM brain_windows').length).toBe(1);
  });

  it('only ledger windows inside the rebuilt range can vanish (02-10-2026 mass delete)', async () => {
    const minTs = new Date('2026-03-14T09:00:00Z');
    const maxTs = new Date('2026-03-14T09:05:00Z');
    const stored = [
      // an old window of the same chat, months before the affected session
      {
        source_id: 'win:old',
        content_hash: 'h',
        chunk_count: 1,
        llm_status: 'done',
        start_ts: new Date('2025-11-02T10:00:00Z'),
      },
      // a window inside the affected session that the rebuild no longer produces
      {
        source_id: 'win:gone',
        content_hash: 'h',
        chunk_count: 0,
        llm_status: 'done',
        start_ts: new Date('2026-03-14T09:01:00Z'),
      },
    ];
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'LEFT JOIN participants', rows: [] },
      ledgerRows(
        // emulate the SQL range filter: start_ts BETWEEN $4 AND $5 when given
        (params: unknown[]) =>
          params.length < 5
            ? stored
            : stored.filter(
                s => s.start_ts >= (params[3] as Date) && s.start_ts <= (params[4] as Date)
              )
      ),
      { match: 'DELETE FROM brain_windows', rows: [] },
    ]);
    const r = await recomputeRange(pool, minTs, maxTs);
    expect(removedDocs.map(x => x.sourceId)).toEqual(['win:gone']);
    expect(r.deleted).toBe(1);
    const q = pool.sqlLike('content_hash, chunk_count, llm_status')[0];
    expect(q.length).toBe(5);
  });

  it('refuses to delete more than maxDeletesPerChat windows of one chat', async () => {
    const stored = Array.from({ length: 60 }, (_, i) => ({
      source_id: `win:x${i}`,
      content_hash: 'h',
      chunk_count: 0,
      llm_status: 'done',
    }));
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'LEFT JOIN participants', rows: [] },
      ledgerRows(stored),
      { match: 'DELETE FROM brain_windows', rows: [] },
    ]);
    const r = await recomputeRange(
      pool,
      new Date('2026-03-14T09:00:00Z'),
      new Date('2026-03-14T09:05:00Z')
    );
    expect(r.deleted).toBe(0);
    expect(r.refused).toBe(60);
    expect(removedDocs.length).toBe(0);
    expect(pool.sqlLike('DELETE FROM brain_windows').length).toBe(0);
  });

  it('a failed push leaves no ledger row (next pass retries)', async () => {
    const msgs = [msg(1), msg(2), msg(3), msg(4)];
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'LEFT JOIN participants', rows: msgs },
      ledgerRows([]),
    ]);
    failNextPush = true;
    const r = await recomputeRange(pool, msgs[0].wa_timestamp, msgs[3].wa_timestamp);
    expect(r.pushed).toBe(0);
    expect(pool.sqlLike('INSERT INTO brain_windows').length).toBe(0);
  });
});

describe('processLlmWindow', () => {
  const msgs = [msg(1), msg(2), msg(3), msg(4)];
  const built = buildWindows(CHAT, msgs, CFG)[0];
  const row: PendingLlmWindow = {
    source_id: built.source_id,
    account: 'personal',
    platform: 'whatsapp',
    conversation_id: 'reforma@g.us',
    window_key: built.window_key,
    part: built.part,
    start_ts: built.start_ts,
    end_ts: built.end_ts,
    message_count: 4,
    conv_kind: 'group',
    content_hash: built.content_hash,
    llm_input_hash: null,
  };

  function llmPool(summary: string | null, committed = true) {
    return new FakePool([
      { match: 'SELECT name FROM conversations WHERE id = $1', rows: [{ name: 'Reforma casa' }] },
      { match: 'LEFT JOIN participants', rows: msgs },
      {
        match: 'SELECT llm_summary FROM brain_windows WHERE source_id',
        rows: summary ? [{ llm_summary: summary }] : [],
      },
      { match: 'SELECT llm_summary', rows: summary ? [{ llm_summary: summary }] : [] },
      { match: 'RETURNING source_id', rows: committed ? [{ source_id: built.source_id }] : [] },
      { match: 'SET llm_status', rows: [] },
    ]);
  }

  const GOOD = {
    summary: 'La reforma sube un 15 %.',
    topics: ['reforma'],
    entities: [],
    facts: [],
    decisions: [],
    action_items: [],
    sentiment: 'neutro',
    trivial: false,
  };

  function mockLlm() {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD) } }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    return calls;
  }

  it('extracts, records done + summary and re-pushes the parent with header + summary', async () => {
    const pool = llmPool(null);
    const calls = mockLlm();
    const r = await processLlmWindow(pool as never, SINK, LLM, row);
    expect(r).toBe('done');
    const llmCall = calls.find(c => c.url.includes('chat/completions'));
    expect((llmCall?.body.messages as { content: string }[])[0].content).toContain(built.header);
    // done + summary in one UPDATE guarded by the content hash that was summarised
    const commit = pool.sqlLike('RETURNING source_id')[0];
    expect(commit[1]).toBe(built.content_hash);
    expect(String(commit[2])).toMatch(/^[0-9a-f]{64}$/);
    expect(commit[3]).toBe('La reforma sube un 15 %.');
    const doc = pushedDocs[0].docs[0];
    expect(doc.content).toBe(`${built.header}\nLa reforma sube un 15 %.`);
    expect(doc.metadata.llm_status).toBe('done');
    expect(doc.metadata.summary).toBe('La reforma sube un 15 %.');
    expect(doc.metadata.extraction).toBeDefined();
  });

  it('a window recomputed during the LLM call keeps its new state: nothing recorded or pushed', async () => {
    const pool = llmPool(null, false);
    mockLlm();
    const r = await processLlmWindow(pool as never, SINK, LLM, row);
    expect(r).toBe('skipped');
    expect(pushedDocs.length).toBe(0);
  });

  it('feeds the previous window summary as context', async () => {
    const pool = llmPool('resumen de la ventana anterior');
    const calls = mockLlm();
    await processLlmWindow(pool as never, SINK, LLM, row);
    const prompt = (
      calls.find(c => c.url.includes('chat/completions'))?.body.messages as { content: string }[]
    )[0].content;
    expect(prompt).toContain('resumen de la ventana anterior');
  });

  it('the input-hash checkpoint skips the LLM entirely', async () => {
    const { llmInputHash } = require('./brain-windows-lib');
    const hash = llmInputHash(LLM.model, built.header, built.transcript, 'previo');
    const pool = llmPool('previo');
    const calls = mockLlm();
    const r = await processLlmWindow(pool as never, SINK, LLM, { ...row, llm_input_hash: hash });
    expect(r).toBe('skipped');
    expect(calls.some(c => c.url.includes('chat/completions'))).toBe(false);
    // status restored to done and the parent re-pushed with the stored summary
    expect(pool.sqlLike('SET llm_status')[0][1]).toBe('done');
    expect(pushedDocs.length).toBe(1);
  });

  it('LLM failure records llm_status=failed with the error', async () => {
    const pool = llmPool(null);
    global.fetch = jest.fn(
      async () => new Response('down', { status: 500 })
    ) as unknown as typeof fetch;
    const r = await processLlmWindow(pool as never, SINK, LLM, row);
    expect(r).toBe('failed');
    const status = pool.sqlLike('SET llm_status')[0];
    expect(status[1]).toBe('failed');
    expect(String(status[2])).toMatch(/down/);
  });

  it('a channel/bot or trivial row is marked skipped without any call', async () => {
    const pool = llmPool(null);
    const calls = mockLlm();
    const r = await processLlmWindow(pool as never, SINK, LLM, { ...row, conv_kind: 'bot' });
    expect(r).toBe('skipped');
    expect(pool.sqlLike('SET llm_status')[0][1]).toBe('skipped');
    expect(calls.length).toBe(0);
  });

  it('content that moved on since the ledger is skipped, not extracted', async () => {
    const pool = llmPool(null);
    const calls = mockLlm();
    const r = await processLlmWindow(pool as never, SINK, LLM, { ...row, content_hash: 'stale' });
    expect(r).toBe('skipped');
    expect(pool.sqlLike('SET llm_status').length).toBe(0);
    expect(calls.length).toBe(0);
  });
});

describe('groupAffectedChats', () => {
  it('merges rows per chat keeping the time span', () => {
    const chats = groupAffectedChats([
      {
        platform: 'whatsapp',
        conversation_id: 'a',
        wa_timestamp: new Date('2026-03-14T10:00:00Z'),
      },
      {
        platform: 'whatsapp',
        conversation_id: 'b',
        wa_timestamp: new Date('2026-03-14T09:00:00Z'),
      },
      {
        platform: 'whatsapp',
        conversation_id: 'a',
        wa_timestamp: new Date('2026-03-14T11:00:00Z'),
      },
      {
        platform: 'telegram',
        conversation_id: 'a',
        wa_timestamp: new Date('2026-03-14T10:00:00Z'),
      },
    ]);
    expect(chats.length).toBe(3);
    const a = chats.find(c => c.platform === 'whatsapp' && c.conversation_id === 'a')!;
    expect(a.minTs.toISOString()).toBe('2026-03-14T10:00:00.000Z');
    expect(a.maxTs.toISOString()).toBe('2026-03-14T11:00:00.000Z');
  });
});

describe('passMetricsText', () => {
  it('emits refused deletes per account and the finish timestamp, in Prometheus text', () => {
    const txt = passMetricsText({ personal: 0, professional: 60 }, 1790900000123);
    expect(txt).toBe(
      'brain_windows_refused_deletes{account="personal"} 0 1790900000123\n' +
        'brain_windows_refused_deletes{account="professional"} 60 1790900000123\n' +
        'brain_windows_pass_finished_timestamp_seconds 1790900000 1790900000123\n'
    );
  });
});

describe('changedAccount (045 NOTIFY payload)', () => {
  it('reads the account and rejects anything else', () => {
    expect(changedAccount('{"n": 2, "account": "personal"}')).toBe('personal');
    expect(changedAccount('{"n": 2}')).toBeNull();
    expect(changedAccount('not json')).toBeNull();
    expect(changedAccount(undefined)).toBeNull();
  });
});

describe('WindowsWorker (SC-5926: event-driven scheduler)', () => {
  const MIN = 60_000;
  let calls: string[];
  let metrics: string[];
  let readyAt: Date | null;
  let waveResult: { done: number; failed: number; skipped: number };
  let recomputeResult: { refused: number; more: boolean };
  let llmReady: boolean;
  let gate: Promise<void> | null;

  function worker(): WindowsWorker {
    const hooks: WorkerHooks = {
      accounts: ['personal', 'professional'],
      debounceMs: 15_000,
      recompute: async account => {
        calls.push(`recompute:${account}`);
        if (gate) await gate;
        return recomputeResult;
      },
      llmWave: async account => {
        calls.push(`wave:${account}`);
        return waveResult;
      },
      nextReadyAt: async () => readyAt,
      llmReady: async () => llmReady,
      metrics: async text => {
        metrics.push(text);
      },
    };
    return new WindowsWorker(hooks);
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-11-17T18:00:00Z') });
    calls = [];
    metrics = [];
    readyAt = null;
    waveResult = { done: 0, failed: 0, skipped: 0 };
    recomputeResult = { refused: 0, more: false };
    llmReady = false;
    gate = null;
  });
  afterEach(() => jest.useRealTimers());
  /**
   * Let the scheduler's await-chains (hook → metrics → re-arm) settle. A 0 ms
   * timer is 1 ms (as in Node), so this moves the clock ~20 ms: the time checks
   * below keep a 1 s margin.
   */
  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await jest.advanceTimersByTimeAsync(1);
  }

  it('debounces a burst of changes into one recompute per account, ignores unknown accounts', async () => {
    const w = worker();
    w.changed('personal');
    await jest.advanceTimersByTimeAsync(5_000);
    w.changed('personal');
    w.changed('daniel');
    await jest.advanceTimersByTimeAsync(9_999);
    expect(calls).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['recompute:personal']);
    expect(metrics[0]).toContain('brain_windows_refused_deletes{account="personal"} 0');
    w.close();
  });

  it('a change during a recompute queues exactly one more; `more` reruns at once', async () => {
    let release!: () => void;
    gate = new Promise(r => (release = r));
    const w = worker();
    w.changed('personal', 0);
    await flush();
    w.changed('personal');
    w.changed('personal');
    gate = null;
    release();
    await flush();
    await jest.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(calls).toEqual(['recompute:personal', 'recompute:personal']);
    let left = 1; // the first run leaves rows behind, the second finishes
    w['h'].recompute = async account => {
      calls.push(`recompute:${account}`);
      return { refused: 0, more: left-- > 0 };
    };
    w.changed('professional', 0);
    await flush();
    expect(calls.filter(c => c === 'recompute:professional').length).toBe(2);
    w.close();
  });

  it('the LLM wave fires at the next close read from the ledger, not before', async () => {
    readyAt = new Date(Date.now() + 40 * MIN);
    const w = worker();
    w.changed('personal', 0);
    await jest.advanceTimersByTimeAsync(0);
    readyAt = null; // after the wave nothing else waits
    await jest.advanceTimersByTimeAsync(40 * MIN - 1);
    expect(calls).toEqual(['recompute:personal']);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['recompute:personal', 'wave:personal', 'wave:professional']);
    w.close();
  });

  it('a wave that summarised something chains the next; one that only failed pauses 10 min, then 20', async () => {
    readyAt = new Date(Date.now() - 1);
    let summarising = 2; // two productive waves, then the LLM only fails
    const w = worker();
    w['h'].llmWave = async account => {
      calls.push(`wave:${account}`);
      if (account === 'personal') summarising--;
      return summarising >= 0
        ? { done: 5, failed: 0, skipped: 0 }
        : { done: 0, failed: 5, skipped: 0 };
    };
    await w.armLlm();
    await flush();
    // waves 1-2 summarised → chained at once; wave 3 failed → paused
    const waves = (): number => calls.filter(c => c === 'wave:personal').length;
    expect(waves()).toBe(3);
    await jest.advanceTimersByTimeAsync(10 * MIN - 1_000);
    expect(waves()).toBe(3);
    await jest.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(waves()).toBe(4);
    await jest.advanceTimersByTimeAsync(20 * MIN - 1_000);
    expect(waves()).toBe(4);
    await jest.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(waves()).toBe(5);
    w.close();
  });

  it('stalled seconds grow while ready work gets no summary and reset on one', async () => {
    readyAt = new Date(Date.now() - 1);
    llmReady = true;
    waveResult = { done: 0, failed: 5, skipped: 0 };
    const w = worker();
    await w.armLlm();
    await flush();
    expect(metrics.at(-1)).toContain('brain_windows_llm_stalled_seconds{account="personal"} 0');
    await jest.advanceTimersByTimeAsync(10 * MIN);
    await flush();
    expect(metrics.at(-1)).toMatch(/brain_windows_llm_stalled_seconds\{account="personal"\} 600 /);
    waveResult = { done: 1, failed: 0, skipped: 0 };
    await jest.advanceTimersByTimeAsync(20 * MIN);
    await flush();
    expect(metrics.at(-1)).toContain('brain_windows_llm_stalled_seconds{account="personal"} 0');
    w.close();
  });
});
