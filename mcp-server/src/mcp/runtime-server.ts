import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { MCPServer } from './server';
import type { McpRuntimeConfig } from './runtime-config';

/** Construct the MCP server identically for stdio and SSE entry points. */
export function createMcpServer(
  dbPool: Pool,
  redisClient: Redis,
  config: McpRuntimeConfig
): MCPServer {
  return new MCPServer(
    dbPool,
    redisClient,
    config.openaiApiKey,
    config.encryptionKey,
    config.connectorSharedSecret,
    config.connectorUrl,
    config.redisUrl,
    config.llmBaseUrl || undefined,
    config.llmChatModel || undefined
  );
}
