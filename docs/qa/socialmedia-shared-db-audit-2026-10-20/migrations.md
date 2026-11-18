# Shared database migration audit, 2026-10-20

Scope: fork `ef500ec7442a4fdf491d2b9a43355644015a8e87` versus author
`upstream/deploy/prod@1470fa85ec529cafb7090baa9f22429812a34236`.
No production schema changes, published migration edits, renumbering, or deployment.

## Result and acceptance

Required evidence is an exact source map and executable PostgreSQL cases for
empty UUID initialization, a synthetic copy of the documented BIGINT layout,
receipt identifiers, the legacy omitted FK, and the new author migrations.
The synthetic layout is not a production dump and cannot prove the complete
inventory of either live database. Live catalog/ledger evidence remains a
deployment gate.

The fork runner already supports UUID and BIGINT message identities. It does
not convert message UUIDs to BIGINT. Migration 022 converts conversation and
participant UUID identities to provider TEXT, preserving message IDs, history,
attachments, embeddings and existing affected FKs. Its conditional body is a
no-op when conversations already use TEXT. Migration 030 avoids the UUID versus
BIGINT variables in released production 015; migration 035 uses
`messages.id%TYPE` for poll/event target lookup. The initial fork and author
001-020 source bytes are identical at the audited references.

The new author 021-023 are absent from the fork's migration directory. Their
numeric prefixes collide with unrelated released fork files. Neither the
filename ledger nor checksum ledger identifies migrations by just that prefix.
Do not replace or renumber either lineage. If their changes are imported into
the fork, use new unused 039+ files after writing compatible additive SQL.

## Specific compatibility findings

1. Fork `021_nas_local_unique_wa_message_id.sql` is byte-identical to the
   released NAS `007_nas_local_unique_wa_message_id.sql` at `0d7423b`; it adds
   uniqueness for the connector's FK to `messages.wa_message_id`. It is not the
   author's newsletter migration 021. Fork 023 likewise has exactly the
   historical NAS 009 bytes. Provider identity 022 was adapted, so its checksum
   differs from historical NAS 008; it must not be asserted byte-equivalent.
2. Commit `2377c7a21f4b8915e232be1321f9277e18469f36` adds a comment to the
   `wa_message_id` line of `db-writer.ts`. The `conversation_id text NOT NULL`
   line had no FK before or after that commit. Its subject explains the
   compatibility reason, but the diff is not evidence that this commit removed
   the FK. The historical no-FK layout remains a supported fixture. Current
   `ensureHistoryTables` has a TEXT FK and requires provider TEXT conversations;
   the runner establishes that schema before the current connector starts.
3. Published 038 has no UUID message reference. Receipt `message_id` is TEXT,
   scoped by `(account, chat_id, message_id)` and optionally participant, and
   refers to the external provider key. It has no FK to `messages.id`. Its
   backfills join payloads by account and `wa_message_id`. No 039 is needed
   solely to make receipts portable across UUID/BIGINT message identities.
4. Author `021_whatsapp_novedades_channels.sql` creates a narrower table than
   the fork connector's `novedades-store.ts`. An existing fork table lacks
   `account_id`; `CREATE TABLE IF NOT EXISTS` does not add it. Direct execution
   installs a trigger referencing the missing column. Both migration runners
   can instead baseline the existing table and skip that trigger entirely.
   An import needs an explicit additive column/trigger plan that preserves
   metadata columns and rows. The reverse order also needs the richer fork
   columns before the fork connector writes them.
5. Author `022_whatsapp_contacts_view.sql` creates a VIEW over participants.
   The fork `durable-message-store.ts` creates and upserts a TABLE of the same
   name, including phone/avatar values (`baileys-client.ts` invokes
   `ensureDurableTables` during startup). Replacing it with a view conflicts with
   existing data and writers. Fork 034 also creates an AFTER row trigger with
   `UPDATE OF name,push_name,phone`; the author's view lacks phone and cannot
   satisfy that trigger contract. Preserve the table when present. A view
   fallback on installations without the table must be designed together with
   these writer and Hindsight contracts before adoption.
6. Author `023_whatsapp_chat_time_index.sql` supplies chat-time and derived
   participant-JID indexes. It does not alter IDs. Its participant expression
   requires provider TEXT IDs. The fork app's current chat-time index also
   filters `NOT is_deleted`; the author index intentionally includes revoked
   placeholders. Index equivalence must be checked by definition, not name.
