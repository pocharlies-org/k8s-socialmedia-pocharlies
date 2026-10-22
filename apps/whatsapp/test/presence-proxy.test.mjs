import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// QA #27.1: el subtítulo del chat directo estaba muerto porque el proxy llamaba una GET que el conector no tiene.
test('GET /api/presence llama a POST /chats/presence/read y desenvuelve la forma anidada', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /featureConnector\(a, '\/chats\/presence\/read', \{ method: 'POST', body: \{ conversationId: providerChat \} \}\)/);
  assert.match(src, /normalizePresence\(result\?\.presence\?\.presence \|\| result\?\.presence \|\| result\)/);
  assert.match(src, /available: presence\.state !== 'unknown' \|\| presence\.lastSeen != null/);
});
