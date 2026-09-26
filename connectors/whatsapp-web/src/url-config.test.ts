import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardUrl, qrPageUrl, whatsappSocketOptions } from './url-config';
import { notifyDashboard } from './dashboard-notifier';
import { buildManualWhatsAppOpenUrl } from './contact-sync';

test('QR links honor public URL, compatibility fallback, and prefixed local route', () => {
  assert.equal(qrPageUrl({ QR_PAGE_URL: 'https://qr.example/personal/qr/page', WA_QR_PUBLIC_URL: 'https://old.example' }), 'https://qr.example/personal/qr/page');
  assert.equal(qrPageUrl({ WA_QR_PUBLIC_URL: 'https://legacy.example/' }), 'https://legacy.example');
  assert.equal(qrPageUrl({ PORT: '3010', UI_BASE_PATH: '/personal' }), 'http://localhost:3010/personal/qr/page');
  for (const value of ['javascript:alert(1)', 'https://user:secret@example.com/', 'https://example.com/#secret']) {
    assert.throws(() => qrPageUrl({ QR_PAGE_URL: value }), /QR_PAGE_URL/);
  }
});

test('dashboard absent or blank performs no fetch; configured dashboard preserves path prefix', async () => {
  const previous = process.env.DASHBOARD_URL;
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async input => { calls.push(String(input)); return new Response(null, { status: 204 }); };
  try {
    delete process.env.DASHBOARD_URL;
    await notifyDashboard('/_connector/typing', {});
    process.env.DASHBOARD_URL = ' ';
    await notifyDashboard('/_connector/typing', {});
    assert.deepEqual(calls, []);
    process.env.DASHBOARD_URL = 'https://dashboard.example/prefix/';
    await notifyDashboard('/_connector/typing', {});
    assert.deepEqual(calls, ['https://dashboard.example/prefix/api/messages/_connector/typing']);
    assert.throws(() => dashboardUrl({ DASHBOARD_URL: 'file:///tmp/dashboard' }), /DASHBOARD_URL/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.DASHBOARD_URL; else process.env.DASHBOARD_URL = previous;
  }
});

test('provider socket override is validated and unsupported origin fails clearly', () => {
  assert.deepEqual(whatsappSocketOptions({}), {});
  assert.deepEqual(whatsappSocketOptions({ WHATSAPP_WEBSOCKET_URL: 'wss://gateway.example/ws' }), { waWebSocketUrl: 'wss://gateway.example/ws' });
  assert.throws(() => whatsappSocketOptions({ WHATSAPP_WEBSOCKET_URL: 'https://gateway.example' }), /WHATSAPP_WEBSOCKET_URL/);
  assert.throws(() => whatsappSocketOptions({ WHATSAPP_ORIGIN: 'https://custom.example' }), /custom origins are unsupported/);
  assert.deepEqual(whatsappSocketOptions({ WHATSAPP_ORIGIN: 'https://web.whatsapp.com' }), {});
});

test('manual links honor provider base and encode message', () => {
  const previous = process.env.WHATSAPP_LINK_BASE_URL;
  try {
    process.env.WHATSAPP_LINK_BASE_URL = 'https://links.example/open/';
    assert.equal(buildManualWhatsAppOpenUrl('+34 600', 'hi & bye'), 'https://links.example/open/34600?text=hi%20%26%20bye');
    process.env.WHATSAPP_LINK_BASE_URL = 'javascript:alert(1)';
    assert.throws(() => buildManualWhatsAppOpenUrl('+34600'), /WHATSAPP_LINK_BASE_URL/);
  } finally {
    if (previous === undefined) delete process.env.WHATSAPP_LINK_BASE_URL; else process.env.WHATSAPP_LINK_BASE_URL = previous;
  }
});
