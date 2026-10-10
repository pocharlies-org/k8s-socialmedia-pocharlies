/**
 * SKIRM-103 (F3, C5/C11): the MCP server signs every call to a connector with
 * the secret it was constructed with — providerGet included, which used to send
 * no credential at all — and never with an empty key read from the environment.
 *
 * `connector('gated')` (test-connector.ts) stands in for the connector once
 * /api/public/* sits behind createHMACAuth.
 */
import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';
import { connector, TEST_CONNECTOR_SECRET as SECRET } from './test-connector';

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
