# Temporary Telegram indexing pause

## Scope

User requested temporarily leaving Telegram out of Hindsight after PostgreSQL
consumed a CPU core. Telegram synchronization remains enabled, WhatsApp indexing
continues, and existing source messages, Hindsight documents and pending ledgers
are preserved. This pauses new worker requests; it does not cancel provider
operations already accepted or purge indexed Telegram history.

## Cause and implementation

Telegram conversation upserts assigned the unchanged name for every message.
Migration 034's name trigger rebuilt every historical scope for OLD and NEW.
One conversation had 1,158 scopes, yielding up to 2,316 queue updates per upsert.
Live counters increased by 88,008 queue updates for 38 conversation updates in
87 seconds. PostgreSQL CPU measured 98-103%, memory approximately 200 MiB.

Code commits: `2cc64a4`, `baf1fcf`.

- New migration **036** adds `hindsight_sync_platform_policy` and guarded capture,
  enqueue and name-change functions. A no-op conversation name update returns
  before scanning history; excluded canonical providers also exit early.
- The worker applies `HINDSIGHT_SYNC_EXCLUDED_PLATFORMS` under its destination
  lock before provider requests. Strict names: whatsapp, telegram, instagram.
- Seed, legacy pending/remaining and conversation candidates respect the policy,
  including persisted pending documents. Exclusion never deletes them.
- Empty configuration preserves all platforms. Resume requires reseeding the
  destination to recover changes made while paused; see hindsight-provider.md.

## Validation

- 42 tests passed in five Hindsight suites, including real PostgreSQL 16.15
  trigger/consumer tests in a disposable database and the existing append/edit/
  rename/topic/delete regression tests. The phonebook fixture uses the maintained
  connector's `whatsapp_contacts` DDL.
- 19 Compose renderer tests passed, including invalid platform rejection before
  rendering. TypeScript noEmit, build and proportional independent review passed.
- Pinned official checker: 103 contracts, no new findings; one existing marker
  note remains. Published migrations 033-035 are unchanged.

## Deployment and observations

Published maintained MCP image, manifest verified:

`docker.staticduo.com/socialmedia-mcp@sha256:38278f5e9835b0e6ae0cd085df803263bd52d2d908349289c6dc8bd62400a54e`

Migration 036 alone ran through the published maintained migrator. Its recorded
SHA-256 is `20061c094e27ea76edd56935738a56c2facd1fd36b3f42cd7680c29c06f6468c`.
Schema/config backups were retained. Compose changes only the worker/migrator
image pins and worker exclusion environment; `.env` sets the exclusion to
`telegram`. Only hindsight-sync was recreated. Backend, web and connectors keep
their existing images/configuration.

At 18:23:38 UTC the policy readback showed Telegram=false, WhatsApp/Instagram=true.
Worker readback confirmed exclusions=telegram, loop=true, published digest and no
restarts. Between **18:24:07 and 18:24:48 UTC**:

- Telegram queue revision sum remained `153979672667` and document update time
  remained `18:22:51.797115`. Its 77,481 stored messages were retained.
- WhatsApp document update time advanced to `18:24:45.066055`; live worker passes
  accepted operations with zero failures. Acceptance is not completion proof.
- PostgreSQL CPU samples fell from 101.94% before rollout to 3.90%, then 0.27%.
  These are measured samples, not a claim about all future workload.
- Telegram sync/connector and both WhatsApp connectors remained healthy; recent
  Telegram sync logs had zero ERROR/Traceback markers. No test messages were sent.
- Public web health and Hindsight health returned 200. Web/backend were not
  redeployed for this change.
