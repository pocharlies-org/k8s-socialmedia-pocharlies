# Connector deletion portability

The remaining WhatsApp connector writes to `messages.deleted_at` failed on the
author's BIGINT/metadata-only schema. The three remote deletion writers now store
the first deletion timestamp in `metadata.deleted_at`, retaining existing
metadata before falling back to the optional legacy column through
`to_jsonb(messages)->>'deleted_at'`. They retain existing deletion provenance and
never erase content. New remote deletion updates scope account and platform.

The durable local deletion writer now follows the existing mutation contract:
`deleted_for_me` metadata only, with its first timestamp preserved on replay. It
does not turn local deletion into remote revocation or overwrite remote deletion
provenance. Its account, platform and canonical chat scopes remain explicit.

No published migration changed. Migration 022 already supplies `metadata` and
`status_at`; the initial NAS schema's optional `deleted_at` is `timestamp`.

## Evidence

`connectors/whatsapp-web/src/message-deletion.postgres.mjs` executes the actual
writer functions on PostgreSQL 16 in a unique scratch schema, removed in
`finally`. It passed all three fixtures:

- UUID IDs with legacy `deleted_at timestamp`, using Europe/Madrid session time.
- UUID IDs with legacy `deleted_at timestamptz`.
- BIGINT IDs without any `deleted_at` column.

Each fixture exercises mutation revoke, status deletion and durable revoke;
fresh/replayed deletion; first metadata timestamp and optional legacy-column
fallback; retained source/actor; account/platform isolation; local deletion via
both writers; durable local chat scope; local-then-remote and remote-then-local
ordering. It checks retained text, raw payload, durable JSON payloads and media
rows. No WhatsApp messages or production database writes occur.

Command (DATABASE_URL must be the explicitly disposable database):

```sh
SHARED_DB_AUDIT_DISPOSABLE=1 DATABASE_URL="$SCRATCH_DATABASE_URL" \
  TSX_TSCONFIG_PATH=/tmp/connector-deletion-full-tsconfig.json \
  node --import tsx connectors/whatsapp-web/src/message-deletion.postgres.mjs
```

Existing regression suites passed: `db-writer.test.ts` and
`durable-message-store.test.ts` **43/43**; `message-mutations.test.ts` and
`read-paths.test.ts` **33/33**. ESLint on the three changed source files reports
**0 errors**, with 131 pre-existing unsafe-any warnings. `git diff --check` passes.

The worktree borrows installed dependencies via untracked root/connector
`node_modules` links. The root workspace package cannot expose named exports
through its CommonJS barrel under this test runtime, so a temporary ESM facade
in `/tmp` re-exports its 44 actual source exports; a temporary tsx paths config
uses that facade. The first narrow config supplied only `namespaceAccountId`
and therefore failed wider read-path imports; the complete source facade fixed
the harness and both suites passed. No dependency manifest or shared dependency
tree was modified.

These are synthetic database and mocked-provider regressions. Provider-side
deletion and deployment behavior were not exercised.

## References

PostgreSQL 16 JSON functions/operator semantics were checked through Context7
and LazyMCP Kindly search: https://www.postgresql.org/docs/16/functions-json.html.
`jsonb || jsonb` retains the second object's duplicate keys; missing JSON field
extraction returns SQL NULL, permitting the optional legacy field fallback.
