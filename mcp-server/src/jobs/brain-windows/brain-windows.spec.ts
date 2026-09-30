import { readFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { BrainDoc } from '../brain-ingest-lib';
import type { BrainClient } from './brain-client';
import { dryRunAccount, formatHistogram, runAccount, type Deps, type Logger } from './brain-windows';
import { TransientLlmError, type ChatFn } from './llm-extract';
import { LlmPool } from './llm-pool';
import { Mem, memoryStore } from './test-support/memory-store';
import { msg } from './test-support/helpers';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(join(__dirname, 'contract', 'conversation-window.schema.json'), 'utf8')));

const CONV = 'c0a8f1d2-0000-4000-8000-000000000001';
const CONV2 = 'c0a8f1d2-0000-4000-8000-000000000002';
const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const good = JSON.stringify({ summary: 'Acuerdan el pedido.', topics: ['pedido'], entities: [{ type: 'Person', name: 'Luis' }], patterns: [], skip: null });

interface Push { instance: string; adapter: string; docs: BrainDoc[] }

function setup(opts: { chat?: ChatFn | null; kinds?: Deps['kinds']; maxLlm?: number | null; brain?: Partial<BrainClient> } = {}) {
  const mem = new Mem();
  const pushes: Push[] = [];
  const deletes: string[] = [];
  const brain: BrainClient = {
    push: async (instance, adapter, docs) => {
      pushes.push({ instance, adapter, docs });
      return docs.length;
    },
    deleteWindow: async (_i, id) => void deletes.push(id),
    ...opts.brain,
  };
  const chat = jest.fn(opts.chat === undefined ? async () => good : (opts.chat ?? (async () => good)));
  const deps: Deps = {
    db: {} as never,
    store: memoryStore(mem),
    brain,
    chat: opts.chat === null ? null : chat,
    pool: new LlmPool(2),
    kinds: opts.kinds ?? {},
    maxLlmPerRun: opts.maxLlm ?? null,
    log: quiet,
    sleep: async () => {},
  };
  const run = () => runAccount(deps, 'personal');
  const windowPushes = () => pushes.filter((p) => p.adapter === 'conversation');
  return { mem, pushes, deletes, deps, run, chat, windowPushes };
}

/** A conversation of `n` messages, 30 s apart, starting at `sec0`, ids from `id0`. */
function fill(mem: Mem, conv: string, n: number, sec0 = 0, id0 = 1, text = 'hablamos del pedido de mañana') {
  for (let i = 0; i < n; i++) mem.add(conv, msg(id0 + i, sec0 + i * 30, `${text} ${i}`));
}

