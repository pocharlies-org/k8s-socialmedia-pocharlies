import test from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppCloudAPI, whatsappGraphBaseUrl } from './cloud-api';

test('Cloud API honors Graph base, version, and encoded phone ID', async () => {
  const previous = process.env.WHATSAPP_GRAPH_BASE_URL;
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    return new Response(JSON.stringify({ messages: [{ id: 'fixture-id' }] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    delete process.env.WHATSAPP_GRAPH_BASE_URL;
    assert.equal(whatsappGraphBaseUrl(), 'https://graph.facebook.com');
    process.env.WHATSAPP_GRAPH_BASE_URL = 'https://meta.example/proxy/';
    const api = new WhatsAppCloudAPI({ accessToken: 'fixture-token', phoneNumberId: 'phone/id', graphApiVersion: 'v99.0' });
    await api.sendText({ to: '+34600123456', content: 'fixture message' });
    assert.deepEqual(requests, ['https://meta.example/proxy/v99.0/phone%2Fid/messages']);
    assert.throws(() => new WhatsAppCloudAPI({ accessToken: '', phoneNumberId: '', graphApiVersion: '../escape' }), /WHATSAPP_GRAPH_API_VERSION/);
    for (const value of ['file:///meta', 'https://user:secret@meta.example', 'https://meta.example/#secret']) {
      process.env.WHATSAPP_GRAPH_BASE_URL = value;
      assert.throws(whatsappGraphBaseUrl, /WHATSAPP_GRAPH_BASE_URL/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.WHATSAPP_GRAPH_BASE_URL; else process.env.WHATSAPP_GRAPH_BASE_URL = previous;
  }
});
