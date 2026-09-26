import { join } from 'node:path';
import { MCPServer } from './server';
import { InstagramIngestionService } from '../application/instagram-ingestion.service';
import { SearchService } from '../application/search.service';
import { getAccounts } from '../domain/account-registry';

beforeAll(() => {
  process.env.SOCIAL_ACCOUNTS_FILE = join(__dirname, '../domain/accounts.fixture.json');
  process.env.TEST_PERSONAL_SECRET = 'test-personal';
  process.env.TEST_SECONDARY_SECRET = 'test-secondary';
  process.env.TEST_THIRD_SECRET = 'test-third';
  process.env.TEST_IG_SECRET = 'test-ig';
  process.env.ENABLE_SENDING = 'false';
});
afterEach(() => jest.restoreAllMocks());
function server(): any {
  const s: any = Object.create(MCPServer.prototype);
  s.waUrls = Object.fromEntries(getAccounts('whatsapp').map(a => [a.accountId, a.connectorUrl]));
  return s;
}

test('third account routes solely from configuration and rejects foreign namespaces', () => {
  const s = server();
  expect(s.waUrl('arbitrary_3')).toBe('http://wa-third');
  expect(() => s.waUrl('unknown')).toThrow();
  expect(() => s.whatsAppProviderTarget({ channel: 'whatsapp', accountId: 'secondary', target: 'arbitrary_3:123@s.whatsapp.net' })).toThrow();
  expect(() => s.whatsAppProviderTarget({ channel: 'whatsapp', accountId: 'secondary', target: 'unknown:123@s.whatsapp.net' })).toThrow();
});

test('provider reads use the selected account HMAC; Instagram uses its own Bearer secret', async () => {
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  const s = server();
  await s.providerGet(s.waUrl('arbitrary_3'), '/api/v1/chats');
  expect(fetchMock.mock.calls[0][0]).toBe('http://wa-third/api/v1/chats');
  expect((fetchMock.mock.calls[0][1]!.headers as any)['X-Connector-Signature']).toBeTruthy();
  await s.instagramCall('GET', '/api/v1/other_ig/profile');
  expect(fetchMock.mock.calls[1][0]).toBe('http://ig-other/api/v1/other_ig/profile');
  expect((fetchMock.mock.calls[1][1]!.headers as any).Authorization).toBe('Bearer test-ig');
});

test('catalog includes only configured accounts and truthful sending capability', async () => {
  const s = server();
  s.handleMessagingStatus = async () => s.jsonResponse({});
  const result = JSON.parse((await s.canonicalListAccounts({ channel: 'whatsapp' })).content[0].text);
  expect(result.accounts.map((a: any) => a.accountId)).toEqual(['personal', 'secondary', 'arbitrary_3', 'disabled', 'instagram']);
  expect(result.accounts.every((a: any) => a.capabilities.send === false)).toBe(true);
});

test('Instagram sender and message keys preserve both accounts', async () => {
  const db = { query: jest.fn(async () => ({ rowCount: 1, rows: [] })) };
  const ingestion = new InstagramIngestionService(db as any);
  for (const account of ['instagram', 'other_ig']) await ingestion.handleEvent({ platform: 'instagram', account, eventType: 'dm', senderId: '42', messageId: 'same', conversationId: 'same', timestamp: '2026-09-12T00:00:00Z' });
  const participants = db.query.mock.calls as unknown as Array<[string, unknown[]]>;
  const writes = participants.filter(([sql]) => sql.includes('INSERT INTO participants'));
  expect(writes[0][1][0]).not.toBe(writes[1][1][0]);
  expect(writes.map(([, args]) => args[2])).toEqual(['instagram', 'other_ig']);
});

test('cross-account search only includes enabled configured channel/account pairs', async () => {
  const db = { query: jest.fn(async () => ({ rows: [] })) };
  const search = new SearchService('', db as any, '');
  await search.keywordSearch('text');
  const calls = db.query.mock.calls as unknown as Array<[string, unknown[]]>;
  expect(calls[0][0]).toContain("m.platform || ':' || m.account");
  expect(calls[0][1][1]).toContain('whatsapp:arbitrary_3');
  expect(calls[0][1][1]).not.toContain('whatsapp:disabled');
});

test('global read-only mode blocks Instagram and Telegram external writes before dispatch', async () => {
  const s = server();
  s.validateCanonicalArguments = jest.fn();
  s.dispatchCanonicalTool = jest.fn();
  for (const channel of ['instagram', 'telegram']) {
    await s.executeCanonicalTool({ effect: 'externalWrite' }, { channel, accountId: 'anything' });
  }
  expect(s.dispatchCanonicalTool).not.toHaveBeenCalled();
});
