import { Pool } from 'pg';
import pino from 'pino';
import { getAccounts } from '../domain/account-registry';
import { HindsightClient, hindsightConfigFromEnv, semanticProviderFromEnv } from '../infrastructure/hindsight-client';
import { destinationKey, syncOptionsFromEnv } from './hindsight-sync-lib';
import { runConversationSyncPass } from './hindsight-conversation-sync';
import { configureHindsightPlatformPolicy, excludedHindsightPlatforms } from './hindsight-platform-policy';

const logger = pino();

export async function main(env: NodeJS.ProcessEnv = process.env, args: string[] = process.argv.slice(2)): Promise<void> {
  if (semanticProviderFromEnv(env) !== 'hindsight') {
    logger.info('hindsight-sync skipped: SEMANTIC_PROVIDER=brain');
    return;
  }
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for hindsight-sync');
  if (args.some(a => !['--loop', '--once'].includes(a)) || (args.includes('--loop') && args.includes('--once'))) {
    throw new Error('Usage: hindsight-sync [--once | --loop]');
  }
  const options = syncOptionsFromEnv(env);
  excludedHindsightPlatforms(env);
  if (args.includes('--loop')) options.loop = true;
  if (args.includes('--once')) options.loop = false;
  const config = hindsightConfigFromEnv(env);
  const destination = destinationKey(config.url,config.bankId);
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
  const db = await pool.connect().catch(async error => { await pool.end(); throw error; });
  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = () => { stopped = true; wake?.(); };
  let databaseFailed = false;
  const onDatabaseError = () => { databaseFailed = true; stop(); };
  db.on('error',onDatabaseError);
  process.once('SIGTERM',stop);
  process.once('SIGINT',stop);
  let locked = false;
  try {
    const lock = await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`hindsight-sync:${destination}`]);
    locked = Boolean(lock.rows[0].locked);
    if (!locked) throw new Error('Another hindsight-sync job holds the destination lock');
    await configureHindsightPlatformPolicy(db,env);
    const hindsight = new HindsightClient(config);
    await hindsight.initializeBank();
    do {
      try {
        const result = await runConversationSyncPass(db,hindsight,destination,getAccounts(),options);
        logger.info(result,'hindsight sync pass');
        if (result.failed && !options.loop) throw new Error(`Hindsight sync pass has ${result.failed} failed operations; retryable ledger saved`);
      } catch (error) {
        if (!options.loop || databaseFailed) throw error;
        // Do not log provider errors, which can contain message text or credentials.
        logger.error('Hindsight sync pass failed; retrying after configured interval');
      }
      if (options.loop && !stopped) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); },options.intervalMs);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    } while (options.loop && !stopped);
    if (databaseFailed) throw new Error('Database connection lost; durable sync state preserved');
  } finally {
    process.removeListener('SIGTERM',stop);
    process.removeListener('SIGINT',stop);
    try {
      if (locked && !databaseFailed) await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`hindsight-sync:${destination}`]);
    } finally {
      db.removeListener('error',onDatabaseError);
      db.release(databaseFailed);
      await pool.end();
    }
  }
}

if (require.main === module) {
  main().catch(() => { logger.error('hindsight-sync failed'); process.exitCode = 1; });
}
