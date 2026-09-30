import { ENTITY_TYPES, extractWindow, normalizeEntityType, normalizeExtraction, skipReason, TransientLlmError, type ChatFn } from './llm-extract';
import { LlmPool } from './llm-pool';
import { buildWindows } from './window-builder';
import { META, msg } from './test-support/helpers';

const longWindow = () =>
  buildWindows(META, [msg(1, 0, 'hablamos del pedido de mañana'), msg(2, 10, 'llega a las nueve'), msg(3, 20, 'perfecto, lo recibe Luis')])[0];
const good = JSON.stringify({ summary: 'Acuerdan el pedido de mañana.', topics: ['Pedido', 'Entrega Mañana'], entities: [{ type: 'person', name: 'Luis' }], patterns: [], skip: null });
const noSleep = async () => {};

describe('skipReason (LLM eligibility)', () => {
  it('kind != chat never goes to the LLM', () => {
    expect(skipReason(longWindow(), 'bot')).toBe('kind');
    expect(skipReason(longWindow(), 'broadcast')).toBe('kind');
  });
  it('trivial: < 3 messages and < 400 chars, or every message <= 12 chars', () => {
    expect(skipReason(buildWindows(META, [msg(1, 0, 'hola, qué tal todo por ahí')])[0], 'chat')).toBe('trivial');
    const short = buildWindows(META, Array.from({ length: 30 }, (_, i) => msg(i + 1, i, 'vale ok')))[0];
    expect(skipReason(short, 'chat')).toBe('trivial');
    expect(skipReason(longWindow(), 'chat')).toBeNull();
  });
  it('3 messages are eligible even if short in chars as long as one exceeds 12', () => {
    expect(skipReason(longWindow(), 'chat')).toBeNull();
  });
});

describe('normalizeExtraction', () => {
  it('trims to the contract limits and kebab-cases topics', () => {
    const r = normalizeExtraction({
      summary: 's'.repeat(900),
      topics: ['Pedido Grande', 'pedido-grande', 'a', 'b', 'c', 'd', 'e'],
      entities: Array.from({ length: 10 }, (_, i) => ({ type: 'Person', name: `P${i}` })),
      patterns: ['1', '2', '3', '4'],
      skip: null,
    });
    expect(r.status).toBe('done');
    if (r.status !== 'done') return;
    expect(r.result.summary).toHaveLength(600);
    expect(r.result.topics).toEqual(['pedido-grande', 'a', 'b', 'c', 'd']);
    expect(r.result.entities).toHaveLength(7);
    expect(r.result.patterns).toHaveLength(3);
  });
  it('skip:"trivial" and empty summary are skipped; wrong shape throws', () => {
    expect(normalizeExtraction({ summary: 'x', skip: 'trivial' })).toEqual({ status: 'skipped', reason: 'trivial' });
    expect(normalizeExtraction({ summary: '  ' })).toEqual({ status: 'skipped', reason: 'empty_summary' });
    expect(() => normalizeExtraction({ summary: 3 })).toThrow();
  });
});

describe('extractWindow', () => {
  it('returns the validated extraction', async () => {
    const chat: ChatFn = async () => good;
    const r = await extractWindow(longWindow(), { chat, pool: new LlmPool(2), sleep: noSleep });
    expect(r).toMatchObject({ status: 'done', result: { topics: ['pedido', 'entrega-manana'] } });
  });

  it('accepts JSON inside a code fence', async () => {
    const r = await extractWindow(longWindow(), { chat: async () => '```json\n' + good + '\n```', pool: new LlmPool(2), sleep: noSleep });
    expect(r.status).toBe('done');
  });

  it('invalid JSON: exactly 1 retry, then skipped(invalid_json)', async () => {
    const chat = jest.fn<Promise<string>, []>(async () => 'no soy json');
    const r = await extractWindow(longWindow(), { chat, pool: new LlmPool(2), sleep: noSleep });
    expect(r).toEqual({ status: 'skipped', reason: 'invalid_json' });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('invalid JSON then a good answer on the retry succeeds', async () => {
    const answers = ['{', good];
    const r = await extractWindow(longWindow(), { chat: async () => answers.shift()!, pool: new LlmPool(2), sleep: noSleep });
    expect(r.status).toBe('done');
  });

  it('backs off on 429/5xx and gives up as llm_error', async () => {
    const sleeps: number[] = [];
    const chat = jest.fn(async () => { throw new TransientLlmError('503', 503); });
    const r = await extractWindow(longWindow(), { chat, pool: new LlmPool(2), sleep: async (ms) => { sleeps.push(ms); } });
    expect(r.status).toBe('skipped');
    expect((r as { reason: string }).reason).toMatch(/^llm_error:/);
    expect(chat).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([2000, 4000, 8000, 16000]);
  });

  it('never more than 2 requests in flight, retries (transient and invalid JSON) included', async () => {
    let inflight = 0;
    let peak = 0;
    const calls = new Map<number, number>();
    let n = 0;
    const chat: ChatFn = async () => {
      const id = n++;
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 3));
      inflight--;
      const k = (calls.get(id % 10) ?? 0) + 1;
      calls.set(id % 10, k);
      if (id % 3 === 0) throw new TransientLlmError('429', 429);
      if (id % 3 === 1) return 'basura';
      return good;
    };
    const pool = new LlmPool(2);
    const rs = await Promise.all(Array.from({ length: 20 }, () => extractWindow(longWindow(), { chat, pool, sleep: async () => { await new Promise((r) => setTimeout(r, 1)); } })));
    expect(rs).toHaveLength(20);
    expect(n).toBeGreaterThan(20); // retries really happened
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('entity types: the closed lowercase set the brain maps (ontology.py entity_label_for_kp_type)', () => {
  it('normalizes case, maps org -> organization and anything unknown -> other', () => {
    expect(ENTITY_TYPES).toEqual(['person', 'organization', 'place', 'product', 'event', 'other']);
    const cases: Array<[string, string]> = [['Person', 'person'], ['PERSON', 'person'], ['Org', 'organization'], ['org', 'organization'], ['Organization', 'organization'], ['Place', 'place'], ['Product', 'product'], ['Event', 'event'], ['Other', 'other'], ['Persona', 'other'], ['', 'other'], ['  Place ', 'place']];
    for (const [raw, want] of cases) expect(normalizeEntityType(raw)).toBe(want);
  });

  it('normalizeExtraction stores only members of the set (and de-duplicates after normalizing)', () => {
    const r = normalizeExtraction({
      summary: 'x',
      entities: [{ type: 'Org', name: 'Skirmshop' }, { type: 'organization', name: 'skirmshop' }, { type: 'Person', name: 'Luis' }, { type: 'Country', name: 'España' }],
    });
    if (r.status !== 'done') throw new Error('expected done');
    expect(r.result.entities).toEqual([{ type: 'organization', name: 'Skirmshop' }, { type: 'person', name: 'Luis' }, { type: 'other', name: 'España' }]);
    for (const e of r.result.entities) expect(ENTITY_TYPES).toContain(e.type);
  });

  it('the prompt asks for the lowercase set, not the old capitalized one', async () => {
    const seen: string[] = [];
    await extractWindow(longWindow(), { chat: async (system) => (seen.push(system), good), pool: new LlmPool(2), sleep: noSleep });
    expect(seen[0]).toContain('person|organization|place|product|event|other');
    expect(seen[0]).not.toContain('Person|Org');
  });
});
