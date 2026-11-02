import { Pool } from 'pg';
import { configDesdeEntorno, ejecutarPasada } from './pasada';

/**
 * Entrada del CronJob (lanzada por la sesion de opencode):
 *   node --import tsx src/main-pasada.ts
 */
async function main(): Promise<void> {
  const cfg = configDesdeEntorno(process.env);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await ejecutarPasada(cfg, pool);
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  console.error(`pasada fallo: ${String(e)}`);
  process.exit(1);
});
