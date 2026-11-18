import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadMcpRuntimeConfig, redisOptionsFor } from './runtime-config';

describe('loadMcpRuntimeConfig', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    jest.restoreAllMocks();
  });

  it('shares explicit connection and LLM settings between stdio and SSE modes', () => {
    process.env.DATABASE_URL = 'postgres://db';
    process.env.CONNECTOR_SHARED_SECRET = 'test-secret';
    process.env.REDIS_URL = 'redis://cache';
    process.env.OPENAI_API_KEY = 'openai';
    process.env.LLM_BASE_URL = 'http://llm';
    process.env.LLM_CHAT_MODEL = 'model';
    process.env.ENCRYPTION_KEY = 'encryption';
    process.env.CONNECTOR_URL = 'http://connector';

    const stdio = loadMcpRuntimeConfig('stdio');
    const sse = loadMcpRuntimeConfig('sse');

    expect(sse).toEqual(stdio);
    expect(stdio).toEqual({
      databaseUrl: 'postgres://db',
      redisUrl: 'redis://cache',
      redisTlsCa: process.env.REDIS_TLS_CA,
      openaiApiKey: 'openai',
      llmBaseUrl: 'http://llm',
      llmChatModel: 'model',
      encryptionKey: 'encryption',
      connectorSharedSecret: 'test-secret',
      connectorUrl: 'http://connector',
    });
  });

  it('keeps defaults and preserves the configured HMAC secret bytes', () => {
    process.env = {
      DATABASE_URL: 'postgres://db',
      CONNECTOR_SHARED_SECRET: ' secret with spaces ',
    };
    expect(loadMcpRuntimeConfig('stdio')).toMatchObject({
      redisUrl: 'redis://localhost:6379',
      openaiApiKey: '',
      llmBaseUrl: '',
      llmChatModel: '',
      encryptionKey: 'dev-encryption-key-change-in-production',
      connectorSharedSecret: ' secret with spaces ',
      connectorUrl: 'http://whatsapp-connector:3001',
    });
  });

  it.each(['', '   '])('refuses the missing or blank connector secret %p', secret => {
    process.env.DATABASE_URL = 'postgres://db';
    process.env.CONNECTOR_SHARED_SECRET = secret;
    expect(() => loadMcpRuntimeConfig('sse')).toThrow('CONNECTOR_SHARED_SECRET is unset or empty');
  });

  it('refuses the public connector placeholder when strict mode is enabled', () => {
    process.env.DATABASE_URL = 'postgres://db';
    process.env.CONNECTOR_SHARED_SECRET = 'dev-secret-change-in-production';
    process.env.CONNECTOR_SECRET_STRICT = 'true';
    expect(() => loadMcpRuntimeConfig('sse')).toThrow('refusing to start with a public HMAC key');
  });

  it('loads a CA with certificate verification only for rediss connections', () => {
    const caPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-')), 'ca.pem');
    fs.writeFileSync(caPath, 'certificate');
    expect(redisOptionsFor({ redisUrl: 'redis://cache', redisTlsCa: '/ca.pem' })).toEqual({});
    expect(redisOptionsFor({ redisUrl: 'rediss://cache', redisTlsCa: caPath })).toEqual({
      tls: { ca: 'certificate', rejectUnauthorized: true },
    });
    fs.rmSync(path.dirname(caPath), { recursive: true, force: true });
  });

  it('does not suppress an unreadable TLS CA', () => {
    expect(() =>
      redisOptionsFor({ redisUrl: 'rediss://cache', redisTlsCa: '/definitely/missing/ca.pem' })
    ).toThrow();
  });

  it('fails closed when the database URL is missing', () => {
    delete process.env.DATABASE_URL;
    process.env.CONNECTOR_SHARED_SECRET = 'test-secret';
    expect(() => loadMcpRuntimeConfig('stdio')).toThrow(
      'DATABASE_URL is unset: refusing to start the MCP server'
    );
  });
});
