import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, trackingOptInBaseUrl } from './config';

test('bridge requires explicit validated endpoints and tracking filter is opt-in', () => {
  const keys = ['GATEWAY_WEBHOOK_URL', 'CONNECTOR_URL', 'WHATSAPP_WEBHOOK_SECRET', 'CONNECTOR_SHARED_SECRET', 'TRACKING_OPT_IN_BASE_URL'];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.throws(loadConfig, /Missing required environment variable: GATEWAY_WEBHOOK_URL/);
    process.env.GATEWAY_WEBHOOK_URL = 'https://gateway.example/hooks/whatsapp';
    assert.throws(loadConfig, /Missing required environment variable: CONNECTOR_URL/);
    process.env.CONNECTOR_URL = 'http://connector:3001';
    process.env.WHATSAPP_WEBHOOK_SECRET = 'fixture-webhook-secret';
    process.env.CONNECTOR_SHARED_SECRET = 'fixture-connector-secret';
    const config = loadConfig();
    assert.equal(config.gatewayWebhookUrl, 'https://gateway.example/hooks/whatsapp');
    assert.equal(config.connectorUrl, 'http://connector:3001');
    assert.equal(trackingOptInBaseUrl(), undefined);
    process.env.TRACKING_OPT_IN_BASE_URL = 'https://tracking.example/orders/';
    assert.equal(trackingOptInBaseUrl(), 'https://tracking.example/orders/');
    process.env.TRACKING_OPT_IN_BASE_URL = 'file:///orders';
    assert.throws(loadConfig, /TRACKING_OPT_IN_BASE_URL/);
    delete process.env.TRACKING_OPT_IN_BASE_URL;
    for (const value of ['http://gateway.example', 'https://user:password@gateway.example', 'https://gateway.example/?secret=1']) {
      process.env.GATEWAY_WEBHOOK_URL = value;
      assert.throws(loadConfig, /GATEWAY_WEBHOOK_URL/);
    }
    process.env.GATEWAY_WEBHOOK_URL = 'https://gateway.example/hooks/whatsapp';
    process.env.CONNECTOR_URL = 'file:///connector';
    assert.throws(loadConfig, /CONNECTOR_URL/);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
  }
});
