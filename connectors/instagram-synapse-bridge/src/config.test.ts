import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, loadConfig } from './config';

test('requires a distinct Instagram webhook secret and HTTPS receiver', () => {
  const before = { ...process.env };
  try {
    delete process.env.INSTAGRAM_WEBHOOK_SECRET;
    assert.throws(() => loadConfig(), ConfigError);
    process.env.INSTAGRAM_WEBHOOK_SECRET = 'different-from-meta-app-secret';
    process.env.SYNAPSE_INSTAGRAM_WEBHOOK_URL = 'http://insecure.invalid/webhooks/instagram';
    assert.throws(() => loadConfig(), /https/);
    process.env.SYNAPSE_INSTAGRAM_WEBHOOK_URL = 'https://synapse.e-dani.com/webhooks/instagram';
    assert.equal(loadConfig().durableName, 'synapse-instagram-skirmshop-v1');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in before)) delete process.env[key];
    }
    Object.assign(process.env, before);
  }
});
