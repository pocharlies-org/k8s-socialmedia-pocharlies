# Registry-driven deployment

The deployed NAS state and verification results are recorded in `NAS-STATUS.md`.
Provision certificates under `<stack-dir>/config/certs` before deployment. On this
NAS that path points to the current rotated certificate bundle. Server SANs must
include the unique `socialmedia-postgres`, `socialmedia-redis`, `socialmedia-nats`
and `socialmedia-minio` names; generic DNS names collide on shared networks.

Render with Python 3 (standard library only):

```sh
python3 scripts/render-compose.py --env-file /volume2/docker/social-media/.env --accounts deploy/accounts.json --stack-dir /volume2/docker/social-media --source-dir /home/staticduo/git/socialmedia --output deploy/generated/docker-compose.json
python3 -m unittest discover -s scripts -p 'test_render_compose.py'
docker compose --env-file /volume2/docker/social-media/.env -f deploy/generated/docker-compose.json config --quiet
```

The output is JSON, also valid YAML and accepted directly by Compose. Rendering writes only the requested output and sibling `accounts.json` and `gateway.conf`; it does not deploy, copy sessions, or change the live stack. It reads the supplied environment file as data; credential values remain private and are not written to generated files. Keep these three generated files together. Required `${NAME:?set in .env}` references remain literal until Compose resolves them. Supply credentials through the deployment environment or a private, untracked environment file; do not commit values. The source path is the canonical checkout used by all builds and Redis/NATS config mounts.

Each account requires `channel` (`whatsapp` or `instagram`), `accountId` matching `^[a-z][a-z0-9_-]*$`, a nonempty `label`, `connectorUrl`, boolean `enabled`, and a `secretEnv` variable name. Optional fields are HTTPS `qrUrl` and boolean `requireInboundBeforeSend`. Channel/account pairs must be unique. Unknown fields are rejected. Deployment-only `sessionPath` is an absolute WhatsApp mount source and is removed from the generated runtime registry. The initial personal account preserves the existing session directory; other accounts get separate `data/whatsapp/<accountId>` directories under the stack path.

Add a WhatsApp entry with `connectorUrl: http://whatsapp-<accountId>:3001`. Rendering adds its service, isolated session mount, secret references, MCP registry and gateway route automatically. Provide its chosen `secretEnv` and `WA_<UPPER_ACCOUNT_ID>_SESSION_KEY` (hyphens become underscores), plus global `UI_AUTH_USERNAME` and `UI_AUTH_PASSWORD`. Each UI is served at `/accounts/<accountId>/qr/page` under `WHATSAPP_PUBLIC_BASE_URL`; the gateway strips that prefix for its internal connector. No connector or infrastructure host ports are published.

Instagram entries share `http://instagram-connector:3003` and each receives `INSTAGRAM_<UPPER_ACCOUNT_ID>_ACCESS_TOKEN` and `INSTAGRAM_<UPPER_ACCOUNT_ID>_BUSINESS_ACCOUNT_ID` references. Missing credentials leave the account waiting for configuration. The connector and MCP receive each account's `secretEnv` independently. Set `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, and `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` when connecting Meta. The gateway currently exposes WhatsApp UI routes only, so configure webhook routing separately before activating Instagram inbound traffic.

The stack preserves the existing `socialmedia_*_data` volume identities, PostgreSQL certificates outside PGDATA, TLS infrastructure configuration, and Compose project name. Migration runs the versioned migration entry point directly and applications wait for successful completion. External networks `npm_npm-net` and `llm-net` must exist. NPM targets `socialmedia-wa:80` and `socialmedia-mcp-sse:3010`; MCP applications also join `llm-net` for LiteLLM.

Generated credentials are never embedded. Build images before a controlled stack recreation, verify migration success, then verify authenticated account health and UI paths through NPM. Rendering and syntax checks alone do not establish deployment health.

Embedding defaults match the existing deployment: `qwen3-embedding-8b`, dimension `4096`, LiteLLM base URL `http://litellm:4000/v1`, and chat model `gpt-5.6-luna`. Explicit environment values override these defaults. IDs that collide after uppercase/hyphen-to-underscore normalization are rejected to avoid sharing credential/session variable names. `QR_PAGE_URL` carries each account's public QR link.

## Environment configuration

Start from `deploy/.env.example` in a private file outside version control, retaining
existing secret values from the current deployment. Fill the empty required secret
fields before Compose validation. The renderer and Compose must both receive the
same `--env-file`; Compose cannot expand variables inside the mounted account JSON
or nginx configuration. Shell variables override file values for both commands.

