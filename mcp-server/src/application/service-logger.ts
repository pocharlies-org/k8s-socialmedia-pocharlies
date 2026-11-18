import pino from 'pino';

/** Creates the human-readable logger used by application services. */
export function createServiceLogger(): pino.Logger {
  return pino({
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  });
}
