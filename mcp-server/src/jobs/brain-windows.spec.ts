/**
 * Integration-ish specs for the brain-windows jobs: fake pool + fake brain
 * (global.fetch), exercising the real diff/push/delete/LLM choreography of
 * recomputeChat and processLlmWindow without Postgres or skirmshop-brain.
 */
import { useTestAccounts } from '../domain/test-accounts';
import { BrainPushConfig } from './brain-ingest-lib';
import {
  ChatRef,
  PendingLlmWindow,
  WindowMessage,
  buildWindows,
  DEFAULT_WINDOWS_CONFIG,
  httpSink,
} from './brain-windows-lib';
import { recomputeChat, processLlmWindow, groupAffectedChats } from './brain-windows';
import { LlmConfig } from './brain-window-llm';

useTestAccounts({ whatsapp: { personal: 'http://wa' } });

const CFG = DEFAULT_WINDOWS_CONFIG;
const BRAIN: BrainPushConfig = { brainUrl: 'http://brain', apiKey: 'k' };
const SINK = httpSink(BRAIN);
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

function mockBrainFetch() {
  const pushes: { url: string; body: Record<string, unknown> }[] = [];
  global.fetch = jest.fn(async (url: string, init: RequestInit) => {
    pushes.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ chunks_ingested: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  return pushes;
}

const META = [{ id: 'reforma@g.us', name: 'Reforma casa', type: 'GROUP', is_group: true }];

describe('recomputeChat', () => {
  it('pushes parents + children for new windows and records the ledger', async () => {
    const msgs = [msg(1), msg(2), msg(3), msg(4), msg(5)];
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'wa_timestamp < ', rows: [] },
      { match: 'wa_timestamp > ', rows: [] },
      { match: 'LEFT JOIN participants', rows: msgs },
      { match: 'content_hash, chunk_count, llm_status', rows: [] },
      { match: 'INSERT INTO brain_windows', rows: [] },
    ]);
    const pushes = mockBrainFetch();
    const r = await recomputeChat(
      pool as never,
      SINK,
      CFG,
      { pushDocsCap: 400, maxDeletesPerChat: 50 },
      'personal',
      { platform: 'whatsapp', conversation_id: 'reforma@g.us', minTs: msgs[0].wa_timestamp, maxTs: msgs[4].wa_timestamp },
      false
    );
    expect(r.chats).toBe(1);
    expect(r.pushed).toBe(1);
    const push = pushes[0];
    expect(push.url).toBe('http://brain/instances/personal/push-ingest');
    const docs = push.body.documents as { source_id: string; metadata: { type: string } }[];
    expect(push.body.adapter).toBe('whatsapp');
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
    const msgs = [msg(1, { content: 'ok' }), msg(2, { content: 'vale' }), msg(3, { content: 'gracias' })];
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'LEFT JOIN participants', rows: msgs },
      { match: 'content_hash, chunk_count, llm_status', rows: [] },
      { match: 'INSERT INTO brain_windows', rows: [] },
    ]);
    const pushes = mockBrainFetch();
    await recomputeChat(
      pool as never, SINK, CFG, { pushDocsCap: 400, maxDeletesPerChat: 50 }, 'personal',
      { platform: 'whatsapp', conversation_id: 'reforma@g.us', minTs: msgs[0].wa_timestamp, maxTs: msgs[2].wa_timestamp },
      false
    );
    const docs = pushes[0].body.documents as { metadata: { type: string; llm_status: string } }[];
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
          source_id: w.source_id, content_hash: w.content_hash, chunk_count: 1, llm_status: 'done',
        })),
      },
    ]);
    const pushes = mockBrainFetch();
    const r = await recomputeChat(
      pool as never, SINK, CFG, { pushDocsCap: 400, maxDeletesPerChat: 50 }, 'personal',
      { platform: 'whatsapp', conversation_id: 'reforma@g.us', minTs: msgs[0].wa_timestamp, maxTs: msgs[3].wa_timestamp },
      false
    );
    expect(r.pushed).toBe(0);
    expect(pushes.length).toBe(0);
  });

  it('vanished windows are deleted from the brain (parent + children) and the ledger', async () => {
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'LEFT JOIN participants', rows: [] },
      {
        match: 'content_hash, chunk_count, llm_status',
        rows: [{ source_id: 'win:gone', content_hash: 'h', chunk_count: 2, llm_status: 'done' }],
      },
      { match: 'DELETE FROM brain_windows', rows: [] },
    ]);
    const calls = mockBrainFetch();
    const r = await recomputeChat(
      pool as never, SINK, CFG, { pushDocsCap: 400, maxDeletesPerChat: 50 }, 'personal',
      {
        platform: 'whatsapp', conversation_id: 'reforma@g.us',
        minTs: new Date('2026-03-14T09:00:00Z'), maxTs: new Date('2026-03-14T09:05:00Z'),
      },
      false
    );
    expect(r.deleted).toBe(1);
    const deleted = calls.filter(c => c.url.endsWith('/delete-document')).map(c => c.body.source_id);
    expect(deleted).toEqual(['win:gone', 'win:gone#c1', 'win:gone#c2']);
    expect(pool.sqlLike('DELETE FROM brain_windows').length).toBe(1);
  });

  it('only ledger windows inside the rebuilt range can vanish (02-10-2026 mass delete)', async () => {
    const minTs = new Date('2026-03-14T09:00:00Z');
    const maxTs = new Date('2026-03-14T09:05:00Z');
    const stored = [
      // an old window of the same chat, months before the affected session
      { source_id: 'win:old', content_hash: 'h', chunk_count: 1, llm_status: 'done', start_ts: new Date('2025-11-02T10:00:00Z') },
      // a window inside the affected session that the rebuild no longer produces
      { source_id: 'win:gone', content_hash: 'h', chunk_count: 0, llm_status: 'done', start_ts: new Date('2026-03-14T09:01:00Z') },
    ];
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'LEFT JOIN participants', rows: [] },
      {
        match: 'content_hash, chunk_count, llm_status',
        // emulate the SQL range filter: start_ts BETWEEN $4 AND $5 when given
        rows: (params: unknown[]) =>
          params.length < 5
            ? stored
            : stored.filter(s => s.start_ts >= (params[3] as Date) && s.start_ts <= (params[4] as Date)),
      },
      { match: 'DELETE FROM brain_windows', rows: [] },
    ]);
    const calls = mockBrainFetch();
    const r = await recomputeChat(
      pool as never, SINK, CFG, { pushDocsCap: 400, maxDeletesPerChat: 50 }, 'personal',
      { platform: 'whatsapp', conversation_id: 'reforma@g.us', minTs, maxTs },
      false
    );
    const deleted = calls.filter(c => c.url.endsWith('/delete-document')).map(c => c.body.source_id);
    expect(deleted).toEqual(['win:gone']);
    expect(r.deleted).toBe(1);
    const q = pool.sqlLike('content_hash, chunk_count, llm_status')[0];
    expect(q.length).toBe(5);
  });

  it('refuses to delete more than maxDeletesPerChat windows of one chat', async () => {
    const stored = Array.from({ length: 60 }, (_, i) => ({
      source_id: `win:x${i}`, content_hash: 'h', chunk_count: 0, llm_status: 'done',
    }));
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'LEFT JOIN participants', rows: [] },
      { match: 'content_hash, chunk_count, llm_status', rows: stored },
      { match: 'DELETE FROM brain_windows', rows: [] },
    ]);
    const calls = mockBrainFetch();
    const r = await recomputeChat(
      pool as never, SINK, CFG, { pushDocsCap: 400, maxDeletesPerChat: 50 }, 'personal',
      {
        platform: 'whatsapp', conversation_id: 'reforma@g.us',
        minTs: new Date('2026-03-14T09:00:00Z'), maxTs: new Date('2026-03-14T09:05:00Z'),
      },
      false
    );
    expect(r.deleted).toBe(0);
    expect(calls.filter(c => c.url.endsWith('/delete-document')).length).toBe(0);
    expect(pool.sqlLike('DELETE FROM brain_windows').length).toBe(0);
  });

  it('DRY_RUN touches nothing', async () => {
    const msgs = [msg(1), msg(2), msg(3), msg(4)];
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'LEFT JOIN participants', rows: msgs },
      { match: 'content_hash, chunk_count, llm_status', rows: [] },
    ]);
    const pushes = mockBrainFetch();
    const r = await recomputeChat(
      pool as never, SINK, CFG, { pushDocsCap: 400, maxDeletesPerChat: 50 }, 'personal',
      { platform: 'whatsapp', conversation_id: 'reforma@g.us', minTs: msgs[0].wa_timestamp, maxTs: msgs[3].wa_timestamp },
      true
    );
    expect(r.pushed).toBe(1);
    expect(pushes.length).toBe(0);
    expect(pool.sqlLike('INSERT INTO brain_windows').length).toBe(0);
  });

  it('a failed push leaves no ledger row (next pass retries)', async () => {
    const msgs = [msg(1), msg(2), msg(3), msg(4)];
    const pool = new FakePool([
      { match: 'FROM conversations', rows: META },
      { match: 'LEFT JOIN participants', rows: msgs },
      { match: 'content_hash, chunk_count, llm_status', rows: [] },
    ]);
    global.fetch = jest.fn(async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
    const r = await recomputeChat(
      pool as never, SINK, CFG, { pushDocsCap: 400, maxDeletesPerChat: 50 }, 'personal',
      { platform: 'whatsapp', conversation_id: 'reforma@g.us', minTs: msgs[0].wa_timestamp, maxTs: msgs[3].wa_timestamp },
      false
    );
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

  function llmPool(summary: string | null) {
    return new FakePool([
      { match: 'SELECT name FROM conversations WHERE id = $1', rows: [{ name: 'Reforma casa' }] },
      { match: 'LEFT JOIN participants', rows: msgs },
      { match: 'SELECT llm_summary FROM brain_windows WHERE source_id', rows: summary ? [{ llm_summary: summary }] : [] },
      { match: 'SELECT llm_summary', rows: summary ? [{ llm_summary: summary }] : [] },
      { match: 'SET llm_status', rows: [] },
      { match: 'SET llm_summary', rows: [] },
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

  function mockLlmAndBrain() {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (url.includes('chat/completions'))
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD) } }] }),
          { status: 200 }
        );
      return new Response(JSON.stringify({ chunks_ingested: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    return calls;
  }

  it('extracts, records done + summary and re-pushes the parent with header + summary', async () => {
    const pool = llmPool(null);
    const calls = mockLlmAndBrain();
    const r = await processLlmWindow(pool as never, SINK, LLM, row, false);
    expect(r).toBe('done');
    const llmCall = calls.find(c => c.url.includes('chat/completions'));
    expect((llmCall?.body.messages as { content: string }[])[0].content).toContain(built.header);
    const status = pool.sqlLike('SET llm_status')[0];
    expect(status[1]).toBe('done');
    expect(String(status[2])).toMatch(/^[0-9a-f]{64}$/);
    const parentPush = calls.find(c => c.url.includes('push-ingest'));
    const doc = (parentPush?.body.documents as { content: string; metadata: Record<string, unknown> }[])[0];
    expect(doc.content).toBe(`${built.header}\nLa reforma sube un 15 %.`);
    expect(doc.metadata.llm_status).toBe('done');
    expect(doc.metadata.summary).toBe('La reforma sube un 15 %.');
    expect(doc.metadata.extraction).toBeDefined();
  });

  it('feeds the previous window summary as context', async () => {
    const pool = llmPool('resumen de la ventana anterior');
    const calls = mockLlmAndBrain();
    await processLlmWindow(pool as never, SINK, LLM, row, false);
    const prompt = (calls.find(c => c.url.includes('chat/completions'))?.body.messages as { content: string }[])[0].content;
    expect(prompt).toContain('resumen de la ventana anterior');
  });

  it('the input-hash checkpoint skips the LLM entirely', async () => {
    const { llmInputHash } = require('./brain-windows-lib');
    const hash = llmInputHash(LLM.model, built.header, built.transcript, 'previo');
    const pool = llmPool('previo');
    const calls = mockLlmAndBrain();
    const r = await processLlmWindow(
      pool as never, SINK, LLM, { ...row, llm_input_hash: hash }, false
    );
    expect(r).toBe('skipped');
    expect(calls.some(c => c.url.includes('chat/completions'))).toBe(false);
    // status restored to done and the parent re-pushed with the stored summary
    expect(pool.sqlLike('SET llm_status')[0][1]).toBe('done');
    expect(calls.some(c => c.url.includes('push-ingest'))).toBe(true);
  });

  it('LLM failure records llm_status=failed with the error', async () => {
    const pool = llmPool(null);
    global.fetch = jest.fn(async () => new Response('down', { status: 500 })) as unknown as typeof fetch;
    const r = await processLlmWindow(pool as never, SINK, LLM, row, false);
    expect(r).toBe('failed');
    const status = pool.sqlLike('SET llm_status')[0];
    expect(status[1]).toBe('failed');
    expect(String(status[3])).toMatch(/down/);
  });

  it('a channel/bot or trivial row is marked skipped without any call', async () => {
    const pool = llmPool(null);
    const calls = mockLlmAndBrain();
    const r = await processLlmWindow(
      pool as never, SINK, LLM, { ...row, conv_kind: 'bot' }, false
    );
    expect(r).toBe('skipped');
    expect(pool.sqlLike('SET llm_status')[0][1]).toBe('skipped');
    expect(calls.length).toBe(0);
  });

  it('content that moved on since the ledger is skipped, not extracted', async () => {
    const pool = llmPool(null);
    const calls = mockLlmAndBrain();
    const r = await processLlmWindow(
      pool as never, SINK, LLM, { ...row, content_hash: 'stale' }, false
    );
    expect(r).toBe('skipped');
    expect(pool.sqlLike('SET llm_status').length).toBe(0);
    expect(calls.length).toBe(0);
  });
});

describe('groupAffectedChats', () => {
  it('merges rows per chat keeping the time span', () => {
    const chats = groupAffectedChats([
      { platform: 'whatsapp', conversation_id: 'a', wa_timestamp: new Date('2026-03-14T10:00:00Z') },
      { platform: 'whatsapp', conversation_id: 'b', wa_timestamp: new Date('2026-03-14T09:00:00Z') },
      { platform: 'whatsapp', conversation_id: 'a', wa_timestamp: new Date('2026-03-14T11:00:00Z') },
      { platform: 'telegram', conversation_id: 'a', wa_timestamp: new Date('2026-03-14T10:00:00Z') },
    ]);
    expect(chats.length).toBe(3);
    const a = chats.find(c => c.platform === 'whatsapp' && c.conversation_id === 'a')!;
    expect(a.minTs.toISOString()).toBe('2026-03-14T10:00:00.000Z');
    expect(a.maxTs.toISOString()).toBe('2026-03-14T11:00:00.000Z');
  });
});
