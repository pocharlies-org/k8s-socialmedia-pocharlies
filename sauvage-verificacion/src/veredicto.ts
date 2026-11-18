import { Pool } from 'pg';
import { guardarVeredicto } from './estado';
import type { Veredicto } from './vision';

/**
 * CLI para que la sesion de opencode registre el veredicto final de un caso
 * dudoso que ha decidido mirando la foto ella misma (plan INFRA-125: "el
 * agente decide casos dudosos, los scripts versionados ejecutan").
 *
 *   tsx src/veredicto.ts --id <userId> --verdict cara|sin_cara|dudoso --raw "<motivo>"
 *
 * `no_auditar` no es opcional aqui: es lo que deja la pasada mecanica cuando
 * fallo la foto o el modelo; el agente solo re-decide con la foto delante.
 */

const PERMITIDOS: ReadonlySet<string> = new Set(['cara', 'sin_cara', 'dudoso']);

export function parsearArgv(argv: string[]): { id: string; verdict: Veredicto; raw: string } | null {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const id = get('--id');
  const verdict = get('--verdict');
  const raw = get('--raw') ?? 'decidido por la sesion de opencode';
  if (!id || !verdict || !PERMITIDOS.has(verdict)) return null;
  return { id, verdict: verdict as Veredicto, raw };
}

async function main(): Promise<void> {
  const args = parsearArgv(process.argv.slice(2));
  if (!args) {
    console.error('uso: tsx src/veredicto.ts --id <userId> --verdict cara|sin_cara|dudoso --raw "<motivo>"');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await guardarVeredicto(pool, {
      account: process.env.SAUVAGE_ACCOUNT ?? 'professional',
      userId: args.id,
      verdict: args.verdict,
      rawText: args.raw,
    });
    // `veredicto-agente` y no `veredicto`: la linea que cuenta C2 es la de la
    // pasada mecanica (una por miembro del barrido); esta es la re-decision.
    console.log(`veredicto-agente ID=${args.id} verdict=${args.verdict}`);
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  console.error(`veredicto fallo: ${String(e)}`);
  process.exit(1);
});
