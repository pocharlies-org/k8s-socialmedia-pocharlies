/** Entry point: advisory lock and DRY_RUN default (pg mocked, nothing real is touched). */
const queries: string[] = [];
let lockGranted = false;
const release = jest.fn();
const fakeClient = {
  query: jest.fn(async (sql: string) => {
    queries.push(sql);
    return { rows: /pg_try_advisory_lock/.test(sql) ? [{ ok: lockGranted }] : [] };
  }),
  release,
};
const fakePool = {
  connect: jest.fn(async () => fakeClient),
  query: jest.fn(async (sql: string) => {
    queries.push(sql);
    return { rows: [] };
  }),
  end: jest.fn(async () => {}),
};
jest.mock('pg', () => ({ Pool: jest.fn(() => fakePool) }));
const fetchSpy = jest.fn();
(global as { fetch: unknown }).fetch = fetchSpy;

import { main } from './brain-windows';

const env = { DATABASE_URL: 'postgres://x', DRY_RUN: 'false', BRAIN_WINDOWS_ACCOUNTS: 'personal' } as NodeJS.ProcessEnv;

describe('main', () => {
  beforeEach(() => {
    queries.length = 0;
    fetchSpy.mockClear();
  });

  it('second process: pg_try_advisory_lock is false -> exits 0 without reading messages or calling the brain', async () => {
    lockGranted = false;
    await expect(main(env)).resolves.toBe(0);
    expect(queries.filter((q) => /advisory_lock/.test(q))).toHaveLength(1);
    expect(queries.some((q) => /FROM messages/.test(q))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it('the lock is hashtext(\'brain-windows\'), session level', async () => {
    lockGranted = false;
    await main(env);
    expect(queries[0]).toContain("pg_try_advisory_lock(hashtext('brain-windows'))");
  });

  it('DRY_RUN is the default: no lock, no writes, no brain', async () => {
    const r = await main({ DATABASE_URL: 'postgres://x', BRAIN_WINDOWS_ACCOUNTS: 'personal' } as NodeJS.ProcessEnv);
    expect(r).toBe(0);
    expect(queries.some((q) => /advisory_lock|^\s*(INSERT|UPDATE|DELETE)\b/i.test(q))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses to start without DATABASE_URL', async () => {
    await expect(main({} as NodeJS.ProcessEnv)).rejects.toThrow(/DATABASE_URL/);
  });
});
