import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resuelve el id de la sesion de opencode en curso (INFRA-745, C1).
 *
 * opencode guarda cada sesion en <XDG_DATA_HOME>/opencode/storage/session/
 * <proyecto>/ses_<id>.json (layout medido en opencode-ai 1.18.30:
 * packages/core/src/global.ts + packages/opencode/src/storage/storage.ts).
 * El bot corre COMO HIJO de esa sesion (la sesion lo lanza con su herramienta
 * bash), asi que la sesion actual es la del fichero `ses_*.json` mas reciente:
 * en el pod del CronJob hay exactamente una (HOME y XDG_DATA_HOME apuntan a un
 * emptyDir nuevo en cada job).
 *
 * Devuelve null si no hay ninguno o no es legible: la pasada sigue y su fila en
 * savage_pasadas sale con sesion NULL (la evidencia es metadata; no puede
 * tumbar el informe).
 */
export function resolverSesionOpencode(dir: string): string | null {
  let mejor: { id: string; mtimeMs: number } | null = null;
  let proyectos: string[];
  try {
    proyectos = readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return null;
  }
  for (const p of proyectos) {
    let ficheros: string[];
    try {
      ficheros = readdirSync(join(dir, p)).filter(f => f.startsWith('ses_') && f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of ficheros) {
      const ruta = join(dir, p, f);
      try {
        const id = JSON.parse(readFileSync(ruta, 'utf8')).id;
        if (typeof id !== 'string' || !id.startsWith('ses_')) continue;
        const { mtimeMs } = statSync(ruta);
        if (!mejor || mtimeMs > mejor.mtimeMs) mejor = { id, mtimeMs };
      } catch {
        continue;
      }
    }
  }
  return mejor?.id ?? null;
}