7. Current author `db-writer.ts` message/attachment inserts use parameters and
   `RETURNING id`, not a UUID cast. UUID-specific app media queries are a
   separate porting issue. A blanket statement that the author connector
   requires UUID messages is unsupported. The author release 001 does use UUID
   messages, whereas the documented deployed layout uses BIGINT; its historical
   SQL alone is not a live schema inventory.

## Ledger and rollout gates

The fork runner locks a single transaction, verifies recorded checksums,
imports matching full filenames from `_migrations`, and recognizes the released
NAS `0d7423b` historical fingerprints. Historical NAS 001 is kept under
`legacy/nas/001_initial_schema.sql`; equivalent original filenames are adopted
and additive files expand their tables. Unknown checksum drift fails closed.
The author's runner uses full filenames in `_migrations`, has no checksums, and
baselines based on the first existing table. Neither behaviour proves that an
existing table has every column or trigger from a later migration.

Before any future deployment, capture only non-secret catalog evidence from
both actual databases: server version; `messages.id`, FK columns,
`conversations.id` and `participants.id` types/defaults; relation kinds for
`whatsapp_contacts`; columns, indexes and triggers for contacts/channels;
both migration ledgers. Compare file bytes with the source commit that built
the migrator, not just the deployment checkout's HEAD or numeric versions.
Use schema-only disposable copies and synthetic rows to execute the final
candidate. No production data copy or production migration was made here.

## Executable evidence

`scripts/shared-db-migration-compat.postgres.ts` adds independent cases for:

- All fork migrations and rerun on empty UUID and synthetic BIGINT layouts;
  receipt insert preserves the internal ID type and uses external TEXT keys.
- Raw author 022 rejects a pre-existing contacts table without losing its row;
  a newly created view fails the fork Hindsight row-trigger contract.
- TEXT-to-UUID FK creation fails while the historical omitted-FK table works.
- Raw author 021 on an existing fork channels table leaves `account_id` absent
  and its newly installed trigger makes the next insert fail.

Run only against explicit disposable PostgreSQL:

```sh
SHARED_DB_AUDIT_DISPOSABLE=1 DATABASE_URL=<disposable> \
  node_modules/.bin/tsx --test scripts/shared-db-migration-compat.postgres.ts
```

Validation: **5/5 new cases passed** on the parent's disposable PostgreSQL 16
container, using no production mounts or data. The existing
`mcp-server/src/infrastructure/database/migrate.integration.ts` also passed
**14/14**, including the released NAS ledger fixture extracted byte-for-byte
from `0d7423b` into a temporary directory. The suite covers historical UUID
rows/FKs/attachments/embeddings, concurrent runners and account separation,
BIGINT production-ledger import, merge/undo, response target notifications,
legacy send attempts, populated vector preservation and historical checksums.

The worktree uses a borrowed root `node_modules` link. The first existing-suite
run failed to resolve workspace package `@mcp-socialmedia/shared`. A temporary
tsx config outside the worktree mapped that package to the exact source file
imported by `db-writer.ts`, `shared/src/utils/account-key.ts`; the final run used
that source implementation and all 14 tests passed. No dependency manifests or
shared node_modules were changed. Logs: `/tmp/shared-db-migration-compat-result.log`
and `/tmp/shared-db-migrate-integration-final.log` (local, uncommitted).

No live database inventory or application end-to-end claim is made in this
document. The parent separately collected deployment metadata; these cases
remain synthetic and do not attest every object in a production snapshot.

## External references

PostgreSQL 16 official documentation, consulted via LazyMCP Context7:
https://www.postgresql.org/docs/16/ddl-constraints.html (FK column type contract)
and https://www.postgresql.org/docs/16/plpgsql-declarations.html (`%TYPE`).
Shared Hindsight recall supplied the historical hypotheses; findings above use
current source diffs and tests rather than treating old deployment reports as
current catalog evidence.

## Source checksum map

Generated from the audited Git objects and working-tree SQL files; full SHA-256
values below are content identifiers, not database ledger attestations.

