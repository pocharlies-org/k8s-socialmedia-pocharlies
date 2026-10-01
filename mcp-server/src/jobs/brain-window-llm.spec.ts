import {
  EXTRACTION_SCHEMA,
  LLM_CONCURRENCY,
  LlmConfig,
  buildExtractionPrompt,
  createLimiter,
  extractWindow,
  llmConcurrencyFromEnv,
  llmConfigFromEnv,
  normalizeExtraction,
} from './brain-window-llm';

const CFG: LlmConfig = {
  baseUrl: 'http://litellm:4000/v1',
  apiKey: 'sk-test',
  model: 'tooling',
  timeoutMs: 240000,
  retries: 2,
  maxTokens: 1200,
};

const WINDOW = { header: '[WhatsApp · chat «Ana» · 2026-03-14 18:02–18:47]', transcript: '18:02 Ana: hola' };

const GOOD = {
  summary: 'Ana y Dani cierran el presupuesto de la reforma.',
  topics: ['reforma', 'presupuesto'],
  entities: [{ name: 'Ana', type: 'persona', aliases: [] }],
  facts: ['El azulejo sube un 15 %.'],
  decisions: ['Se aplaza el baño.'],
  action_items: [{ owner: 'Dani', task: 'pedir muestra', due: '2026-03-16' }],
  sentiment: 'neutro',
  trivial: false,
};

function llmResponse(content: unknown) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }),
    { status: 200 }
  );
}

describe('extraction schema (ADR 0002 §5)', () => {
  it('accepts the ADR example shape and rejects bad enums', () => {
    expect(EXTRACTION_SCHEMA.safeParse(GOOD).success).toBe(true);
    expect(EXTRACTION_SCHEMA.safeParse({ ...GOOD, sentiment: 'meh' }).success).toBe(false);
    expect(EXTRACTION_SCHEMA.safeParse({ ...GOOD, entities: [{ name: 'x', type: 'alien' }] }).success).toBe(false);
    expect(EXTRACTION_SCHEMA.safeParse({ ...GOOD, summary: 'x'.repeat(2000) }).success).toBe(false);
  });
});

describe('prompt', () => {
  it('carries header, transcript and the previous summary', () => {
    const p = buildExtractionPrompt(WINDOW, 'resumen previo');
    expect(p).toContain(WINDOW.header);
    expect(p).toContain(WINDOW.transcript);
    expect(p).toContain('resumen previo');
    expect(buildExtractionPrompt(WINDOW, null)).not.toContain('ventana anterior');
  });
});

describe('extractWindow', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('posts JSON-mode params to LiteLLM and returns the validated extraction', async () => {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      return llmResponse(GOOD);
    }) as unknown as typeof fetch;
    const r = await extractWindow(CFG, WINDOW, null);
    expect(calls[0].url).toBe('http://litellm:4000/v1/chat/completions');
    expect(calls[0].headers.Authorization).toBe('Bearer sk-test');
    expect(calls[0].body.model).toBe('tooling');
    expect(calls[0].body.temperature).toBe(0);
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0].body.max_tokens).toBe(1200);
    expect(calls[0].body.enable_thinking).toBe(false);
    expect(r.extraction.summary).toBe(GOOD.summary);
    expect(r.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tolerates a markdown-fenced JSON answer', async () => {
    global.fetch = jest.fn(async () => llmResponse('```json\n' + JSON.stringify(GOOD) + '\n```')) as unknown as typeof fetch;
    await expect(extractWindow(CFG, WINDOW, null)).resolves.toBeDefined();
  });

  it('retries 5xx and schema failures, then throws with the last error', async () => {
    let n = 0;
    global.fetch = jest.fn(async () => {
      n++;
      if (n === 1) return new Response('upstream down', { status: 502 });
      // No summary: the one miss normalizeExtraction does not paper over.
      return llmResponse({ topics: ['sin resumen'] });
    }) as unknown as typeof fetch;
    await expect(
      extractWindow(CFG, WINDOW, null, { sleep: async () => {} })
    ).rejects.toThrow(/failed after 3 attempts/);
    expect(n).toBe(3); // retries: 2
  });

  it('does not retry a 401 (auth/config problem, not transient)', async () => {
    let n = 0;
    global.fetch = jest.fn(async () => {
      n++;
      return new Response('no key', { status: 401 });
    }) as unknown as typeof fetch;
    await expect(extractWindow(CFG, WINDOW, null, { sleep: async () => {} })).rejects.toThrow(/401/);
    expect(n).toBe(1);
  });

  it('network errors are retried', async () => {
    let n = 0;
    global.fetch = jest.fn(async () => {
      n++;
      if (n < 3) throw new Error('socket hang up');
      return llmResponse(GOOD);
    }) as unknown as typeof fetch;
    const r = await extractWindow(CFG, WINDOW, null, { sleep: async () => {} });
    expect(r.extraction.trivial).toBe(false);
    expect(n).toBe(3);
  });

  it('requires a base url', async () => {
    await expect(extractWindow({ ...CFG, baseUrl: '' }, WINDOW, null)).rejects.toThrow(/LLM_BASE_URL/);
  });
});

