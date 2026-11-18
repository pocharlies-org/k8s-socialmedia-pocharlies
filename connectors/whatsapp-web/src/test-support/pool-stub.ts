import pg from 'pg';

export interface QueryCall {
  sql: string;
  params: unknown[];
}

export type Rows = Record<string, unknown>[];

/** Capture pool queries without requiring PostgreSQL, preserving routed errors. */
export function stubPool(route: (sql: string, params: unknown[]) => Rows = () => []) {
  const captured: QueryCall[] = [];
  const poolPrototype = pg.Pool.prototype;
  const previousQuery: typeof poolPrototype.query = Reflect.get(poolPrototype, 'query');
  const query = async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    const rows = route(sql, params);
    return { rows, rowCount: rows.length };
  };
  Object.assign(poolPrototype, { query });
  return {
    calls: captured,
    restore() {
      poolPrototype.query = previousQuery;
    },
  };
}
