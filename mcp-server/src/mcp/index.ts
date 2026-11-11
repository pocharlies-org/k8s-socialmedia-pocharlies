import { Pool } from 'pg';
import { syncSocialAccountsBestEffort } from '../infrastructure/database/social-accounts';
import Redis from 'ioredis';
import { loadMcpRuntimeConfig, redisOptionsFor } from './runtime-config';
import { createMcpServer } from './runtime-server';

const config = loadMcpRuntimeConfig('stdio');

async function main() {
  try {
    const dbPool = new Pool({
      connectionString: config.databaseUrl,
      max: 30,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      application_name: 'mcp-stdio',
    } as any);
    await dbPool.query('SELECT 1');
    console.log('Connected to database (pool max=30, statement_timeout=10s)');

    // Connect to Redis with TLS if configured
    const redisClient = new Redis(config.redisUrl, redisOptionsFor(config));
    console.log('Connected to Redis' + (config.redisTlsCa ? ' with TLS' : ''));

    await syncSocialAccountsBestEffort(dbPool);

    // Create MCP server
    const server = createMcpServer(dbPool, redisClient, config);

    // Run server
    await server.run();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`${signal} received, shutting down MCP server...`);
      await dbPool.end();
      await redisClient.quit();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