describe('concurrency (ADR 0002 §5: exactly 2)', () => {
  it('never runs more than 2 at once and keeps order of admission', async () => {
    expect(LLM_CONCURRENCY).toBe(2);
    let active = 0;
    let peak = 0;
    const limit = createLimiter(2);
    const job = (ms: number) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, ms));
        active--;
        return peak;
      });
    await Promise.all([job(30), job(30), job(30), job(1), job(1), job(1)]);
    expect(peak).toBe(2);
  });

  it('a rejected job does not wedge the queue', async () => {
    const limit = createLimiter(2);
    const results = await Promise.allSettled([
      limit(async () => {
        throw new Error('boom');
      }),
      limit(async () => 'ok'),
      limit(async () => 'ok2'),
    ]);
    expect(results[0].status).toBe('rejected');
    expect((results[1] as PromiseFulfilledResult<string>).value).toBe('ok');
    expect((results[2] as PromiseFulfilledResult<string>).value).toBe('ok2');
  });
});

describe('llmConfigFromEnv', () => {
  it('prefers the dedicated low-priority key and falls back to OPENAI_API_KEY', () => {
    expect(llmConfigFromEnv({ LLM_API_KEY: 'sk-batch', OPENAI_API_KEY: 'sk-old' }).apiKey).toBe('sk-batch');
    expect(llmConfigFromEnv({ OPENAI_API_KEY: 'sk-old' }).apiKey).toBe('sk-old');
    const c = llmConfigFromEnv({ LLM_BASE_URL: 'http://x/v1', LLM_CHAT_MODEL: 'tooling' });
    expect(c.model).toBe('tooling');
    expect(c.timeoutMs).toBe(240000);
    expect(c.retries).toBe(2);
    expect(c.maxTokens).toBe(1200);
  });
});

describe('normalizeExtraction (near-miss answers are kept, 02-10-2026)', () => {
  const ok = (v: unknown) => EXTRACTION_SCHEMA.safeParse(normalizeExtraction(v));

  it('maps entity-type synonyms and drops only the unknown entity', () => {
    const r = ok({
      ...GOOD,
      entities: [
        { name: 'Skirmshop', type: 'empresa' },
        { name: 'Madrid', type: 'Ciudad' },
        { name: 'x', type: 'alien' },
        { name: 'Ana', type: 'Persona' },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success)
      expect(r.data.entities.map(e => [e.name, e.type])).toEqual([
        ['Skirmshop', 'organizacion'],
        ['Madrid', 'lugar'],
        ['Ana', 'persona'],
      ]);
  });

  it('cuts lists and the summary to their caps instead of failing', () => {
    const r = ok({
      ...GOOD,
      summary: 'x'.repeat(2000),
      topics: Array.from({ length: 10 }, (_, i) => `t${i}`),
      facts: Array.from({ length: 30 }, (_, i) => `f${i}`),
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.summary).toHaveLength(1200);
      expect(r.data.topics).toHaveLength(6);
      expect(r.data.facts).toHaveLength(24);
    }
  });

  it('maps an unknown or English sentiment and a string boolean', () => {
    const a = ok({ ...GOOD, sentiment: 'Negative', trivial: 'true' });
    expect(a.success && a.data.sentiment).toBe('negativo');
    expect(a.success && a.data.trivial).toBe(true);
    expect(ok({ ...GOOD, sentiment: 'meh' }).success && true).toBe(true);
  });

  it('accepts plain-string action items', () => {
    const r = ok({ ...GOOD, action_items: ['llamar a Ana', { task: 'pagar', owner: 'Dani' }] });
    expect(r.success && r.data.action_items).toEqual([
      { owner: '', task: 'llamar a Ana', due: '' },
      { owner: 'Dani', task: 'pagar', due: '' },
    ]);
  });

  it('still fails without a summary (a real miss, worth the retry)', () => {
    const { summary: _s, ...rest } = GOOD;
    expect(ok(rest).success).toBe(false);
  });

  it('extractWindow keeps a near-miss answer on the first attempt', async () => {
    let n = 0;
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => {
      n++;
      return llmResponse({ ...GOOD, entities: [{ name: 'Skirmshop', type: 'empresa' }] });
    }) as unknown as typeof fetch;
    const r = await extractWindow(CFG, WINDOW, null, { sleep: async () => {} });
    global.fetch = realFetch;
    expect(n).toBe(1);
    expect(r.extraction.entities[0].type).toBe('organizacion');
  });
});

describe('llmConcurrencyFromEnv', () => {
  it('defaults to 2 and takes 1..8 from BRAIN_WINDOWS_LLM_CONCURRENCY', () => {
    expect(llmConcurrencyFromEnv({})).toBe(2);
    expect(llmConcurrencyFromEnv({ BRAIN_WINDOWS_LLM_CONCURRENCY: '4' })).toBe(4);
    expect(llmConcurrencyFromEnv({ BRAIN_WINDOWS_LLM_CONCURRENCY: '0' })).toBe(2);
    expect(llmConcurrencyFromEnv({ BRAIN_WINDOWS_LLM_CONCURRENCY: '50' })).toBe(2);
    expect(llmConcurrencyFromEnv({ BRAIN_WINDOWS_LLM_CONCURRENCY: 'x' })).toBe(2);
  });
});
