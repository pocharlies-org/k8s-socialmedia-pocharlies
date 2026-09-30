/**
 * Window -> summary / topics / entities / patterns with the local LLM (LiteLLM,
 * OpenAI-compatible). Output is validated with zod; invalid JSON gets ONE retry,
 * then the window is `skipped` with the reason. 429/5xx back off. The whole
 * attempt sequence (retries included) runs inside a single pool slot.
 */
import OpenAI from 'openai';
import { z } from 'zod';
import type { Window, ChatKind } from './window-builder';
import { LlmPool } from './llm-pool';

export const LLM_MODEL = 'tooling';
export const PROMPT_VERSION = 1;
const INVALID_JSON_RETRIES = 1;
const TRANSIENT_RETRIES = 4;
const TRIVIAL_LINE_CHARS = 12;

export interface ExtractionResult {
  summary: string;
  topics: string[];
  entities: Array<{ type: string; name: string }>;
  patterns: string[];
}

export type LlmOutcome =
  { status: 'done'; result: ExtractionResult } | { status: 'skipped'; reason: string };

const kebab = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

// Lenient on size (we trim afterwards), strict on shape.
const RawSchema = z.object({
  summary: z.string().default(''),
  topics: z.array(z.string()).default([]),
  entities: z.array(z.object({ type: z.string().min(1), name: z.string().min(1) })).default([]),
  patterns: z.array(z.string()).default([]),
  skip: z.union([z.null(), z.literal('trivial')]).default(null),
});

/** Throws on a wrong shape; returns skipped for trivial/empty answers. */
export function normalizeExtraction(raw: unknown): LlmOutcome {
  const p = RawSchema.safeParse(raw);
  if (!p.success) throw new Error('invalid_shape'); // counts as invalid JSON: one retry
  const v = p.data;
  if (v.skip === 'trivial') return { status: 'skipped', reason: 'trivial' };
  const summary = v.summary.trim().slice(0, 600);
  if (!summary) return { status: 'skipped', reason: 'empty_summary' };
  const topics = [...new Set(v.topics.map(kebab).filter(Boolean))].slice(0, 5);
  const seen = new Set<string>();
  const entities: ExtractionResult['entities'] = [];
  for (const e of v.entities) {
    const name = e.name.trim();
    const key = `${e.type}\u0000${name.toLowerCase()}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    entities.push({ type: e.type.trim(), name });
    if (entities.length >= 7) break;
  }
  const patterns = v.patterns
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 3);
  return { status: 'done', result: { summary, topics, entities, patterns } };
}

/** Why a window does not go to the LLM, or null if it is eligible. */
export function skipReason(w: Window, kind: ChatKind): string | null {
  if (kind !== 'chat') return 'kind';
  if (w.messageCount < 3 && w.contentChars < 400) return 'trivial';
  if (w.maxContentLen <= TRIVIAL_LINE_CHARS) return 'trivial';
  return null;
}

const SYSTEM_PROMPT = [
  'Analizas una ventana de conversación de WhatsApp/Telegram (texto entre corchetes = cabecera; 🎙 = nota de voz transcrita).',
  'Responde SOLO con un objeto JSON con estas claves:',
  '"summary": resumen en español, máximo 600 caracteres, solo lo que dice el texto, sin inventar;',
  '"topics": hasta 5 temas, cada uno en minúsculas con guiones (kebab-case, ASCII);',
  '"entities": hasta 7 objetos {"type": "Person|Org|Place|Product|Event|Other", "name": "..."};',
  '"patterns": hasta 3 pautas recurrentes o compromisos (frases cortas), o [];',
  '"skip": null, o "trivial" si no hay contenido informativo (saludos, risas, acuses).',
  'No añadas texto fuera del JSON.',
].join('\n');

export type ChatFn = (system: string, user: string) => Promise<string>;

export class TransientLlmError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

export function openAiChat(env: NodeJS.ProcessEnv = process.env): ChatFn {
  const client = new OpenAI({
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY || 'unused',
    timeout: 120_000,
    maxRetries: 0,
    defaultHeaders: { 'X-Source-Service': 'socialmedia-brain-windows' },
  });
  return async (system, user) => {
    try {
      const r = await client.chat.completions.create({
        model: LLM_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      return r.choices[0]?.message?.content ?? '';
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === undefined || status === 429 || status >= 500) {
        throw new TransientLlmError(String((e as Error).message), status);
      }
      throw e;
    }
  };
}

function parseJson(text: string): unknown {
  const t = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(t);
}

export interface ExtractDeps {
  chat: ChatFn;
  pool: LlmPool;
  sleep?: (ms: number) => Promise<void>;
}

export async function extractWindow(w: Window, deps: ExtractDeps): Promise<LlmOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  return deps.pool.run(async () => {
    let invalid = 0;
    for (let transient = 0; ;) {
      let text: string;
      try {
        text = await deps.chat(SYSTEM_PROMPT, w.windowText);
      } catch (e) {
        if (e instanceof TransientLlmError && transient < TRANSIENT_RETRIES) {
          transient++;
          await sleep(Math.min(1000 * 2 ** transient, 30_000)); // slot stays held while backing off
          continue;
        }
        return { status: 'skipped', reason: `llm_error:${(e as Error).message.slice(0, 120)}` };
      }
      try {
        return normalizeExtraction(parseJson(text));
      } catch {
        if (invalid++ < INVALID_JSON_RETRIES) continue;
        return { status: 'skipped', reason: 'invalid_json' };
      }
    }
  });
}
