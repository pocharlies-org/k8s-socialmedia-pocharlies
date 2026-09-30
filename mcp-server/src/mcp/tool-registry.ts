export type SocialChannel = 'whatsapp' | 'telegram' | 'instagram';
export type SocialEffect = 'read' | 'compute' | 'internalWrite' | 'externalWrite' | 'destructive';
export type SocialAuthScope = 'social.read' | 'social.write';

type JsonSchema = Record<string, unknown>;

export interface SocialToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  effect: SocialEffect;
  authScope: SocialAuthScope;
  capability: string;
  handler: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const channel = {
  type: 'string',
  enum: ['whatsapp', 'telegram', 'instagram'],
  description: 'Provider channel. Numeric targets never imply a channel.',
} as const;

const accountId = {
  type: 'string',
  minLength: 1,
  description:
    "Configured provider account, for example 'personal', 'professional' or 'leila' " +
    '(WhatsApp), ' +
    "'skirmshop'/'barbelpapis' (Instagram). With SOCIAL_IDENTITY_BINDING=on it must be " +
    'bound to the verified caller.',
} as const;

const target = {
  type: 'string',
  minLength: 1,
  description: 'Provider-native peer, group, conversation or media target.',
} as const;

const readSource = {
  type: 'string',
  enum: ['auto', 'provider', 'index'],
  default: 'auto',
} as const;

const commonProperties = { channel, accountId, target };
const writeProperties = {
  ...commonProperties,
  idempotencyKey: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    description: 'Replay key. Reusing it with a different payload returns conflict.',
  },
};

const attachment = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      description:
        'Media reference the CONNECTOR fetches server-side with a plain HTTP fetch before ' +
        'uploading to the provider. MUST be an http(s) URL reachable from the connector pod ' +
        '(it runs inside the cluster). Supported: public https URLs, cluster-internal http ' +
        'URLs, and presigned S3/MinIO http URLs (e.g. from the skirmshop-drive bucket the ' +
        'connector itself has credentials for). NOT supported — the fetch throws ' +
        '"Failed to fetch file from <url>": file:// paths, s3:// URIs (the connector is not ' +
        'an S3 client; s3:// only appears in READ results because ingestion presigns them), ' +
        'and internal hosts that resolve to nothing (labels.local-style). The response ' +
        'Content-Type decides the WhatsApp message type: image/* → photo, video/* → video, ' +
        'audio/* → audio, anything else → document (fileName taken from the URL last path ' +
        'segment, so prefer URLs ending in the real filename). Telegram fetches http(s) ' +
        'connector-side too; non-http paths pass through and fail for cluster-internal URLs.',
    },
    name: { type: 'string' },
    mimeType: { type: 'string' },
    caption: { type: 'string' },
  },
  required: ['url'],
} as const;

const sourceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'asOf', 'completeness'],
  properties: {
    kind: { type: 'string', enum: ['providerQuery', 'providerSync', 'localIndex'] },
    asOf: { type: 'string', format: 'date-time' },
    completeness: { type: 'string', enum: ['complete', 'partial', 'unknown'] },
  },
} as const;

const outputSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'status', 'data', 'meta'],
  properties: {
    ok: { type: 'boolean' },
    status: {
      type: 'string',
      enum: ['completed', 'accepted', 'delivered', 'read', 'conflict', 'outcome_unknown', 'failed'],
    },
    data: {},
    meta: {
      type: 'object',
      additionalProperties: true,
      properties: {
        source: sourceSchema,
        replayed: { type: 'boolean' },
        partialErrors: {
          type: 'array',
          items: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              channel: channel,
              accountId: accountId,
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    error: {
      type: 'object',
      additionalProperties: true,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {},
      },
    },
  },
};

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
  constraints: Record<string, unknown> = {}
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
    ...constraints,
  };
}

function tool(
  args: Omit<SocialToolDefinition, 'outputSchema' | 'annotations'> & {
    idempotent?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
  }
): SocialToolDefinition {
  const {
    idempotent = false,
    destructive = args.effect === 'destructive',
    openWorld = true,
    ...definition
  } = args;
  return {
    ...definition,
    outputSchema,
    annotations: {
      readOnlyHint: definition.effect === 'read' || definition.effect === 'compute',
      destructiveHint: destructive,
      idempotentHint: idempotent,
      openWorldHint: openWorld,
    },
  };
}

