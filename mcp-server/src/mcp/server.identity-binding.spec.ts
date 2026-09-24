import { useTestAccounts } from '../domain/test-accounts';
/**
 * SC-1144 fase 2 — the identity-binding gate as seen from executeCanonicalTool,
 * the single point every canonical tool call passes through.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MCPServer } from './server';
import { SOCIAL_TOOL_REGISTRY, type SocialToolDefinition } from './tool-registry';
import { runWithRequestActor } from '@mcp-socialmedia/shared';
import { IdentityBindingError } from '../domain/identity-bindings';

const DANIEL = 'e51253a7-c137-4c6c-9fb9-af9cecd3b147';
const LEILA = '66ec6f4f-5f2c-44f6-a3db-0dccba6e1748';

function definition(name: string): SocialToolDefinition {
  const found = SOCIAL_TOOL_REGISTRY.find(tool => tool.name === name);
  if (!found) throw new Error(`Missing test definition ${name}`);
  return found;
}

function fakeRedis() {
  const values = new Map<string, string>();
  return {
    get: jest.fn(async (key: string) => values.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
    }),
  };
}

function createServer() {
  const server: any = Object.create(MCPServer.prototype);
  server.redisClient = fakeRedis();
  server.logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  useTestAccounts({
    whatsapp: {
      personal: 'http://wa-personal',
      professional: 'http://wa-professional',
      leila: 'http://wa-leila',
    },
  });
  useTestAccounts({
    telegram: { personal: 'http://tg-personal', professional: 'http://tg-professional' },
  });
  server.dispatchCanonicalTool = jest.fn(async () => ({ dispatched: true }));
  return server;
}

let dir: string;
let bindingsFile: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-gate-'));
  bindingsFile = path.join(dir, 'social-identity-bindings.yaml');
  fs.writeFileSync(
    bindingsFile,
    `bindings:
  - sub: ${DANIEL}
    label: daniel
    accounts: [personal, professional]
  - sub: ${LEILA}
    label: leila
    accounts: [leila]
`
  );
  for (const key of ['SOCIAL_IDENTITY_BINDING', 'SOCIAL_IDENTITY_BINDINGS_FILE']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function enableBinding() {
  process.env.SOCIAL_IDENTITY_BINDING = 'on';
  process.env.SOCIAL_IDENTITY_BINDINGS_FILE = bindingsFile;
}

const getProfile = definition('social_get_profile');

describe('executeCanonicalTool identity gate', () => {
  it('flag OFF: byte-identical legacy path — the bindings file is never read', async () => {
    // The flag is off and the bindings path points at a NONEXISTENT file: if the
    // gate touched the table at all, this call would fail-closed instead of
    // running the exact legacy path (social_list_conversations legitimately
    // allows an omitted accountId — it aggregates across accounts).
    process.env.SOCIAL_IDENTITY_BINDINGS_FILE = path.join(dir, 'absent.yaml');
    const server = createServer();
    const args: Record<string, any> = { channel: 'whatsapp' };
    await server.executeCanonicalTool(definition('social_list_conversations'), args);
    expect(args.accountId).toBeUndefined();
    expect(server.dispatchCanonicalTool).toHaveBeenCalledWith(
      'listConversations',
      expect.not.objectContaining({ accountId: expect.anything() })
    );
  });

  it('flag ON + bound sub + omitted accountId -> first account of the binding, never the global personal default', async () => {
    enableBinding();
    const server = createServer();
    await runWithRequestActor({ sub: LEILA }, () =>
      server.executeCanonicalTool(getProfile, { channel: 'whatsapp' })
    );
    expect(server.dispatchCanonicalTool).toHaveBeenCalledWith(
      'getProfile',
      expect.objectContaining({ accountId: 'leila' })
    );
  });

  it('flag ON + bound sub + bound account passes through unchanged', async () => {
    enableBinding();
    const server = createServer();
    await runWithRequestActor({ sub: DANIEL }, () =>
      server.executeCanonicalTool(getProfile, { channel: 'whatsapp', accountId: 'professional' })
    );
    expect(server.dispatchCanonicalTool).toHaveBeenCalledWith(
      'getProfile',
      expect.objectContaining({ accountId: 'professional' })
    );
  });

  it('flag ON + account outside the binding -> fail-closed naming principal and bounds', async () => {
    enableBinding();
    const server = createServer();
    await expect(
      runWithRequestActor({ sub: LEILA }, () =>
        server.executeCanonicalTool(getProfile, { channel: 'whatsapp', accountId: 'professional' })
      )
    ).rejects.toThrow(/no está ligado a este llamante/);
    expect(server.dispatchCanonicalTool).not.toHaveBeenCalled();
    // The MCP error envelope carries the canonical forbidden code.
    try {
      await runWithRequestActor({ sub: LEILA }, () =>
        server.executeCanonicalTool(getProfile, { channel: 'whatsapp', accountId: 'personal' })
      );
    } catch (error) {
      expect((error as IdentityBindingError).canonicalCode).toBe('forbidden');
      expect(server.errorCode(error)).toBe('forbidden');
    }
  });

  it('flag ON + no verified sub -> fail-closed even for a request that omits the account', async () => {
    enableBinding();
    const server = createServer();
    await expect(server.executeCanonicalTool(getProfile, { channel: 'whatsapp' })).rejects.toThrow(
      /x-user-sub/
    );
    expect(server.dispatchCanonicalTool).not.toHaveBeenCalled();
  });

  it('flag ON + sub without an entry -> fail-closed', async () => {
    enableBinding();
    const server = createServer();
    await expect(
      runWithRequestActor({ sub: 'no-existe' }, () =>
        server.executeCanonicalTool(getProfile, { channel: 'whatsapp', accountId: 'personal' })
      )
    ).rejects.toThrow(/no tiene entrada/);
  });

  it('flag ON + tools that take no account parameter are not gated', async () => {
    enableBinding();
    const server = createServer();
    // social_list_accounts has no accountId in its schema; the gate must not
    // invent one (it would fail channel validation and change the tool's shape).
    await runWithRequestActor({ sub: LEILA }, () =>
      server.executeCanonicalTool(definition('social_list_accounts'), {})
    );
    expect(server.dispatchCanonicalTool).toHaveBeenCalledWith('listAccounts', {});
  });

  it('flag ON + Instagram account not bound to anyone -> fail-closed for every caller', async () => {
    enableBinding();
    const server = createServer();
    await expect(
      runWithRequestActor({ sub: DANIEL }, () =>
        server.executeCanonicalTool(definition('social_get_profile'), {
          channel: 'instagram',
          accountId: 'skirmshop',
        })
      )
    ).rejects.toThrow(/no está ligado a este llamante/);
  });
});
