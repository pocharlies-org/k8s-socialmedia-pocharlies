import type { Veredicto } from './vision';

/**
 * Estado del bot en Postgres `whatsappmcp` (tablas de la migracion 042).
 * El bot solo toca savage_verdicts / savage_actions: nunca tablas del conector.
 */

export interface EstadoDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * C6: al empezar la pasada se lee el estado previo y se loggea. Tras un pod
 * matado a mitad, la pasada siguiente arranca con esta linea y ademas salta
 * los miembros ya auditados hoy (`auditadosHoy`): no empieza de cero.
 */
export async function cargarEstado(db: EstadoDb): Promise<number> {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM savage_verdicts');
  const n = Number(rows[0]?.n ?? 0);
  console.log(`estado cargado: ${n} veredictos previos`);
  return n;
}

/** Miembros con veredicto de hoy (reanudacion tras interrupcion). */
export async function auditadosHoy(db: EstadoDb, account: string): Promise<Set<string>> {
  const { rows } = await db.query(
    `SELECT DISTINCT user_id FROM savage_verdicts
      WHERE account = $1 AND audited_at >= date_trunc('day', now())`,
    [account]
  );
  return new Set(rows.map(r => String(r.user_id)));
}

export async function guardarVeredicto(
  db: EstadoDb,
  v: { account: string; userId: string; verdict: Veredicto; rawText: string }
): Promise<void> {
  // audited_at lo pone NOW(): una fila por (cuenta, miembro, momento).
  // ON CONFLICT por el PK (account, user_id, audited_at): dos veredictos del
  // mismo miembro en el mismo segundo son el caso del agente re-decidiendo un
  // dudoso — gana el ultimo.
  await db.query(
    `INSERT INTO savage_verdicts (account, user_id, verdict, raw_text, audited_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (account, user_id, audited_at)
     DO UPDATE SET verdict = EXCLUDED.verdict, raw_text = EXCLUDED.raw_text`,
    [v.account, v.userId, v.verdict, v.rawText]
  );
}

export interface VeredictoActual {
  userId: string;
  verdict: Veredicto;
}

/** Miembros auditados hoy (el total del informe cuadra con el del barrido). */
export async function auditadosDesde(db: EstadoDb, account: string): Promise<VeredictoActual[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (user_id) user_id, verdict
       FROM savage_verdicts
      WHERE account = $1 AND audited_at >= date_trunc('day', now())
      ORDER BY user_id, audited_at DESC`,
    [account]
  );
  return rows.map(r => ({ userId: String(r.user_id), verdict: r.verdict as Veredicto }));
}
