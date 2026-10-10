/**
 * SKIRM-103 (F3-2, C11): the connector and its HMAC key.
 *
 * main.ts is started for real: with the key unset or empty the process must die
 * naming CONNECTOR_SHARED_SECRET, before it listens or opens a WhatsApp socket,
 * and so must the repository's placeholder when the Deployment sets
 * CONNECTOR_SECRET_STRICT=true. "The placeholder without the flag starts, with
 * one warning" is requireConnectorSecret itself
 * (mcp-server/src/mcp/connector-secret.spec.ts, which also starts the two
 * mcp-server entrypoints that way): going on, main.ts would open a Baileys
 * socket, which a test must not do.
 *
 * The dashboard notifier asks the helper on every signature: no key, or a
 * strict-refused placeholder, sends nothing; the placeholder without the flag
 * signs and sends, with one warning for the whole process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import './test-env';
import { notifyDashboard } from '@mcp-socialmedia/shared';

const run = promisify(execFile);
const PLACEHOLDER = 'dev-secret-change-in-production';

async function startMain(env: Record<string, string>) {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none',
    PORT: '0',
    ...env,
  };
  try {
    await run(process.execPath, ['--import', 'tsx', join('src', 'main.ts')], {
      cwd: process.cwd(),
      env: childEnv,
      timeout: 60_000,
    });
    return { code: 0, output: '' };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('main.ts no arranca con la clave HMAC ausente o vacía, ni con el placeholder si es estricto', async () => {
  const results = await Promise.all([
    startMain({}),
    startMain({ CONNECTOR_SHARED_SECRET: '' }),
    startMain({ CONNECTOR_SHARED_SECRET: PLACEHOLDER, CONNECTOR_SECRET_STRICT: 'true' }),
  ]);
  for (const r of results) {
    assert.notEqual(r.code, 0);
    assert.match(r.output, /CONNECTOR_SHARED_SECRET/);
    assert.doesNotMatch(r.output, /listening on port/);
  }
  assert.match(results[0].output, /unset or empty/);
  assert.match(results[2].output, /is the placeholder/);
});

async function withNotifier(
  env: Record<string, string | undefined>,
  fn: (seen: { sent: { headers: Record<string, string> }[]; errors: string[]; warnings: string[] }) => Promise<void>
) {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const realError = console.error;
  const saved = {
    secret: process.env.CONNECTOR_SHARED_SECRET,
    strict: process.env.CONNECTOR_SECRET_STRICT,
  };
  const seen = {
    sent: [] as { headers: Record<string, string> }[],
    errors: [] as string[],
    warnings: [] as string[],
  };
  globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.sent.push({ headers: init?.headers ?? {} });
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch;
  console.warn = (...args: unknown[]) => void seen.warnings.push(args.join(' '));
  console.error = (...args: unknown[]) => void seen.errors.push(args.join(' '));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn(seen);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.error = realError;
    for (const [key, value] of [
      ['CONNECTOR_SHARED_SECRET', saved.secret],
      ['CONNECTOR_SECRET_STRICT', saved.strict],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('el notifier del dashboard no envía nada sin clave, o con el placeholder si es estricto', async () => {
  const cases: Record<string, string | undefined>[] = [
    { CONNECTOR_SHARED_SECRET: undefined, CONNECTOR_SECRET_STRICT: undefined },
    { CONNECTOR_SHARED_SECRET: '', CONNECTOR_SECRET_STRICT: undefined },
    { CONNECTOR_SHARED_SECRET: PLACEHOLDER, CONNECTOR_SECRET_STRICT: 'true' },
  ];
  for (const env of cases) {
    await withNotifier(env, async seen => {
      await notifyDashboard('/_connector/typing', { chatId: 'x' });
      assert.deepEqual(seen.sent, [], JSON.stringify(env));
      assert.equal(seen.warnings.length, 1); // its own "[dashboard-notifier] … failed" line
    });
  }
});

test('el notifier firma con una clave propia, y con el placeholder no estricto firma, envía y avisa una sola vez', async () => {
  await withNotifier(
    { CONNECTOR_SHARED_SECRET: 'a-key-of-our-own', CONNECTOR_SECRET_STRICT: undefined },
    async seen => {
      await notifyDashboard('/_connector/typing', { chatId: 'x' });
      assert.equal(seen.sent.length, 1);
      assert.match(seen.sent[0].headers['x-connector-signature'], /^sha256=[0-9a-f]{64}$/);
      assert.deepEqual(seen.errors, []);
    }
  );

  await withNotifier(
    { CONNECTOR_SHARED_SECRET: PLACEHOLDER, CONNECTOR_SECRET_STRICT: undefined },
    async seen => {
      for (let i = 0; i < 4; i += 1) await notifyDashboard('/_connector/typing', { chatId: 'x' });
      assert.equal(seen.sent.length, 4);
      assert.match(seen.sent[0].headers['x-connector-signature'], /^sha256=[0-9a-f]{64}$/);
      assert.equal(seen.errors.length, 1); // one line for the process, not one per signature
      assert.match(seen.errors[0], /CONNECTOR_SHARED_SECRET is the placeholder/);
    }
  );
});
