/**
 * SKIRM-103 (F3-2, C11): the connector fails closed on its HMAC key.
 *
 * main.ts is started for real: with the key unset, empty or the placeholder
 * the process must die naming CONNECTOR_SHARED_SECRET, before it listens or
 * opens a WhatsApp socket. The "valid key starts" half is requireConnectorSecret
 * itself (mcp-server/src/mcp/connector-secret.spec.ts): a valid key lets main.ts
 * go on to open a Baileys socket, which a test must not do.
 *
 * The dashboard notifier used to sign with the placeholder when the key was
 * missing; now it sends nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import './test-env';
import { notifyDashboard } from './dashboard-notifier';

const run = promisify(execFile);
const PLACEHOLDER = 'dev-secret-change-in-production';

async function startMain(secret: string | undefined) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none',
    PORT: '0',
  };
  if (secret !== undefined) env.CONNECTOR_SHARED_SECRET = secret;
  try {
    await run(process.execPath, ['--import', 'tsx', join('src', 'main.ts')], {
      cwd: process.cwd(),
      env,
      timeout: 60_000,
    });
    return { code: 0, output: '' };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('main.ts no arranca con la clave HMAC ausente, vacía o el placeholder', async () => {
  const results = await Promise.all([
    startMain(undefined),
    startMain(''),
    startMain(PLACEHOLDER),
  ]);
  for (const r of results) {
    assert.notEqual(r.code, 0);
    assert.match(r.output, /CONNECTOR_SHARED_SECRET/);
    assert.doesNotMatch(r.output, /listening on port/);
  }
  assert.match(results[2].output, /placeholder/);
});

test('el notifier del dashboard no envía nada sin una clave utilizable (antes firmaba con el placeholder)', async () => {
  const realFetch = globalThis.fetch;
  const realSecret = process.env.CONNECTOR_SHARED_SECRET;
  const realWarn = console.warn;
  const sent: { headers: Record<string, string> }[] = [];
  const warnings: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    sent.push({ headers: init?.headers ?? {} });
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
  try {
    for (const bad of [undefined, '', PLACEHOLDER]) {
      if (bad === undefined) delete process.env.CONNECTOR_SHARED_SECRET;
      else process.env.CONNECTOR_SHARED_SECRET = bad;
      await notifyDashboard('/_connector/typing', { chatId: 'x' });
    }
    assert.deepEqual(sent, []);
    assert.equal(warnings.length, 3);

    process.env.CONNECTOR_SHARED_SECRET = 'a-real-rotated-secret';
    await notifyDashboard('/_connector/typing', { chatId: 'x' });
    assert.equal(sent.length, 1);
    assert.match(sent[0].headers['x-connector-signature'], /^sha256=[0-9a-f]{64}$/);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    if (realSecret === undefined) delete process.env.CONNECTOR_SHARED_SECRET;
    else process.env.CONNECTOR_SHARED_SECRET = realSecret;
  }
});
