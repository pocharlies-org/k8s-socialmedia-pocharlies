import * as fs from 'node:fs';
import type { RedisOptions } from 'ioredis';
import { requireConnectorSecret } from '@mcp-socialmedia/shared';

export interface McpRuntimeConfig {
  databaseUrl: string;
  redisUrl: string;
  redisTlsCa?: string;
  openaiApiKey: string;
  llmBaseUrl: string;
  llmChatModel: string;
  encryptionKey: string;
  connectorSharedSecret: string;
  connectorUrl: string;
}

/** Load the shared process configuration for stdio and SSE entry points. */
export function loadMcpRuntimeConfig(mode: 'stdio' | 'sse'): McpRuntimeConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      `DATABASE_URL is unset: refusing to start the MCP ${mode === 'sse' ? 'SSE ' : ''}server without an explicit database connection`
    );
  }

  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const redisTlsCa = process.env.REDIS_TLS_CA;
  return {
    databaseUrl,
    redisUrl,
    redisTlsCa,
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    llmBaseUrl: process.env.LLM_BASE_URL || '',
    llmChatModel: process.env.LLM_CHAT_MODEL || '',
    encryptionKey: process.env.ENCRYPTION_KEY || 'dev-encryption-key-change-in-production',
    connectorSharedSecret: requireConnectorSecret(),
    connectorUrl: process.env.CONNECTOR_URL || 'http://whatsapp-connector:3001',
  };
}

/** Read the CA only when the entry point is ready to connect to Redis. */
export function redisOptionsFor(
  config: Pick<McpRuntimeConfig, 'redisUrl' | 'redisTlsCa'>
): RedisOptions {
  return config.redisUrl.startsWith('rediss://') && config.redisTlsCa
    ? { tls: { ca: fs.readFileSync(config.redisTlsCa, 'utf-8'), rejectUnauthorized: true } }
    : {};
}