export const SOCIAL_TOOL_REGISTRY: readonly SocialToolDefinition[] = [
  tool({
    name: 'social_list_accounts',
    title: 'List social accounts',
    description:
      'List configured provider accounts, transports and capabilities actually deployed.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'accounts.list',
    handler: 'listAccounts',
    inputSchema: objectSchema({ channel }),
    idempotent: true,
    openWorld: false,
  }),
  tool({
    name: 'social_list_conversations',
    title: 'List conversations',
    description:
      'List conversations from one channel/account or aggregate explicitly reported partial results.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'conversations.list',
    handler: 'listConversations',
    inputSchema: objectSchema({
      channel,
      accountId,
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      readSource,
    }),
    idempotent: true,
  }),
  tool({
    name: 'social_get_conversation',
    title: 'Get conversation',
    description: 'Get one provider conversation and its current metadata.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'conversations.get',
    handler: 'getConversation',
    inputSchema: objectSchema({ ...commonProperties, readSource }, [
      'channel',
      'accountId',
      'target',
    ]),
    idempotent: true,
  }),
  tool({
    name: 'social_list_participants',
    title: 'List participants',
    description:
      'List participants of a group or conversation when supported by the selected provider.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'participants.list',
    handler: 'listParticipants',
    inputSchema: objectSchema(
      {
        ...commonProperties,
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        readSource,
      },
      ['channel', 'accountId', 'target']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_list_messages',
    title: 'List messages',
    description: 'List messages in a conversation with explicit provider/index provenance.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'messages.list',
    handler: 'listMessages',
    inputSchema: objectSchema(
      {
        ...commonProperties,
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        before: { type: ['string', 'integer'] },
        after: { type: ['string', 'integer'] },
        readSource,
      },
      ['channel', 'accountId', 'target']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_search_messages',
    title: 'Search messages',
    description:
      'Search indexed or provider messages without inferring a channel from target shape.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'messages.search',
    handler: 'searchMessages',
    inputSchema: objectSchema(
      {
        ...commonProperties,
        query: { type: 'string', minLength: 1 },
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
        sender: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        readSource,
      },
      ['query'],
      {
        allOf: [
          {
            if: { required: ['channel'] },
            then: { required: ['accountId'] },
          },
          {
            if: { required: ['accountId'] },
            then: { required: ['channel'] },
          },
        ],
      }
    ),
    idempotent: true,
    openWorld: false,
  }),
  tool({
    name: 'social_resolve_target',
    title: 'Resolve target',
    description:
      'Resolve a name, username or address to provider-native targets usable by send operations.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'targets.resolve',
    handler: 'resolveTarget',
    inputSchema: objectSchema(
      {
        channel,
        accountId,
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        readSource,
      },
      ['channel', 'accountId', 'query']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_get_media',
    title: 'Get message media',
    description: 'Retrieve media attached to a provider message.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'media.get',
    handler: 'getMedia',
    inputSchema: objectSchema(
      {
        ...commonProperties,
        messageId: { type: 'string', minLength: 1 },
        readSource,
      },
      ['channel', 'accountId', 'target', 'messageId']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_summarize',
    title: 'Summarize conversation',
    description: 'Compute a conversation, day, week or context summary from indexed messages.',
    effect: 'compute',
    authScope: 'social.read',
    capability: 'conversations.summarize',
    handler: 'summarize',
    inputSchema: objectSchema(
      {
        ...commonProperties,
        range: {
          type: 'string',
          enum: ['conversation', 'context', 'day', 'week'],
          default: 'conversation',
        },
        date: { type: 'string', format: 'date' },
        weekStart: { type: 'string', format: 'date' },
        messageId: { type: 'string' },
        lastN: { type: 'integer', minimum: 1, maximum: 500 },
        language: { type: 'string', enum: ['en', 'es'] },
        readSource,
      },
      ['channel', 'accountId'],
      {
        allOf: [
          {
            if: {
              required: ['range'],
              properties: { range: { const: 'context' } },
            },
            then: { required: ['target', 'messageId'] },
          },
          {
            if: {
              required: ['range'],
              properties: { range: { const: 'day' } },
            },
            then: { required: ['date'] },
          },
          {
            if: {
              required: ['range'],
              properties: { range: { const: 'week' } },
            },
            then: { required: ['weekStart'] },
          },
          {
            if: {
              anyOf: [
                { not: { required: ['range'] } },
                { properties: { range: { const: 'conversation' } } },
              ],
            },
            then: { required: ['target'] },
          },
        ],
      }
    ),
    idempotent: true,
    openWorld: false,
  }),
  tool({
    name: 'social_list_drafts',
    title: 'List drafts',
    description: 'List persisted reply drafts for a conversation.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'drafts.list',
    handler: 'listDrafts',
    inputSchema: objectSchema(
      {
        ...commonProperties,
        status: { type: 'string', enum: ['DRAFT', 'APPROVED', 'SENT'] },
        readSource,
      },
      ['channel', 'accountId', 'target']
    ),
    idempotent: true,
    openWorld: false,
  }),
  tool({
    name: 'social_get_digest',
    title: 'Get unread digest',
    description: 'Read the current state and result of an unread digest.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'digests.get',
    handler: 'getDigest',
    inputSchema: objectSchema(
      {
        channel,
        accountId,
        digestId: { type: 'string', minLength: 1 },
        readSource,
      },
      ['channel', 'accountId', 'digestId']
    ),
    idempotent: true,
    openWorld: false,
  }),
  tool({
    name: 'social_get_profile',
    title: 'Get account profile',
    description: 'Get the selected provider account profile.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'profiles.get',
    handler: 'getProfile',
    inputSchema: objectSchema({ channel, accountId, readSource }, ['channel', 'accountId']),
    idempotent: true,
  }),
  tool({
    name: 'social_list_content',
    title: 'List published content',
    description: 'List Instagram media or stories for an account.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'content.list',
    handler: 'listContent',
    inputSchema: objectSchema(
      {
        channel,
        accountId,
        kind: { type: 'string', enum: ['media', 'stories'], default: 'media' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        readSource,
      },
      ['channel', 'accountId']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_list_comments',
    title: 'List comments',
    description: 'List comments for Instagram media.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'comments.list',
    handler: 'listComments',
    inputSchema: objectSchema({ channel, accountId, target, readSource }, [
      'channel',
      'accountId',
      'target',
    ]),
    idempotent: true,
  }),
  tool({
    name: 'social_get_insights',
    title: 'Get insights',
    description: 'Get Instagram account or media insights and publishing limits.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'insights.get',
    handler: 'getInsights',
    inputSchema: objectSchema(
      {
        channel,
        accountId,
        target,
        kind: { type: 'string', enum: ['account', 'media', 'publishingLimit'], default: 'account' },
        metrics: { type: 'array', items: { type: 'string' } },
        period: { type: 'string' },
        readSource,
      },
      ['channel', 'accountId'],
      {
        allOf: [
          {
            if: {
              required: ['kind'],
              properties: { kind: { const: 'media' } },
            },
            then: { required: ['target'] },
          },
        ],
      }
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_discover_business',
    title: 'Discover Instagram business',
    description: 'Discover an Instagram business or hashtag and its media.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'business.discover',
    handler: 'discoverBusiness',
    inputSchema: objectSchema(
      {
        channel,
        accountId,
        query: { type: 'string', minLength: 1 },
        kind: {
          type: 'string',
          enum: ['business', 'hashtag', 'hashtagMedia'],
          default: 'business',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        readSource,
      },
      ['channel', 'accountId', 'query']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_list_mentions',
    title: 'List mentions',
    description: 'List recent Instagram mentions.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'mentions.list',
    handler: 'listMentions',
    inputSchema: objectSchema(
      {
        channel,
        accountId,
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        readSource,
      },
      ['channel', 'accountId']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_validate_account',
    title: 'Validate account',
    description: 'Validate provider credentials and report the account connection state.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'accounts.validate',
    handler: 'validateAccount',
    inputSchema: objectSchema({ channel, accountId, readSource }, ['channel', 'accountId']),
    idempotent: true,
  }),
  tool({
    name: 'social_get_forum',
    title: 'Get Telegram forum',
    description: 'List Telegram forum topics and their state.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'forums.get',
    handler: 'getForum',
    inputSchema: objectSchema(
      {
        ...commonProperties,
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
        readSource,
      },
      ['channel', 'accountId', 'target']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_send_message',
    title: 'Send message',
    description:
      'Send text, attachments, a native Telegram image album, a reply, a Telegram thread message or Instagram DM.',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'messages.send',
    handler: 'sendMessage',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        message: { type: 'string', minLength: 1 },
        attachments: {
          type: 'array',
          items: attachment,
          default: [],
        },
        mediaGroup: {
          type: 'boolean',
          default: false,
          description:
            'Telegram only. Send 2-10 image attachments as one native album with a shared media_group_id. When message is present it becomes the album caption.',
        },
        replyTo: { type: ['string', 'integer', 'null'] },
        threadId: { type: ['string', 'integer', 'null'] },
        template: {
          type: 'object',
          description:
            'Provider template payload; unsupported on deployed Baileys WhatsApp accounts.',
        },
      },
      ['channel', 'accountId', 'target'],
      {
        anyOf: [
          { required: ['message'] },
          {
            required: ['attachments'],
            properties: { attachments: { minItems: 1 } },
          },
          { required: ['template'] },
        ],
      }
    ),
  }),
  tool({
    name: 'social_forward_message',
    title: 'Forward message',
    description: 'Forward one provider message to a target on the same channel/account.',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'messages.forward',
    handler: 'forwardMessage',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        messageId: { type: 'string', minLength: 1 },
        fromTarget: { type: 'string', minLength: 1 },
        threadId: { type: ['string', 'integer', 'null'] },
      },
      ['channel', 'accountId', 'target', 'fromTarget', 'messageId']
    ),
  }),
  tool({
    name: 'social_delete_message',
    title: 'Delete message',
    description: 'Delete a provider message where supported.',
    effect: 'destructive',
    authScope: 'social.write',
    capability: 'messages.delete',
    handler: 'deleteMessage',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        messageId: { type: 'string', minLength: 1 },
      },
      ['channel', 'accountId', 'target', 'messageId']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_edit_message',
    title: 'Edit message',
    description:
      'Replace the text of one of our own sent text messages (WhatsApp and Telegram). ' +
      'The previous text is kept in the message history.',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'messages.edit',
    handler: 'editMessage',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        messageId: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1 },
      },
      ['channel', 'accountId', 'target', 'messageId', 'message']
    ),
    idempotent: true,
    destructive: true,
  }),
  tool({
    name: 'social_mark_read',
    title: 'Mark conversation read',
    description: 'Advance read state for a provider conversation or message.',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'messages.markRead',
    handler: 'markRead',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        messageId: { type: 'string' },
      },
      ['channel', 'accountId', 'target']
    ),
    idempotent: true,
    destructive: true,
  }),
  tool({
    name: 'social_create_draft',
    title: 'Create draft',
    description: 'Create a persisted AI-assisted reply draft.',
    effect: 'internalWrite',
    authScope: 'social.write',
    capability: 'drafts.create',
    handler: 'createDraft',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        messageId: { type: 'string' },
        lastN: { type: 'integer', minimum: 1, maximum: 500 },
        tone: { type: 'string', enum: ['professional', 'casual', 'friendly', 'formal'] },
        language: { type: 'string', enum: ['en', 'es'] },
        constraints: { type: 'object' },
      },
      ['channel', 'accountId', 'target']
    ),
    openWorld: false,
  }),
  tool({
    name: 'social_approve_draft',
    title: 'Approve draft',
    description: 'Approve a persisted draft and issue its send token.',
    effect: 'internalWrite',
    authScope: 'social.write',
    capability: 'drafts.approve',
    handler: 'approveDraft',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        draftId: { type: 'string', minLength: 1 },
      },
      ['channel', 'accountId', 'draftId']
    ),
    idempotent: true,
    destructive: true,
    openWorld: false,
  }),
  tool({
    name: 'social_send_draft',
    title: 'Send approved draft',
    description: 'Send a previously approved persisted draft.',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'drafts.send',
    handler: 'sendDraft',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        sendToken: { type: 'string', minLength: 1 },
      },
      ['channel', 'accountId', 'sendToken']
    ),
    destructive: true,
  }),
  tool({
    name: 'social_start_digest',
    title: 'Start unread digest',
    description: 'Create an unread digest checkpoint and process its first batch.',
    effect: 'internalWrite',
    authScope: 'social.read',
    capability: 'digests.start',
    handler: 'startDigest',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        channels: {
          type: 'array',
          items: channel,
          minItems: 1,
        },
        batchSize: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
        maxChats: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        messageLimit: { type: 'integer', minimum: 5, maximum: 100, default: 30 },
        language: { type: 'string', enum: ['en', 'es'], default: 'es' },
      },
      ['channel', 'accountId']
    ),
  }),
  tool({
    name: 'social_continue_digest',
    title: 'Continue unread digest',
    description: 'Advance an existing unread digest checkpoint.',
    effect: 'internalWrite',
    authScope: 'social.read',
    capability: 'digests.continue',
    handler: 'continueDigest',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        digestId: { type: 'string', minLength: 1 },
        batchSize: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
      },
      ['channel', 'accountId', 'digestId']
    ),
    destructive: true,
    openWorld: false,
  }),
  tool({
    name: 'social_manage_session',
    title: 'Manage provider session',
    description:
      'Renew a WhatsApp QR session, repair a WhatsApp group encryption session, or start ' +
      'Instagram pairing for the verified user (action=startPairing on channel=instagram ' +
      'returns the Instagram Login authorize link; it needs no accountId and only works when ' +
      'the call carries the gateway-verified user identity).',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'sessions.manage',
    handler: 'manageSession',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        action: { type: 'string', enum: ['renewQr', 'repairGroup', 'startPairing'] },
        confirmDisconnect: { type: 'boolean' },
      },
      ['channel', 'action'],
      {
        allOf: [
          {
            if: { properties: { action: { const: 'renewQr' } } },
            then: {
              required: ['accountId', 'confirmDisconnect'],
              properties: { confirmDisconnect: { const: true } },
            },
          },
          {
            if: { properties: { action: { const: 'repairGroup' } } },
            then: { required: ['accountId', 'target'] },
          },
          {
            if: { properties: { action: { const: 'startPairing' } } },
            then: { properties: { channel: { const: 'instagram' } } },
          },
        ],
      }
    ),
    destructive: true,
  }),
  tool({
    name: 'social_click_interaction',
    title: 'Click interaction',
    description: 'Press a Telegram message button.',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'interactions.click',
    handler: 'clickInteraction',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        messageId: { type: ['string', 'integer'] },
        data: {
          type: 'string',
          minLength: 1,
          description: 'Exact Telegram callback payload from the selected inline button.',
        },
        dataB64: {
          type: 'string',
          minLength: 1,
          description:
            "Button's dataB64 from social_list_messages, echoed back verbatim. Required for bots whose callback payload is binary (BotFather); takes precedence over data.",
        },
        threadId: { type: ['string', 'integer', 'null'] },
      },
      ['channel', 'accountId', 'target', 'messageId']
    ),
    destructive: true,
  }),
  tool({
    name: 'social_manage_forum',
    title: 'Manage Telegram forum',
    description:
      'Create, edit, close, pin or delete a Telegram topic, or manage group membership and permissions.',
    effect: 'destructive',
    authScope: 'social.write',
    capability: 'forums.manage',
    handler: 'manageForum',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        action: {
          type: 'string',
          enum: [
            'createTopic',
            'editTopic',
            'closeTopic',
            'reopenTopic',
            'pinTopic',
            'unpinTopic',
            'deleteTopic',
            'createGroup',
            'addMembers',
            'setAdminPermissions',
          ],
        },
        threadId: { type: ['string', 'integer', 'null'] },
        title: { type: 'string', minLength: 1 },
        icon: { type: 'integer' },
        hidden: { type: 'boolean' },
        clearIcon: { type: 'boolean' },
        groupType: { type: 'string', enum: ['group', 'supergroup', 'channel'] },
        description: { type: 'string' },
        forum: { type: 'boolean' },
        members: { type: 'array', items: { type: ['string', 'integer'] } },
        forwardCount: { type: 'integer', minimum: 0, maximum: 100 },
        userId: { type: ['string', 'integer'] },
        rights: { type: 'object', additionalProperties: { type: 'boolean' } },
        rank: { type: 'string' },
      },
      ['channel', 'accountId', 'action'],
      {
        allOf: [
          {
            if: {
              properties: {
                action: { enum: ['createTopic'] },
              },
            },
            then: { required: ['target', 'title'] },
          },
          {
            if: {
              properties: {
                action: { const: 'editTopic' },
              },
            },
            then: {
              required: ['target', 'threadId'],
              anyOf: [
                { required: ['title'] },
                { required: ['icon'] },
                { required: ['hidden'] },
                { required: ['clearIcon'] },
              ],
            },
          },
          {
            if: {
              properties: {
                action: {
                  enum: ['closeTopic', 'reopenTopic', 'pinTopic', 'unpinTopic', 'deleteTopic'],
                },
              },
            },
            then: { required: ['target', 'threadId'] },
          },
          {
            if: { properties: { action: { const: 'createGroup' } } },
            then: { required: ['title'] },
          },
          {
            if: { properties: { action: { const: 'addMembers' } } },
            then: {
              required: ['target', 'members'],
              properties: {
                members: {
                  type: 'array',
                  items: { type: ['string', 'integer'] },
                  minItems: 1,
                },
              },
            },
          },
          {
            if: { properties: { action: { const: 'setAdminPermissions' } } },
            then: { required: ['target', 'userId', 'rights'] },
          },
        ],
      }
    ),
  }),
  tool({
    name: 'social_manage_chat',
    title: 'Manage Telegram chat',
    description: 'Change Telegram title, description, photo or forum mode.',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'chats.manage',
    handler: 'manageChat',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        action: {
          type: 'string',
          enum: ['setTitle', 'setDescription', 'setPhoto', 'setForumEnabled'],
        },
        title: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        mediaUrl: { type: 'string', format: 'uri' },
        enabled: { type: 'boolean' },
      },
      ['channel', 'accountId', 'target', 'action'],
      {
        allOf: [
          {
            if: { properties: { action: { const: 'setTitle' } } },
            then: { required: ['title'] },
          },
          {
            if: { properties: { action: { const: 'setDescription' } } },
            then: { required: ['description'] },
          },
          {
            if: { properties: { action: { const: 'setPhoto' } } },
            then: { required: ['mediaUrl'] },
          },
          {
            if: { properties: { action: { const: 'setForumEnabled' } } },
            then: { required: ['enabled'] },
          },
        ],
      }
    ),
    destructive: true,
  }),
  tool({
    name: 'social_publish_content',
    title: 'Publish Instagram content',
    description: 'Publish an Instagram image, carousel, reel or story.',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'content.publish',
    handler: 'publishContent',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        kind: { type: 'string', enum: ['image', 'carousel', 'reel', 'story'] },
        caption: { type: 'string' },
        imageUrl: { type: 'string', format: 'uri' },
        videoUrl: { type: 'string', format: 'uri' },
        items: {
          type: 'array',
          items: { type: 'string', format: 'uri' },
          minItems: 2,
        },
        shareToFeed: { type: 'boolean' },
      },
      ['channel', 'accountId', 'kind'],
      {
        allOf: [
          {
            if: { properties: { kind: { const: 'image' } } },
            then: { required: ['imageUrl'] },
          },
          {
            if: { properties: { kind: { const: 'carousel' } } },
            then: { required: ['items'] },
          },
          {
            if: { properties: { kind: { const: 'reel' } } },
            then: { required: ['videoUrl'] },
          },
          {
            if: { properties: { kind: { const: 'story' } } },
            then: {
              anyOf: [{ required: ['imageUrl'] }, { required: ['videoUrl'] }],
            },
          },
        ],
      }
    ),
  }),
  tool({
    name: 'social_manage_comment',
    title: 'Manage Instagram comment',
    description: 'Create, reply to, hide, unhide or delete an Instagram comment.',
    effect: 'destructive',
    authScope: 'social.write',
    capability: 'comments.manage',
    handler: 'manageComment',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        action: { type: 'string', enum: ['create', 'reply', 'hide', 'unhide', 'delete'] },
        message: { type: 'string', minLength: 1 },
      },
      ['channel', 'accountId', 'target', 'action'],
      {
        allOf: [
          {
            if: { properties: { action: { enum: ['create', 'reply'] } } },
            then: { required: ['message'] },
          },
        ],
      }
    ),
  }),
  // Fase 3 WhatsApp capabilities. Every write goes through the connector's
  // gate (ENABLE_SENDING / EMERGENCY_DISABLE_SENDING); reads are not gated.
  tool({
    name: 'social_react_message',
    title: 'React to message',
    description:
      "Set or remove (emoji '') our reaction on a message (WhatsApp, Telegram). " +
      'A new reaction replaces the previous one.',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'messages.react',
    handler: 'reactMessage',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        messageId: { type: 'string', minLength: 1 },
        emoji: {
          type: 'string',
          maxLength: 32,
          description: "One emoji; '' removes our reaction.",
        },
      },
      ['channel', 'accountId', 'target', 'messageId', 'emoji']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_set_chat_state',
    title: 'Set chat state',
    description:
      'Archive, unarchive, pin, unpin, mute, unmute, mark read or mark unread a chat on ' +
      'the account (WhatsApp). mute without durationMs/muteUntil mutes always.',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'chats.state',
    handler: 'setChatState',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        action: {
          type: 'string',
          enum: [
            'archive',
            'unarchive',
            'pin',
            'unpin',
            'mute',
            'unmute',
            'markRead',
            'markUnread',
          ],
        },
        durationMs: {
          type: 'integer',
          minimum: 1,
          maximum: 31622400000,
          description: 'mute only: mute for this long from now (at most 366 days).',
        },
        muteUntil: {
          type: 'string',
          format: 'date-time',
          description: 'mute only: mute until this future time (at most 366 days away).',
        },
      },
      ['channel', 'accountId', 'target', 'action'],
      {
        not: { required: ['durationMs', 'muteUntil'] },
        allOf: [
          {
            if: { not: { properties: { action: { const: 'mute' } } } },
            then: {
              not: { anyOf: [{ required: ['durationMs'] }, { required: ['muteUntil'] }] },
            },
          },
        ],
      }
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_get_group',
    title: 'Get group',
    description:
      'Read a group: subject, description, settings, members and what this account may ' +
      'change in it (WhatsApp).',
    effect: 'read',
    authScope: 'social.read',
    capability: 'groups.get',
    handler: 'getGroup',
    inputSchema: objectSchema({ ...commonProperties, readSource }, [
      'channel',
      'accountId',
      'target',
    ]),
    idempotent: true,
  }),
  tool({
    name: 'social_manage_group',
    title: 'Manage group',
    description:
      'Create a group, change its subject, description or settings, or add, remove, ' +
      'promote or demote participants (WhatsApp). Members see every change.',
    effect: 'destructive',
    authScope: 'social.write',
    capability: 'groups.manage',
    handler: 'manageGroup',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        action: {
          type: 'string',
          enum: [
            'create',
            'update',
            'addParticipants',
            'removeParticipants',
            'promoteParticipants',
            'demoteParticipants',
          ],
        },
        subject: { type: 'string', minLength: 1, maxLength: 100 },
        description: {
          type: 'string',
          maxLength: 2048,
          description: "update only; '' removes the description.",
        },
        announce: { type: 'boolean', description: 'update only: only admins send messages.' },
        restrict: {
          type: 'boolean',
          description: 'update only: only admins edit subject, description and picture.',
        },
        participants: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: 50,
          description: 'Phone numbers or user jids (…@s.whatsapp.net, …@c.us, …@lid).',
        },
      },
      ['channel', 'accountId', 'action'],
      {
        allOf: [
          {
            if: { properties: { action: { const: 'create' } } },
            then: { required: ['subject', 'participants'] },
          },
          {
            if: { properties: { action: { const: 'update' } } },
            then: {
              required: ['target'],
              anyOf: [
                { required: ['subject'] },
                { required: ['description'] },
                { required: ['announce'] },
                { required: ['restrict'] },
              ],
            },
          },
          {
            if: {
              properties: {
                action: {
                  enum: [
                    'addParticipants',
                    'removeParticipants',
                    'promoteParticipants',
                    'demoteParticipants',
                  ],
                },
              },
            },
            then: { required: ['target', 'participants'] },
          },
        ],
      }
    ),
  }),
  tool({
    name: 'social_send_poll',
    title: 'Send poll',
    description: 'Send a poll to a chat (WhatsApp).',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'polls.send',
    handler: 'sendPoll',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        question: { type: 'string', minLength: 1, maxLength: 255 },
        options: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 100 },
          minItems: 2,
          maxItems: 12,
          uniqueItems: true,
        },
        selectableCount: {
          type: 'integer',
          minimum: 0,
          maximum: 12,
          default: 0,
          description: '0 = any number of options, 1 = single choice.',
        },
      },
      ['channel', 'accountId', 'target', 'question', 'options']
    ),
  }),
  tool({
    name: 'social_vote_poll',
    title: 'Vote in poll',
    description:
      'Vote in a poll with the exact option names; [] retracts our vote. A vote replaces ' +
      'the previous one (WhatsApp).',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'polls.vote',
    handler: 'votePoll',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        messageId: { type: 'string', minLength: 1 },
        options: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 12,
          uniqueItems: true,
        },
      },
      ['channel', 'accountId', 'target', 'messageId', 'options']
    ),
    idempotent: true,
    destructive: true,
  }),
  tool({
    name: 'social_get_poll_results',
    title: 'Get poll results',
    description: 'Read the options, votes and voters of a poll (WhatsApp).',
    effect: 'read',
    authScope: 'social.read',
    capability: 'polls.results',
    handler: 'getPollResults',
    inputSchema: objectSchema(
      { ...commonProperties, messageId: { type: 'string', minLength: 1 }, readSource },
      ['channel', 'accountId', 'target', 'messageId']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_send_event',
    title: 'Send event',
    description: 'Send an event invitation to a chat (WhatsApp).',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'events.send',
    handler: 'sendEvent',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        name: { type: 'string', minLength: 1, maxLength: 255 },
        description: { type: 'string', maxLength: 2048 },
        startTime: { type: 'string', format: 'date-time' },
        endTime: { type: 'string', format: 'date-time' },
        location: {
          oneOf: [
            { type: 'string', minLength: 1, maxLength: 255 },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', maxLength: 255 },
                degreesLatitude: { type: 'number', minimum: -90, maximum: 90 },
                degreesLongitude: { type: 'number', minimum: -180, maximum: 180 },
              },
            },
          ],
        },
        call: { type: 'string', enum: ['audio', 'video'] },
        extraGuestsAllowed: { type: 'boolean' },
      },
      ['channel', 'accountId', 'target', 'name', 'startTime']
    ),
  }),
  tool({
    name: 'social_respond_event',
    title: 'Respond to event',
    description:
      'Answer an event invitation (going, not_going, maybe). An answer replaces the ' +
      'previous one (WhatsApp).',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'events.respond',
    handler: 'respondEvent',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        messageId: { type: 'string', minLength: 1 },
        response: { type: 'string', enum: ['going', 'not_going', 'maybe'] },
        extraGuestCount: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Only with response going, when the event allows extra guests.',
        },
      },
      ['channel', 'accountId', 'target', 'messageId', 'response']
    ),
    idempotent: true,
    destructive: true,
  }),
  tool({
    name: 'social_get_event_results',
    title: 'Get event results',
    description: 'Read an event and who answered going, not going or maybe (WhatsApp).',
    effect: 'read',
    authScope: 'social.read',
    capability: 'events.results',
    handler: 'getEventResults',
    inputSchema: objectSchema(
      { ...commonProperties, messageId: { type: 'string', minLength: 1 }, readSource },
      ['channel', 'accountId', 'target', 'messageId']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_start_chat',
    title: 'Start chat',
    description:
      'Open (or find) the chat with a phone number and optionally send a first message ' +
      '(WhatsApp). Returns the canonical conversation. When WhatsApp restricts the ' +
      'account, the error carries a wa.me link for a human to send manually.',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'chats.start',
    handler: 'startChat',
    inputSchema: objectSchema(
      {
        channel,
        accountId,
        idempotencyKey: writeProperties.idempotencyKey,
        phone: {
          type: 'string',
          minLength: 1,
          description: 'E.164 phone number (or 9 digits of the default country).',
        },
        message: { type: 'string', minLength: 1, maxLength: 4096 },
      },
      ['channel', 'accountId', 'phone']
    ),
  }),
  tool({
    name: 'social_share_contact',
    title: 'Share contact',
    description: 'Send one to five contact cards to a chat (WhatsApp).',
    effect: 'externalWrite',
    authScope: 'social.write',
    capability: 'contacts.share',
    handler: 'shareContact',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        contacts: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['displayName', 'phone'],
            properties: {
              displayName: { type: 'string', minLength: 1, maxLength: 100 },
              phone: { type: 'string', minLength: 1 },
              organization: { type: 'string', maxLength: 100 },
              email: { type: 'string', format: 'email' },
            },
          },
        },
      },
      ['channel', 'accountId', 'target', 'contacts']
    ),
  }),
  tool({
    name: 'social_list_contacts',
    title: 'List contacts',
    description: 'List the contacts the account knows, optionally filtered by name or number.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'contacts.list',
    handler: 'listContacts',
    inputSchema: objectSchema(
      {
        channel,
        accountId,
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        readSource,
      },
      ['channel', 'accountId']
    ),
    idempotent: true,
    openWorld: false,
  }),
  tool({
    name: 'social_get_presence',
    title: 'Get presence',
    description:
      'Read the last known presence (online, typing, last seen) of a chat or of one group ' +
      'participant (WhatsApp). Read-only: it never changes our own presence.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'presence.get',
    handler: 'getPresence',
    inputSchema: objectSchema(
      {
        ...commonProperties,
        participant: {
          type: 'string',
          minLength: 1,
          description: 'Group chats: phone number or user jid of one participant.',
        },
        readSource,
      },
      ['channel', 'accountId', 'target']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_block_contact',
    title: 'Block or unblock contact',
    description:
      'Block or unblock a contact (WhatsApp), by phone or by its 1:1 conversation (target) — ' +
      'exactly one of them; groups cannot be blocked. Visible to the contact and on every ' +
      'linked device, so confirm must be true. Already blocked/unblocked answers changed: false.',
    effect: 'destructive',
    authScope: 'social.write',
    capability: 'contacts.block',
    handler: 'blockContact',
    inputSchema: objectSchema(
      {
        ...writeProperties,
        phone: {
          type: 'string',
          minLength: 1,
          description: 'Phone number (E.164) of the contact, instead of target.',
        },
        action: { type: 'string', enum: ['block', 'unblock'] },
        confirm: {
          const: true,
          description: 'Must be true: blocking is visible to the contact and on every device.',
        },
      },
      ['channel', 'accountId', 'action', 'confirm']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_list_blocked',
    title: 'List blocked contacts',
    description:
      "List the account's blocked contacts (WhatsApp), one entry per person with phone, name " +
      'and 1:1 conversation when known. fresh re-reads the list from WhatsApp.',
    effect: 'read',
    authScope: 'social.read',
    capability: 'contacts.blocklist',
    handler: 'listBlocked',
    inputSchema: objectSchema(
      { channel, accountId, fresh: { type: 'boolean', default: false }, readSource },
      ['channel', 'accountId']
    ),
    idempotent: true,
  }),
  tool({
    name: 'social_get_privacy',
    title: 'Get privacy settings',
    description:
      "Read the account's privacy settings and default disappearing timer (WhatsApp); with " +
      "target, also that chat's disappearing-messages timer. Read-only.",
    effect: 'read',
    authScope: 'social.read',
    capability: 'privacy.get',
    handler: 'getPrivacy',
    inputSchema: objectSchema({ channel, accountId, target, readSource }, ['channel', 'accountId']),
    idempotent: true,
  }),
].sort((left, right) => left.name.localeCompare(right.name));

export const SOCIAL_TOOL_NAMES = SOCIAL_TOOL_REGISTRY.map(toolDefinition => toolDefinition.name);

export function publicToolDefinition(definition: SocialToolDefinition) {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    annotations: definition.annotations,
  };
}
