# Hindsight conversation change performance

Telegram remains excluded from production Hindsight indexing by migration 036's
platform policy and `HINDSIGHT_SYNC_EXCLUDED_PLATFORMS=telegram`. This change does
not purge documents, reset indexing state or resume Telegram indexing.

## Root correction

Telegram message replays previously updated the conversation row even when the
effective title and latest activity were unchanged. The producer now compares
the resulting COALESCE/GREATEST values with IS DISTINCT FROM and skips that
write. Genuine renames and newer activity still apply, including nullable titles.

New migration 037 deduplicates OLD/NEW lookup identities before history scans and
overlapping conversation/topic scopes before queue updates. It preserves 036's
policy and no-op guards. Published migrations 033-036 are unchanged. The migration
runs last on future full migration passes so 036 cannot restore the old function.

The connector Dockerfile uses the public official Python 3.12 slim image instead
of upstream's private Harbor cache, which is unreachable from this NAS. Debian
security updates and the existing dependency set remain part of the build.

## Validation

- 43 tests across six Hindsight suites passed against disposable PostgreSQL
  16.15, including a synthetic conversation with 1,158 topics. A genuine rename
  produces exactly 1,158 actual queue updates; no-op and paused updates produce
  none. Existing append, edit, name, topic and deletion regressions pass.
- Six focused Python tests passed, including real PostgreSQL temporary-table
  assertions for replay row versions, activity advance, nullable titles and
  account namespaces. No production data is used for fixtures.
- TypeScript noEmit and independent review passed; no blocking findings.

Production deployment evidence is recorded after publishing and verifying images.
