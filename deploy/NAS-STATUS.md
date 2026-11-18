# NAS deployment - 2026-09-12

## Environment configuration update - 2026-09-13

The active private configuration is `/volume2/docker/social-media/.env`, also
available through `/home/staticduo/git/socialmedia/.env` (ignored symlink).
`.env.example` points to the complete template in `deploy/`. Public and provider
URLs, dependencies, storage, per-account overrides and trust settings are
documented in `deploy/README.md`.

The current registry and gateway bundle is
`/volume2/docker/social-media/config/20260913-env/`. Compose now keeps credential
references and reads the private `.env`; the old description of resolved inline
credentials below applies only to the previous backup. Sessions and keys were
preserved. Only application containers/gateway were recreated; databases, Redis,
NATS and MinIO were not restarted.

`https://ss.staticduo.com/` now serves the public access page (HTTP 200).
`/mcp` and `/sse` still reject anonymous requests (401), and authenticated LazyMCP
lists all three accounts. Both QR URLs now use `ss-wa.staticduo.com` throughout.
`DASHBOARD_URL` is blank, disabling the inherited notifier rather than contacting
an old remote address. No DNS or NPM changes were needed; both existing domains
already route to the correct services.

Verification: MCP 197 tests pass, WhatsApp 50, Instagram 7, renderer 12. Optional
undeployed Telegram/Cloud/bridge URL changes pass 44 tests combined. TypeScript
checks pass. Live HTTPS and read-only MCP validation pass. QR pairing and Meta
credentials remain user setup steps; sending stays disabled.

Pre-update files: `/volume2/docker/social-media/backups/20260913-093018-env-config/`.

## Previous Deployment Record

Source: `/home/staticduo/git/socialmedia`.
Active Compose: `/volume2/docker/social-media/docker-compose.yaml`.
Runtime registry and gateway: `/volume2/docker/social-media/config/20260912-multiaccount/`.
Active TLS certificates: `/volume2/docker/social-media/config/20260912-multiaccount-v2/certs/`.

Configured accounts are WhatsApp `personal`, WhatsApp `secondary`, and Instagram
`instagram`. The registry drives routes, capabilities, policy and generated
services; further accounts require configuration and credentials, not source edits.

MCP: https://ss.staticduo.com/mcp (existing Bearer token).
WhatsApp selector: https://ss-wa.staticduo.com/.
Browser credentials are in `/home/staticduo/socialmedia-access.txt`, mode 0600.
Both WhatsApp accounts currently have a QR available and require user pairing.
Instagram reports `setup-required` until Meta credentials are configured. Its
webhook is not publicly routed; configure a verified Meta callback before enabling
inbound Instagram events. No real messages were sent. Sending remains disabled.

The first WhatsApp session mount and encryption key were preserved. The old
`whatsapp-connector` container is stopped; do not start it alongside the new
`whatsapp-personal` instance because they share the preserved session directory.

The eight versioned migrations completed and reran successfully. A restricted
pre-change PostgreSQL dump, Compose, environment and certificates are in
`/volume2/docker/social-media/backups/20260912-202451-multiaccount/`.
Database, Redis, NATS and MinIO use unique `socialmedia-*` DNS aliases to avoid
collisions on shared Docker networks. Infrastructure images are pinned by digest
in the active Compose. No infrastructure or connector host ports are published.
NPM host 141 now forwards to `socialmedia-wa:80`; MCP stays on
`socialmedia-mcp-sse:3010`. Existing DNS records were retained.

Local private certificate material was rotated and access restricted. Historical
Git objects were not rewritten. The active Compose contains resolved credentials
and is private/untracked; never copy it into the source repository. Generator
outputs contain variable references only. Keep secrets out of Git.

Validation: server 195 tests passed (four skipped, including three PostgreSQL
integration tests run separately); WhatsApp 46 passed; isolated schema migration
five passed; real PostgreSQL account/channel isolation three passed. Independent
review covered auth, webhooks, attachments, migration and cross-account queries.
Live HTTPS checks passed MCP initialize, tools/list, social_list_accounts and
conversation reads for both WhatsApp accounts. Anonymous MCP/history/QR requests
return 401; authenticated QR requests return 200. All long-running services are
healthy (gateway has no healthcheck). LiteLLM embeddings return 4096 dimensions.

Operational verification script: `/home/staticduo/tmp/socialmedia-verify.py`.
It performs read-only requests and prints only outcomes/counts.

## 2026-10-08: Optional Hindsight Activated

The earlier sections are historical snapshots. The NAS now selects
`SEMANTIC_PROVIDER=hindsight` with the dedicated bank ID and display name
`socialmedia-staticduo`. The private deployment uses the existing Hindsight API
over its internal Docker route; credentials remain outside Git.

