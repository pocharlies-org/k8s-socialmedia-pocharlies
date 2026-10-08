/**
 * SKIRM-103 (F3-2, C11): the HMAC key of the connector API fails closed.
 * The helper lives in shared/src/crypto/connector-secret.ts (shared has no
 * runner of its own: this jest harness runs it, like the session-store specs).
 * The two mcp-server entrypoints are started for real: a missing, empty or
 * placeholder secret must stop them before they touch the database.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CONNECTOR_SECRET_PLACEHOLDER, requireConnectorSecret } from '@mcp-socialmedia/shared';

const run = promisify(execFile);

describe('requireConnectorSecret', () => {
  test('a usable value is returned exactly as read', () => {
    expect(requireConnectorSecret({ CONNECTOR_SHARED_SECRET: 'k3y-from-the-vault' })).toBe(
      'k3y-from-the-vault'
    );
    // Untrimmed on purpose: the connector verifies with the raw value.
    expect(requireConnectorSecret({ CONNECTOR_SHARED_SECRET: 'k3y\n' })).toBe('k3y\n');
  });

  test.each([
    ['unset', {}],
    ['empty', { CONNECTOR_SHARED_SECRET: '' }],
    ['blank', { CONNECTOR_SHARED_SECRET: '  \n' }],
  ])('%s → throws and names the variable', (_name, env) => {
    expect(() => requireConnectorSecret(env)).toThrow(/CONNECTOR_SHARED_SECRET is unset or empty/);
  });

  test.each([CONNECTOR_SECRET_PLACEHOLDER, ` ${CONNECTOR_SECRET_PLACEHOLDER}\n`])(
    'the placeholder %j → throws',
    value => {
      expect(() => requireConnectorSecret({ CONNECTOR_SHARED_SECRET: value })).toThrow(
        /is the placeholder/
      );
    }
  );

  test('the placeholder is still the value the repository used to default to', () => {
    expect(CONNECTOR_SECRET_PLACEHOLDER).toBe('dev-secret-change-in-production');
  });
});

// A port nothing listens on: past the guard the process dies on the database,
// which is how the positive control tells "started" from "refused".
const BASE_ENV = {
  PATH: process.env.PATH ?? '',
  DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none',
};

async function start(entrypoint: string, secret: string | undefined) {
  const env: Record<string, string> = { ...BASE_ENV };
  if (secret !== undefined) env.CONNECTOR_SHARED_SECRET = secret;
  try {
    await run(process.execPath, ['--import', 'tsx', join('src/mcp', entrypoint)], {
      cwd: join(__dirname, '..', '..'),
      env,
      timeout: 60_000,
    });
    return { code: 0, output: '' };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe.each(['index.ts', 'sse-server.ts'])('%s startup', entrypoint => {
  test('refuses to start without a usable CONNECTOR_SHARED_SECRET, and starts past the guard with one', async () => {
    const [unset, empty, placeholder, valid] = await Promise.all([
      start(entrypoint, undefined),
      start(entrypoint, ''),
      start(entrypoint, CONNECTOR_SECRET_PLACEHOLDER),
      start(entrypoint, 'a-real-rotated-secret'),
    ]);
    for (const refused of [unset, empty, placeholder]) {
      expect(refused.code).not.toBe(0);
      expect(refused.output).toMatch(/CONNECTOR_SHARED_SECRET/);
      expect(refused.output).not.toMatch(/ECONNREFUSED/); // never reached the database
    }
    expect(placeholder.output).toMatch(/placeholder/);
    // Positive control: with a valid secret the guard is passed and the first
    // thing to fail is the (unreachable) database.
    expect(valid.output).not.toMatch(/CONNECTOR_SHARED_SECRET/);
    expect(valid.output).toMatch(/ECONNREFUSED|connect/i);
  }, 90_000);
});
