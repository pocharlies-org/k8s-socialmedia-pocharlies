import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SOCIAL_TOOL_REGISTRY,
  SocialAuthScope,
  SocialEffect,
  SocialToolDefinition,
  publicToolDefinition,
} from './tool-registry';

const EXPECTED_TOOL_NAMES = [
  'social_approve_draft',
  'social_click_interaction',
  'social_continue_digest',
  'social_create_draft',
  'social_delete_message',
  'social_discover_business',
  'social_forward_message',
  'social_get_conversation',
  'social_get_digest',
  'social_get_forum',
  'social_get_insights',
  'social_get_media',
  'social_get_profile',
  'social_list_accounts',
  'social_list_comments',
  'social_list_content',
  'social_list_conversations',
  'social_list_drafts',
  'social_list_mentions',
  'social_list_messages',
  'social_list_participants',
  'social_manage_chat',
  'social_manage_comment',
  'social_manage_forum',
  'social_manage_session',
  'social_mark_read',
  'social_publish_content',
  'social_resolve_target',
  'social_search_messages',
  'social_send_draft',
  'social_send_message',
  'social_start_digest',
  'social_summarize',
  'social_validate_account',
] as const;

const EXPECTED_EFFECTS: Record<(typeof EXPECTED_TOOL_NAMES)[number], SocialEffect> = {
  social_approve_draft: 'internalWrite',
  social_click_interaction: 'externalWrite',
  social_continue_digest: 'internalWrite',
  social_create_draft: 'internalWrite',
  social_delete_message: 'destructive',
  social_discover_business: 'read',
  social_forward_message: 'externalWrite',
  social_get_conversation: 'read',
  social_get_digest: 'read',
  social_get_forum: 'read',
  social_get_insights: 'read',
  social_get_media: 'read',
  social_get_profile: 'read',
  social_list_accounts: 'read',
  social_list_comments: 'read',
  social_list_content: 'read',
  social_list_conversations: 'read',
  social_list_drafts: 'read',
  social_list_mentions: 'read',
  social_list_messages: 'read',
  social_list_participants: 'read',
  social_manage_chat: 'externalWrite',
  social_manage_comment: 'destructive',
  social_manage_forum: 'destructive',
  social_manage_session: 'externalWrite',
  social_mark_read: 'externalWrite',
  social_publish_content: 'externalWrite',
  social_resolve_target: 'read',
  social_search_messages: 'read',
  social_send_draft: 'externalWrite',
  social_send_message: 'externalWrite',
  social_start_digest: 'internalWrite',
  social_summarize: 'compute',
  social_validate_account: 'read',
};

const EXPECTED_AUTH_SCOPES: Record<
  (typeof EXPECTED_TOOL_NAMES)[number],
  SocialAuthScope
> = Object.fromEntries(
  EXPECTED_TOOL_NAMES.map(name => [
    name,
    name === 'social_start_digest' || name === 'social_continue_digest'
      ? 'social.read'
      : EXPECTED_EFFECTS[name] === 'read' || EXPECTED_EFFECTS[name] === 'compute'
        ? 'social.read'
        : 'social.write',
  ])
) as Record<(typeof EXPECTED_TOOL_NAMES)[number], SocialAuthScope>;

const EXPECTED_ANNOTATIONS: Record<
  (typeof EXPECTED_TOOL_NAMES)[number],
  SocialToolDefinition['annotations']
