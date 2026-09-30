/**
 * LLM extraction for brain windows (INFRA-364, ADR 0002 §5).
 *
 * Local model behind LiteLLM (alias `tooling` -> the resident of the Sparks),
 * on a LOW-PRIORITY virtual key, exactly 2 requests in parallel, temperature
 * 0, JSON mode, 240 s timeout, 2 retries. Trivial windows and channel/bot
 * kinds never reach this module (the callers filter, ADR §5).
 *
 * The output shape is the ADR §5 JSON, validated with zod: a model answer
 * that does not fit the schema is a FAILED extraction, not a corrupt brain.
 */
import { z } from 'zod';
import { BuiltWindow, llmInputHash } from './brain-windows-lib';

export const EXTRACTION_SCHEMA = z.object({
  summary: z.string().max(1200),
  topics: z.array(z.string()).max(6),
  entities: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum([
          'persona',
          'lugar',
          'organizacion',
          'proyecto',
          'producto',
          'servicio',
          'evento',
          'importe',
          'fecha',
        ]),
        aliases: z.array(z.string()).default([]),
      })
    )
    .max(24),
  facts: z.array(z.string()).max(24),
  decisions: z.array(z.string()).max(24),
  action_items: z
    .array(
      z.object({ owner: z.string().default(''), task: z.string(), due: z.string().default('') })
    )
    .max(24),
  sentiment: z.enum(['positivo', 'neutro', 'negativo', 'mixto']),
  trivial: z.boolean(),
});

export type Extraction = z.infer<typeof EXTRACTION_SCHEMA>;

export interface LlmConfig {
  baseUrl: string; // e.g. http://litellm.litellm.svc.cluster.local:4000/v1
  apiKey: string; // low-priority virtual key (ADR §5 "tipo hermes-batch")
  model: string; // 'tooling'
  timeoutMs: number; // 240000 (ADR §5)
  retries: number; // 2 (ADR §5)
  maxTokens: number; // 1200 (ADR §5)
}

export const LLM_CONCURRENCY = 2; // ADR §5: "2 peticiones en paralelo", exactly

export function llmConfigFromEnv(env: NodeJS.ProcessEnv): LlmConfig {
  return {
    baseUrl: env.LLM_BASE_URL || '',
    // LLM_API_KEY is the dedicated low-priority key; OPENAI_API_KEY is the
    // repo's existing LiteLLM key (envFrom whatsapp-mcp-secrets), kept as the
    // fallback so the job runs before the dedicated key is provisioned.
    apiKey: env.LLM_API_KEY || env.OPENAI_API_KEY || '',
    model: env.LLM_CHAT_MODEL || 'tooling',
    timeoutMs: num(env.LLM_TIMEOUT_MS, 240000),
    retries: num(env.LLM_RETRIES, 2),
    maxTokens: num(env.LLM_MAX_TOKENS, 1200),
  };
}

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/**
 * Tiny limiter equivalent to p-limit (which is ESM-only from v3; this repo's
 * jest/ts-jest run is CJS). `run`s are queued and executed with at most
 * `concurrency` in flight.
 */
export function createLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        fn().then(
          v => {
            active--;
            resolve(v);
            queue.shift()?.();
          },
          e => {
            active--;
            reject(e);
            queue.shift()?.();
          }
        );
      };
      if (active < concurrency) start();
      else queue.push(start);
    });
}

/** Prompt (ADR §5): header + transcript + previous-window summary, Spanish out. */
export function buildExtractionPrompt(
  w: Pick<BuiltWindow, 'header' | 'transcript'>,
  prevSummary: string | null
): string {
  const prev = prevSummary
    ? `Contexto (resumen de la ventana anterior del mismo chat, para resolver referencias):\n${prevSummary}\n\n`
    : '';
  return (
    `Eres el extractor de conocimiento de una base de conversaciones de WhatsApp y Telegram. ` +
    `Devuelve EXCLUSIVAMENTE un objeto JSON (sin markdown) con esta forma exacta:\n` +
    `{"summary": "resumen en español de máximo 120 palabras", ` +
    `"topics": ["hasta 6 temas"], ` +
    `"entities": [{"name": "", "type": "persona|lugar|organizacion|proyecto|producto|servicio|evento|importe|fecha", "aliases": []}], ` +
    `"facts": ["hechos concretos"], "decisions": ["decisiones tomadas"], ` +
    `"action_items": [{"owner": "", "task": "", "due": ""}], ` +
    `"sentiment": "positivo|neutro|negativo|mixto", "trivial": false}\n` +
    `"trivial" debe ser true solo si la conversación no aporta ninguna información.\n\n` +
    `${prev}` +
    `Ventana de conversación:\n${w.header}\n${w.transcript}`
  );
}

export interface ExtractResult {
  extraction: Extraction;
  inputHash: string;
}

/**
 * Run the extraction for one window. Throws on persistent failure (the caller
 * records llm_status=failed and retries next pass, ADR §5).
 */
export async function extractWindow(
  config: LlmConfig,
  w: Pick<BuiltWindow, 'header' | 'transcript'>,
  prevSummary: string | null,
  deps: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<ExtractResult> {
  if (!config.baseUrl) throw new Error('LLM_BASE_URL is unset: cannot run window extraction');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const inputHash = llmInputHash(config.model, w.header, w.transcript, prevSummary);
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: config.model,
    messages: [{ role: 'user', content: buildExtractionPrompt(w, prevSummary) }],
    temperature: 0,
    max_tokens: config.maxTokens,
    response_format: { type: 'json_object' },
    enable_thinking: false, // local vLLM default (CLAUDE.md); explicit here
  };

  let lastError = 'unknown';
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (attempt > 0) await sleep(2000 * 2 ** (attempt - 1));
    try {
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!resp.ok) {
        const text = (await resp.text().catch(() => '')).slice(0, 300);
        lastError = `LLM ${resp.status}: ${text}`;
        // 4xx other than 429 will not fix themselves: stop early.
        if (resp.status < 500 && resp.status !== 429) break;
        continue;
      }
      const data = (await resp.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const raw = data.choices?.[0]?.message?.content ?? '';
      const parsed = safeJson(raw);
      if (parsed === undefined) {
        lastError = `LLM returned non-JSON content: ${raw.slice(0, 200)}`;
        continue;
      }
      const checked = EXTRACTION_SCHEMA.safeParse(parsed);
      if (!checked.success) {
        lastError = `LLM output failed schema: ${checked.error.issues
          .map(i => `${i.path.join('.')}: ${i.message}`)
          .join('; ')
          .slice(0, 300)}`;
        continue;
      }
      return { extraction: checked.data, inputHash };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`window extraction failed after ${config.retries + 1} attempts: ${lastError}`);
}

function safeJson(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
