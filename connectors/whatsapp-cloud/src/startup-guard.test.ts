/**
 * SKIRM-111 (C4, F3-2): the WhatsApp Cloud connector and its HMAC key.
 *
 * main.ts is started for real: with the key unset or empty the process must die
 * naming CONNECTOR_SHARED_SECRET, and so must the repository's placeholder when
 * the Deployment sets CONNECTOR_SECRET_STRICT=true. "The placeholder without the
 * flag starts, with one warning" is requireConnectorSecret itself
 * (mcp-server/src/mcp/connector-secret.spec.ts): going on, main.ts would listen
 * and dial NATS, which a test must not do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const PLACEHOLDER = 'dev-secret-change-in-production';

test('main.ts no arranca con la clave HMAC ausente o vacía, ni con el placeholder si es estricto', () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{}, /unset or empty/],
    [{ CONNECTOR_SHARED_SECRET: '' }, /unset or empty/],
    [
      { CONNECTOR_SHARED_SECRET: PLACEHOLDER, CONNECTOR_SECRET_STRICT: 'true' },
      /is the placeholder/,
    ],
  ];
  for (const [env, reason] of cases) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', PORT: '0', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const output = `${run.stdout}${run.stderr}`;
    assert.notEqual(run.status, 0, JSON.stringify(env));
    assert.match(output, /CONNECTOR_SHARED_SECRET/);
    assert.match(output, reason);
    assert.doesNotMatch(output, /listening/i);
  }
});
