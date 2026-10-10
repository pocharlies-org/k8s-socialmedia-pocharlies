/**
 * SKIRM-112 (C2/C3): every call mcp-server makes to /api/v1 of the Instagram connector is
 * signed with the connector key, as the WhatsApp ones are (SKIRM-103).
 *
 * `gated` stands in for the connector once /api/v1 sits behind createHMACAuth (a request with no
 * body, GET or DELETE, signs `{}`); `open` is a connector without the gate: a signed request must
 * still work there (the consumers ship first). See test-connector.ts.
 * The actor headers (x-user-sub) travel next to the signature and are not signed.
 */
import { runWithRequestActor } from '@mcp-socialmedia/shared';
import { MCPServer } from './server';
import { connector as stub, TEST_CONNECTOR_SECRET as SECRET } from './test-connector';

const connector = (mode: 'gated' | 'open') => stub(mode, '{"id":"1"}');

function serverFor(instagramUrl: string, secret = SECRET) {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  Object.assign(server as unknown as Record<string, unknown>, {
    instagramUrl,
    connectorSecret: secret,
    logger: { error: jest.fn() },
  });
  return server as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
}

describe('the Instagram tools sign every call to the connector', () => {
  it('GET (profile): signs "{}"', async () => {
    const ig = await connector('gated');
    try {
      await serverFor(ig.url).handleInstagramGetProfile({ account: 'skirmshop' });
      expect(ig.seen.map(s => [s.method, s.url, s.signatureOk])).toEqual([
        ['GET', '/api/v1/skirmshop/profile', true],
      ]);
      expect(ig.seen[0].headers['x-connector-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(ig.seen[0].headers['x-connector-timestamp']).toMatch(/^\d{10}$/);
    } finally {
      await ig.close();
    }
  });

  it('POST (send DM): the signature covers the body that travels', async () => {
    const ig = await connector('gated');
    try {
      await serverFor(ig.url).handleInstagramSendDm({
        account: 'skirmshop',
        recipientId: 'user-1',
        message: 'hola',
      });
      expect(ig.seen.map(s => [s.method, s.url, s.signatureOk])).toEqual([
        ['POST', '/api/v1/skirmshop/messages/send', true],
      ]);
    } finally {
      await ig.close();
    }
  });

  it('POST hide and DELETE comment (the ones that change what the account shows)', async () => {
    const ig = await connector('gated');
    try {
      const server = serverFor(ig.url);
      await server.handleInstagramHideComment({ account: 'skirmshop', commentId: 'c1' });
      await server.handleInstagramDeleteComment({ account: 'skirmshop', commentId: 'c1' });
      expect(ig.seen.map(s => [s.method, s.url, s.signatureOk])).toEqual([
        ['POST', '/api/v1/skirmshop/comments/c1/hide', true],
        ['DELETE', '/api/v1/skirmshop/comments/c1', true],
      ]);
    } finally {
      await ig.close();
    }
  });

  it('keeps the actor headers next to the signature', async () => {
    const ig = await connector('gated');
    try {
      await runWithRequestActor({ sub: 'daniel-sub' }, () =>
        serverFor(ig.url).handleInstagramGetProfile({ account: 'skirmshop' })
      );
      expect(ig.seen[0].headers['x-user-sub']).toBe('daniel-sub');
      expect(ig.seen[0].signatureOk).toBe(true);
    } finally {
      await ig.close();
    }
  });

  it('a signature made with another key is refused by the gate (401 → "Instagram API error")', async () => {
    const ig = await connector('gated');
    try {
      await expect(
        serverFor(ig.url, 'some-other-key').handleInstagramGetProfile({ account: 'skirmshop' })
      ).rejects.toThrow(/Instagram API error \(401\)/);
    } finally {
      await ig.close();
    }
  });

  it('against a connector WITHOUT the gate the signed request still works (the consumers ship first)', async () => {
    const ig = await connector('open');
    try {
      const out = await serverFor(ig.url).handleInstagramGetProfile({ account: 'skirmshop' });
      expect(JSON.parse(out.content[0].text)).toEqual({ id: '1' });
    } finally {
      await ig.close();
    }
  });
});
