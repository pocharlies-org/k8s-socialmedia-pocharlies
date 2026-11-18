# SocialMedia: Oppos audit closure candidate

Scope authorized through Marlin on 2026-10-20: prepare and publish fixes through
the existing fork/PR74, with tests and a deliberate connector-port assessment.
**No deployment or production mutation is authorized or performed.**

## Environment Correction

The opening report called the databases shared. Read-only NAS catalog inspection
and Marlin's subsequent clarification establish separate physical databases:
the NAS has UUID message IDs, `messages.deleted_at`, and both attachment duration
columns; Oppos reports BIGINT IDs, metadata revocation and `duration_seconds`
only. The candidate supports both layouts without modifying either live schema.
Oppos deployment reference: `deploy/prod@1470fa85ec529cafb7090baa9f22429812a34236`.
Fork baseline: `ef500ec7442a4fdf491d2b9a43355644015a8e87`.

## Acceptance Matrix

| Audit item | Candidate and evidence | External boundary |
| --- | --- | --- |
| 1. Connector behind app | Fork already implements GET block, presence subscribe/stream, message info, history recovery, status/channels and stars. Existing parameterized aliases are preserved; missing sending/emergency gates on modify, disappearing and legacy read are fixed. See connector-contracts.md. | Oppos must port/build/promote this connector deliberately; no claim its currently deployed image gains routes from this PR alone. |
| 2. Schema IDs/revocation | Visible-relation schema discovery supports UUID/BIGINT IDs; metadata timestamp projection tolerates an optional legacy column. Real app tests cover both. | Oppos catalog is reported by its audit, not directly accessed here. |
| 3. Migration collisions | Published 001-038 remain byte-identical. Names/checksums and actual effects are mapped in migrations.md; no new migration is necessary for these fixes. | Do not apply author 021/022 blindly: channels and contacts object conflicts are demonstrated. Future portable additions need a free number, currently 039+ in this fork. |
| 4. Media library | Optional duration columns, native numeric ordering, precise BIGINT cursors, tied attachments and account isolation pass in PG16. | Synthetic records, not provider media recovery. |
| 5. Large chat list | Rank sender names only after ten recent indexed inbound candidates per conversation/alias. PG16 EXPLAIN checks the limit/index. | No production cold-cache latency guarantee; fixture uses 10,000 records. |
| 6. Group enrichment | Native typed ID arrays preserve the PK index for attachments, thumbnails and link previews; UUID/BIGINT HTTP tests use 80,000 messages. | Fresh synthetic data; operating-system cache was not flushed. |
| 7. Delete for me | App and connector use metadata-only local hiding; preserve global state and first remote revocation time. Hidden records stay excluded from library/gallery/search/favorites/AI context. | Provider mutations use fixtures, not real user messages. |
| 8. Professional 463 | Current inbound/trusted-contact identity policy and destination guard ordering are retained; 50 MCP regression tests pass. Diagnostic guidance is in connector-contracts.md. | A real send, phone restriction notice and provider acceptance require the owner/QA; no authorized real test message was supplied. |
| 9. Safe connector port | Conditional yes: use the route/schema changes and existing fingerprint-aware runner; preserve contacts/channel tables and historic no-FK layout. It is not safe to cherry-pick every migration by number or merge 110 commits blindly. | Human promotion gate remains in place. |
| Optional columns by installation | All three connector revocation writers and the app mirror avoid a required deleted_at column. Duration SQL references only discovered columns. First provenance, content and attachments remain retained. | UUID and BIGINT installations intentionally need not have identical columns. |

An old NAS QR default referring to `whatsapp.e-dani.com` was reported by Marlin.
It can confuse environments, but no runtime configuration is changed here;
correcting NAS production QR configuration requires the separately stated owner
approval. The accepted feature comparisons must not follow that link and claim
they tested the NAS deployment.

## Validation

- Full web suite: **589/589 pass, zero skipped**, PostgreSQL-backed cases enabled.
- Full connector suite: **929 pass, zero fail, one existing skip**, 89 test files.
- Professional MCP identity/inbound gates: **50/50 pass**.
- Node 22 candidate image: **10/10** focused schema/HTTP/media/cursor/deletion/plan
  tests against PostgreSQL 16; enrichment plans use `messages_pkey` in both layouts.
- Migration compatibility **5/5** plus existing runner **14/14**, including the
  historical NAS ledger. Connector deletion passed UUID timestamp, UUID timestamptz
  and BIGINT metadata-only fixtures; chat-name/date SQL **3/3** passed.
- Connector TypeScript, app/connector Docker builds for local QA, diff whitespace
  and the pinned official contract checker pass. The checker reports 107 entries
  and its existing unrelated missing-marker note.
- Independent review's local/global deletion and retained-filter findings were
  fixed with reproducing regressions and retested. No blocking finding remains.

Commands and detailed evidence appear in the companion documents. Principal logs
are copied into this directory so the results remain reviewable after /tmp cleanup.
The database container uses tmpfs, no production volumes, and unique test schemas.
Dependency symlinks are local test setup and are not included in the commit.

## Delivery Limits

No live WhatsApp send, account restriction workaround, remote schema write,
container restart, image promotion, or public-site UI mutation was performed.
Passing local HTTP fixtures proves the candidate routes; it does not prove the
Oppos public deployment has been updated. PR74 remains the review vehicle and
production promotion remains a human action.
