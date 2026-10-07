# PR74 migration integration

Production baseline: `upstream/deploy/prod@73a12244889568fb3c1976f4c848980d99e7d719`.
All MCP SQL files 001-020 retain the exact source bytes. A pinned SHA-256 test
checks all twenty files, including 001's vector(1536) and IVFFlat index. Independent
app and connector migration runners retain their own numbering.

## Mapping

| Released NAS fork | Integrated migration |
| --- | --- |
| 007 local message uniqueness | 021 |
| 008 provider identity schema | 022; UUID conversion runs once, provider-text IDs stay intact |
| 009 message type text | 023 |
| 010 realtime hints | 024 |
| 011 reaction hints | 025; executes against the existing prod reaction table |
| 012 reaction on own message reason | 026 |
| 013 channel credentials | prod 007; SQL equivalent |
| 014 multiaccount | prod 008; SQL equivalent |
| 015 payload compatibility/backfill | prod 009 plus additive 027; no duplicate merge functions in 027 |
| 016 UUID-safe merge history | 028; retains prod 013 chat state, reactions, polls and events behavior |
| Configuration | 029; explicit embedding dimensions, preserving populated vectors |
| UUID reaction backfills | 030; type-compatible port of prod 015 |
| NAS send attempts | 031; legacy columns and rows remain available |
| NAS reaction shape | 032; additive expansion before unchanged prod 011 |

## Ledger and bootstrap behavior

The runner uses one advisory-locked transaction and checksum-verifies every
recorded current file. It imports production's `_migrations` filenames into
`schema_migrations`; the existing production ledger remains intact.

The released NAS fork `0d7423b` is recognized by pinned historical checksums.
Its original 001 checksum is retained as `legacy/nas/001_initial_schema.sql`.
The equivalent production 001/007/008/009 entries are adopted, then additive
migrations expand the existing schema. Other NAS records remain intact. Unknown
historical checksum drift fails the transaction instead of silently adopting it.

Two incompatibilities in the unchanged production files were reproduced against
PostgreSQL 16:

- 001 creates UUID conversation IDs; 008 adds a TEXT foreign key to them and
  fails. On UUID schemas, the runner applies 021/022 before 008. Existing
  provider-text installations keep their IDs.
- 015 uses BIGINT variables/keyset cursors although 001's message IDs are UUID.
  UUID installations execute type-compatible 030 and adopt 015's original
  checksum; BIGINT installations execute 015 normally. Both retain its backfill
  and reaction-trigger behavior.

Existing NAS payload tables are expanded by 027 before executing an unrecorded
prod 009. Existing NAS reaction tables are expanded by 032 before an unrecorded
prod 011. These exceptions avoid modifying any baseline SQL file.

031 exposes key_hash/updated_at/error/account_id over legacy token_hash/sent_at,
keeps existing hashes, timestamps and prepared/pending/sent states, and permits
failed. A compatibility trigger fills both hash columns for new production
inserts; the legacy primary key stays available alongside production's unique
(account,key_hash) index. The existing production 010 table is unchanged.

## Embedding dimensions

029 installs a function invoked only when `EMBEDDING_DIMENSIONS`, or the legacy
`EMBEDDING_DIMENSION` alias, is explicitly set. Plural takes precedence. An empty
table may change dimensions; a populated mismatch fails with a separate
re-embedding migration message, preserving every vector. Above 2000 dimensions
the incompatible IVFFlat index is removed only after confirming the table is
empty. Unconfigured installations retain their existing dimensions. Application
fresh defaults are text-embedding-3-small/1536; deployed bge-m3/1024 configuration
must explicitly reach the migrator and its writers. Semantic message search now
uses the external brain configured by production; these vectors remain preserved
for the existing ingestion/history paths.

## Validation

Validated using disposable `pgvector/pgvector:pg16` with its data in tmpfs and
no production mounts, and the Node 22 tooling container:

- `corepack pnpm --filter @mcp-socialmedia/server exec jest src/infrastructure/database/migrate.spec.ts --runInBand --silent`: 6 tests, including exact baseline bytes.
- `LEGACY_NAS_MIGRATIONS_DIR=/tmp/pr74-nas-migrations DATABASE_URL=<disposable> corepack pnpm exec tsx --test mcp-server/src/infrastructure/database/migrate.integration.ts`: 12 PostgreSQL integration tests.
- Integration covers empty initialization, UUID history/FKs, concurrent runners,
  account isolation, reaction notifications, full prod 001-020 ledger import with
  BIGINT IDs, merge/undo with chat state and reactions/polls/events, production's
  four send states, legacy NAS send attempts, safe dimension changes, and the
  released NAS checksum ledger upgrade.
- `DATABASE_URL=<disposable> corepack pnpm --filter @mcp-socialmedia/connector exec tsx src/statuses.postgres.mjs`:
  10 PostgreSQL cases cover channel/account isolation, deleted and superseded
  posts, client/server aliases, locale-independent keyset pagination, unique
  channel counts, and legacy fallback. Fixtures run in a rolled-back transaction.

No production migration or deployment is part of this validation. Real upstream
production data was not sampled; the production fixture reproduces its released
SQL and the documented BIGINT message ID layout.