describe('brain-windows: run', () => {
  it('initial load pushes window + chunks in ONE request, then the packet; every doc validates', async () => {
    const t = setup();
    fill(t.mem, CONV, 5);
    const s = await t.run();
    expect(s).toMatchObject({ chats: 1, windowsPushed: 1, llmDone: 1, failures: 0 });
    const kinds = t.pushes.map((p) => [p.instance, p.adapter, p.docs.map((d) => d.metadata.type)]);
    expect(kinds[0]).toEqual(['personal', 'conversation', ['conversation_window', 'conversation_chunk']]); // pending first
    expect(kinds[1]).toEqual(['personal', 'conversation', ['conversation_window', 'conversation_chunk']]); // then with the summary
    expect(kinds[2]).toEqual(['personal', 'knowledge_packet', ['conversation_packet']]);
    expect(t.pushes[0].docs[0].metadata.llm_status).toBe('pending');
    expect(t.pushes[1].docs[0].metadata.llm_status).toBe('done');
    expect(t.pushes[1].docs[0].content).toBe('Acuerdan el pedido.');
    for (const p of t.pushes) for (const d of p.docs) expect({ id: d.source_id, ok: validate(d) }).toEqual({ id: d.source_id, ok: true });
    expect(t.mem.cursors.get('personal')).toBeDefined();
  });

  it('a second run with nothing new repeats nothing: no pushes, no LLM calls', async () => {
    const t = setup();
    fill(t.mem, CONV, 5);
    await t.run();
    const pushed = t.pushes.length;
    const calls = t.chat.mock.calls.length;
    const s = await t.run();
    expect(t.pushes).toHaveLength(pushed);
    expect(t.chat).toHaveBeenCalledTimes(calls);
    expect(s.chats).toBe(0);
  });

  it('resume after a failure: no window is pushed twice and no LLM call is repeated; cursor only advances on success', async () => {
    let failOn: string | null = CONV2;
    const t = setup({
      brain: {
        push: async function (this: unknown, instance, adapter, docs) {
          if (failOn && docs[0].metadata.conversation_id === failOn) throw new Error('503 connection reset');
          t.pushes.push({ instance, adapter, docs });
          return docs.length;
        },
      },
    });
    fill(t.mem, CONV, 5, 0, 1);
    fill(t.mem, CONV2, 5, 100_000, 100);
    const first = await t.run();
    expect(first.failures).toBe(1);
    expect(t.mem.cursors.has('personal')).toBe(false);
    const afterFirst = t.pushes.filter((p) => p.adapter === 'conversation').map((p) => `${p.docs[0].source_id}|${p.docs[0].metadata.llm_status}`);
    const llmFirst = t.chat.mock.calls.length;

    failOn = null;
    const second = await t.run();
    expect(second.failures).toBe(0);
    expect(t.mem.cursors.has('personal')).toBe(true);
    const all = t.pushes.filter((p) => p.adapter === 'conversation').map((p) => `${p.docs[0].source_id}|${p.docs[0].metadata.llm_status}`);
    expect(new Set(all).size).toBe(all.length); // the same (window, status) never pushed twice
    expect(afterFirst.every((x) => all.filter((y) => y === x).length === 1)).toBe(true);
    // one LLM call per eligible window in total (CONV was done in run 1; CONV2 in run 2)
    expect(llmFirst).toBe(1);
    expect(t.chat).toHaveBeenCalledTimes(2);
  });

  it('a stored LLM answer is reused when the push failed after it: one call, not two', async () => {
    let failWindowWithSummary = true;
    const t = setup({
      brain: {
        push: async (instance, adapter, docs) => {
          if (failWindowWithSummary && docs[0].metadata.llm_status === 'done') throw new Error('503 down');
          t.pushes.push({ instance, adapter, docs });
          return docs.length;
        },
      },
    });
    fill(t.mem, CONV, 5);
    await t.run();
    expect(t.chat).toHaveBeenCalledTimes(1);
    failWindowWithSummary = false;
    await t.run();
    expect(t.chat).toHaveBeenCalledTimes(1);
    expect(t.pushes.some((p) => p.docs[0].metadata.llm_status === 'done')).toBe(true);
  });

  it('late message inside the window: same window_id (upsert), no delete, LLM redone because the input changed', async () => {
    const t = setup();
    fill(t.mem, CONV, 5);
    await t.run();
    const id = [...t.mem.windows.keys()][0];
    t.mem.add(CONV, msg(999, 60, 'mensaje tardío dentro de la ventana')); // wa_timestamp in the middle, inserted now
    await t.run();
    expect(t.deletes).toEqual([]);
    expect([...t.mem.windows.keys()]).toEqual([id]);
    const w = t.windowPushes().map((p) => p.docs[0]);
    expect(w.filter((d) => d.source_id === id).length).toBeGreaterThanOrEqual(3);
    expect(w[w.length - 1].metadata).toMatchObject({ message_count: 6, llm_status: 'done' });
    expect(t.chat).toHaveBeenCalledTimes(2);
  });

  it('late message older than the first one: new window_id is pushed and the old one is delete-window’d', async () => {
    const t = setup();
    fill(t.mem, CONV, 5, 1_000, 10);
    await t.run();
    const oldId = [...t.mem.windows.keys()][0];
    expect(oldId.endsWith(':10')).toBe(true);
    t.mem.add(CONV, msg(5, 900, 'llega tarde y es el primero')); // 100 s before the first one, same window
    await t.run();
    expect(t.deletes).toEqual([oldId]);
    expect([...t.mem.windows.keys()]).toEqual([oldId.replace(/:10$/, ':5')]);
    expect(t.windowPushes().some((p) => p.docs[0].source_id.endsWith(':5'))).toBe(true);
  });

  it('a window that stops existing is deleted; a later window of the chat is untouched', async () => {
    const t = setup();
    fill(t.mem, CONV, 4, 0, 1);
    fill(t.mem, CONV, 4, 100_000, 50);
    await t.run();
    expect(t.mem.windows.size).toBe(2);
    t.mem.messages = t.mem.messages.filter((m) => Number(m.id) >= 50); // the first window's messages vanish
    t.mem.dirty.push({ account: 'personal', conversationId: CONV, at: 1 });
    await t.run();
    expect(t.deletes).toHaveLength(1);
    expect(t.mem.windows.size).toBe(1);
  });

  it('kind != chat and trivial windows: window + chunks, llm_status=skipped, no LLM, no packet', async () => {
    const t = setup({ kinds: { [CONV]: 'bot' } });
    fill(t.mem, CONV, 6);
    t.mem.add(CONV2, msg(500, 0, 'hola que tal')); // trivial: 1 message, < 400 chars
    await t.run();
    expect(t.chat).not.toHaveBeenCalled();
    expect(t.pushes.every((p) => p.adapter === 'conversation')).toBe(true);
    const ws = t.windowPushes().map((p) => p.docs[0].metadata);
    expect(ws.map((m) => [m.kind, m.llm_status]).sort()).toEqual([['bot', 'skipped'], ['chat', 'skipped']]);
    expect(t.windowPushes().every((p) => p.docs.length >= 2)).toBe(true);
    for (const p of t.pushes) for (const d of p.docs) expect(validate(d)).toBe(true);
  });

  it('invalid JSON from the LLM: one retry, then llm_status=skipped (window pushed, no packet)', async () => {
    const t = setup({ chat: async () => 'no json' });
    fill(t.mem, CONV, 5);
    const s = await t.run();
    expect(t.chat).toHaveBeenCalledTimes(2);
    expect(s).toMatchObject({ llmSkipped: 1, llmDone: 0 });
    expect(t.mem.windows.values().next().value).toMatchObject({ llmStatus: 'skipped', llmJson: { status: 'skipped', reason: 'invalid_json' } });
    expect(t.pushes.some((p) => p.adapter === 'knowledge_packet')).toBe(false);
    expect(t.windowPushes().pop()!.docs[0].metadata.llm_status).toBe('skipped');
  });

  it('LLM down: windows stay pending, nothing is marked skipped, and the pass gives up after 5 errors', async () => {
    const t = setup({ chat: async () => { throw new TransientLlmError('503', 503); } });
    for (let c = 0; c < 8; c++) fill(t.mem, `c-${c}`, 4, c * 100_000, 1 + c * 10);
    const s = await t.run();
    expect(s.llmErrors).toBeGreaterThanOrEqual(5);
    expect([...t.mem.windows.values()].every((w) => w.llmStatus === 'pending')).toBe(true);
    expect(s.failures).toBe(0);
  });

  it('incremental cap: MAX_LLM_PER_RUN, most recent first; initial load has no cap', async () => {
    const t = setup({ maxLlm: 2 });
    for (let c = 0; c < 5; c++) fill(t.mem, `c-${c}`, 4, c * 100_000, 1 + c * 10);
    await t.run(); // first run = initial load: no cap
    expect(t.chat).toHaveBeenCalledTimes(5);
    for (let c = 5; c < 10; c++) fill(t.mem, `c-${c}`, 4, c * 100_000, 1 + c * 10);
    await t.run(); // incremental: cap 2, newest windows first
    expect(t.chat).toHaveBeenCalledTimes(7);
    const done = [...t.mem.windows.values()].filter((w) => w.llmStatus === 'done' && w.conversationId >= 'c-5').map((w) => w.conversationId).sort();
    expect(done).toEqual(['c-8', 'c-9']);
  });

  it('never more than 2 LLM requests in flight across the whole run', async () => {
    let inflight = 0;
    let peak = 0;
    const t = setup({
      chat: async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 2));
        inflight--;
        return good;
      },
    });
    for (let c = 0; c < 12; c++) fill(t.mem, `c-${c}`, 4, c * 100_000, 1 + c * 10);
    await t.run();
    expect(t.chat).toHaveBeenCalledTimes(12);
    expect(peak).toBe(2);
  });

  it('poison (422): logged, the run continues, and the same content is not retried', async () => {
    const t = setup({
      brain: {
        push: async (instance, adapter, docs) => {
          if (docs[0].metadata.conversation_id === CONV) throw new Error(`brain push-ingest ${instance}/${adapter} -> 422: window_text too long`);
          t.pushes.push({ instance, adapter, docs });
          return docs.length;
        },
      },
    });
    fill(t.mem, CONV, 4, 0, 1);
    fill(t.mem, CONV2, 4, 100_000, 50);
    const s = await t.run();
    expect(s).toMatchObject({ poison: 1, failures: 0 });
    expect(t.mem.cursors.has('personal')).toBe(true);
    expect([...t.mem.windows.values()].find((w) => w.conversationId === CONV)!.pushError).toMatch(/422/);
    t.mem.add(CONV2, msg(900, 500_000, 'otra conversación')); // forces a cursor advance
    t.mem.add(CONV, msg(901, 600_000, 'nuevo en la conversación envenenada'));
    const s2 = await t.run();
    expect(s2.windowsPushed).toBeGreaterThanOrEqual(1); // the new window of the poisoned chat is tried
  });

  it.each([401, 403, 404, 405])('a %i from the brain is a configuration failure, not poison: thrown, no push_error, cursor not advanced, retried next run', async (status) => {
    let broken = true;
    const t = setup({
      brain: {
        push: async (instance, adapter, docs) => {
          if (broken) throw new Error(`brain push-ingest ${instance}/${adapter} -> ${status}: nope`);
          t.pushes.push({ instance, adapter, docs });
          return docs.length;
        },
      },
    });
    fill(t.mem, CONV, 4);
    const s1 = await t.run();
    expect(s1).toMatchObject({ failures: 1, poison: 0 });
    expect(t.mem.windows.size).toBe(0);
    expect(t.mem.cursors.has('personal')).toBe(false);
    broken = false;
    const s2 = await t.run();
    expect(s2).toMatchObject({ failures: 0, windowsPushed: 1 });
    expect([...t.mem.windows.values()].every((w) => !w.pushError)).toBe(true);
  });

  it.each([400, 413, 422])('a %i is poison: push_error set, run continues, cursor advances', async (status) => {
    const t = setup({
      brain: {
        push: async (instance, adapter, docs) => {
          if (docs[0].metadata.conversation_id === CONV) throw new Error(`brain push-ingest ${instance}/${adapter} -> ${status}: bad doc`);
          t.pushes.push({ instance, adapter, docs });
          return docs.length;
        },
      },
    });
    fill(t.mem, CONV, 4, 0, 1);
    fill(t.mem, CONV2, 4, 100_000, 50);
    const s = await t.run();
    expect(s).toMatchObject({ poison: 1, failures: 0 });
    expect(t.mem.cursors.has('personal')).toBe(true);
  });

  it.each([['422 poison', 'brain delete-window personal -> 422: bad id'], ['404 absent route', 'brain delete-window personal -> 404: Not Found'], ['503 down', 'brain delete-window personal -> 503: down']])(
    'delete-window failing (%s): the state row is KEPT, it counts as a failure, the cursor does not advance; next run deletes it',
    async (_n, message) => {
      let broken = true;
      const t = setup({
        brain: {
          deleteWindow: async (_i, id) => {
            if (broken) throw new Error(message);
            t.deletes.push(id);
          },
        },
      });
      fill(t.mem, CONV, 5, 1_000, 10);
      await t.run();
      const oldId = [...t.mem.windows.keys()][0];
      t.mem.add(CONV, msg(5, 900, 'llega tarde y es el primero'));
      const s = await t.run();
      expect(s.failures).toBe(1);
      expect(t.mem.windows.has(oldId)).toBe(true); // not orphaned: still tracked, retried
      expect(t.mem.cursors.get('personal')!.lastCreatedAt).not.toBe(String(Math.max(...t.mem.counted().map((m) => m.seq))));
      broken = false;
      const s2 = await t.run();
      expect(s2.failures).toBe(0);
      expect(t.deletes).toEqual([oldId]);
      expect(t.mem.windows.has(oldId)).toBe(false);
    }
  );

  it('dirty mailbox (late voice transcription): recomputes the chat, re-pushes only the changed window, clears the row', async () => {
    const t = setup();
    fill(t.mem, CONV, 4, 0, 1);
    fill(t.mem, CONV, 4, 100_000, 50);
    await t.run();
    const before = t.windowPushes().length;
    const m = t.mem.messages.find((x) => x.id === '51')!;
    m.content = 'ahora sí tiene la transcripción de la nota de voz'; // the UPDATE of the transcriber
    t.mem.dirty.push({ account: 'personal', conversationId: CONV, at: 5 });
    await t.run();
    const added = t.windowPushes().slice(before).map((p) => p.docs[0].source_id);
    expect(new Set(added).size).toBe(1);
    expect(added[0].endsWith(':50')).toBe(true);
    expect(t.mem.dirty).toHaveLength(0);
  });

  it('no LLM configured (chat null): windows pushed pending, nothing is asked, zero failures — also on the initial load', async () => {
    const t = setup({ chat: null });
    for (let c = 0; c < 6; c++) fill(t.mem, `c-${c}`, 4, c * 100_000, 1 + c * 10);
    const s = await t.run();
    expect(s).toMatchObject({ windowsPushed: 6, failures: 0, llmDone: 0, llmErrors: 0 });
    expect(t.windowPushes().every((p) => p.docs[0].metadata.llm_status === 'pending')).toBe(true);
    expect([...t.mem.windows.values()].every((w) => w.llmStatus === 'pending')).toBe(true);
    expect(t.mem.cursors.has('personal')).toBe(true);
  });

  it('maxLlmPerRun = 0 means NO LLM (not "no cap"), on the initial load and after it', async () => {
    const t = setup({ maxLlm: 0 });
    for (let c = 0; c < 5; c++) fill(t.mem, `c-${c}`, 4, c * 100_000, 1 + c * 10);
    await t.run(); // initial load: the override to "no cap" must not apply to 0
    expect(t.chat).not.toHaveBeenCalled();
    fill(t.mem, 'c-9', 4, 900_000, 91);
    await t.run();
    expect(t.chat).not.toHaveBeenCalled();
    expect([...t.mem.windows.values()].every((w) => w.llmStatus === 'pending')).toBe(true);
  });

  it('pendingLlm: null = no cap, 0 = none, n = n most recent', async () => {
    const t = setup({ chat: null });
    for (let c = 0; c < 4; c++) fill(t.mem, `c-${c}`, 4, c * 100_000, 1 + c * 10);
    await t.run();
    const q = (n: number | null) => t.deps.store.pendingLlm(t.deps.db, 'personal', n);
    expect(await q(null)).toHaveLength(4);
    expect(await q(0)).toHaveLength(0);
    expect((await q(2)).map((w) => w.conversationId)).toEqual(['c-3', 'c-2']);
  });

  it('snapshot with delay: a message younger than the delay is not in the snapshot, the cursor does not pass it, and it is picked up once it has aged', async () => {
    const t = setup();
    fill(t.mem, CONV, 4, 0, 1);
    t.mem.add(CONV2, msg(500, 100_000, 'mensaje de una transacción larga que aún no se ve'), { young: true });
    await t.run();
    expect(t.mem.windows.size).toBe(1); // only CONV
    expect([...t.mem.windows.values()][0].conversationId).toBe(CONV);
    const cur = t.mem.cursors.get('personal')!;
    expect(Number(cur.lastCreatedAt)).toBeLessThan(t.mem.messages.find((m) => m.id === '500')!.seq);
    t.mem.messages.find((m) => m.id === '500')!.young = false; // 15 minutes later
    await t.run();
    expect(t.mem.windows.size).toBe(2);
  });
});

describe('brain-windows: DRY_RUN histogram (read-only)', () => {
  it('counts windows, chunks and LLM-eligible windows without touching brain, LLM or state', async () => {
    const mem = new Mem();
    fill(mem, CONV, 5); // eligible
    mem.add(CONV2, msg(500, 0, 'hola que tal')); // trivial
    const h = await dryRunAccount({ db: {} as never, store: memoryStore(mem), kinds: { [CONV2]: 'bot' }, log: quiet }, 'personal');
    expect(h).toMatchObject({ conversations: 2, messages: 6, windows: 2, llmEligible: 1, llmSkipped: { kind: 1 }, byKind: { chat: 1, bot: 1 } });
    expect(mem.windows.size).toBe(0);
    expect(mem.cursors.size).toBe(0);
    const out = formatHistogram([h]);
    expect(out).toContain('DRY_RUN brain-windows');
    expect(out).toContain('LLM-eligible windows, all accounts: 1');
  });
});
