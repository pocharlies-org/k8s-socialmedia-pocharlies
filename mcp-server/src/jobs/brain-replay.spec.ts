import { replayOptionsFromEnv } from './brain-replay';

describe('brain replay options', () => {
  it('defaults to dry-run and requires no live cursor mutation', () => {
    const opts = replayOptionsFromEnv({ RUN_ID: 'audit-20260609', SINCE: '2026-01-01T00:00:00Z' });

    expect(opts.dryRun).toBe(true);
    expect(opts.runId).toBe('audit-20260609');
    expect(opts.since).toBe('2026-01-01T00:00:00Z');
    expect(opts.accounts).toEqual(['personal', 'professional']);
  });

  it('can target one account and platform for windowed replay', () => {
    const opts = replayOptionsFromEnv({
      RUN_ID: 'personal-telegram-1',
      ACCOUNT: 'personal',
      PLATFORM: 'telegram',
      SINCE: '2026-05-01T00:00:00Z',
      UNTIL: '2026-06-01T00:00:00Z',
      LIMIT: '500',
      DRY_RUN: 'false',
    });

    expect(opts.dryRun).toBe(false);
    expect(opts.accounts).toEqual(['personal']);
    expect(opts.platform).toBe('telegram');
    expect(opts.until).toBe('2026-06-01T00:00:00Z');
    expect(opts.limit).toBe(500);
  });
});
