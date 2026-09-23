/**
 * SC-1194 P1 (SC-1143) criteria 3 and 4 at the mcp-server edge:
 *  - instagramCall forwards the verified actor to the connector (the SC-705
 *    pattern the WhatsApp/Telegram routes already use);
 *  - social_manage_session action=startPairing hands back the connector's
 *    authorize link, and refuses anonymous callers with an explicit error;
 *  - the WhatsApp session surface is untouched.
 */
import { MCPServer } from './server';
import { runWithRequestActor } from '@mcp-socialmedia/shared';

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

function pairingServer(fetchImpl: jest.Mock) {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  Object.assign(server as unknown as Record<string, unknown>, {
    instagramUrl: 'http://instagram-connector:3003',
    connectorSecret: 'test-shared-secret',
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  });
  global.fetch = fetchImpl as unknown as typeof fetch;
  return server;
}

function callPrivate(server: MCPServer, method: string, ...args: unknown[]): Promise<unknown> {
  return (server as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method](
    ...args
  );
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe('instagramCall actor forwarding (criterion 3)', () => {
  it('forwards x-user-sub/x-user-name when a request actor is present', async () => {
    const calls: FetchCall[] = [];
    const fetchMock = jest.fn(async (url: unknown, init: any) => {
      calls.push({ url: String(url), headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ id: '1' }) };
    });
    const server = pairingServer(fetchMock);

    await runWithRequestActor({ sub: 'daniel-sub', name: 'Daniel' }, () =>
      callPrivate(server, 'instagramCall', 'GET', '/api/v1/skirmshop/profile')
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].headers['x-user-sub']).toBe('daniel-sub');
    expect(calls[0].headers['x-user-name']).toBe('Daniel');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
  });

  it('sends no actor headers outside a request context (legacy consumers unchanged)', async () => {
    const calls: FetchCall[] = [];
    const fetchMock = jest.fn(async (url: unknown, init: any) => {
      calls.push({ url: String(url), headers: init.headers });
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const server = pairingServer(fetchMock);

    await callPrivate(server, 'instagramCall', 'GET', '/api/v1/skirmshop/profile');

    expect(calls[0].headers['x-user-sub']).toBeUndefined();
    expect(calls[0].headers['x-user-name']).toBeUndefined();
  });
});

describe('social_manage_session startPairing (criterion 2 + gate C5)', () => {
  it('returns the connector authorize link for a verified caller', async () => {
    const calls: FetchCall[] = [];
    const fetchMock = jest.fn(async (url: unknown, init: any) => {
      calls.push({ url: String(url), headers: init.headers });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          url: 'https://www.instagram.com/oauth/authorize?client_id=1&state=v1.x.y',
          scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
          stateExpiresInSec: 600,
        }),
      };
    });
    const server = pairingServer(fetchMock);

    const result = (await runWithRequestActor({ sub: 'daniel-sub' }, () =>
      callPrivate(server, 'canonicalManageSession', {
        channel: 'instagram',
        action: 'startPairing',
      })
    )) as { content: Array<{ text: string }> };

    expect(calls[0].url).toBe(
      'http://instagram-connector:3003/api/v1/oauth/instagram/authorize-url'
    );
    expect(calls[0].headers['x-user-sub']).toBe('daniel-sub');
    const payload = JSON.parse(result.content[0].text);
    expect(payload.pairingUrl).toContain('instagram.com/oauth/authorize');
    expect(payload.action).toBe('startPairing');
    expect(payload.instructions).toMatch(/YOUR user id/i);
  });

  it('refuses an anonymous caller with an explicit error (no pairing without identity)', async () => {
    const fetchMock = jest.fn();
    const server = pairingServer(fetchMock);

    await expect(
      callPrivate(server, 'canonicalManageSession', {
        channel: 'instagram',
        action: 'startPairing',
      })
    ).rejects.toThrow(/x-user-sub/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown instagram session actions', async () => {
    const server = pairingServer(jest.fn());
    await expect(
      callPrivate(server, 'canonicalManageSession', { channel: 'instagram', action: 'renewQr' })
    ).rejects.toThrow(/startPairing/);
  });

  it('keeps the whatsapp surface: renewQr still requires a configured whatsapp account', async () => {
    const server = pairingServer(jest.fn());
    (server as unknown as Record<string, unknown>).handleRenewQRCode = jest.fn();
    await expect(
      callPrivate(server, 'canonicalManageSession', {
        channel: 'telegram',
        action: 'renewQr',
        accountId: 'personal',
      })
    ).rejects.toThrow(/not supported for channel 'telegram'/);
  });
});