`PUBLIC_BASE_URL` is the public MCP/application origin; `WHATSAPP_PUBLIC_BASE_URL`
is the WhatsApp gateway origin. Set both for the deployment (the generator's local
fallback is `https://localhost`). `DASHBOARD_URL=` disables the optional dashboard
link. Changing these values requires regeneration before recreation. Public URLs
must be absolute HTTP(S) URLs, and account QR URLs must use HTTPS.

Registry string fields accept `${NAME}`, `${NAME:-fallback}` and `${NAME:?message}`;
missing required names and unresolved expressions fail rendering. The environment
parser accepts `NAME=value`, optional `export`, single/double quotes and trailing
comments; it never runs shell commands. Use simple single-line values. Per-account
`WA_<UPPER_ACCOUNT_ID>_QR_PAGE_URL`, `WA_<UPPER_ACCOUNT_ID>_CONNECTOR_URL` and
`WA_<UPPER_ACCOUNT_ID>_SESSION_PATH` override generated values without editing
source. `INSTAGRAM_CONNECTOR_URL` controls the shared Instagram endpoint. Connector
overrides change the registry and WhatsApp gateway upstream together; their
services are still generated. A remote upstream must be reachable from containers.

Database connection settings are `DATABASE_URL` or the `POSTGRES_*` parts;
`REDIS_URL`, `NATS_URL`, `MINIO_ENDPOINT`, `MINIO_USE_SSL`, `MINIO_BUCKET`,
`LLM_BASE_URL` and `EMBEDDING_BASE_URL` control dependencies. Existing TLS mounts
and certificate requirements still apply to the chosen endpoints. These settings
change application connections; bundled dependency containers are still created.
`POSTGRES_IMAGE`, `REDIS_IMAGE`, `NATS_IMAGE`, `MINIO_IMAGE`, `GATEWAY_IMAGE`,
`STACK_NETWORK`, `NPM_NETWORK`, `LLM_NETWORK`, `STACK_DIR` and `SOURCE_DIR` configure
images, networks and host paths. Existing named data volumes intentionally retain
their identities, including when the Compose project name changes.

`INSTAGRAM_GRAPH_BASE_URL`, `FACEBOOK_GRAPH_BASE_URL`, `WHATSAPP_WEBSOCKET_URL`,
`WHATSAPP_ORIGIN` and `WHATSAPP_LINK_BASE_URL` are forwarded to connectors.
Runtime credential references remain `${NAME}` expressions, so secrets are resolved
by Compose rather than persisted in generated JSON. Avoid `docker compose config`
without `--quiet` in shared logs: resolved Compose output contains credentials.

After review and in the authorized deployment window, use the same environment:

```sh
docker compose --env-file /volume2/docker/social-media/.env -f deploy/generated/docker-compose.json up -d --build
```

No deployment is performed by rendering or by the unit tests.

History recovery: set `WA_HISTORY_SYNC_ON_LOGIN=true` globally, or
`WA_<ID>_HISTORY_SYNC_ON_LOGIN=true` for a specific account. Existing sessions keep
their browser identity; new pairings request desktop/full history. WhatsApp can
limit the history delivered. Enabling after pairing does not replay a discarded
initial snapshot. Authenticated `POST /api/v1/history/backfill` requests older
messages for known chats; it scopes keys by account, sends millisecond cursors,
and stops after bounded waits without repeating the same cursor within a run.
No session needs to be deleted for this on-demand recovery.

On the NAS the repository `.env` is a symlink to the private deployment `.env`.
The root `.env.example` links to the template here. After changing domain values,
regenerate to the active bundle and apply using the same private file:

```sh
python3 scripts/render-compose.py --env-file .env --output /volume2/docker/social-media/config/20260913-env/docker-compose.json
```

The active Compose is `/volume2/docker/social-media/docker-compose.yaml`; install
the generated document there before applying. Keep its companion `accounts.json`
and `gateway.conf` in the bundle directory referenced by the generated mounts.
Changing a public domain also requires its DNS record, NPM proxy host and TLS
certificate. Changing the MCP URL requires updating its LiteLLM registration.
Environment changes cannot configure those external services automatically.

Baileys supports `WHATSAPP_WEBSOCKET_URL` but fixes its protocol Origin internally
to `https://web.whatsapp.com`. `WHATSAPP_ORIGIN` accepts that official value only;
custom values fail explicitly. Provider defaults still contact WhatsApp/Meta even
when every self-hosted service uses your own domain.

