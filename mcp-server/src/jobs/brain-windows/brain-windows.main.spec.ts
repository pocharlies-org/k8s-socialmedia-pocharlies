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

import { ConfigError, main, parseMaxLlmPerRun } from './brain-windows';

const env = { DATABASE_URL: 'postgres://x', DRY_RUN: 'false', BRAIN_WINDOWS_ACCOUNTS: 'personal', BRAIN_URL: 'http://skirmshop-brain-ingest.skirmshop-brain-prod.svc.cluster.local', BRAIN_API_KEY: 'k' } as NodeJS.ProcessEnv;

describe('main', () => {
  beforeEach(() => {
    queries.length = 0;
    fetchSpy.mockClear();
    fakePool.connect.mockClear();
    lockGranted = false;
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

  describe('configuration: the only exit-1 case, and no wrong defaults', () => {
    it.each(['BRAIN_URL', 'BRAIN_API_KEY', 'DATABASE_URL'])('%s missing with DRY_RUN=false -> ConfigError before touching the database', async (name) => {
      const bad = { ...env };
      delete bad[name];
      await expect(main(bad)).rejects.toBeInstanceOf(ConfigError);
      expect(fakePool.connect).not.toHaveBeenCalled();
      expect(queries).toHaveLength(0);
    });

    it('DRY_RUN does not need the brain', async () => {
      await expect(main({ DATABASE_URL: 'postgres://x', BRAIN_WINDOWS_ACCOUNTS: 'personal' } as NodeJS.ProcessEnv)).resolves.toBe(0);
    });

    it('MAX_LLM_PER_RUN: unset=200, 0=LLM off, integer kept, garbage -> ConfigError', () => {
      expect(parseMaxLlmPerRun(undefined)).toBe(200);
      expect(parseMaxLlmPerRun('')).toBe(200);
      expect(parseMaxLlmPerRun('0')).toBe(0);
      expect(parseMaxLlmPerRun('37')).toBe(37);
      expect(() => parseMaxLlmPerRun('-1')).toThrow(ConfigError);
      expect(() => parseMaxLlmPerRun('abc')).toThrow(ConfigError);
      expect(() => parseMaxLlmPerRun('1.5')).toThrow(ConfigError);
    });

    it('invalid MAX_LLM_PER_RUN is a ConfigError at startup', async () => {
      await expect(main({ ...env, MAX_LLM_PER_RUN: 'abc' })).rejects.toBeInstanceOf(ConfigError);
    });
  });

  describe('soft failures exit 0 with a warning (a cron that warns must not go Degraded)', () => {
    it('a database error while running an account -> resolves 0', async () => {
      lockGranted = true;
      fakePool.query.mockImplementationOnce(async () => { throw new Error('connection terminated'); });
      fakeClient.query.mockImplementation(async (sql: string) => {
        if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: true }] };
        throw new Error('connection terminated');
      });
      await expect(main(env)).resolves.toBe(0);
      lockGranted = false;
    });

    it('the pool cannot connect -> resolves 0', async () => {
      fakePool.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(main(env)).resolves.toBe(0);
    });

    it('a failing dry run is loud: it rejects (manual tool, proof that the SQL runs)', async () => {
      fakePool.query.mockRejectedValueOnce(new Error('column m.sender_id does not exist'));
      await expect(main({ DATABASE_URL: 'postgres://x', BRAIN_WINDOWS_ACCOUNTS: 'personal' } as NodeJS.ProcessEnv)).rejects.toThrow(/sender_id/);
    });
  });
});