> = {
  social_approve_draft: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  social_click_interaction: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  social_continue_digest: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  social_create_draft: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  social_delete_message: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_discover_business: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_forward_message: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  social_get_conversation: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_get_digest: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  social_get_forum: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_get_insights: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_get_media: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_get_profile: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_list_accounts: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  social_list_comments: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_list_content: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_list_conversations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_list_drafts: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  social_list_mentions: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_list_messages: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_list_participants: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_manage_chat: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  social_manage_comment: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  social_manage_forum: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  social_manage_session: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  social_mark_read: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_publish_content: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  social_resolve_target: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  social_search_messages: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  social_send_draft: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  social_send_message: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  social_start_digest: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  social_summarize: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  social_validate_account: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

const LEGACY_PUBLIC_NAMES = new Set([
  'create_draft',
  'get_chat',
  'get_me',
  'get_unread_chats',
  'list_conversations',
  'mark_as_read',
  'messaging_status',
  'search_messages',
  'search_users',
  'send_draft',
  'socialmedia_download_media',
  'socialmedia_fetch_chat_live',
  'socialmedia_get_chat',
  'socialmedia_get_me',
  'socialmedia_list_chats',
  'socialmedia_list_chats_live',
  'socialmedia_mark_as_read',
  'socialmedia_resolve_chat',
  'socialmedia_search_messages',
  'socialmedia_search_users',
  'socialmedia_send',
  'socialmedia_status',
  'socialmedia_unread',
  'socialmedia_unread_digest',
  'summarize_chat',
  'telegram_send_message',
  'unread_digest',
  'whatsapp_send_message',
]);

interface ContractManifest {
  schemaVersion: string;
  service: string;
  digestAlgorithm: string;
  digest: string;
  tools: Array<Omit<SocialToolDefinition, 'handler'>>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`;
  }
  const rendered = JSON.stringify(value);
  if (rendered === undefined) {
    throw new TypeError('Contract values must be JSON serializable');
  }
  return rendered;
}

function requiredFields(tool: SocialToolDefinition): string[] {
  const required = tool.inputSchema.required;
  return Array.isArray(required)
    ? required.filter((value): value is string => typeof value === 'string')
    : [];
}

function assertBasicObjectSchema(
  schema: Record<string, unknown>,
  schemaName: string
): void {
  expect(schema.type).toBe('object');
  expect(schema.properties).toEqual(expect.any(Object));

  const properties = schema.properties as Record<string, unknown>;
  if (schema.required !== undefined) {
    expect(Array.isArray(schema.required)).toBe(true);
    for (const field of schema.required as unknown[]) {
      expect(typeof field).toBe('string');
      expect(properties).toHaveProperty(String(field));
    }
  }

  expect(Object.keys(properties).length).toBeGreaterThan(0);
  expect(schemaName).not.toHaveLength(0);
}

describe('Socialmedia v2 tool contract', () => {
  const manifestPath = resolve(
    __dirname,
    '../../../contracts/socialmedia-tools.json'
  );
  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8')
  ) as ContractManifest;

  it('contains exactly the 34 canonical tools in deterministic order', () => {
    const names = SOCIAL_TOOL_REGISTRY.map(tool => tool.name);

    expect(names).toEqual(EXPECTED_TOOL_NAMES);
    expect(new Set(names).size).toBe(34);
    expect(manifest.tools.map(tool => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('declares valid schemas, effects, scopes and MCP annotations', () => {
    for (const tool of SOCIAL_TOOL_REGISTRY) {
      const name = tool.name as (typeof EXPECTED_TOOL_NAMES)[number];

      expect(tool.title.trim()).not.toHaveLength(0);
      expect(tool.description.trim()).not.toHaveLength(0);
      expect(tool.capability.trim()).not.toHaveLength(0);
      expect(tool.handler.trim()).not.toHaveLength(0);
      assertBasicObjectSchema(tool.inputSchema, `${tool.name}.inputSchema`);
      assertBasicObjectSchema(tool.outputSchema, `${tool.name}.outputSchema`);

      expect(tool.effect).toBe(EXPECTED_EFFECTS[name]);
      expect(tool.authScope).toBe(EXPECTED_AUTH_SCOPES[name]);
      expect(tool.annotations).toEqual(EXPECTED_ANNOTATIONS[name]);
    }
  });

  it('requires explicit channel and accountId on every write operation', () => {
    const writes = SOCIAL_TOOL_REGISTRY.filter(
      tool => tool.effect !== 'read' && tool.effect !== 'compute'
    );

    expect(writes).toHaveLength(15);
    for (const tool of writes) {
      expect(requiredFields(tool)).toEqual(
        expect.arrayContaining(['channel', 'accountId'])
      );
    }
  });

  it('keeps the generated manifest byte-contract aligned with the registry digest', () => {
    const generatedTools = SOCIAL_TOOL_REGISTRY.map(
      ({ handler: _handler, ...tool }) => tool
    );
    const computedDigest = `sha256:${createHash('sha256')
      .update(stableJson(generatedTools))
      .digest('hex')}`;

    expect(manifest.schemaVersion).toBe('2.0');
    expect(manifest.service).toBe('socialmedia');
    expect(manifest.digestAlgorithm).toBe('sha256');
    expect(manifest.tools).toEqual(generatedTools);
    expect(manifest.digest).toBe(computedDigest);
  });

  it('publishes no legacy tool names', () => {
    const publicNames = SOCIAL_TOOL_REGISTRY.map(tool =>
      publicToolDefinition(tool)
    ).map(tool => tool.name);

    expect(publicNames).toEqual(EXPECTED_TOOL_NAMES);
    for (const name of publicNames) {
      expect(LEGACY_PUBLIC_NAMES.has(name)).toBe(false);
      expect(name).not.toMatch(/^(?:whatsapp|telegram|instagram|socialmedia)_/);
    }
  });
});
