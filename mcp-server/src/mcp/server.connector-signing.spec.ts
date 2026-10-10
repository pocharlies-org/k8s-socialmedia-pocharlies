/**
 * SKIRM-103 (F3, C5/C11): the MCP server signs every call to a connector with
 * the secret it was constructed with — providerGet included, which used to send
 * no credential at all — and never with an empty key read from the environment.
 *
 * `gated` stands in for the connector once /api/public/* sits behind
 * createHMACAuth: it verifies "<ts>:<JSON body>" with the same shared
 * verifyHMACSignature that scheme is built on, where a GET carries `{}`
 * (express.json leaves req.body = {} on a request with no body).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyHMACSignature } from '@mcp-socialmedia/shared';
import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';

const SECRET = 'connector-secret-under-test';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  signatureOk: boolean;
}

async function connector(mode: 'gated' | 'open') {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const signatureOk = verifyHMACSignature(
        body,
        Number(req.headers['x-connector-timestamp']),
        String(req.headers['x-connector-signature'] ?? ''),
        SECRET
      );
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, signatureOk });
      if (mode === 'gated' && !signatureOk) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Invalid signature"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"chats":[],"messageId":"m1"}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>(resolve => server.close(() => resolve()));
  return { url, seen, close };
}

function serverWithSecret(connectorUrl: string, secret = SECRET) {
  useTestAccounts({ whatsapp: { personal: connectorUrl } });
  const server = Object.create(MCPServer.prototype) as MCPServer;
  Object.assign(server as unknown as Record<string, unknown>, {
    connectorSecret: secret,
    logger: { error: jest.fn() },
  });
  return server as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
}

describe('providerGet signs the GET', () => {
  it('sends x-connector-timestamp and a signature over "{}" that the gate accepts', async () => {
    const wa = await connector('gated');
    try {
      const out = await serverWithSecret(wa.url).providerGet(wa.url, '/api/public/chats');
      expect(out).toEqual({ chats: [], messageId: 'm1' });
      expect(wa.seen).toHaveLength(1);
      expect(wa.seen[0].headers['x-connector-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(wa.seen[0].signatureOk).toBe(true);
    } finally {
      await wa.close();
    }
  });

  it('signs history reads with the query string and an encoded chat id', async () => {
    const wa = await connector('gated');
    try {
      await serverWithSecret(wa.url).providerGet(
        wa.url,
        `/api/public/history/${encodeURIComponent('34600111222@s.whatsapp.net')}?limit=50`
      );
      expect(wa.seen[0].url).toBe('/api/public/history/34600111222%40s.whatsapp.net?limit=50');
      expect(wa.seen[0].signatureOk).toBe(true);
    } finally {
      await wa.close();
    }
  });

  it('a signature made with another key is refused by the gate (401 → "Provider query failed")', async () => {
    const wa = await connector('gated');
    try {
      await expect(
        serverWithSecret(wa.url, 'some-other-key').providerGet(wa.url, '/api/public/chats')
      ).rejects.toThrow(/Provider query failed \(401\)/);
    } finally {
      await wa.close();
    }
  });

  it('against a connector WITHOUT the gate the signed request still works (step 1 ships first)', async () => {
    const wa = await connector('open');
    try {
      const out = await serverWithSecret(wa.url).providerGet(wa.url, '/api/public/chats');
      expect(out).toEqual({ chats: [], messageId: 'm1' });
    } finally {
      await wa.close();
    }
  });
});

describe('the Telegram reads of /api/public are signed too (SKIRM-111)', () => {
  // Same providerGet as WhatsApp's; what is new is the connector gating these routes.
  function telegramServer(url: string, secret = SECRET) {
    useTestAccounts({ telegram: { personal: url } });
    return serverWithSecret(url, secret);
  }

  it('the dialog list signs "{}" and the gate lets it through', async () => {
    const tg = await connector('gated');
    try {
      const server = telegramServer(tg.url);
      await server.listConversationsFor('telegram', 'personal', { readSource: 'provider' });
      expect(tg.seen.map(s => [s.method, s.url, s.signatureOk])).toEqual([
        ['GET', '/api/public/dialogs', true],
      ]);
    } finally {
      await tg.close();
    }
  });

  it('the history read signs with the limit in the query and an encoded chat id', async () => {
    const tg = await connector('gated');
    try {
      await telegramServer(tg.url).canonicalListMessages({
        channel: 'telegram',
        accountId: 'personal',
        target: '-1001234567890',
        readSource: 'provider',
        limit: 20,
      });
      expect(tg.seen.map(s => [s.method, s.url, s.signatureOk])).toEqual([
        ['GET', '/api/public/messages/-1001234567890?limit=20', true],
      ]);
    } finally {
      await tg.close();
    }
  });

  it('with another key the gate answers 401 and the read fails', async () => {
    const tg = await connector('gated');
    try {
      await expect(
        telegramServer(tg.url, 'some-other-key').listConversationsFor('telegram', 'personal', {
          readSource: 'provider',
        })
      ).rejects.toThrow(/Provider query failed \(401\)/);
    } finally {
      await tg.close();
    }
  });
});

describe('the inline signers use the constructed secret, never an empty one from the environment', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.CONNECTOR_SHARED_SECRET;
    process.env.ENABLE_SENDING = 'true';
    delete process.env.EMERGENCY_DISABLE_SENDING;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('handleSendMessage', async () => {
    const wa = await connector('gated');
    try {
      await serverWithSecret(wa.url).handleSendMessage({
        chatId: '34600111222@s.whatsapp.net',
        text: 'hola',
      });
      expect(wa.seen.map(s => [s.method, s.url, s.signatureOk])).toEqual([
        ['POST', '/api/v1/messages/send', true],
      ]);
    } finally {
      await wa.close();
    }
  });

  it('handleSendApprovedReply', async () => {
    const wa = await connector('gated');
    try {
      const server = serverWithSecret(wa.url);
      Object.assign(server, {
        requireDraftAccount: async () => undefined,
        draftService: {
          getDraftById: async () => ({
            status: 'APPROVED',
            conversationId: '34600111222@s.whatsapp.net',
            content: 'hola',
          }),
          markAsSent: async () => undefined,
        },
      });
      await server.handleSendApprovedReply({ sendToken: 'send-d1-1700000000', account: 'personal' });
      expect(wa.seen.map(s => [s.method, s.url, s.signatureOk])).toEqual([
        ['POST', '/api/v1/messages/send', true],
      ]);
    } finally {
      await wa.close();
    }
  });

  it('handleRenewQRCode', async () => {
    const wa = await connector('gated');
    try {
      await serverWithSecret(wa.url).handleRenewQRCode({
        confirmDisconnect: true,
        account: 'personal',
      });
      expect(wa.seen.map(s => [s.method, s.url, s.signatureOk])).toEqual([
        ['POST', '/api/v1/auth/logout', true],
      ]);
    } finally {
      await wa.close();
    }
  });
});
