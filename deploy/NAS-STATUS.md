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
