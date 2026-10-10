/**
 * SKIRM-111 (C4, F3-2): the Telegram connector and its HMAC key.
 *
 * main.ts is started for real. With the key unset or empty the process dies
 * naming CONNECTOR_SHARED_SECRET before it reads anything else, and so does the
 * repository's placeholder when the Deployment sets CONNECTOR_SECRET_STRICT=true.
 * The placeholder without the flag gets past the guard (it dies one line later,
 * on the Telegram credentials the test does not give it, after the one warning).
 * The helper itself is covered by mcp-server/src/mcp/connector-secret.spec.ts, and the
 * dashboard notifier both connectors share (`shared`, one signature at a time through
 * the same helper) by connectors/whatsapp-web/src/startup-guard.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const PLACEHOLDER = 'dev-secret-change-in-production';

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
