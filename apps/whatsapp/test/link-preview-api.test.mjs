import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const id = '11111111-1111-1111-1111-111111111111';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const previewPayload = {
  matchedText: 'https://maps.app.goo.gl/example',
  title: 'Central Park',
  description: 'New York',
  jpegThumbnail: { type: 'Buffer', data: [...jpeg] },
};

test('stored link preview and thumbnail stay scoped to the authenticated account and chat', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wa-link-preview-'));
  const db = { query: async (sql, args) => {
    if (/FROM conversations/.test(sql)) return { rows: args[1] === 'chat-a' ? [{ id: 'chat-a' }] : [] };
    if (/AS text/.test(sql)) return { rows: [{ id, waMessageId: 'wa-id', text: 'https://maps.app.goo.gl/example', type: 'TEXT', timestamp: new Date(), fromMe: false }] };
    if (/AS preview_payload/.test(sql)) {
      const allowed = args[1] === 'personal' && args[2]?.includes('chat-a');
      return { rows: allowed ? [{ id, content: 'https://maps.app.goo.gl/example', preview_payload: previewPayload }] : [] };
    }
    return { rows: [] };
  } };
  const app = await createApp({
    env: { DATA_DIR: dir, UI_AUTH_USERNAME: 'operator', UI_AUTH_PASSWORD: 'password', APP_PUBLIC_URL: 'https://wa.example' },
    db, registry: [{ channel: 'whatsapp', accountId: 'personal', connectorUrl: 'http://connector' }],
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = `Basic ${Buffer.from('operator:password').toString('base64')}`;
  const request = (path, authorization = auth) => fetch(base + path, { headers: { authorization } });
  const list = await request('/api/messages?account=personal&chat=chat-a');
  assert.equal(list.status, 200);
  const preview = (await list.json()).messages[0].linkPreview;
  assert.equal(preview.title, 'Central Park');
  assert.equal(preview.site, 'Google Maps');
  const thumb = await request(preview.thumbnailUrl);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), jpeg);
  assert.equal((await request(preview.thumbnailUrl.replace('chat-a', 'chat-b'))).status, 404);
  assert.equal((await request(preview.thumbnailUrl, '')).status, 401);
});
