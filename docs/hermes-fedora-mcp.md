# Hermes on Fedora: current WhatsApp chat MCP

The SocialMedia web app uses a dedicated Hermes profile on Fedora. The existing
Hermes installation and multiplexed gateway serve it at `/p/socialmedia/v1`;
the default profile and its Telegram tools remain separate. The web app owns
the authenticated owner's instruction; the MCP direct-send tool delivers to
the selected WhatsApp connector, while draft approval stays in the web app.

Reuse the existing `socialmedia` profile; do not install another Hermes or start
another gateway. Configure `~/.hermes/profiles/socialmedia/config.yaml` with the
same provider settings as the default profile, its general API toolsets,
skills, and LazyMCP configuration. Keep platform messaging credentials on the
default profile so two profiles do not consume the same bot credential. The
SocialMedia-specific MCP entry is:

```yaml
platform_toolsets:
  api_server: [all]
agent:
  disabled_toolsets: []
approvals:
  mode: "off"
skills:
  external_dirs: [/home/staticduo/.hermes/skills]
mcp_servers:
  socialmedia_current_chat:
    url: https://ss.staticduo.com/mcp
    transport: streamable-http
    headers:
      Authorization: "Bearer ${SOCIALMEDIA_MCP_TOKEN}"
    enabled: true
    connect_timeout: 15
    timeout: 45
    tools:
      include: [social_read_current_chat, social_send_current_chat, social_deliver_current_chat]
      resources: false
      prompts: false
```

Store `SOCIALMEDIA_MCP_TOKEN`, the provider key, `API_SERVER_ENABLED=true`, and
a unique `API_SERVER_KEY` in the profile's `.env` with mode `0600`. The MCP token
is the existing SocialMedia `MCP_SSE_AUTH_TOKEN`; never put its value in this
repository or in `config.yaml`. Keep the profile's `config.yaml` mode `0600`.
Set the deployment's `HERMES_API_URL` to the Fedora gateway URL ending in
`/p/socialmedia/v1` and `HERMES_API_KEY` to this profile's API key. Do not use
the default profile's API key for this path.

Set `HERMES_DEFAULT_MODEL=gpt-6-luna` in the Compose `.env` to select the app's
model independently of other Hermes conversations. Hermes can persist a model
selection on an existing session; its official
`POST /api/sessions/{session_id}/model` endpoint changes that selection without
replacing the session or losing history. The profile's default should match the
app's model for requests that do not supply an explicit selection.

The web app issues a signed capability for one owner-selected account, chat,
and turn. The profile also exposes the owner's general Hermes tools.
`social_send_current_chat` creates a pending proposal for web approval;
`social_deliver_current_chat` delivers according to the owner's current web
instruction, in any language or word order. The app does not infer permission
from a sending verb. Normal assistant turns grant the owner's tools; their
instruction controls which actions should run. The dedicated draft button has no direct-send
grant and still only inserts its suggestion into the composer. Set
`HERMES_CHAT_ALLOW_DIRECT_SEND=true` for both `whatsapp-app` and `mcp-sse` in
Compose to enable this behavior; keep global `ENABLE_SENDING` independent.
Incoming WhatsApp content is untrusted data and does not grant authority to
use either sending tool. Each direct call uses a stable owner-request ID and
connector send token so retries across Hermes turns and browser clients do not
duplicate messages. The app persists the request ID before invoking Hermes and
reuses it for the same owner instruction for ten minutes.
When the owner requests several deliveries, use a distinct `idempotencyKey` for
each message and reuse that key on retries. The delivery ledger remains scoped to
the signed owner request; connector confirmation is the delivery evidence.

The profile has separate sessions, built-in memory, and skills. To let it use
the default assistant's accumulated knowledge without saving untrusted
WhatsApp content to the shared bank, set `memory.provider: hindsight` in the
profile config and give the profile its own `hindsight/config.json` with the
same `bank_id: user-staticduo`, `memory_mode: hybrid`, and
`auto_retain: false`. Put its Hindsight URL and API key only in the profile's
mode-`0600` `.env`. Hybrid mode makes explicit memory tools available while
avoiding automatic retention of untrusted WhatsApp content. Reuse the default
profile's skills and non-messaging tools, without copying Telegram, WhatsApp,
or Home Assistant credentials that would collide with the default gateway.

Check the connection with `hermes -p socialmedia mcp test
socialmedia_current_chat` and the effective filter with `hermes -p socialmedia
mcp list` (expect `3 selected`). The diagnostic test enumerates the server's
full catalog before applying the Hermes filter.
Restart the existing gateway after changing profile configuration so it serves
the new profile. Verify `/p/socialmedia/v1/toolsets` includes general tools and
LazyMCP, and complete a real owner-authored turn. Do not start a second gateway
process for the same profile.