Backend services `mcp-server`, `mcp-sse`, `migrate` and the new `hindsight-sync`
use revision `2c24b2eba2aa12586f36e74508ed4955fb710d13`. Migration 033 completed
with exit code 0. The web, connectors and infrastructure retain their existing
container IDs. The registered UGREEN project remains `socialmedia` at
`/volume2/docker/social-media/docker-compose.yaml`.

Both backend health endpoints returned HTTP 200. The WhatsApp public route
returned the expected authentication redirect. Hindsight confirmed `chunks`
extraction, 100 imported documents and zero failed operations at the first
provider check. A subsequent read-only search through the deployed SearchService
returned `mode=semantic`, found the expected PostgreSQL message and had no partial
errors. These counts are snapshots: historical import continues automatically
in batches of 100 with a 30-second interval, alongside new message changes.

The three empty `socialmedia-qa-*` banks created during integration tests were
deleted and their absence verified. Disposable PR74 tooling/PostgreSQL containers
and identified temporary QA environments/scripts were removed. Production banks,
runtime volumes, source checkout and rollback backups were preserved.

## 2026-10-08: Upstream Adoption Agreement

Migration 033 is published and deployed; subsequent NAS migrations must use 034
or a higher unused number without renumbering any published migration. Upstream
adopts selected PR74 stages rather than merging the PR in full. Its semantic
search stage can retain the default brain provider, provider/account/chat
isolation and textual fallback; the Hindsight URL and bank are NAS deployment
configuration. Upstream summaries, Synapse and CO_OCCURS remain outside this
integration's scope. Invalid provider values must still fail before rendering.

The previously requested minor fixes are already published: `6462940` requires
Instagram webhook signatures for environment-configured accounts; `d14f350`
registers that signed webhook contract; `5df2f35` corrects its source references.
The official pinned checker was rerun for `5df2f35..387d0bf` and reports
`contracts: OK (100 entries)`. Its existing missing-marker note for
`metric.brain-windows.refused-deletes.v1` is nonblocking. Future upstream adoption
must revalidate its resulting registry with that checker rather than assume a
contract count from this report. This agreement update changes no runtime service.

## 2026-10-08: Conversation Memory Rebuild

Backend and sync services now use immutable image `socialmedia-mcp:1b1c57e`.
The conversation implementation is `52aae75`, with the phonebook-title priority
correction in `1b1c57e`. Migration 034 completed successfully. The web and
connectors were not rebuilt for this delivery.

With Jordi's explicit approval, only `socialmedia-staticduo` and its destination
indexing state were reset. The 6,958 previous documents and PostgreSQL backup
remain at `/volume2/docker/social-media/backups/conversation-memory-20261008-095711`;
the five original manifest checksums and sizes were verified. Messages, contacts
and `user-staticduo` were preserved.

Stop `hindsight-sync` before resetting its ledger: its legacy drain persists
selected operations with an upsert and can otherwise recreate deleted rows.
Pause the Hindsight worker while clearing this bank's outstanding operations;
bank deletion alone does not remove those operations. The final reset verified
zero old documents, memory units and legacy ledger entries before restarting.
The rebuild seeded all 382 source conversation/topic scopes in one transaction;
the normal worker continues in batches of 10 every 30 seconds. This is an ongoing
historical rebuild, not a claim that every conversation has finished indexing.

The new documents retain canonical JSONL transcripts under a stable account/chat
identity. New turns append to the same document. Edits, deletes, late history and
name changes replace its canonical contents. WhatsApp phonebook names take
priority over stale conversation labels, including in document titles. Search
hydrates results from PostgreSQL and applies local deletion and account filters.
The implementation does not replicate upstream Brain's graph.

Validation: 816 MCP tests passed (15 skipped); the final nine conversation tests
also passed against disposable PostgreSQL. Fresh/legacy migration tests and the
NAS schema-copy migration passed. TypeScript and the pinned contract checker
passed (100 entries, existing nonblocking marker note). A production document
contained 785 source messages with exactly matching original text, and a deployed
semantic search returned PostgreSQL messages with zero failures. A real-provider
QA run passed same-document append without duplicates, phonebook names, rename
without a new message, canonical edit replacement, PostgreSQL-backed search and
immediate local hiding of deleted messages. Its disposable PostgreSQL container,
temporary scripts and both synthetic Hindsight banks were removed; provider reads
confirmed no remaining QA banks or operations. Production backups were preserved.
No GitHub checks were reported for the published PR74 head; this is not a CI-green
claim.

Hindsight's existing API was kept, with bounded worker/pool concurrency and one
reserved retain slot. Slow personal-bank operations can still delay queued work;
accepted operations are not counted as completed. After API recreation, Nginx's
static advanced upstream retained an old Docker address; a validated Nginx reload
restored the public Hindsight health endpoint to HTTP 200. Both SocialMedia
backend health endpoints returned 200, the public WhatsApp route returned 302,
and the existing UGREEN `socialmedia` registration was verified read-only.
