import { Pool } from 'pg';
import { ConnectorClient } from './connector-client';
import { chatInforme, construirInforme, enviarInforme, reunirInforme } from './informe';

/**
 * Entrada que lanza la sesion de opencode al cerrar la pasada (despues de
 * revisar los casos dudosos): reune los apartados desde el estado de hoy y
 * manda el informe a Dani por la cuenta personal.
 *   node --import tsx src/main-informe.ts
 */
async function main(): Promise<void> {
  const secret = process.env.CONNECTOR_SHARED_SECRET ?? '';
  if (!secret) throw new Error('CONNECTOR_SHARED_SECRET vacio');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL vacio');
  const personal = new ConnectorClient({
    baseUrl:
      process.env.SAUVAGE_CONNECTOR_PERSONAL_URL ??
      'http://telegram-connector.whatsapp-mcp.svc.cluster.local:3002/api/v1',
    sharedSecret: secret,
  });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const account = process.env.SAUVAGE_ACCOUNT ?? 'professional';
    const datos = await reunirInforme(pool, account, new Map());
    const chat = await chatInforme(personal, process.env.SAUVAGE_REPORT_CHAT_ID);
    await enviarInforme(personal, chat, construirInforme(datos));
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  console.error(`informe fallo: ${String(e)}`);
  process.exit(1);
});
