import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resuelve el id de la sesion de opencode en curso (INFRA-745, C1).
 *
 * FUENTE FIABLE (2a vuelta, defecto de qa en nota-qa-c1-18nov.md): la SALIDA
 * del propio `opencode run`. Medido en el job real del CronJob y reproducido
 * con opencode-ai@1.18.30: cada linea que `--print-logs` vuelca a stdout
 * (incluida `message=created id=ses_...`, la autoritativa) va ademas a
 * <XDG_DATA_HOME>/opencode/log/opencode.log — un fichero que el bot SI puede
 * leer (la stdout del contenedor, no). Ver leerSesionDeSalidaDelRun.
 *
 * El resolvedor de almacenamiento queda SOLO como fallback: medido en
 * opencode-ai@1.18.30, esa version guarda el estado en SQLite
 * (<XDG_DATA_HOME>/opencode/opencode.db) y NO escribe
 * <XDG_DATA_HOME>/opencode/storage/session/<proyecto>/ses_<id>.json — la
 * afirmacion del fix original (PR 492) no se corresponde con la version
 * pinneada, y por eso la fila salia siempre con sesion NULL en el job real.
 *
 * Devuelve null si no hay nada legible: la pasada sigue y su fila en
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

/**
 * Extrae el id de sesion de la SALIDA de un `opencode run` (el texto tal cual
 * que el proceso imprime y graba en su log). La linea autoritativa es la del
 * propio opencode al crear la sesion:
 *
 *   ... message=created id=ses_e0db736cfffe2WYzjUMQZouCCx slug=... version=1.18.30 projectID=global ...
 *
 * (copiada literal del `kubectl logs` del job real del 19-11). Si no esa,
 * vale cualquier `session.id=ses_...` del log. El largo del id NO se
 * hardcodea: los dos medidos en produccion son 'ses_' + 26 (el patron del
 * fix original, 22, no corresponde). Con varias sesiones en el texto gana la
 * ultima (el log es append: la pasada es el run mas reciente).
 */
export function capturarSesionDeSalida(salida: string): string | null {
  let id: string | null = null;
  for (const m of salida.matchAll(/message=created[^\n]*?\bid=(ses_[A-Za-z0-9]+)/g)) id = m[1];
  if (id) return id;
  for (const m of salida.matchAll(/\bsession\.id=(ses_[A-Za-z0-9]+)/g)) id = m[1];
  return id;
}

/**
 * La salida del run tal como la graba opencode en disco:
 * <XDG_DATA_HOME>/opencode/log/opencode.log (medido en 1.18.30: las mismas
 * lineas de `--print-logs`). null si el fichero no existe o no es legible
 * (o no trae ningun ses_): la llamada decide el fallback.
 */
export function leerSesionDeSalidaDelRun(rutaLog: string): string | null {
  let texto: string;
  try {
    texto = readFileSync(rutaLog, 'utf8');
  } catch {
    return null;
  }
  return capturarSesionDeSalida(texto);
}
