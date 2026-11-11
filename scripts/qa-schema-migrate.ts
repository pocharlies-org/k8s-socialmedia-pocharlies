/**
 * SKIRM-89: wrapper del runner real de migraciones (migrate.ts) para el sandbox
 * de esquema (scripts/qa-schema-sandbox.sh). No duplica lógica: importa
 * runMigrations y le pasa la base de datos del sandbox y, si QA_SANDBOX_MIGRATIONS_DIR
 * está puesto, un directorio de migraciones en staging (las del repo + las de
 * prueba), dejando el runner y el repo intactos.
 *
 * SKIRM-261: con QA_SANDBOX_PROFILE=1 mide cada migración (duración y los locks
 * que deja tomados en la transacción única del runner). Como todo va en una sola
 * transacción, un lock que choca con el INSERT (RowExclusiveLock) se mantiene
 * hasta el COMMIT: el informe dice desde qué migración y cuánto tiempo quedaría
 * bloqueada la escritura en cada tabla.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import {
  runMigrations,
  type MigrationClient,
} from '../mcp-server/src/infrastructure/database/migrate';

// Modos que chocan con RowExclusiveLock (INSERT/UPDATE/DELETE).
const BLOCKS_WRITES = new Set([
  'ShareLock',
  'ShareRowExclusiveLock',
  'ExclusiveLock',
  'AccessExclusiveLock',
]);

interface Step {
  file: string;
  ms: number;
}

function profiled(client: Client, dir: string) {
  const byBody = new Map<string, string>();
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')))
    byBody.set(readFileSync(join(dir, f), 'utf8'), f);
  const steps: Step[] = [];
  // tabla -> primera migración y momento en que tomó un lock que bloquea escrituras
  const firstBlock = new Map<string, { file: string; mode: string; at: number }>();
  // tabla -> primera migración que toma AccessExclusiveLock (bloquea también las lecturas)
  const firstExclusive = new Map<string, { file: string; at: number }>();
  const wrapped: MigrationClient = {
    async query(sql: string, params?: unknown[]) {
      const file = byBody.get(sql);
      const t0 = Date.now();
      const res = await client.query(sql, params as unknown[]);
      if (file) {
        steps.push({ file, ms: Date.now() - t0 });
        const locks = await client.query(
          `SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
           WHERE l.pid = pg_backend_pid() AND l.granted AND c.relkind IN ('r','p') AND c.relnamespace = 'public'::regnamespace`
        );
        for (const { relname, mode } of locks.rows as Array<{ relname: string; mode: string }>) {
          if (BLOCKS_WRITES.has(mode) && !firstBlock.has(relname))
            firstBlock.set(relname, { file, mode, at: t0 });
          if (mode === 'AccessExclusiveLock' && !firstExclusive.has(relname))
            firstExclusive.set(relname, { file, at: t0 });
        }
      }
      return res as unknown as { rows: Array<Record<string, unknown>> };
    },
  };
  const report = (end: number) => {
    console.log('perfil: migración · ms');
    for (const s of steps) console.log(`perfil: ${s.file} · ${s.ms}`);
    console.log(
      'perfil: tabla · primer lock que bloquea escrituras · migración que lo toma · ms desde su inicio hasta el COMMIT'
    );
    for (const [t, b] of [...firstBlock].sort((a, b) => a[1].at - b[1].at))
      console.log(`perfil: ${t} · ${b.mode} · ${b.file} · ${end - b.at}`);
    console.log(
      'perfil: tabla · AccessExclusiveLock (también bloquea lecturas) · migración · ms hasta el COMMIT'
    );
    for (const [t, b] of [...firstExclusive].sort((a, b) => a[1].at - b[1].at))
      console.log(`perfil: ${t} · AccessExclusiveLock · ${b.file} · ${end - b.at}`);
  };
  return { wrapped, report };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is unset');
    process.exit(1);
  }
  const dir =
    process.env.QA_SANDBOX_MIGRATIONS_DIR ??
    join(__dirname, '..', 'mcp-server', 'src', 'infrastructure', 'database', 'migrations');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    if (process.env.QA_SANDBOX_PROFILE === '1') {
      const { wrapped, report } = profiled(client, dir);
      const t0 = Date.now();
      await runMigrations(wrapped, dir);
      const end = Date.now();
      report(end);
      console.log(`perfil: total ${end - t0} ms (BEGIN a COMMIT)`);
    } else {
      await runMigrations(client, dir);
    }
    console.log('sandbox: migraciones terminadas');
  } finally {
    await client.end();
  }
}

void main().catch(error => {
  console.error('sandbox: migración fallida:', error);
  process.exit(1);
});
