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

## Production deployment

Source commit: `f54874bf55fbafcd3d37e5718ec352419d90ebe0` (fork main / PR74).
Official pinned contract checker passed with 104 entries; its pre-existing
missing marker note remains. Both image builds succeeded; registry manifests
were inspected before deployment:

- Maintained migrator: `docker.staticduo.com/socialmedia-mcp@sha256:948705436f4784e8d74c7f2df1748e1bd7916d7ebe0f739d14bcd3c91dbe5e4e`
- Telegram sync: `docker.staticduo.com/socialmedia-telegram-sync@sha256:944f2983adea16b27b9c4362a264cfafef190beb43d0d5dca7ed3f4902431202`

Only migration 037 ran through the published maintained migrator. Its ledger
checksum matches source: `fee0a31ca3f600e53e900308656b448b306922a5594a7255e4f06dc91fd3ab73`.
Schema and Compose backups remain on the NAS. Compose verification confirms
only migrate/telegram-sync image pins changed; all other values are preserved.
Only telegram-sync's container ID changed. The existing Hindsight worker image
and its Telegram exclusion remain unchanged. No seed reset or purge occurred.

Between 18:38:00 and 18:38:34 UTC on 2026-10-10, Telegram queue revision sum stayed
`153979672667`, and its document update time stayed `18:22:51.797115`. Policy
readback remained Telegram=false, WhatsApp/Instagram=true.

All 14 stack services run; all defined healthchecks pass. Telegram bridge readback
returns status=ok, connector=true, db=true, with zero restarts and no recent
ERROR/Traceback lines. Public `/health` returns 200 (`/api/health` is authenticated
and returns 401 without a session). PostgreSQL CPU samples were 5.45% before
rollout and 37.02-41.68% immediately afterwards; no steady-state CPU claim is
made from those startup samples. Memory samples were 224-231 MiB.

The disposable PostgreSQL fixture container was stopped and auto-removed. No
production Telegram indexing or synthetic messages were enabled for QA.
GitHub exposes no status checks for this PR head; local checks are reported
separately rather than claiming a green GitHub CI run.