| Lineage  | Filename                                           | SHA-256                                                            | Added in  |
| -------- | -------------------------------------------------- | ------------------------------------------------------------------ | --------- |
| `fork`   | `021_nas_local_unique_wa_message_id.sql`           | `8beac637f9380e8cb7aa5f0ac6e982a1195b71d6d05e6a48224d0de6ed289855` | `2efbbf8` |
| `fork`   | `022_provider_identity_schema.sql`                 | `047b0d119c26303830904834f4a22581e7b24b4d93eea8aff2a3c108dbb156e5` | `2efbbf8` |
| `fork`   | `023_messages_message_type_text.sql`               | `9cf262ed2530361106770986d5309c6a5a7daf675103857f389d25bc059ff170` | `2efbbf8` |
| `fork`   | `024_realtime_change_notifications.sql`            | `70ee6bceae0acc54723a7cb19665d0251ec6b7ba89b94aca5e1924ea978f1090` | `2efbbf8` |
| `fork`   | `025_reaction_change_notifications.sql`            | `5b186a75189c22e233263ed3dfbd26e0bbd8d0afc7f74a5f72a5abbea9b93f1e` | `2efbbf8` |
| `fork`   | `026_reaction_own_message_reason.sql`              | `a46e0e20836b0723ad6c1eeb2e605fde3d0fdd056820d4a71fe81c667e6d20bf` | `2efbbf8` |
| `fork`   | `027_whatsapp_payload_legacy_backfill.sql`         | `584b3c372d1ab82bc1522f90b4e00f41e35d86da645262eacdc49082b9efe767` | `2efbbf8` |
| `fork`   | `028_uuid_safe_conversation_merges.sql`            | `4e82f1ece25acfa746f2642ce0b9d30872ae225d25ab31cd4de94a54d6006d4d` | `2efbbf8` |
| `fork`   | `029_configurable_embedding_dimensions.sql`        | `8d6b1d3b8ab92dfc304d88b89cbfe1f37c37ab9161539924a57be3c705d4a7c9` | `2efbbf8` |
| `fork`   | `030_message_id_compatible_reaction_backfills.sql` | `bd4bbf14ab0f095b41d89a894676ad591d7ee9049bd0fe11512833b729a25418` | `2efbbf8` |
| `fork`   | `031_legacy_whatsapp_send_attempts.sql`            | `f97e39cb784534b23afaa590b1b851205721c642590fd6a6c1fa61f14d904bea` | `2efbbf8` |
| `fork`   | `032_legacy_whatsapp_reaction_shape.sql`           | `7ddfe64ac7a36cb2d1addb523c18c9ad13f611f8652363fb4d852289a545e40d` | `2efbbf8` |
| `fork`   | `033_hindsight_sync.sql`                           | `a81e7072e9e89e992a79829b4164e194d19bc154ac72bb02406c50c38480e824` | `5a4ec3c` |
| `fork`   | `034_hindsight_conversations.sql`                  | `9c6f42cd292be2b6486f07cb522e695bb5cf7adc710c181537d39e2cc8857288` | `52aae75` |
| `fork`   | `035_whatsapp_response_target_identity.sql`        | `8db1df53c5729c5e6c41eac8926bd85a908bcc31794532fe6f7881567e361dbb` | `b0d5841` |
| `fork`   | `036_hindsight_platform_policy.sql`                | `20061c094e27ea76edd56935738a56c2facd1fd36b3f42cd7680c29c06f6468c` | `2cc64a4` |
| `fork`   | `037_hindsight_change_deduplication.sql`           | `fee0a31ca3f600e53e900308656b448b306922a5594a7255e4f06dc91fd3ab73` | `f54874b` |
| `fork`   | `038_whatsapp_message_receipts.sql`                | `6505b23c17946a8fcbed3941cc02dc58a7c0659fc56c751bd1065d5d931afea3` | `7182a59` |
| `author` | `021_whatsapp_novedades_channels.sql`              | `833497ffef1801470dfae72a3d1451984abf12bd2cc4f2588a198fdb3c9cb525` | `5a5d95b` |
| `author` | `022_whatsapp_contacts_view.sql`                   | `20ddceb41d9591eb2444ac6b2dc912ecdb53bdb746db7941eb0cf8acb0e8f849` | `fe28c16` |
| `author` | `023_whatsapp_chat_time_index.sql`                 | `25151ce5de2c0be3adf0271058e2ec9e59a5971848bcd826cecd3224b40fb261` | `fe28c16` |

Legacy `0d7423b` mapping fingerprints:

- `007_nas_local_unique_wa_message_id.sql`: `8beac637f9380e8cb7aa5f0ac6e982a1195b71d6d05e6a48224d0de6ed289855`
- `008_provider_identity_schema.sql`: `18e89d366ded6e97abfc862f038f8b05dd74d9f1d3e60f14485ff33c03bb2461`
- `009_messages_message_type_text.sql`: `9cf262ed2530361106770986d5309c6a5a7daf675103857f389d25bc059ff170`
