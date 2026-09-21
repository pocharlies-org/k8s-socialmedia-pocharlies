import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  identityBindingEnabled,
  loadIdentityBindings,
  resetIdentityBindingsCache,
  resolveBoundAccount,
  IdentityBindingError,
} from './identity-bindings';

const DANIEL = 'e51253a7-c137-4c6c-9fb9-af9cecd3b147';
const LEILA = '66ec6f4f-5f2c-44f6-a3db-0dccba6e1748';
const OPERATOR = '2379d025-dfb6-433e-bd02-0f2aa9a5ae75';

const TABLE = `bindings:
  - sub: ${OPERATOR}
    label: operator-machines (agentgateway-mcp service-account via auth-proxy)
    accounts: [personal, professional]
  - sub: ${DANIEL}
    label: daniel
    accounts: [personal, professional]
  - sub: ${LEILA}
    label: leila
    accounts: [leila]
`;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-bindings-'));
  file = path.join(dir, 'social-identity-bindings.yaml');
  fs.writeFileSync(file, TABLE);
  resetIdentityBindingsCache();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetIdentityBindingsCache();
});

describe('SOCIAL_IDENTITY_BINDING flag', () => {
  it('is off unless explicitly on (and OFF means zero file reads)', () => {
    expect(identityBindingEnabled({})).toBe(false);
    expect(identityBindingEnabled({ SOCIAL_IDENTITY_BINDING: 'off' })).toBe(false);
    expect(identityBindingEnabled({ SOCIAL_IDENTITY_BINDING: 'garbage' })).toBe(false);
    for (const on of ['on', 'ON', '1', 'true', 'yes']) {
      expect(identityBindingEnabled({ SOCIAL_IDENTITY_BINDING: on })).toBe(true);
    }
  });
});

describe('loadIdentityBindings', () => {
  it('parses the GitOps table into sub -> {label, accounts}', () => {
    const table = loadIdentityBindings(file);
    expect(table.get(LEILA)).toEqual({ label: 'leila', accounts: ['leila'] });
    expect(table.get(DANIEL)?.accounts).toEqual(['personal', 'professional']);
    expect(table.get(OPERATOR)?.label).toContain('agentgateway-mcp');
  });

  it('re-reads the mounted file when it changes (ConfigMap apply without restart)', () => {
    expect(loadIdentityBindings(file).get(LEILA)?.accounts).toEqual(['leila']);
    // A ConfigMap update replaces the symlinked payload: mtime moves, content grows.
    const next = TABLE.replace('accounts: [leila]', 'accounts: [leila, personal]');
    expect(next.length).not.toBe(TABLE.length); // guard the cache key sees the size change
    fs.writeFileSync(file, next);
    const table = loadIdentityBindings(file);
    expect(table.get(LEILA)?.accounts).toEqual(['leila', 'personal']);
  });

  it('drops placeholder entries with no sub or no accounts (fail-closed by absence)', () => {
    fs.writeFileSync(
      file,
      `bindings:\n  - sub: TODO-fill-me\n    label: alguien\n    accounts: []\n  - label: sin sub\n    accounts: [personal]\n`
    );
    const table = loadIdentityBindings(file);
    expect(table.size).toBe(0);
  });

  it('fails closed when the file is missing or malformed', () => {
    expect(() => loadIdentityBindings(path.join(dir, 'nope.yaml'))).toThrow(
      IdentityBindingError
    );
    fs.writeFileSync(file, 'bindings: {esto: no es una lista}');
    expect(() => loadIdentityBindings(file)).toThrow(/no se puede parsear|lista/);
  });
});

describe('resolveBoundAccount (flag ON)', () => {
  const filePath = () => ({ filePath: file });

  it('no verified sub -> fail-closed with an explicit error', () => {
    expect(() => resolveBoundAccount('personal', {}, filePath())).toThrow(
      /x-user-sub.*fail-closed/s
    );
    expect(() => resolveBoundAccount(undefined, { sub: '   ' }, filePath())).toThrow(
      IdentityBindingError
    );
  });

  it('sub without an entry -> fail-closed, no account even when omitted', () => {
    expect(() => resolveBoundAccount(undefined, { sub: 'unbound-sub' }, filePath())).toThrow(
      /no tiene entrada/
    );
    expect(() => resolveBoundAccount('personal', { sub: 'unbound-sub' }, filePath())).toThrow(
      /no tiene entrada/
    );
  });

  it('requested account inside the list passes; outside throws naming principal + bounds', () => {
    expect(resolveBoundAccount('personal', { sub: DANIEL }, filePath())).toBe('personal');
    expect(resolveBoundAccount('professional', { sub: DANIEL }, filePath())).toBe(
      'professional'
    );
    expect(resolveBoundAccount('leila', { sub: LEILA }, filePath())).toBe('leila');
    expect(resolveBoundAccount('professional', { sub: OPERATOR }, filePath())).toBe(
      'professional'
    );

    let message = '';
    try {
      resolveBoundAccount('professional', { sub: LEILA }, filePath());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("account 'professional' no está ligado a este llamante");
    expect(message).toContain('Principal: leila');
    expect(message).toContain(`sub ${LEILA}`);
    expect(message).toContain('Cuentas ligadas: leila');
    // Leila must never land on personal either.
    expect(() => resolveBoundAccount('personal', { sub: LEILA }, filePath())).toThrow(
      IdentityBindingError
    );
  });

  it('omitted account resolves to the FIRST bound account, never the global personal default', () => {
    expect(resolveBoundAccount(undefined, { sub: LEILA }, filePath())).toBe('leila');
    expect(resolveBoundAccount('   ', { sub: LEILA }, filePath())).toBe('leila');
    expect(resolveBoundAccount(undefined, { sub: DANIEL }, filePath())).toBe('personal');
    // Daniel's first is personal by table order; the service-account likewise.
    expect(resolveBoundAccount(undefined, { sub: OPERATOR }, filePath())).toBe('personal');
  });

  it('carries the canonical forbidden code for the MCP error envelope', () => {
    try {
      resolveBoundAccount('skirmshop', { sub: DANIEL }, filePath());
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as IdentityBindingError).canonicalCode).toBe('forbidden');
    }
  });
});
