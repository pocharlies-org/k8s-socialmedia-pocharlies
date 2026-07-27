import { MCPServer } from './server';
import { SOCIAL_TOOL_REGISTRY } from './tool-registry';

function definition(name: string) {
  const found = SOCIAL_TOOL_REGISTRY.find(tool => tool.name === name);
  if (!found) throw new Error(`Missing test definition ${name}`);
  return found;
}

function legacy(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fakeRedis() {
  const values = new Map<string, string>();
  return {
    values,
    get: jest.fn(async (key: string) => values.get(key) ?? null),
    set: jest.fn(
      async (key: string, value: string, ...args: Array<string | number>) => {
        if (args.includes('NX') && values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      }
    ),
  };
}

function createServer() {
  const server: any = Object.create(MCPServer.prototype);
  server.redisClient = fakeRedis();
  server.logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  server.waUrls = {
    personal: 'http://wa-personal',
    professional: 'http://wa-professional',
  };
  server.tgUrls = {
    personal: 'http://tg-personal',
    professional: 'http://tg-professional',
  };
  server.tgBridgeUrls = {
    personal: 'http://tg-bridge-personal',
    professional: 'http://tg-bridge-professional',
  };
  server.instagramUrl = 'http://instagram';
  return server;
}

function expectStructuredError(result: any, code: string) {
  expect(result).toMatchObject({
    isError: true,
    structuredContent: {
      ok: false,
      status: code === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
      data: null,
      meta: {},
      error: { code },
    },
  });
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
}

describe('Socialmedia canonical v2 acceptance gaps', () => {
  describe('Ajv action-specific validation', () => {
    const invalidCases: Array<[string, string, Record<string, unknown>]> = [
      [
        'renewQr requires explicit disconnect confirmation',
        'social_manage_session',
        { channel: 'whatsapp', accountId: 'personal', action: 'renewQr' },
      ],
      [
        'renewQr rejects a false confirmation',
        'social_manage_session',
        {
          channel: 'whatsapp',
          accountId: 'personal',
          action: 'renewQr',
          confirmDisconnect: false,
        },
      ],
      [
        'repairGroup requires a target',
        'social_manage_session',
        { channel: 'whatsapp', accountId: 'personal', action: 'repairGroup' },
      ],
      [
        'createTopic requires a target',
        'social_manage_forum',
        {
          channel: 'telegram',
          accountId: 'personal',
          action: 'createTopic',
          title: 'Operations',
        },
      ],
      [
        'topic mutation requires a thread id',
        'social_manage_forum',
        {
          channel: 'telegram',
          accountId: 'personal',
          action: 'closeTopic',
          target: '-1001',
        },
      ],
      [
        'editTopic requires at least one changed field',
        'social_manage_forum',
        {
          channel: 'telegram',
          accountId: 'personal',
          action: 'editTopic',
          target: '-1001',
          threadId: 11,
        },
      ],
      [
        'createGroup requires a title',
        'social_manage_forum',
        { channel: 'telegram', accountId: 'personal', action: 'createGroup' },
      ],
      [
        'addMembers rejects an empty member list',
        'social_manage_forum',
        {
          channel: 'telegram',
          accountId: 'personal',
          action: 'addMembers',
          target: '-1001',
          members: [],
        },
      ],
      [
        'setAdminPermissions requires rights',
        'social_manage_forum',
        {
          channel: 'telegram',
          accountId: 'personal',
          action: 'setAdminPermissions',
          target: '-1001',
          userId: 42,
        },
      ],
      [
        'setTitle requires a title',
        'social_manage_chat',
        {
          channel: 'telegram',
          accountId: 'personal',
          target: '-1001',
          action: 'setTitle',
        },
      ],
      [
        'setDescription requires a description',
        'social_manage_chat',
        {
          channel: 'telegram',
          accountId: 'personal',
          target: '-1001',
          action: 'setDescription',
        },
      ],
      [
        'setPhoto requires a media URL',
        'social_manage_chat',
        {
          channel: 'telegram',
          accountId: 'personal',
          target: '-1001',
          action: 'setPhoto',
        },
      ],
      [
        'setForumEnabled requires enabled',
        'social_manage_chat',
        {
          channel: 'telegram',
          accountId: 'personal',
          target: '-1001',
          action: 'setForumEnabled',
        },
      ],
      [
        'image publish requires imageUrl',
        'social_publish_content',
        { channel: 'instagram', accountId: 'skirmshop', kind: 'image' },
      ],
      [
        'carousel publish requires two items',
        'social_publish_content',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          kind: 'carousel',
          items: ['https://example.test/one.jpg'],
        },
      ],
      [
        'reel publish requires videoUrl',
        'social_publish_content',
        { channel: 'instagram', accountId: 'skirmshop', kind: 'reel' },
      ],
      [
        'story publish requires imageUrl or videoUrl',
        'social_publish_content',
        { channel: 'instagram', accountId: 'skirmshop', kind: 'story' },
      ],
      [
        'comment creation requires a message',
        'social_manage_comment',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          target: 'media-1',
          action: 'create',
        },
      ],
      [
        'comment reply requires a message',
        'social_manage_comment',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          target: 'comment-1',
          action: 'reply',
        },
      ],
      [
        'context summary requires target and messageId',
        'social_summarize',
        {
          channel: 'whatsapp',
          accountId: 'personal',
          range: 'context',
          target: '34600000000@s.whatsapp.net',
        },
      ],
      [
        'day summary requires date',
        'social_summarize',
        { channel: 'whatsapp', accountId: 'personal', range: 'day' },
      ],
      [
        'week summary requires weekStart',
        'social_summarize',
        { channel: 'telegram', accountId: 'personal', range: 'week' },
      ],
      [
        'conversation summary requires target',
        'social_summarize',
        { channel: 'telegram', accountId: 'personal', range: 'conversation' },
      ],
      [
        'attachments require a valid URL',
        'social_send_message',
        {
          channel: 'telegram',
          accountId: 'personal',
          target: '-1001',
          attachments: [{ url: 'not a URL' }],
        },
      ],
      [
        'unknown properties are rejected',
        'social_send_message',
        {
          channel: 'whatsapp',
          accountId: 'personal',
          target: '34600000000@s.whatsapp.net',
          message: 'hola',
          live: true,
        },
      ],
    ];

    test.each(invalidCases)('%s', (_label, toolName, args) => {
      const server = createServer();
      expect(() =>
        server.validateCanonicalArguments(definition(toolName), args)
      ).toThrow();
    });

    test.each([
      [
        'message send accepts the documented empty attachments array',
        'social_send_message',
        {
          channel: 'telegram',
          accountId: 'personal',
          target: '-1001',
          message: 'hola',
          attachments: [],
        },
      ],
      [
        'summary defaults to conversation without requiring day/week fields',
        'social_summarize',
        {
          channel: 'whatsapp',
          accountId: 'personal',
          target: '34600000000@s.whatsapp.net',
        },
      ],
      [
        'insights default to account without requiring a media target',
        'social_get_insights',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
        },
      ],
    ])('%s', (_label, toolName, args) => {
      const server = createServer();
      expect(() =>
        server.validateCanonicalArguments(definition(toolName), args)
      ).not.toThrow();
    });
  });

  describe('account validation and isolation', () => {
    const unknownAccounts: Array<[string, string]> = [
      ['whatsapp', 'skirmshop'],
      ['telegram', 'barbelpapis'],
      ['instagram', 'personal'],
      ['telegram', 'does-not-exist'],
    ];

    test.each(unknownAccounts)(
      'rejects account %s/%s before calling a provider',
      async (channel, accountId) => {
        const server = createServer();
        server.handleSendMessage = jest.fn(async () => legacy({ sent: true }));
        server.handleTelegramSendMessage = jest.fn(async () => legacy({ sent: true }));
        server.handleInstagramSendDm = jest.fn(async () => legacy({ sent: true }));

        const result = await server.executeCanonicalTool(
          definition('social_send_message'),
          {
            channel,
            accountId,
            target: '12345',
            message: 'hola',
          }
        );

        expectStructuredError(result, 'unsupported_capability');
        expect(server.handleSendMessage).not.toHaveBeenCalled();
        expect(server.handleTelegramSendMessage).not.toHaveBeenCalled();
        expect(server.handleInstagramSendDm).not.toHaveBeenCalled();
      }
    );

    test('rejects an unknown account selector on aggregate reads', async () => {
      const server = createServer();
      server.providerGet = jest.fn(async () => ({ dialogs: [] }));

      const result = await server.executeCanonicalTool(
        definition('social_list_conversations'),
        {
          channel: 'telegram',
          accountId: 'does-not-exist',
          readSource: 'provider',
        }
      );

      expectStructuredError(result, 'unsupported_capability');
      expect(server.providerGet).not.toHaveBeenCalled();
    });

    test('namespaces WhatsApp drafts by account before persistence', async () => {
      const server = createServer();
      server.handleDraftReply = jest.fn(async (args: unknown) => legacy(args));

      await server.executeCanonicalTool(definition('social_create_draft'), {
        channel: 'whatsapp',
        accountId: 'personal',
        target: '34600000000@s.whatsapp.net',
      });
      await server.executeCanonicalTool(definition('social_create_draft'), {
        channel: 'whatsapp',
        accountId: 'professional',
        target: '34600000000@s.whatsapp.net',
      });

      expect(server.handleDraftReply).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ chatId: '34600000000@s.whatsapp.net' })
      );
      expect(server.handleDraftReply).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          chatId: 'professional:34600000000@s.whatsapp.net',
        })
      );
    });

    test('does not approve a draft through another account selector', async () => {
      const server = createServer();
      server.draftService = {
        getDraftById: jest.fn(async () => ({
          id: 'draft-1',
          conversationId: 'professional:34600000000@s.whatsapp.net',
        })),
      };
      server.handleApproveDraft = jest.fn(async () => legacy({ approved: true }));

      const result = await server.executeCanonicalTool(
        definition('social_approve_draft'),
        {
          channel: 'whatsapp',
          accountId: 'personal',
          draftId: 'draft-1',
        }
      );

      expectStructuredError(result, 'not_found');
      expect(server.handleApproveDraft).not.toHaveBeenCalled();
    });

    test('does not read a digest through another account selector', async () => {
      const server = createServer();
      server.unreadDigestService = {
        status: jest.fn(async () => ({
          id: 'digest-1',
          account: 'professional',
          platforms: ['telegram'],
        })),
      };

      const result = await server.executeCanonicalTool(
        definition('social_get_digest'),
        {
          channel: 'telegram',
          accountId: 'personal',
          digestId: 'digest-1',
        }
      );

      expectStructuredError(result, 'not_found');
    });

    test('passes account and channel filters to day summaries', async () => {
      const server = createServer();
      server.handleSummarizeDay = jest.fn(async (args: unknown) => legacy(args));

      await server.executeCanonicalTool(definition('social_summarize'), {
        channel: 'whatsapp',
        accountId: 'professional',
        range: 'day',
        date: '2026-07-27',
      });
      await server.executeCanonicalTool(definition('social_summarize'), {
        channel: 'telegram',
        accountId: 'personal',
        range: 'day',
        date: '2026-07-27',
      });

      expect(server.handleSummarizeDay).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          account: 'professional',
          platform: 'whatsapp',
        })
      );
      expect(server.handleSummarizeDay).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          account: 'personal',
          platform: 'telegram',
        })
      );
    });
  });

  describe('send replies, threads and attachments', () => {
    test('routes WhatsApp text and media replies independently of Telegram threads', async () => {
      const server = createServer();
      server.handleSendMessage = jest.fn(async (args: unknown) => legacy(args));
      server.handleSendFile = jest.fn(async (args: unknown) => legacy(args));

      const result = await server.executeCanonicalTool(
        definition('social_send_message'),
        {
          channel: 'whatsapp',
          accountId: 'professional',
          target: '34600000000@s.whatsapp.net',
          message: 'texto',
          attachments: [
            {
              url: 'https://example.test/photo.jpg',
              caption: 'foto',
            },
          ],
          replyTo: 71,
        }
      );

      expect(result.structuredContent).toMatchObject({
        ok: true,
        status: 'accepted',
      });
      expect(server.handleSendMessage).toHaveBeenCalledWith({
        chatId: '34600000000@s.whatsapp.net',
        text: 'texto',
        account: 'professional',
        replyTo: '71',
      });
      expect(server.handleSendFile).toHaveBeenCalledWith({
        conversationId: '34600000000@s.whatsapp.net',
        fileUrl: 'https://example.test/photo.jpg',
        caption: 'foto',
        account: 'professional',
        replyTo: '71',
      });
    });

    test('routes Telegram replyTo and threadId to both text and attachment operations', async () => {
      const server = createServer();
      server.handleTelegramSendMessage = jest.fn(async (args: unknown) => legacy(args));
      server.handleTelegramSendFile = jest.fn(async (args: unknown) => legacy(args));

      const result = await server.executeCanonicalTool(
        definition('social_send_message'),
        {
          channel: 'telegram',
          accountId: 'personal',
          target: '-100123456',
          message: 'texto',
          attachments: [
            {
              url: 'https://example.test/document.pdf',
              caption: 'documento',
            },
          ],
          replyTo: 22,
          threadId: 77,
        }
      );

      expect(result.structuredContent).toMatchObject({
        ok: true,
        status: 'accepted',
      });
      expect(server.handleTelegramSendMessage).toHaveBeenCalledWith({
        chatId: '-100123456',
        text: 'texto',
        account: 'personal',
        topicId: 77,
        replyTo: 22,
      });
      expect(server.handleTelegramSendFile).toHaveBeenCalledWith({
        chatId: '-100123456',
        filePath: 'https://example.test/document.pdf',
        caption: 'documento',
        account: 'personal',
        replyTo: 22,
        threadId: 77,
      });
    });

    const unsupportedSendShapes: Array<
      [string, Record<string, unknown>]
    > = [
      [
        'WhatsApp thread',
        {
          channel: 'whatsapp',
          accountId: 'personal',
          target: '34600000000@s.whatsapp.net',
          message: 'hola',
          threadId: '77',
        },
      ],
      [
        'Instagram reply',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          target: '1789',
          message: 'hola',
          replyTo: '22',
        },
      ],
      [
        'Instagram thread',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          target: '1789',
          message: 'hola',
          threadId: '77',
        },
      ],
      [
        'Instagram DM attachment',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          target: '1789',
          attachments: [{ url: 'https://example.test/photo.jpg' }],
        },
      ],
    ];

    test.each(unsupportedSendShapes)(
      'returns a structured unsupported error for %s',
      async (_label, args) => {
        const server = createServer();
        server.handleSendMessage = jest.fn(async () => legacy({ sent: true }));
        server.handleInstagramSendDm = jest.fn(async () => legacy({ sent: true }));

        const result = await server.executeCanonicalTool(
          definition('social_send_message'),
          args
        );

        expectStructuredError(result, 'unsupported_capability');
        expect(server.handleSendMessage).not.toHaveBeenCalled();
        expect(server.handleInstagramSendDm).not.toHaveBeenCalled();
      }
    );

    test('reports outcome_unknown if a later attachment fails after text was accepted', async () => {
      const server = createServer();
      server.handleTelegramSendMessage = jest.fn(async () =>
        legacy({ messageId: 'accepted-text' })
      );
      server.handleTelegramSendFile = jest.fn(async () => {
        throw new Error('media provider failed');
      });

      const result = await server.executeCanonicalTool(
        definition('social_send_message'),
        {
          channel: 'telegram',
          accountId: 'personal',
          target: '-100123456',
          message: 'texto',
          attachments: [{ url: 'https://example.test/document.pdf' }],
        }
      );

      expectStructuredError(result, 'outcome_unknown');
      expect(result.structuredContent.error.message).toContain(
        'accepted 1 sub-operation'
      );
    });
  });

  describe('complete Telegram forum action matrix', () => {
    const topicCases: Array<
      [
        string,
        string,
        Record<string, unknown>,
        Record<string, unknown>,
      ]
    > = [
      [
        'createTopic',
        'handleTelegramCreateTopic',
        { target: '-1001', title: 'Operations', icon: 7 },
        {
          chatId: '-1001',
          account: 'professional',
          topicId: undefined,
          title: 'Operations',
          icon: 7,
        },
      ],
      [
        'editTopic',
        'handleTelegramEditTopic',
        {
          target: '-1001',
          threadId: 11,
          title: 'Renamed',
          hidden: false,
          clearIcon: true,
        },
        {
          chatId: '-1001',
          account: 'professional',
          topicId: 11,
          title: 'Renamed',
          hidden: false,
          clearIcon: true,
        },
      ],
      [
        'closeTopic',
        'handleTelegramToggleTopicClosed',
        { target: '-1001', threadId: 11 },
        {
          chatId: '-1001',
          account: 'professional',
          topicId: 11,
          closed: true,
        },
      ],
      [
        'reopenTopic',
        'handleTelegramToggleTopicClosed',
        { target: '-1001', threadId: 11 },
        {
          chatId: '-1001',
          account: 'professional',
          topicId: 11,
          closed: false,
        },
      ],
      [
        'pinTopic',
        'handleTelegramToggleTopicPinned',
        { target: '-1001', threadId: 11 },
        {
          chatId: '-1001',
          account: 'professional',
          topicId: 11,
          pinned: true,
        },
      ],
      [
        'unpinTopic',
        'handleTelegramToggleTopicPinned',
        { target: '-1001', threadId: 11 },
        {
          chatId: '-1001',
          account: 'professional',
          topicId: 11,
          pinned: false,
        },
      ],
      [
        'deleteTopic',
        'handleTelegramDeleteTopic',
        { target: '-1001', threadId: 11 },
        {
          chatId: '-1001',
          account: 'professional',
          topicId: 11,
        },
      ],
    ];

    test.each(topicCases)(
      '%s routes to %s',
      async (action, handler, extraArgs, expected) => {
        const server = createServer();
        server[handler] = jest.fn(async (args: unknown) => legacy(args));

        const result = await server.executeCanonicalTool(
          definition('social_manage_forum'),
          {
            channel: 'telegram',
            accountId: 'professional',
            action,
            ...extraArgs,
          }
        );

        expect(result.structuredContent).toMatchObject({
          ok: true,
          status: 'accepted',
        });
        expect(server[handler]).toHaveBeenCalledWith(expected);
      }
    );

    const groupCases: Array<
      [
        string,
        Record<string, unknown>,
        string,
        string,
        Record<string, unknown>,
      ]
    > = [
      [
        'createGroup',
        {
          title: 'Operations',
          groupType: 'supergroup',
          description: 'Team',
          forum: true,
          members: ['@alice', 42],
        },
        'POST',
        '/api/v1/groups',
        {
          title: 'Operations',
          type: 'supergroup',
          description: 'Team',
          forum: true,
          members: ['@alice', 42],
        },
      ],
      [
        'addMembers',
        {
          target: '-1001',
          members: ['@alice', 42],
          forwardCount: 5,
        },
        'POST',
        '/api/v1/chats/-1001/members',
        {
          members: ['@alice', 42],
          forwardCount: 5,
        },
      ],
      [
        'setAdminPermissions',
        {
          target: '-1001',
          userId: 42,
          rights: { deleteMessages: true, banUsers: false },
          rank: 'Moderator',
        },
        'PUT',
        '/api/v1/chats/-1001/admins/42',
        {
          rights: { deleteMessages: true, banUsers: false },
          rank: 'Moderator',
        },
      ],
    ];

    test.each(groupCases)(
      '%s routes to the Telegram connector',
      async (action, extraArgs, method, path, body) => {
        const server = createServer();
        server.connectorCall = jest.fn(async () => ({ ok: true }));

        const result = await server.executeCanonicalTool(
          definition('social_manage_forum'),
          {
            channel: 'telegram',
            accountId: 'professional',
            action,
            ...extraArgs,
          }
        );

        expect(result.structuredContent).toMatchObject({
          ok: true,
          status: 'accepted',
        });
        expect(server.connectorCall).toHaveBeenCalledWith(
          'http://tg-professional',
          method,
          path,
          body
        );
      }
    );
  });

  describe('complete Telegram chat action matrix', () => {
    const chatCases: Array<
      [
        string,
        string,
        Record<string, unknown>,
        Record<string, unknown>,
      ]
    > = [
      [
        'setTitle',
        'handleTelegramSetChatTitle',
        { title: 'New title' },
        {
          chatId: '-1001',
          account: 'personal',
          title: 'New title',
        },
      ],
      [
        'setDescription',
        'handleTelegramSetChatDescription',
        { description: '' },
        {
          chatId: '-1001',
          account: 'personal',
          description: '',
        },
      ],
      [
        'setPhoto',
        'handleTelegramSetChatPhoto',
        { mediaUrl: 'https://example.test/photo.jpg' },
        {
          chatId: '-1001',
          account: 'personal',
          filePath: 'https://example.test/photo.jpg',
        },
      ],
      [
        'setForumEnabled',
        'handleTelegramUpdateForumSettings',
        { enabled: false },
        {
          chatId: '-1001',
          account: 'personal',
          isForum: false,
        },
      ],
    ];

    test.each(chatCases)(
      '%s routes to %s',
      async (action, handler, extraArgs, expected) => {
        const server = createServer();
        server[handler] = jest.fn(async (args: unknown) => legacy(args));

        const result = await server.executeCanonicalTool(
          definition('social_manage_chat'),
          {
            channel: 'telegram',
            accountId: 'personal',
            target: '-1001',
            action,
            ...extraArgs,
          }
        );

        expect(result.structuredContent).toMatchObject({
          ok: true,
          status: 'accepted',
        });
        expect(server[handler]).toHaveBeenCalledWith(expected);
      }
    );
  });

  describe('unsupported read sources and structured errors', () => {
    const sourceCases: Array<
      [string, Record<string, unknown>]
    > = [
      [
        'social_list_conversations',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          readSource: 'index',
        },
      ],
      [
        'social_get_conversation',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          target: 'conversation-1',
          readSource: 'index',
        },
      ],
      [
        'social_list_participants',
        {
          channel: 'whatsapp',
          accountId: 'personal',
          target: '120363000@g.us',
          readSource: 'index',
        },
      ],
      [
        'social_list_messages',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          target: 'conversation-1',
          readSource: 'index',
        },
      ],
      [
        'social_search_messages',
        { query: 'hola', readSource: 'provider' },
      ],
      [
        'social_resolve_target',
        {
          channel: 'telegram',
          accountId: 'personal',
          query: 'alice',
          readSource: 'index',
        },
      ],
      [
        'social_get_media',
        {
          channel: 'telegram',
          accountId: 'personal',
          target: '-1001',
          messageId: '22',
          readSource: 'index',
        },
      ],
      [
        'social_summarize',
        {
          channel: 'whatsapp',
          accountId: 'personal',
          target: '34600000000@s.whatsapp.net',
          readSource: 'provider',
        },
      ],
      [
        'social_list_drafts',
        {
          channel: 'whatsapp',
          accountId: 'personal',
          target: '34600000000@s.whatsapp.net',
          readSource: 'provider',
        },
      ],
      [
        'social_get_digest',
        {
          channel: 'telegram',
          accountId: 'personal',
          digestId: 'digest-1',
          readSource: 'provider',
        },
      ],
      [
        'social_get_profile',
        {
          channel: 'telegram',
          accountId: 'personal',
          readSource: 'index',
        },
      ],
      [
        'social_list_content',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          readSource: 'index',
        },
      ],
      [
        'social_list_comments',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          target: 'media-1',
          readSource: 'index',
        },
      ],
      [
        'social_get_insights',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          readSource: 'index',
        },
      ],
      [
        'social_discover_business',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          query: 'openclaw',
          readSource: 'index',
        },
      ],
      [
        'social_list_mentions',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          readSource: 'index',
        },
      ],
      [
        'social_validate_account',
        {
          channel: 'instagram',
          accountId: 'skirmshop',
          readSource: 'index',
        },
      ],
      [
        'social_get_forum',
        {
          channel: 'telegram',
          accountId: 'personal',
          target: '-1001',
          readSource: 'index',
        },
      ],
    ];

    test.each(sourceCases)(
      '%s reports unsupported_capability instead of a silent empty result',
      async (toolName, args) => {
        const server = createServer();
        const result = await server.executeCanonicalTool(
          definition(toolName),
          args
        );
        expectStructuredError(result, 'unsupported_capability');
      }
    );

    test('provider exceptions retain a single structured error representation', async () => {
      const server = createServer();
      server.handleTelegramGetTopics = jest.fn(async () => {
        throw new Error('provider exploded');
      });

      const result = await server.executeCanonicalTool(
        definition('social_get_forum'),
        {
          channel: 'telegram',
          accountId: 'personal',
          target: '-1001',
          readSource: 'provider',
        }
      );

      expectStructuredError(result, 'provider_error');
      expect(result.structuredContent.error.message).toBe('provider exploded');
      expect(result.content[0].text).not.toBe('failed');
    });
  });

  describe('provider boundary and idempotency durability', () => {
    test('sends a professional draft with a bare provider JID', async () => {
      const server = createServer();
      const draft = {
        id: '42',
        conversationId: 'professional:34600000000@s.whatsapp.net',
        content: 'respuesta',
        tone: 'casual',
        status: 'APPROVED',
        approvedAt: new Date(),
        sentAt: null,
        createdAt: new Date(),
      };
      server.draftService = {
        getDraftById: jest.fn(async () => draft),
        markAsSent: jest.fn(async () => undefined),
      };
      const previousFetch = global.fetch;
      const previousEnableSending = process.env.ENABLE_SENDING;
      const previousEmergency = process.env.EMERGENCY_DISABLE_SENDING;
      const fetchMock = jest.fn(async (_input: any, _init?: RequestInit) => ({
        ok: true,
        json: async () => ({ messageId: 'wa-1' }),
      }));
      global.fetch = fetchMock as any;
      process.env.ENABLE_SENDING = 'true';
      process.env.EMERGENCY_DISABLE_SENDING = 'false';

      try {
        await server.handleSendApprovedReply({
          sendToken: 'send-42-123456',
          account: 'professional',
        });
      } finally {
        global.fetch = previousFetch;
        if (previousEnableSending === undefined) delete process.env.ENABLE_SENDING;
        else process.env.ENABLE_SENDING = previousEnableSending;
        if (previousEmergency === undefined) {
          delete process.env.EMERGENCY_DISABLE_SENDING;
        } else {
          process.env.EMERGENCY_DISABLE_SENDING = previousEmergency;
        }
      }

      const request = fetchMock.mock.calls[0]?.[1];
      expect(request).toBeDefined();
      expect(JSON.parse(String(request?.body))).toMatchObject({
        conversationId: '34600000000@s.whatsapp.net',
        content: 'respuesta',
      });
      expect(server.draftService.markAsSent).toHaveBeenCalledWith('42');
    });

    test('returns outcome_unknown when a successful mutation cannot persist its idempotency result', async () => {
      const server = createServer();
      let sets = 0;
      server.redisClient = {
        get: jest.fn(async () => null),
        set: jest.fn(async () => {
          sets += 1;
          if (sets === 1) return 'OK';
          throw new Error('redis unavailable');
        }),
      };
      server.handleSendMessage = jest.fn(async () =>
        legacy({ accepted: true, messageId: 'wa-1' })
      );

      const result = await server.executeCanonicalTool(
        definition('social_send_message'),
        {
          channel: 'whatsapp',
          accountId: 'personal',
          target: '34600000000@s.whatsapp.net',
          message: 'hola',
          idempotencyKey: 'send-durability-1',
        }
      );

      expectStructuredError(result, 'outcome_unknown');
      expect(result.structuredContent.error.message).toContain(
        'idempotency result could not be persisted'
      );
      expect(server.handleSendMessage).toHaveBeenCalledTimes(1);
    });
  });
});
