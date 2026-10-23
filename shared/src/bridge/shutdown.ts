import type pino from 'pino';

/** SIGTERM/SIGINT: close the HTTP server, stop the bridge, exit 0 (DGX-1235 B0, moved from whatsapp-synapse-bridge/src/main.ts). */
export function stopOnSignals(
  server: { close(): unknown },
  stop: () => Promise<void>,
  logger: pino.Logger
): void {
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close();
    void stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
