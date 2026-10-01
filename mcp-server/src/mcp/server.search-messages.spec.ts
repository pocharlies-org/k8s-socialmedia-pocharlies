import { SearchService } from '../application/search.service';
import { messageTypesFor } from '../application/media-type-filter';
import { useTestAccounts } from '../domain/test-accounts';
import { MCPServer } from './server';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';

/**
 * social_search_messages over the local index: Instagram rows (platform
 * 'instagram', ids `ig_<account>_…` never namespace-prefixed, filed under the
 * account's DB namespace) and the mediaType filter on every channel.
 */
function serverWith() {
  const server = Object.create(MCPServer.prototype) as MCPServer;
  const query = jest.fn(async (..._args: unknown[]) => ({ rows: [] as any[] }));
  useTestAccounts({
    whatsapp: { personal: 'http://wa-personal', professional: 'http://wa-professional' },
    telegram: { personal: 'http://tg-personal' },
  });
  const searchService = Object.create(SearchService.prototype) as SearchService;
  Object.assign(searchService as unknown as Record<string, unknown>, {
    dbClient: { query },
    // No embeddings endpoint: search() falls back to the keyword (FTS) query.
    openai: { embeddings: { create: jest.fn(async () => Promise.reject(new Error('no llm'))) } },
    logger: { warn: jest.fn() },
  });
  Object.assign(server as unknown as Record<string, unknown>, {
    dbClient: { query },
    searchService,
    logger: { error: jest.fn() },
    resolveTelegramChatId: jest.fn(async () => 'tg_personal_-100123'),
  });
  const any = server as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
  const run = (args: Record<string, unknown>) =>
    any.executeCanonicalTool(
      SOCIAL_TOOL_REGISTRY.find(tool => tool.name === 'social_search_messages'),
      args
    ) as Promise<{ isError?: boolean; structuredContent: Record<string, any> }>;
  const lastQuery = () => {
    const call = query.mock.calls[query.mock.calls.length - 1] as unknown as [string, unknown[]];
    return { sql: call[0], params: call[1] };
  };
  return { run, query, lastQuery };
}

describe('social_search_messages — Instagram', () => {
  it('searches the instagram rows of the account namespace with the ids as stored', async () => {
    const { run, query, lastQuery } = serverWith();
    query.mockResolvedValueOnce({
      rows: [
        {
          message_id: 'm1',
          conversation_id: 'ig_skirmshop_thread_42',
          content: 'hola precio',
          sender_wa_id: 'ig_skirmshop_42',
          wa_timestamp: new Date('2026-09-30T10:00:00Z'),
          platform: 'instagram',
          account: 'professional',
          message_type: 'TEXT',
          rank: '0.5',
        },
      ],
    });
    const out = await run({
      channel: 'instagram',
      accountId: 'skirmshop',
      query: 'precio',
      target: 'ig_skirmshop_thread_42',
      sender: 'ig_skirmshop_42',
    });
    expect(out.isError).toBeFalsy();
    const { sql, params } = lastQuery();
    expect(sql).toContain('m.conversation_id = $2');
    expect(sql).toContain('m.sender_wa_id = $3');
    expect(sql).toContain('m.account = $4');
    expect(sql).toContain('m.platform = $5');
    expect(params).toEqual([
      'precio',
      'ig_skirmshop_thread_42',
      'ig_skirmshop_42',
      'professional',
      'instagram',
      20,
    ]);
    expect(out.structuredContent.data.results[0]).toMatchObject({
      conversationId: 'ig_skirmshop_thread_42',
      channel: 'instagram',
      accountId: 'professional',
      messageType: 'TEXT',
    });
    expect(out.structuredContent.meta.source.kind).toBe('localIndex');
  });

  it('refuses an Instagram account that is not configured', async () => {
    const { run, query } = serverWith();
    const out = await run({ channel: 'instagram', accountId: 'nadie', query: 'x' });
    expect(out.structuredContent.error).toMatchObject({ code: 'unsupported_capability' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('social_search_messages — mediaType', () => {
  it('filters Instagram video, including MEDIA rows whose content starts with the kind', async () => {
    const { run, lastQuery } = serverWith();
    await run({ channel: 'instagram', accountId: 'barbelpapis', query: 'run', mediaType: 'video' });
    const { sql, params } = lastQuery();
    expect(sql).toContain('upper(m.message_type) = ANY($4::text[])');
    expect(sql).toContain("upper(split_part(m.content, ' |', 1)) = ANY($4::text[])");
    expect(params).toEqual(['run', 'personal', 'instagram', ['VIDEO', 'VIDEO_NOTE'], 20]);
  });

  it('filters WhatsApp images keeping the namespaced chat id', async () => {
    const { run, lastQuery } = serverWith();
    await run({
      channel: 'whatsapp',
      accountId: 'professional',
      query: 'factura',
      target: '34600@s.whatsapp.net',
      mediaType: 'image',
    });
    const { params } = lastQuery();
    expect(params).toEqual([
      'factura',
      'professional:34600@s.whatsapp.net',
      'professional',
      'whatsapp',
      messageTypesFor('image'),
      20,
    ]);
  });

  it('filters Telegram audio with the chat parameter after the media types', async () => {
    const { run, lastQuery } = serverWith();
    await run({
      channel: 'telegram',
      accountId: 'personal',
      query: 'nota',
      target: '-100123',
      mediaType: 'audio',
    });
    const { sql, params } = lastQuery();
    expect(sql).toContain('upper(message_type) = ANY($4::text[])');
    expect(sql).toContain('conversation_id = $5');
    expect(params).toEqual([
      '%nota%',
      20,
      'personal',
      ['AUDIO', 'PTT', 'VOICE'],
      'tg_personal_-100123',
    ]);
  });

  it("adds no filter for 'any' or when absent, and searches every channel without one", async () => {
    const { run, lastQuery } = serverWith();
    await run({ query: 'hola', mediaType: 'any' });
    expect(lastQuery().sql).not.toContain('message_type) = ANY');
    expect(lastQuery().sql).not.toContain('m.platform = ');
    expect(lastQuery().params).toEqual(['hola', 20]);
    await run({ query: 'hola', mediaType: 'sticker' });
    expect(lastQuery().params).toEqual(['hola', ['STICKER'], 20]);
  });

  it('rejects an unknown mediaType before touching the index', async () => {
    const { run, query } = serverWith();
    const out = await run({ query: 'hola', mediaType: 'gif' }).catch(error => ({
      structuredContent: { error: { code: (error as any).canonicalCode } },
    }));
    expect(out.structuredContent.error).toMatchObject({ code: 'invalid_request' });
    expect(query).not.toHaveBeenCalled();
  });
});
