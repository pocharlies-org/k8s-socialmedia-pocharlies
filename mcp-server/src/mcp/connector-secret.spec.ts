/**
 * SKIRM-103 (F3-2, C11): the HMAC key of the connector API.
 *
 * A missing or empty key is always fatal. The repository's placeholder value
 * starts with a warning, once per process, and is fatal only where the
 * Deployment declares CONNECTOR_SECRET_STRICT=true.
 *
 * The helper lives in shared/src/crypto/connector-secret.ts (shared has no
 * runner of its own: this jest harness runs it, like the session-store specs).
 * The two mcp-server entrypoints are started for real, so the wiring is tested
 * and not just the function.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CONNECTOR_SECRET_PLACEHOLDER, requireConnectorSecret } from '@mcp-socialmedia/shared';

const run = promisify(execFile);

describe('requireConnectorSecret', () => {
  test('a usable value is returned exactly as read, with no warning', () => {
    const warn = jest.fn();
    expect(requireConnectorSecret({ CONNECTOR_SHARED_SECRET: 'k3y-from-the-vault' }, warn)).toBe(
      'k3y-from-the-vault'
    );
    // Untrimmed on purpose: the connector verifies with the raw value.
    expect(requireConnectorSecret({ CONNECTOR_SHARED_SECRET: 'k3y\n' }, warn)).toBe('k3y\n');
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    ['unset', {}],
    ['empty', { CONNECTOR_SHARED_SECRET: '' }],
    ['blank', { CONNECTOR_SHARED_SECRET: '  \n' }],
  ])('%s → throws and names the variable, with or without the strict flag', (_name, env) => {
    for (const strict of [undefined, 'true', 'false']) {
      expect(() =>
        requireConnectorSecret({ ...env, CONNECTOR_SECRET_STRICT: strict }, jest.fn())
      ).toThrow(/CONNECTOR_SHARED_SECRET is unset or empty/);
    }
  });

  test.each([CONNECTOR_SECRET_PLACEHOLDER, ` ${CONNECTOR_SECRET_PLACEHOLDER}\n`])(
    'the placeholder %j with CONNECTOR_SECRET_STRICT=true → throws',
    value => {
      const warn = jest.fn();
      expect(() =>
        requireConnectorSecret(
          { CONNECTOR_SHARED_SECRET: value, CONNECTOR_SECRET_STRICT: 'true' },
          warn
        )
      ).toThrow(/is the placeholder/);
      expect(warn).not.toHaveBeenCalled();
    }
  );

  test.each([undefined, '1', 'false', 'TRUE', ''])(
    'the placeholder with CONNECTOR_SECRET_STRICT=%j → returned as read, not strict',
    flag => {
      // Fresh module state: the warning is once per process.
      jest.isolateModules(() => {
        const fresh = require('@mcp-socialmedia/shared') as typeof import('@mcp-socialmedia/shared');
        const warn = jest.fn();
        expect(
          fresh.requireConnectorSecret(
            { CONNECTOR_SHARED_SECRET: CONNECTOR_SECRET_PLACEHOLDER, CONNECTOR_SECRET_STRICT: flag },
            warn
          )
        ).toBe(CONNECTOR_SECRET_PLACEHOLDER);
        expect(warn).toHaveBeenCalledTimes(1);
      });
    }
  );

  test('the placeholder warns once per process however often it is asked (the notifier asks on every signature)', () => {
    jest.isolateModules(() => {
      const fresh = require('@mcp-socialmedia/shared') as typeof import('@mcp-socialmedia/shared');
      const warn = jest.fn();
      const env = { CONNECTOR_SHARED_SECRET: CONNECTOR_SECRET_PLACEHOLDER };
      for (let i = 0; i < 5; i += 1) fresh.requireConnectorSecret(env, warn);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toMatch(/CONNECTOR_SHARED_SECRET/);
      expect(message).toMatch(/placeholder/);
      expect(message).toMatch(/SC-2092/);
      expect(message).toMatch(/CONNECTOR_SECRET_STRICT=true/);
    });
  });

  test('the placeholder is still the value the repository used to default to', () => {
    expect(CONNECTOR_SECRET_PLACEHOLDER).toBe('dev-secret-change-in-production');
  });
});

// A port nothing listens on: past the guard the process dies on the database,
// which is how the positive controls tell "started" from "refused".
const BASE_ENV = {
  PATH: process.env.PATH ?? '',
  DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none',
};

async function start(entrypoint: string, env: Record<string, string | undefined>) {
  const childEnv: Record<string, string> = { ...BASE_ENV };
  for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value;
  try {
    await run(process.execPath, ['--import', 'tsx', join('src/mcp', entrypoint)], {
      cwd: join(__dirname, '..', '..'),
      env: childEnv,
      timeout: 60_000,
    });
    return { code: 0, output: '' };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe.each(['index.ts', 'sse-server.ts'])('%s startup', entrypoint => {
  test('refuses without a key, refuses the placeholder only when strict, starts past the guard otherwise', async () => {
    const [unset, empty, strict, lenient, valid] = await Promise.all([
      start(entrypoint, {}),
      start(entrypoint, { CONNECTOR_SHARED_SECRET: '' }),
      start(entrypoint, {
        CONNECTOR_SHARED_SECRET: CONNECTOR_SECRET_PLACEHOLDER,
        CONNECTOR_SECRET_STRICT: 'true',
      }),
      start(entrypoint, { CONNECTOR_SHARED_SECRET: CONNECTOR_SECRET_PLACEHOLDER }),
      start(entrypoint, { CONNECTOR_SHARED_SECRET: 'a-key-of-our-own' }),
    ]);
    for (const refused of [unset, empty, strict]) {
      expect(refused.code).not.toBe(0);
      expect(refused.output).toMatch(/CONNECTOR_SHARED_SECRET/);
      expect(refused.output).not.toMatch(/ECONNREFUSED/); // never reached the database
    }
    expect(strict.output).toMatch(/is the placeholder/);

    // Past the guard the first thing to fail is the (unreachable) database.
    for (const started of [lenient, valid]) {
      expect(started.output).toMatch(/ECONNREFUSED|connect/i);
      expect(started.output).not.toMatch(/refusing to start/);
    }
    // Exactly one warning from the placeholder, none from a key of our own.
    expect(lenient.output.match(/is the placeholder/g)).toHaveLength(1);
    expect(valid.output).not.toMatch(/CONNECTOR_SHARED_SECRET/);
  }, 90_000);
});
