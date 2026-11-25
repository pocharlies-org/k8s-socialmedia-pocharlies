import { Pool } from 'pg';
import { ConnectorClient, listarParticipantes } from './connector-client';
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
    // Recuento de moderacion (INFRA-1561 C3): quien sigue dentro del grupo. Se
    // pide al conector `professional` (el del grupo); si falla, el informe sale
    // sin el apartado (fallo blando: no tumba el envio a Dani).
    let enGrupo: Set<string> | undefined;
    try {
      const pro = new ConnectorClient({
        baseUrl:
          process.env.SAUVAGE_CONNECTOR_PRO_URL ??
          'http://telegram-connector-professional.whatsapp-mcp.svc.cluster.local:3002/api/v1',
        sharedSecret: secret,
      });
      const ps = await listarParticipantes(pro, process.env.SAUVAGE_GROUP_ID ?? '-1003365295248');
      enGrupo = new Set(ps.map(p => p.id));
    } catch (e) {
      console.log(`informe: recuento de moderacion omitido (${String(e)})`);
    }
    const datos = await reunirInforme(pool, account, new Map(), enGrupo);
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
