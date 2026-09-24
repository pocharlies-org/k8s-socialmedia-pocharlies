import { backfillOptionsFromEnv, runBackfill, type BackfillClient } from './multiaccount-backfill';

type Row = Record<string, unknown>;

function fakeClient(opts: { missingAfter?: number; invalidIndex?: string } = {}) {
  const sql: string[] = [];
  let backfilled = false;
  const client: BackfillClient = {
    query: jest.fn(async (text: string, params?: unknown[]) => {
      sql.push(text);
      const rows = (r: Row[]) => ({ rows: r, rowCount: r.length });
      if (text.startsWith('SELECT count(*) AS n')) {
        return rows([{ n: backfilled ? (opts.missingAfter ?? 0) : 10 }]);
      }
      if (text.includes('min(id) AS lo')) return rows([{ lo: 1, hi: 45 }]);
      if (text.startsWith('UPDATE messages')) {
        backfilled = true;
        return { rows: [], rowCount: 20 };
      }
      if (text.includes('indisvalid')) {
        return rows([{ valid: params?.[0] !== opts.invalidIndex }]);
      }
      if (text.includes('social_merge_contact_aliases')) return rows([{ n: 3 }]);
      return rows([]);
    }),
  };
  return { client, sql };
}

const run = { batch: 20, dryRun: false, skipMerge: false, pauseMs: 0 };

describe('multiaccount backfill', () => {
  it('defaults to a dry run that writes nothing', async () => {
    expect(backfillOptionsFromEnv({}).dryRun).toBe(true);
    const { client, sql } = fakeClient();
    await runBackfill(client, { ...run, dryRun: true });
    expect(sql.some(s => /UPDATE|CREATE|merge/.test(s))).toBe(false);
  });

  it('batches messages by id range, builds the indexes, then merges', async () => {
    const { client, sql } = fakeClient();
    await runBackfill(client, run);
    expect(sql.filter(s => s.startsWith('UPDATE messages'))).toHaveLength(3); // 1..45 by 20
    expect(sql.filter(s => s.includes('CREATE UNIQUE INDEX CONCURRENTLY'))).toHaveLength(3);
    expect(sql[sql.length - 1]).toContain('social_merge_contact_aliases');
  });

  it('refuses to build indexes while rows are still unkeyed', async () => {
    const { client, sql } = fakeClient({ missingAfter: 2 });
    await expect(runBackfill(client, run)).rejects.toThrow(/still without/);
    expect(sql.some(s => s.includes('CREATE UNIQUE INDEX'))).toBe(false);
  });

  it('drops an index left invalid and stops before merging', async () => {
    const { client, sql } = fakeClient({ invalidIndex: 'uq_messages_account_external' });
    await expect(runBackfill(client, run)).rejects.toThrow(/left invalid/);
    expect(sql.some(s => s.startsWith('DROP INDEX CONCURRENTLY'))).toBe(true);
    expect(sql.some(s => s.includes('social_merge_contact_aliases'))).toBe(false);
  });

  it('skips the merge on request', async () => {
    const { client, sql } = fakeClient();
    await runBackfill(client, { ...run, skipMerge: true });
    expect(sql.some(s => s.includes('social_merge_contact_aliases'))).toBe(false);
  });
});
