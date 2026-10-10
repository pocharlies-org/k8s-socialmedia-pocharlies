/**
 * SKIRM-111 (C4, F3-2): the Telegram connector and its HMAC key.
 *
 * main.ts is started for real. With the key unset or empty the process dies
 * naming CONNECTOR_SHARED_SECRET before it reads anything else, and so does the
 * repository's placeholder when the Deployment sets CONNECTOR_SECRET_STRICT=true.
 * The placeholder without the flag gets past the guard (it dies one line later,
 * on the Telegram credentials the test does not give it, after the one warning).
 * The helper itself is covered by mcp-server/src/mcp/connector-secret.spec.ts.
 *
 * The dashboard notifier asks the helper on every signature: no key, or a
 * strict-refused placeholder, sends nothing; the placeholder without the flag
 * signs and sends, with one warning for the whole process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { notifyDashboard } from './dashboard-notifier';

const PLACEHOLDER = 'dev-secret-change-in-production';
const SIGNATURE = /^sha256=[0-9a-f]{64}$/;

function startMain(env: Record<string, string>) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', PORT: '0', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: run.status, output: `${run.stdout}${run.stderr}` };
}

test('main.ts no arranca con la clave ausente o vacía, ni con el placeholder si es estricto; con el placeholder sin interruptor pasa el guard', () => {
  const refused: Array<[Record<string, string>, RegExp]> = [
    [{}, /unset or empty/],
    [{ CONNECTOR_SHARED_SECRET: '' }, /unset or empty/],
    [
      { CONNECTOR_SHARED_SECRET: PLACEHOLDER, CONNECTOR_SECRET_STRICT: 'true' },
      /is the placeholder/,
    ],
  ];
  for (const [env, reason] of refused) {
    const run = startMain(env);
    assert.notEqual(run.code, 0, JSON.stringify(env));
    assert.match(run.output, /CONNECTOR_SHARED_SECRET/);
    assert.match(run.output, reason);
    assert.doesNotMatch(run.output, /TELEGRAM_API_ID/); // it never got that far
  }
  const warned = startMain({ CONNECTOR_SHARED_SECRET: PLACEHOLDER });
  assert.match(warned.output, /CONNECTOR_SHARED_SECRET is the placeholder from the repository/);
  assert.match(warned.output, /TELEGRAM_API_ID and TELEGRAM_API_HASH are required/);
  assert.doesNotMatch(warned.output, /refusing to start/);
});

async function notify(
  env: Record<string, string | undefined>,
  times = 1
): Promise<{ sent: Array<Record<string, string>>; warnings: string[]; errors: string[] }> {
  const saved = { fetch: globalThis.fetch, warn: console.warn, error: console.error };
  const keys = ['CONNECTOR_SHARED_SECRET', 'CONNECTOR_SECRET_STRICT'];
  const before = keys.map(key => process.env[key]);
  const seen = {
    sent: [] as Array<Record<string, string>>,
    warnings: [] as string[],
    errors: [] as string[],
  };
  globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    seen.sent.push(init?.headers ?? {});
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch;
  console.warn = (...args: unknown[]) => void seen.warnings.push(args.join(' '));
  console.error = (...args: unknown[]) => void seen.errors.push(args.join(' '));
  for (const key of keys) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    for (let i = 0; i < times; i += 1) await notifyDashboard('/_connector/typing', { chatId: 'x' });
  } finally {
    globalThis.fetch = saved.fetch;
    console.warn = saved.warn;
    console.error = saved.error;
    keys.forEach((key, i) => {
      if (before[i] === undefined) delete process.env[key];
      else process.env[key] = before[i];
    });
  }
  return seen;
}

test('el notifier del dashboard no envía nada sin clave, o con el placeholder si es estricto', async () => {
  for (const env of [
    {},
    { CONNECTOR_SHARED_SECRET: '' },
    { CONNECTOR_SHARED_SECRET: PLACEHOLDER, CONNECTOR_SECRET_STRICT: 'true' },
  ]) {
    const seen = await notify(env);
    assert.deepEqual(seen.sent, [], JSON.stringify(env));
    assert.equal(seen.warnings.length, 1); // its own "[dashboard-notifier] … failed" line
  }
});

test('el notifier firma con una clave propia, y con el placeholder sin interruptor firma, envía y avisa una sola vez', async () => {
  const own = await notify({ CONNECTOR_SHARED_SECRET: 'a-key-of-our-own' });
  assert.equal(own.sent.length, 1);
  assert.match(own.sent[0]['x-connector-signature'], SIGNATURE);
  assert.deepEqual(own.errors, []);

  const placeholder = await notify({ CONNECTOR_SHARED_SECRET: PLACEHOLDER }, 4);
  assert.equal(placeholder.sent.length, 4);
  assert.match(placeholder.sent[0]['x-connector-signature'], SIGNATURE);
  assert.equal(placeholder.errors.length, 1); // one line for the process, not one per signature
  assert.match(placeholder.errors[0], /CONNECTOR_SHARED_SECRET is the placeholder/);
});
