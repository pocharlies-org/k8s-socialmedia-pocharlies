import { PoolClient } from 'pg';

const platforms = ['whatsapp', 'telegram', 'instagram'] as const;
type Platform = typeof platforms[number];

export function excludedHindsightPlatforms(env: NodeJS.ProcessEnv): Set<Platform> {
  // CONTRACT: env.hindsight-excluded-platforms.v1
  const value = env.HINDSIGHT_SYNC_EXCLUDED_PLATFORMS?.trim() || '';
  if (!value) return new Set();
  const excluded = value.split(',').map(platform => platform.trim());
  if (excluded.some(platform => !platforms.includes(platform as Platform))) {
    throw new Error('HINDSIGHT_SYNC_EXCLUDED_PLATFORMS must contain only whatsapp, telegram, instagram');
  }
  return new Set(excluded as Platform[]);
}

/** Apply under the destination lock before making any provider requests. */
export async function configureHindsightPlatformPolicy(db: PoolClient, env: NodeJS.ProcessEnv): Promise<void> {
  const excluded = excludedHindsightPlatforms(env);
  await db.query('BEGIN');
  try {
    await db.query(`INSERT INTO hindsight_sync_platform_policy(platform,enabled)
      SELECT platform,enabled FROM unnest($1::text[],$2::boolean[]) AS policy(platform,enabled)
      ON CONFLICT(platform) DO UPDATE SET enabled=EXCLUDED.enabled`,
    [platforms, platforms.map(platform => !excluded.has(platform))]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