`api_server: [all]` selects tools but does not grant execution approval. For this
owner-controlled panel, keep `approvals.mode` aligned with the owner's default
profile (`"off"` above); otherwise Hermes treats API turns as unattended and can
block `execute_code` even though that tool is enabled. This does not turn incoming
WhatsApp history into an authorized instruction.

Profiles do not automatically inherit authenticated integrations or skill script
paths. Reuse the existing Fedora skills and user-level CLI connections before
requesting new OAuth setup. In particular, a missing profile-local
`google_token.json` says nothing about an already authenticated `gog` connection.
Validate the existing connection with a read-only call, and keep keyring values
out of tool output and source control.

Hermes persists assembled prompts for resumed API sessions. Restarting the gateway
does not refresh those snapshots after changing profile instructions. Back up the
affected prompt and use `hermes -p socialmedia sessions repair-prompts SESSION_ID
--apply --json` for the specific session; the next turn rebuilds the prompt while
retaining its messages. Verify that same session, rather than only a new QA session.

For a file-based `gog` keyring, merely sourcing its environment file may leave the
password unexported. The Fedora profile's `bin/gog` wrapper loads it with tracing
disabled and `set -a`, then executes the installed CLI. Profile instructions should
use this wrapper so unattended API turns do not attempt an interactive unlock.

## Audio, Runs And Images

The existing Fedora `tts.provider: omnivoice` configuration invokes
`/home/staticduo/.hermes/scripts/omnivoice_tts.py` against the existing service.
Use `text_to_speech`, then convert its returned Fedora audio file into a data URL
with `terminal` or `execute_code`. Deliver it with
`social_deliver_current_chat({capability, media: {url: "data:audio/ogg;base64,...",
name: "audio.ogg"}, idempotencyKey: "audio-1"})`. A Fedora filesystem path cannot
be read by the NAS connector. Generated audio is not an uploaded audio input:
Hermes advertises `audio_api: false`.

The default app transport uses the installed Hermes `/v1/runs` API. Submission
returns a run ID; `/v1/runs/{id}/events` carries deltas, tool activity and the final
terminal event. The app persists the run ID and turn ID so stop can address the
same execution after a lost browser connection. An admitted run without a
confirmed terminal result is not automatically resubmitted.

`POST /api/ai/stop` accepts `{account, chat, turnId, sessionId?}`. It revokes the
current chat capability, calls `/v1/runs/{id}/stop`, then checks run status. Only
a terminal result returns `{stopped: true, status, turnId}`; `stopping` alone is
not confirmation. Cancelling a browser stream does not stop the Fedora run.
Assistant SSE returns `{sessionId, text: "", status: "cancelled", cancelled: true}`
for cancellation (also `interrupted` after gateway interruption). Stop cannot
undo an action already confirmed by a connector.

Assistant input accepts `images: [{name, url}]` containing base64 data URLs for
PNG, JPEG, WebP or GIF, at most four images and 8 MiB decoded bytes in total.
The app sends and persists OpenAI multipart `text`/`image_url` content. Remote
URLs, file paths, PDFs and audio uploads are not accepted as assistant image input.
`HERMES_RUNS_ENABLED=false` retains the legacy Chat Completions transport only for
compatibility; it cannot provide run cancellation and is not used in deployment.

Live inspection on 2026-10-06 confirmed `run_submission`, `run_events_sse` and
`run_stop` on the existing gateway, API toolsets `[all]`, approvals `off`, shared
skills and OmniVoice. The missing `codex-remote-bridge` MCP entry was copied from
the default profile with a private configuration backup; gateway reload remains
part of coordinated deployment. `hermes -p socialmedia skills list` confirms
external enabled skills. `/v1/skills` currently returns 500 because the installed
API calls `_find_all_skills(include_editorial=True)` while that helper accepts
only `skip_disabled`; this catalogue defect is separate from skill execution.

A native owner QA run on 2026-10-06 invoked `text_to_speech` successfully with
provider `omnivoice`. Independent file inspection confirmed a nonempty Ogg
audio file: 16,827 bytes and 3.0065 seconds. No WhatsApp delivery was requested.
The installed API exposes no supported download route for that local audio file;
local audio preview remains unavailable, while supported public audio URLs can
be rendered by the web app. Browser artifact download is disabled in this profile
and its MIME allowlist excludes audio.
