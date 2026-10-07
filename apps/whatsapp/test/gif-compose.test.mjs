import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const exec = promisify(execFile);
const auth = `Basic ${Buffer.from('operator:password').toString('base64')}`;

test('16:9 GIF compose converts to even yuv420p dimensions before provider send', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'whatsapp-gif-compose-test-'));
  const inputPath = join(directory, 'input.gif');
  const outputPath = join(directory, 'output.mp4');
  const calls = [];
  const db = {
    query: async (sql, args = []) => {
      if (/FROM conversations/.test(sql) && args[0] === 'personal' && args[1] === 'wide-chat') {
        return { rows: [{ id: 'wide-chat', account: 'personal', wa_chat_id: 'wide-chat', is_group: false, archived: false, name: 'Wide chat' }] };
      }
      return { rows: [] };
    },
  };
  const app = await createApp({
    env: {
      DATA_DIR: directory,
      UI_AUTH_USERNAME: 'operator',
      UI_AUTH_PASSWORD: 'password',
      APP_PUBLIC_URL: 'https://wa.example',
      APP_ENABLE_SENDING: 'true',
      PERSONAL_SECRET: 'personal-secret',
    },
    db,
    registry: [{ channel: 'whatsapp', accountId: 'personal', secretEnv: 'PERSONAL_SECRET', connectorUrl: 'http://simulated-connector' }],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ messageId: 'gif-provider-message' });
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  // Generate a real 320x180 GIF so the 720px aspect-ratio scale would produce
  // an odd 405px height without force_divisible_by=2.
  await exec('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=0.25:r=2',
    '-f', 'gif', inputPath,
  ]);
  const input = await readFile(inputPath);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${base}/api/messages/compose`, {
    method: 'POST',
    headers: { authorization: auth, origin: 'https://wa.example', 'content-type': 'application/json' },
    body: JSON.stringify({
      account: 'personal', chat: 'wide-chat', kind: 'gif', name: 'wide.gif', mimeType: 'image/gif', data: input.toString('base64'),
    }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(calls.length, 1, 'exactly one simulated provider send is expected');
  const providerPayload = JSON.parse(calls[0].options.body);
  assert.equal(providerPayload.conversationId, 'wide-chat');
  assert.equal(providerPayload.kind, 'gif');
  assert.equal(providerPayload.sourceMimeType, 'image/gif');
  const [, encoded] = providerPayload.fileUrl.split(',', 2);
  await writeFile(outputPath, Buffer.from(encoded, 'base64'));
  const probe = JSON.parse((await exec('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', outputPath,
  ])).stdout);
  const stream = probe.streams?.[0];
  assert.ok(stream);
  assert.equal(stream.width, 720);
  assert.equal(stream.height % 2, 0);
  assert.equal(stream.pix_fmt, 'yuv420p');
});
