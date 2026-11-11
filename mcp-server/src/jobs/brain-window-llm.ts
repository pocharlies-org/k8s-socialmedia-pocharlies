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
import { BuiltWindow, llmInputHash, wellFormed } from './brain-windows-lib';

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

const ENTITY_TYPES = [
  'persona',
  'lugar',
  'organizacion',
  'proyecto',
  'producto',
  'servicio',
  'evento',
  'importe',
  'fecha',
] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

// What the local model writes instead of the enum, seen in production or
// obvious English/Spanish variants. Anything else drops just that entity.
const ENTITY_SYNONYMS: Record<string, EntityType> = {
  person: 'persona',
  usuario: 'persona',
  contacto: 'persona',
  place: 'lugar',
  location: 'lugar',
  ciudad: 'lugar',
  pais: 'lugar',
  direccion: 'lugar',
  ubicacion: 'lugar',
  organization: 'organizacion',
  organisation: 'organizacion',
  empresa: 'organizacion',
  compania: 'organizacion',
  tienda: 'organizacion',
  marca: 'organizacion',
  grupo: 'organizacion',
  equipo: 'organizacion',
  project: 'proyecto',
  product: 'producto',
  articulo: 'producto',
  item: 'producto',
  service: 'servicio',
  app: 'servicio',
  aplicacion: 'servicio',
  plataforma: 'servicio',
  web: 'servicio',
  event: 'evento',
  amount: 'importe',
  cantidad: 'importe',
  dinero: 'importe',
  precio: 'importe',
  moneda: 'importe',
  date: 'fecha',
  dia: 'fecha',
  hora: 'fecha',
};

const SENTIMENTS: Record<string, Extraction['sentiment']> = {
  positivo: 'positivo',
  positive: 'positivo',
  neutro: 'neutro',
  neutral: 'neutro',
  negativo: 'negativo',
  negative: 'negativo',
  mixto: 'mixto',
  mixed: 'mixto',
};

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

const strings = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : [])
    .map(x => (typeof x === 'number' ? String(x) : x))
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .slice(0, max);

/**
 * Bring a near-miss LLM answer inside EXTRACTION_SCHEMA instead of throwing
 * the whole window away: unknown entity types map to a synonym or drop only
 * that entity, lists are cut to their caps, an over-long summary is cut, an
 * unknown sentiment becomes `neutro`. A missing summary still fails (that is
 * a real miss, worth the retry). Each retry costs ~45 s of the local model.
 */
export function normalizeExtraction(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  const entities = (Array.isArray(r.entities) ? r.entities : [])
    .map(e => {
      if (!e || typeof e !== 'object') return null;
      const o = e as Record<string, unknown>;
      if (typeof o.name !== 'string' || !o.name.trim()) return null;
      const t = typeof o.type === 'string' ? fold(o.type) : '';
      const type = (ENTITY_TYPES as readonly string[]).includes(t)
        ? (t as EntityType)
        : ENTITY_SYNONYMS[t];
      if (!type) return null;
      return { name: o.name, type, aliases: strings(o.aliases, 24) };
    })
    .filter(e => e !== null)
    .slice(0, 24);
  const actionItems = (Array.isArray(r.action_items) ? r.action_items : [])
    .map(a => {
      if (typeof a === 'string') return a.trim() ? { owner: '', task: a, due: '' } : null;
      if (!a || typeof a !== 'object') return null;
      const o = a as Record<string, unknown>;
      if (typeof o.task !== 'string' || !o.task.trim()) return null;
      return {
        owner: typeof o.owner === 'string' ? o.owner : '',
        task: o.task,
        due: typeof o.due === 'string' ? o.due : '',
      };
    })
    .filter(a => a !== null)
    .slice(0, 24);
  const sentiment = typeof r.sentiment === 'string' ? SENTIMENTS[fold(r.sentiment)] : undefined;
  const trivial =
    typeof r.trivial === 'boolean'
      ? r.trivial
      : typeof r.trivial === 'string'
        ? fold(r.trivial) === 'true'
        : false;
  return {
    ...r,
    summary: typeof r.summary === 'string' ? wellFormed(r.summary.slice(0, 1200)) : r.summary,
    topics: strings(r.topics, 6),
    entities,
    facts: strings(r.facts, 24),
    decisions: strings(r.decisions, 24),
    action_items: actionItems,
    sentiment: sentiment ?? 'neutro',
    trivial,
  };
}

export interface LlmConfig {
  baseUrl: string; // e.g. http://litellm.litellm.svc.cluster.local:4000/v1
  apiKey: string; // low-priority virtual key (ADR §5 "tipo hermes-batch")
  model: string; // 'tooling'
  timeoutMs: number; // 240000 (ADR §5)
  retries: number; // 2 (ADR §5)
  maxTokens: number; // 1200 (ADR §5)
}

export const LLM_CONCURRENCY = 2; // ADR §5: "2 peticiones en paralelo" — the default

/**
 * Parallel LLM calls. Default 2 (ADR §5); BRAIN_WINDOWS_LLM_CONCURRENCY raises
 * it for a one-off load (Dani, 02-10-2026: 4 for the initial reindex). The key
 * is the lowest-priority one, so extra calls yield to everyone else.
 */
export function llmConcurrencyFromEnv(env: NodeJS.ProcessEnv): number {
  const n = Number(env.BRAIN_WINDOWS_LLM_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : LLM_CONCURRENCY;
}

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
    messages: [{ role: 'user', content: wellFormed(buildExtractionPrompt(w, prevSummary)) }],
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
      const checked = EXTRACTION_SCHEMA.safeParse(normalizeExtraction(parsed));
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
