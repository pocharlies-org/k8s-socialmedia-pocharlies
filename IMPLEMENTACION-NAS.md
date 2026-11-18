# Multi-account NAS Implementation Plan

**Goal:** Two WhatsApp accounts and one Instagram account, extensible through configuration.
**Architecture:** A JSON account registry drives the MCP catalog and generated Compose services. Each WhatsApp connector has an isolated session; PostgreSQL IDs and queries preserve account identity. Authentication protects browser and connector APIs.
**Tech Stack:** Node 22, TypeScript, PostgreSQL/pgvector, Docker Compose, NPM.
**Spec:** ADAPTACION-NAS.md (approved by user: haz los cambios).

## Constraints

- Source: /home/staticduo/git/socialmedia. Deployment: /volume2/docker/social-media.
- Preserve all existing data, sessions, unrelated changes and original clones.
- No real messages sent during tests. No upstream push or unrelated restarts.
- Secrets never emitted or committed. Keep account config free of secrets.

## Tasks and ownership

- [x] Account routing: domain/account.ts, new domain/account-registry.ts, mcp/server.ts, Instagram ingestion, search and their tests. SOCIAL_ACCOUNTS_FILE reads a JSON array of {channel, accountId, label, connectorUrl, enabled, qrUrl, requireInboundBeforeSend}. IDs use lowercase letters, digits, underscores or hyphens. Unknown accounts fail; no sibling-account fallback. Disabled accounts are not routed. New accounts require configuration only.
- [x] Schema and migrations: infrastructure/database/migrate.ts and migrations; connector db-writer.ts; integration tests. Versioned transactional migrations with advisory locking reconcile UUID legacy schema with text provider IDs without destroying data. Test ingestion/read isolation and reruns on a disposable PostgreSQL instance.
- [x] Connector authentication: whatsapp-web main.ts and API controller, authentication helpers and tests. Protect QR, history and mutations; browser Basic auth plus connector shared-secret auth. No unauthenticated history. Per-account credentials supplied by Compose.
- [x] Deployment: scripts/render-compose.py, deploy/accounts.json, deployment templates and tests. Generate two WA services, Instagram and MCP configuration; source builds from canonical clone. Runtime data under stack data directories; preserve existing first-account session path. Remove direct external service ports; expose only gateway through NPM. Secrets are local files.
- [x] Integration: test account catalog, unknown/third accounts, same provider IDs in multiple accounts, migration reruns, auth rejection/acceptance, embedding dimensions and Compose validation.
- [x] Review and deploy: independent adversarial review; backup; fix blockers; targeted rebuild and recreation; verify HTTPS auth, MCP tools and actual schema. Record paired/unpaired status honestly.
