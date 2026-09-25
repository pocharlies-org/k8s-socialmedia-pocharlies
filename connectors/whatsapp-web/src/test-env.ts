/**
 * Test-only DATABASE_URL default (SC-1239 C2).
 *
 * db-writer.ts refuses to load without DATABASE_URL — the connector must fail
 * at startup rather than carry a connection string baked into the image.
 * Tests that pull the module chain in (db-writer directly, or through
 * baileys-client) import THIS file first: ESM evaluates imports in source
 * order, so the dummy URL exists before the chain loads. No test here opens a
 * real connection — the pools are stubbed or never queried.
 */
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
