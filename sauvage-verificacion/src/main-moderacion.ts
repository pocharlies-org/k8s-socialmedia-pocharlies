import { Pool } from 'pg';
import type { FetchFn, FetchResponse } from './connector-client';
import { crearApiModeracion, configModeracionDesdeEntorno, ejecutarModeracion } from './moderacion';

/**
 * Entrada de la moderacion (INFRA-746), lanzada por la sesion de opencode tras
 * la auditoria y el informe:
 *   node --import tsx src/main-moderacion.ts
 *
 * Con SAUVAGE_MODERATION != "on" no toca a nadie (fail-closed): loggea
 * `moderacion off: ninguna accion` y sale sin abrir el conector.
 */
async function main(): Promise<void> {
  const cfg = configModeracionDesdeEntorno(process.env);
  if (!cfg.moderation) {
    console.log('moderacion off: ninguna accion');
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const fetchImpl: FetchFn = (u, i) => fetch(u, i) as unknown as Promise<FetchResponse>;
    await ejecutarModeracion(cfg, pool, crearApiModeracion(cfg, fetchImpl));
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  console.error(`moderacion fallo: ${String(e)}`);
  process.exit(1);
});
