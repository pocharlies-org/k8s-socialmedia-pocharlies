/**
 * SKIRM-111: the Telegram reads of /api/public are signed with the connector key, as the WhatsApp
 * ones are (SKIRM-103). It is the same providerGet; what is new is the Telegram connector gating
 * these routes. `connector('gated')` (test-connector.ts) stands in for it: a GET signs "{}".
 */
import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';
import { connector, TEST_CONNECTOR_SECRET as SECRET } from './test-connector';

function telegramServer(url: string, secret = SECRET) {
  process.env.TEST_CONNECTOR_SECRET = secret;
  useTestAccounts({ telegram: { personal: url }, secretEnv: 'TEST_CONNECTOR_SECRET' });
  const server = Object.create(MCPServer.prototype) as MCPServer;
  Object.assign(server as unknown as Record<string, unknown>, {
    connectorSecret: 'unused-constructor-secret',
    logger: { error: jest.fn() },
  });
  return server as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
}

describe('the Telegram reads of /api/public are signed', () => {
  it('the dialog list signs "{}" and the gate lets it through', async () => {
    const tg = await connector('gated');
    try {
      await telegramServer(tg.url).listConversationsFor('telegram', 'personal', {
        readSource: 'provider',
      });
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

  it('INFRA-1008: before/after travel in the query, unsigned, so the connector can page', async () => {
    const tg = await connector('gated');
    try {
      await telegramServer(tg.url).canonicalListMessages({
        channel: 'telegram',
        accountId: 'personal',
        target: '-1001234567890',
        readSource: 'provider',
        limit: 500,
        before: 20200,
      });
      await telegramServer(tg.url).canonicalListMessages({
        channel: 'telegram',
        accountId: 'personal',
        target: '-1001234567890',
        readSource: 'provider',
        after: '100',
      });
      expect(tg.seen.map(s => [s.method, s.url, s.signatureOk])).toEqual([
        ['GET', '/api/public/messages/-1001234567890?limit=500&before=20200', true],
        ['GET', '/api/public/messages/-1001234567890?limit=50&after=100', true],
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
