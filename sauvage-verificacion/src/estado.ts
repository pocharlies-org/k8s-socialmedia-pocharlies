import type { Veredicto } from './vision';

/**
 * Estado del bot en Postgres `whatsappmcp` (tablas de las migraciones 042 y
 * 044). El bot solo toca savage_verdicts / savage_actions / savage_pasadas:
 * nunca tablas del conector.
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

/**
 * Una fila por pasada (savage_pasadas, migracion 044): el `ses_` de la sesion
 * de opencode que ejecuto la pasada y su fecha/hora. Es la evidencia estable de
 * C1: el log del pod con el `ses_` lo borre savage-pod-reaper a las 2 h del
 * exito (SUCCEEDED_TTL_SECONDS=7200). `sesionId` null = pasada sin ses_
 * resoluble (ver sesion-opencode.ts); la fila existe igual.
 */
export async function registrarPasada(
  db: EstadoDb,
  p: { account: string; sesionId: string | null }
): Promise<void> {
  await db.query(
    `INSERT INTO savage_pasadas (account, sesion_id, pasada_at)
     VALUES ($1, $2, NOW())`,
    [p.account, p.sesionId]
  );
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

/**
 * Veredicto ACTUAL de cada miembro auditado alguna vez (parte B, INFRA-746):
 * sin corte de fecha, porque un expulsado se re-audita fuera del barrido y su
 * estado es su fila mas nueva, sea de cuando sea.
 */
export async function veredictosActuales(
  db: EstadoDb,
  account: string
): Promise<Map<string, Veredicto>> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (user_id) user_id, verdict
       FROM savage_verdicts
      WHERE account = $1
      ORDER BY user_id, audited_at DESC`,
    [account]
  );
  return new Map(rows.map(r => [String(r.user_id), r.verdict as Veredicto]));
}

export interface Accion {
  userId: string;
  /** dm | ban | unban | add | link | confirmado | omitido | cancelacion */
  action: string;
  at: string;
  confirmed: boolean;
  motivo: string | null;
}

/**
 * Registro append-only de la moderacion (savage_actions, migracion 042).
 * `at` lo pone NOW(): dos acciones del mismo miembro en la misma pasada salen
 * con marcas distintas y el PK (user_id, at) no choca.
 */
export async function registrarAccion(
  db: EstadoDb,
  a: { userId: string; action: string; confirmed?: boolean; motivo?: string | null }
): Promise<void> {
  await db.query(
    `INSERT INTO savage_actions (user_id, action, at, confirmed, motivo)
     VALUES ($1, $2, NOW(), $3, $4)`,
    [a.userId, a.action, a.confirmed ?? false, a.motivo ?? null]
  );
}

/** Historial completo de acciones agrupado por miembro, en orden de tiempo (la maquina de estados de B). */
export async function accionesPorUsuario(db: EstadoDb): Promise<Map<string, Accion[]>> {
  const { rows } = await db.query(
    `SELECT user_id, action, at, confirmed, motivo
       FROM savage_actions
      ORDER BY user_id, at`
  );
  const out = new Map<string, Accion[]>();
  for (const r of rows) {
    const a: Accion = {
      userId: String(r.user_id),
      action: String(r.action),
      at: String(r.at),
      confirmed: Boolean(r.confirmed),
      motivo: r.motivo == null ? null : String(r.motivo),
    };
    const lista = out.get(a.userId);
    if (lista) lista.push(a);
    else out.set(a.userId, [a]);
  }
  return out;
}

/** Readmisiones confirmadas hoy (apartado `reingresos` del informe, C4→C5). */
export async function reingresosHoy(db: EstadoDb): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT user_id FROM savage_actions
      WHERE action = 'confirmado' AND confirmed AND at >= date_trunc('day', now())`
  );
  return rows.map(r => String(r.user_id));
}
