# WhatsApp browser app

Node 22 HTTP server with PostgreSQL reads, signed manual connector sends and an
external Hermes AI adapter. Build this directory as its own Docker context.

Required: APP_AUTH_MODE, APP_PUBLIC_URL (browser HTTPS origin), DATABASE_URL,
SOCIAL_ACCOUNTS_FILE and DATA_DIR (writable by UID 1000). The registry
is an array of enabled WhatsApp accounts with accountId, label, connectorUrl and
secretEnv; each named secret must also exist in the app environment.

Authentication is selected explicitly with `APP_AUTH_MODE=oidc` or
`APP_AUTH_MODE=basic`. OIDC mode requires `OIDC_ISSUER_URL` (the Keycloak apps
realm issuer), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and a nonempty,
comma-separated `OIDC_ALLOWED_SUBJECTS` list containing the owner's stable Keycloak
`sub`. `OIDC_SESSION_TTL_SECONDS` defaults to 2592000 (30 days) and may be set
between 1 and 2592000 seconds. The confidential client must allow only the authorization-code
flow with the exact callback `${APP_PUBLIC_URL}/auth/callback`; PKCE S256 is sent
for every login. OIDC discovery is lazy, so a temporary identity-provider outage
does not make the container fail at startup. Discovery and callback failures fail
closed with an authentication error.

OIDC protects the UI, APIs and media routes with an opaque, bounded session
persisted in `/data/auth/oidc-sessions.json`. The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax` and scoped to
the host. `GET /auth/login` and `GET /auth/callback` are the only unauthenticated
OIDC routes besides `GET /health`; `POST /auth/logout` requires the configured
Origin and clears the local session. Expired API sessions return a JSON 401 with
`code: AUTH_REQUIRED`, and the browser redirects to the login flow. Basic
credentials (`UI_AUTH_USERNAME` and `UI_AUTH_PASSWORD`) are supported only in
explicit Basic mode for local compatibility and are ignored in OIDC mode.

For Basic mode, set `UI_AUTH_USERNAME` and `UI_AUTH_PASSWORD` as well as
`APP_AUTH_MODE=basic`.

Sending requires APP_ENABLE_SENDING=true and EMERGENCY_DISABLE_SENDING not true,
plus the connector's separate sending gate. Connector responses without a provider
message ID and timeouts return an explicit unconfirmed error; do not retry blindly.
Uploads accept up to 10 MiB of image/video/audio/PDF. Voice recordings are decoded
by ffmpeg and normalized to Ogg Opus, with a ten minute duration limit.

AI requires LITELLM_BASE_URL (including /v1) and LITELLM_API_KEY for the model
catalog, plus HERMES_API_URL and HERMES_API_KEY pointing at an existing
OpenAI-compatible Hermes gateway: the NAS does not bundle a Hermes. Point
HERMES_API_URL at the existing gateway's `/p/socialmedia/v1` profile endpoint
and use that profile's API_SERVER_KEY as HERMES_API_KEY. Configure
HERMES_DEFAULT_MODEL=gpt-6-luna and HERMES_PROVIDER for the existing provider.
Profile deployment and MCP configuration are documented in
[Hermes on Fedora](../../docs/hermes-fedora-mcp.md).

The panel submits messages optimistically, clears the composer immediately, and
streams the answer with temporary thinking/tool activity. The app's SSE events
carry sanitized status labels, text deltas, and the confirmed final result;
internal reasoning, tool arguments, and credentials are not displayed. An
interrupted stream is an error, not a completed answer. Failed turns keep the
owner's message, mark partial answers as incomplete, and offer an explicit retry
without adding another local bubble. Retries preserve the turn identifier so a
lost response cannot create a fresh delivery attempt.

Each turn continues a stable Hermes conversation and is namespaced so the shared
agent's other sessions and long-term memory are untouched. The agent/session
model is one canonical session per (account, chat, global):

- x-hermes-session-key: whatsapp-app:<canonicalSessionId> scopes Hermes long-term
  memory to this app conversation; the whatsapp-app: prefix keeps it separate
  from every other caller, so using it never overwrites Fedora memory.
- x-hermes-session-id carries continuity: the canonical UUID on the first turn,
  then the id Hermes echoes back, so Hermes loads history from its own state.
- A Responses API object (object: response) is also accepted: its id is stored as
  previous_response_id and any conversation is replayed, when the gateway uses
  that API.

Completion is judged from the official response, not headers alone: a turn is
accepted when the body or headers affirm it (Chat Completion finish_reason stop,
or Responses status completed, with hermes.completed not false and
X-Hermes-Completed not false) and it carries an answer plus a continuation
handle. A truncated or failed turn is never stored as a completed answer: JSON
requests return an error status, while an already-open SSE response emits an
`error` event.

The existing Fedora profile exposes the scoped current-chat MCP tools alongside
its configured general tools. `social_read_current_chat` reads context,
`social_send_current_chat` creates a proposal, and `social_deliver_current_chat`
can send when the authenticated owner's current instruction authorizes it.
The dedicated draft button never grants direct delivery. Incoming WhatsApp
messages are untrusted reference data and cannot authorize actions.

The app request contains scoped recent conversation context; tool tenant
isolation must be enforced by the Hermes/MCP deployment, not by prompt
instructions. AI sessions are atomic private JSON files scoped to account, chat
and explicit global mode. Run one app replica per DATA_DIR; locking is within one
process.

Media references are resolved only after an account/chat-scoped DB lookup.
HTTP references require exact MEDIA_ALLOWED_ORIGINS (comma separated, no redirects).
S3 references use S3_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET,
S3_USE_SSL and optional AWS_REGION; corresponding MINIO_* names are supported.
MEDIA_ALLOWED_BUCKETS can allow multiple buckets explicitly. Legacy plain keys use
MINIO_BUCKET. The app signs S3 GETs and never exposes credentials or stored URLs.

Run npm ci and npm test. Tests use a stub database and HTTP upstream; they never
send real WhatsApp messages. GET /health is public and reveals no configuration.
The remaining UI/API routes require the selected authentication mode, and JSON
POST requests must include the exact configured Origin. TLS should terminate at
the proxy.

Agent chat screenshots use synthetic conversations:
[desktop](../../docs/screenshots/agent-chat-desktop.png) and
[mobile](../../docs/screenshots/agent-chat-mobile.png).

## NAS verification (2026-09-13)

Published at the configured WHATSAPP_APP_PUBLIC_URL, currently
https://whatsapp.staticduo.com. Access uses the same private UI credentials as the
QR pages. Two accounts, authenticated chat reads, media downloads and the model
catalog were checked through HTTPS. Desktop/mobile Chromium checks cover account
switches, draft isolation, themes, assistant navigation, attachment confirmation
and microphone capture/preview with a simulated device. No real messages were
sent by verification. Eleven backend tests and thirteen generator tests pass.

The external shared agent runs under its own configured toolsets; the selected
chat and global checkbox determine starting context, not a separate authorization
boundary. Because it does not register the socialmedia MCP, it does not send on
its own; use the assistant answer as a composer draft to review and send manually
via /api/send.

Current limits: the latest 200 stored messages per chat are displayed; history
availability depends on provider synchronization. Uploads are limited to 10 MiB.
Calling/video calls, automatic voice transcription and AI-triggered sends are not
implemented. Browser codec support determines which media can play inline;
originals remain downloadable. The app does not cache conversations offline.
