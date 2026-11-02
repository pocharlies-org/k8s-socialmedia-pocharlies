import type { FetchFn } from './connector-client';

/**
 * Veredicto de vision contra LiteLLM (INFRA-745).
 *
 * Regla dura del spec y del plan: un fallo NUNCA produce `sin_cara`.
 *  - HTTP no-200, red, o salida del modelo no parseable tras los reintentos
 *    → `no_auditar` (se reintenta `reintentos` veces con espera creciente).
 *  - `dudoso` lo emite el modelo cuando la foto no permite decidir; la
 *    ausencia de foto (404) la decide `pasada.ts`, no aqui.
 * El texto bruto de cada respuesta se conserva siempre (`rawText`) para poder
 * auditar el veredicto despues.
 */

export type Veredicto = 'cara' | 'sin_cara' | 'dudoso' | 'no_auditar';

const VEREDICTOS_MODELO: ReadonlySet<string> = new Set(['cara', 'sin_cara', 'dudoso', 'no_auditar']);

export interface ResultadoVision {
  verdict: Veredicto;
  rawText: string;
  intentos: number;
  /** motivo del no_auditar cuando lo hubo (auditoria y apartado de ambiguedades). */
  fallo?: string;
}

export interface VisionOptions {
  url: string;              // http://litellm.litellm.svc.cluster.local:4000/v1/chat/completions
  apiKey: string;           // OPENAI_API_KEY del pod (clave virtual `socialmedia`)
  model: string;            // qwen38-flash-next-uncensored (supports_vision medido)
  photoBase64: string;      // jpeg tal cual lo devolvio GET /peers/:id/photo
  prompt: string;           // criterio determinista (ConfigMap, montado en el pod)
  fetchImpl: FetchFn;
  reintentos?: number;      // intentos totales (default 3)
  esperarMs?: (ms: number) => Promise<void>;
  baseEsperaMs?: number;    // backoff base (default 2000)
}

/**
 * Extrae el veredicto de la salida del modelo. Acepta tanto un JSON
 * `{"veredicto": "cara", ...}` suelto en el texto como la palabra desnuda.
 * Devuelve `null` si no hay forma segura de leerlo (→ no_auditar, jamas
 * sin_cara por defecto: medir antes de asumir).
 */
export function parsearVeredicto(texto: string): Veredicto | null {
  const limpio = texto.trim();
  const m = limpio.match(/"veredicto"\s*:\s*"(cara|sin_cara|dudoso|no_auditar)"/);
  if (m) return m[1] as Veredicto;
  // Salida desnuda: solo vale si ES exactamente una de las palabras. Un texto
  // libre que las mencione de pasada no es un veredicto.
  const desnudo = limpio.toLowerCase();
  for (const v of VEREDICTOS_MODELO) {
    if (desnudo === v) return v as Veredicto;
  }
  return null;
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string } }>;
}

export async function veredictoDeVision(opts: VisionOptions): Promise<ResultadoVision> {
  const reintentos = Math.max(1, opts.reintentos ?? 3);
  const esperar = opts.esperarMs ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const base = opts.baseEsperaMs ?? 2000;

  let ultimoTexto = '';
  let ultimoFallo = 'no_parseable';

  for (let intento = 1; intento <= reintentos; intento++) {
    try {
      const res = await opts.fetchImpl(opts.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: 200,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: opts.prompt },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${opts.photoBase64}` } },
              ],
            },
          ],
        }),
      });
      const texto = await res.text();
      if (res.status !== 200) {
        ultimoFallo = `vision_http_${res.status}`;
        ultimoTexto = texto.slice(0, 2000);
      } else {
        let parsed: ChatCompletion | null = null;
        try {
          parsed = JSON.parse(texto) as ChatCompletion;
        } catch {
          parsed = null;
        }
        const content = parsed?.choices?.[0]?.message?.content ?? '';
        ultimoTexto = content;
        const v = parsearVeredicto(content);
        if (v) {
          return { verdict: v, rawText: content, intentos: intento };
        }
        ultimoFallo = 'no_parseable';
      }
    } catch (e) {
      ultimoFallo = `vision_error_${String(e).slice(0, 200)}`;
    }
    if (intento < reintentos) await esperar(base * 2 ** (intento - 1));
  }

  return { verdict: 'no_auditar', rawText: ultimoTexto, intentos: reintentos, fallo: ultimoFallo };
}
