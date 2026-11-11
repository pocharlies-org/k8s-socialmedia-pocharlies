import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const auth = `Basic ${Buffer.from('operator:password').toString('base64')}`;

// QA #10: un 400 del conector llegaba al navegador como "Upstream returned
// HTTP 400" sin cuerpo. El motivo (error/failureClass) debe salir intacto.
test('a connector rejection reaches the browser with its reason, not a bare 502', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'whatsapp-connector-error-test-'));
  const db = {
    query: async (sql, args = []) => {
      if (/FROM conversations/.test(sql) && args[0] === 'personal') {
        return { rows: [{ id: 'jordi-chat', account: 'personal', wa_chat_id: 'jordi-chat', is_group: false, archived: false, name: 'Jordi' }] };
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
    fetchImpl: async () => Response.json({ error: 'polls are not supported in this chat', failureClass: 'rejected_by_whatsapp' }, { status: 400 }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${base}/api/messages/compose`, {
    method: 'POST',
    headers: { authorization: auth, origin: 'https://wa.example', 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'personal', chat: 'jordi-chat', kind: 'poll', payload: { question: '¿Cenamos?', options: ['Sí', 'No', 'Tanto'] } }),
  });
  const body = await response.json().catch(() => null);
  // 502: la accion no quedo confirmada (semantica de las rutas de envio).
  // Lo que cambia es que el motivo del conector llega con el 502.
  assert.equal(response.status, 502, JSON.stringify(body));
  assert.equal(body.error, 'polls are not supported in this chat');
  assert.equal(body.code, 'UPSTREAM_REJECTED');
  assert.equal(body.details.failureClass, 'rejected_by_whatsapp');
});
