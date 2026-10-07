/**
 * SKIRM-89: wrapper del runner real de migraciones (migrate.ts) para el sandbox
 * de esquema (scripts/qa-schema-sandbox.sh). No duplica lógica: importa
 * runMigrations y le pasa la base de datos del sandbox y, si QA_SANDBOX_MIGRATIONS_DIR
 * está puesto, un directorio de migraciones en staging (las del repo + las de
 * prueba), dejando el runner y el repo intactos.
 */
import { join } from 'path';
import { Client } from 'pg';
import { runMigrations } from '../mcp-server/src/infrastructure/database/migrate';

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
    await runMigrations(client, dir);
    console.log('sandbox: migraciones terminadas');
  } finally {
    await client.end();
  }
}

void main().catch(error => {
  console.error('sandbox: migración fallida:', error);
  process.exit(1);
});