Optional upstream components are not installed by this Compose. Telegram uses
the same opt-in `DASHBOARD_URL`. The Synapse bridge requires explicit
`GATEWAY_WEBHOOK_URL` and `CONNECTOR_URL`; `TRACKING_OPT_IN_BASE_URL` optionally
enables its tracking-link filter. WhatsApp Cloud accepts
`WHATSAPP_GRAPH_BASE_URL` (without version) and `WHATSAPP_GRAPH_API_VERSION`.
Their own deployments must pass those variables if enabled later.

Object storage accepts `S3_ENDPOINT`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` as primary overrides, plus `LEGACY_MINIO_ENDPOINT`,
`LEGACY_MINIO_BUCKET`, `LEGACY_MINIO_ACCESS_KEY` and `LEGACY_MINIO_SECRET_KEY` for
reading historical objects. Use an explicit `http://` or `https://` scheme in S3
and legacy endpoints to select TLS consistently across MCP and connectors.
`S3_PUBLIC_ENDPOINT` enables public presigned WhatsApp media URLs;
`S3_PRESIGN_EXPIRY_SECONDS` controls their lifetime. `S3_USE_SSL` and
`LEGACY_MINIO_USE_SSL` are WhatsApp connector fallbacks for schemeless endpoints.
MCP uses `S3_PREFIX`; each WhatsApp account uses `WA_<ID>_S3_PREFIX` (personal
retains an empty prefix; new accounts default to `whatsapp/<accountId>`).
Per-account Instagram `INSTAGRAM_<ID>_APP_ID`, `INSTAGRAM_<ID>_APP_SECRET` and
`INSTAGRAM_<ID>_FB_ACCESS_TOKEN` are forwarded alongside access token/business ID.

HTTPS WhatsApp connector overrides enable upstream SNI and certificate verification
in nginx. The upstream Host header follows the connector hostname. Public upstreams
use the nginx image's `/etc/ssl/certs/ca-certificates.crt` bundle by default; custom
nginx images must provide that bundle. For private certificates, set
`GATEWAY_UPSTREAM_CA_FILE` to an absolute host CA bundle path, then regenerate; the
gateway mounts it read-only. Include every required root in that bundle when mixing
public and private HTTPS upstreams.

`CERTS_DIR` overrides the absolute host directory used by all certificate mounts
(default: `<STACK_DIR>/config/certs`). Application `MINIO_CA_CERT`, `NATS_CA_CERT`,
`REDIS_TLS_CA` and `NODE_EXTRA_CA_CERTS` default to `/certs/ca.crt` only when unset.
Set them explicitly empty for external services using system trust, or point them
to a certificate file available inside the container. An empty CA override keeps
TLS certificate verification enabled; it changes which roots are trusted. Bundled
infrastructure still needs its existing server/client certificates.

## WhatsApp web app

The optional `apps/whatsapp` application is part of this repository. Set
`WHATSAPP_APP_ENABLED=true` and `WHATSAPP_APP_PUBLIC_URL` in the private deployment
`.env`, then render the Compose bundle again. Its internal port is 3080; route
Nginx Proxy Manager to `socialmedia-whatsapp-app:3080` on the shared NPM network.
The source remains in the checkout; persistent app state is under
`STACK_DIR/data/whatsapp-app`. The same generated account registry drives the UI.

Avatar downloads use an account-scoped, bounded cache to avoid querying WhatsApp
on every chat-list refresh. `APP_AVATAR_CACHE_TTL_MS` defaults to 30000;
`APP_AVATAR_NEGATIVE_CACHE_TTL_MS` defaults to 5000 for unavailable photos.
`APP_AVATAR_CACHE_MAX_ENTRIES` and `APP_AVATAR_CACHE_MAX_BYTES` default to 256
and 16777216 respectively. Photos and last-seen data remain subject to the
contact's WhatsApp privacy settings.

`APP_ENABLE_SENDING` controls the browser action gate, `WA_ENABLE_SENDING` the
WhatsApp connector gate, and `ENABLE_SENDING` the MCP gate. Browser sending needs
both browser and connector gates enabled. `EMERGENCY_DISABLE_SENDING=true` blocks
app sending regardless of the other switches. Do not interpret a submitted request
as successful until the connector confirms a message ID.

Configure `HERMES_API_URL` and `HERMES_API_KEY` for the optional agent integration.
`LITELLM_BASE_URL` and `LITELLM_API_KEY` override the existing model endpoint/key;
otherwise the app inherits `LLM_BASE_URL` and `OPENAI_API_KEY`. The agent must have
its Socialmedia MCP configured; availability of the model catalog alone does not
prove tool execution. Never put any of these keys in the frontend or its manifest.
