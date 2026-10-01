# Socialmedia MCP contract v2

Socialmedia exposes one provider-neutral MCP contract for WhatsApp, Telegram,
and Instagram. The canonical registry lives in
`mcp-server/src/mcp/tool-registry.ts`; `contracts/socialmedia-tools.json` is its
deterministic, SHA-256-addressed projection for AgentGateway, OpenClaw,
documentation, and deployment checks.

There is no legacy catalog, alias layer, `_live` variant, or `/v2` endpoint.
Unknown historical names return `method not found`.

## Endpoint

- Streamable HTTP: `https://mcp-socialmedia.e-dani.com/mcp`
- SSE: `https://mcp-socialmedia.e-dani.com/sse`
- In-cluster: `http://mcp-sse.whatsapp-mcp.svc.cluster.local:3010/mcp`

AgentGateway exposes the authorized route at `/social`. Its rules and the MCP
catalog must carry the same contract digest before deployment.

## Common contract

- `channel`: `whatsapp`, `telegram`, or `instagram`.
- `accountId`: the configured provider account.
- `target`: always a string containing the provider-native peer, group,
  conversation, message, media, or comment target expected by that operation.
- Every mutation requires explicit `channel` and `accountId`.
- A numeric-looking target never selects a channel.
- Reads accept `readSource: auto | provider | index`.
- Unsupported source/provider combinations return
  `unsupported_capability`; they never masquerade as an empty list.

Read results include:

```json
{
  "source": {
    "kind": "providerQuery",
    "asOf": "2026-07-27T12:00:00.000Z",
    "completeness": "complete"
  }
}
```

Aggregated reads may return `completeness: partial` and `partialErrors` per
channel/account.

Tool results use `structuredContent`:

```json
{
  "ok": true,
  "status": "accepted",
  "data": {},
  "meta": {}
}
```

Provider failures set MCP `isError` and include a structured `error`. A timeout
after a provider may have accepted a mutation returns `outcome_unknown`.

## Canonical tools

The exact catalog table is generated at
`contracts/socialmedia-tools.md`. The machine-readable manifest and test
fixture is `contracts/socialmedia-tools.json`; it contains every input/output
schema, effect, scope, annotation and capability. Both files are regenerated
from the same typed registry and checked by CI.

## Sending

```json
{
  "channel": "telegram",
  "accountId": "personal",
  "target": "-100123456",
  "message": "Texto",
  "attachments": [],
  "replyTo": null,
  "threadId": null,
  "idempotencyKey": "optional"
}
```

`replyTo` and `threadId` are independent. Reusing an `idempotencyKey` with the
same payload replays the stored result; changing the payload returns
`conflict`.

The deployed WhatsApp accounts use Baileys. They advertise
`templates: false`; official Cloud API templates are not claimed until that
transport is actually deployed.

## Telegram administration

`social_manage_forum` supports:

- `createTopic`, `editTopic`, `closeTopic`, `reopenTopic`, `pinTopic`,
  `unpinTopic`, `deleteTopic`
- `createGroup` (`group`, `supergroup`, `channel`; optional forum)
- `addMembers`
- `setAdminPermissions`

`social_manage_chat` supports `setTitle`, `setDescription`, `setPhoto`, and
`setForumEnabled`.

## WhatsApp chats, groups, polls, events and contacts

WhatsApp only unless noted; other channels return `unsupported_capability`.
Writes pass through the connector's `ENABLE_SENDING` /
`EMERGENCY_DISABLE_SENDING` gate; reads are not gated.

- `social_react_message` (WhatsApp and Telegram): `emoji: ''` removes ours.
- `social_set_chat_state`: `archive`, `unarchive`, `pin`, `unpin`, `mute`
  (optional `durationMs` or `muteUntil`), `unmute`, `markRead`, `markUnread`.
- `social_get_group` / `social_manage_group`: `create`, `update` (subject,
  description, `announce`, `restrict`), `add|remove|promote|demoteParticipants`.
  An add WhatsApp refuses for someone's privacy lists them in `inviteRequired`
  (in `data`, or in `error.details` when nobody was added).
- `social_invite_to_group` (admins only): sends WhatsApp's private "join group"
  card to 1–20 people (`participants`, optional `text` caption ≤ 1024) — a real
  message to each; members are reported, not messaged. Per-person `results`
  with `reason` `invited | already_participant | send_failed |
invite_link_unavailable`; nobody invited → `invite_not_sent`.
- `social_send_poll`, `social_vote_poll` (`options: []` retracts),
  `social_get_poll_results`, `social_send_event`, `social_respond_event`,
  `social_get_event_results`.
- `social_start_chat` (phone, optional first message; returns the canonical
  conversation), `social_share_contact` (1–5 cards), `social_list_contacts`
  (local index).
- `social_get_presence` and `social_get_privacy` are read-only (the latter,
  with `target`, adds that chat's disappearing timer).
- `social_send_typing`: our typing indicator in one chat, `state`
  `composing`, `recording` or `paused`. It never sends `available` or
  `unavailable` (account-wide; `available` silences the phone's notifications).
- `social_set_privacy` (destructive, `confirm: true` required by the schema):
  one account-wide setting per call with WhatsApp's exact values — `lastSeen`,
  `profilePicture`, `status`: `all | contacts | contact_blacklist | none`;
  `online`: `all | match_last_seen`; `readReceipts`: `all | none`; `groupsAdd`:
  `all | contacts | contact_blacklist`; `call`: `all | known`; `messages`:
  `all | contacts`; `defaultDisappearing` (new chats): `0`, `86400`, `604800`
  or `7776000` seconds. An equal value answers `changed: false`.
- `social_set_disappearing`: a chat's timer, `expiration` `0`, `86400`,
  `604800` or `7776000` seconds; everyone in the chat sees the change.
- `social_send_sticker` (WhatsApp and Telegram; WebP, WhatsApp ≤ 1 MiB) and
  `social_send_gif` (WhatsApp; MP4 ≤ 16 MiB played looped, optional `caption`):
  `fileUrl` is an http(s) URL the connector fetches, as attachment `url`s.
  Nothing is converted (`sticker_not_webp`, `gif_not_mp4`). Separate tools
  rather than `social_send_message` attachments: that path picks the message
  type from the Content-Type (a WebP would go as a photo) and its schema stays
  unchanged.
- `social_delete_message` with `forMe: true` (WhatsApp only) removes the
  message from this account and its devices; the other side keeps it.
- `social_block_contact` (`action: block|unblock`, exactly one of `target` —
  the 1:1 conversation — or `phone`, `confirm: true` required by the schema;
  groups are refused) and `social_list_blocked` (read; `fresh: true` re-reads
  WhatsApp's list). `changed: false` means it already was so.
- `social_star_message` (`messageId`, `star: true|false`; `target` optional):
  only this account sees it, in the phone's Starred messages.
  `social_list_starred` (read): the account's starred messages, newest star
  first, optionally of one `target`; `limit` ≤ 200, page with `cursor` =
  `nextCursor`.
- `social_pin_message` (`messageId`, `pin: true|false`, `durationSeconds`
  `86400 | 604800 | 2592000`, default 7 days, only for a pin): everyone in the
  chat sees it; in a group whose info only admins may edit, only admins pin
  (`not_group_admin`). `social_list_pinned` (read, `target` required): the
  active pins of the chat, newest first, at most the 3 WhatsApp shows, each
  with `expiresAt`. Both lists hold what the connector recorded since
  migration 018 (plus history-sync stars); `persisted: false` = not recorded.
- `social_list_communities` and `social_get_community` (reads; `target` = the
  community's `…@g.us`): subject, description, size, the announcement group,
  every linked group (`joined` says whether this account is in it;
  `linkedGroupsComplete: false` = only the joined ones could be read) and
  `capabilities`. A group of a community answers `not_a_community` with the
  community id in `details`.
- `social_manage_community` (destructive): `create` (`subject`, optional
  `description`; this account owns it), `link` / `unlink` (`target` + `group`;
  community admins, linking also needs admin of that ordinary group; never the
  announcement group), `leave` (`confirm: true`; also leaves the announcement
  group). Already so → `changed: false`. Every change is read back;
  `change_not_confirmed` = read it again before retrying. The group tools still
  answer `community_unsupported` for a community.
- `social_lookup_channel` (read; `target` = `…@newsletter`, a
  `whatsapp.com/channel/…` link or the invite code): name, description,
  subscribers, verification, share link, `role`, `following`, `muted`. No
  channel search exists.
- `social_list_channels` (read, `meta.source.completeness: partial`): the
  followed channels among those the connector has seen (history-sync chats,
  channels whose posts it received, look-ups and follows); WhatsApp's own
  followed list is not readable with Baileys rc13 (`data.coverage`).
- `social_manage_channel_subscription` (`target` = `…@newsletter`, `action`
  `follow | unfollow | mute | unmute`; muting needs a followed channel): proven
  by the channel's own metadata, `changed: false` when already so.
- `social_list_statuses` (read): WhatsApp statuses of the account's contacts
  and its own, newest first; by default only the ones still visible (24 h),
  `includeExpired: true` for the ones the connector keeps
  (`WA_STATUS_RETENTION_DAYS`, 30); `contact` (phone or user jid) narrows to
  one person, PN and LID together. Media: `social_get_media` with target
  `status@broadcast`. Indexed in `whatsapp_statuses` (migration 019, which
  backfills from `messages`); the statuses themselves stay in `messages`.
- `social_list_channel_posts` (read): posts of the channels the account
  follows (all, or `target` = `<digits>@newsletter`), from `messages`; names
  and following: `social_list_channels`.
- `social_publish_status` (destructive, `confirm: true`): text or image
  status to an explicit `recipients` list (phones or user jids, ≤ 256). Off
  unless the connector runs with `WA_STATUS_PUBLISH_ENABLED=true`
  (`status_publish_disabled`), then the usual send gate.
- `social_get_my_profile` (read): this WhatsApp account's own name, about
  (`aboutSetAt`), whether it has a photo and `capabilities` (what the session
  can change). `aboutKnown` / `photoKnown: false` = WhatsApp did not answer.
- `social_update_my_profile` (destructive, `confirm: true` required by the
  schema): `name` (≤ 25), `about` (≤ 139, `''` clears it), `photoUrl` (http(s),
  JPEG/PNG/WebP ≤ 8 MB, fetched by the connector, WhatsApp crops it square) or
  `removePhoto: true` — at least one, photoUrl and removePhoto not together.
  Every contact sees it. Each field answers `accepted` (WhatsApp took it) and
  `confirmed` (a readback proved it); a name is usually accepted but not yet
  confirmed by the linked session. A photo step failing after name/about were
  applied is `outcome_unknown`.
- `social_send_message` attachments (WhatsApp only, additive): `viewOnce: true`
  sends a JPEG/PNG photo or MP4 video that opens once (anything else is
  refused, never sent permanent); `hd: true` re-encodes a still image to HD
  (long edge ≤ 2560 px). Without them the bytes go out untouched, as before.

Sends (`poll`, `vote`, `event`, `respond`, `share_contact`, `invite_to_group`,
WhatsApp `send_sticker`, `send_gif`, `pin_message`, `publish_status`, `start_chat` with a
message)
forward the caller's `idempotencyKey`, scoped per
tool, as the connector's `Idempotency-Key`. Connector refusals keep their `failureClass` as
the error `code` (`disabled_sending`, `disconnected`, `not_group_admin`,
`not_on_whatsapp`, `account_restricted`, …) with the connector payload in
`error.details`; `invalid_request` stays, `idempotency_key_reused` becomes
`conflict`, `send_outcome_uncertain` becomes `outcome_unknown`, and a route the
deployed connector lacks becomes `unsupported_capability`.
`social_edit_message` and `social_delete_message` (WhatsApp and Telegram) map
their connector refusals the same way (`not_own_message`,
`rejected_by_whatsapp`, `rejected_by_telegram`, `message_unavailable`, …). `account_restricted`
on `social_start_chat` carries a `wa.me` link a human can open to send by hand.

## OpenClaw

OpenClaw registers channel adapters named `socialmedia-whatsapp`,
`socialmedia-telegram`, and `socialmedia-instagram`. Sending, attachments,
replies, and deletion use OpenClaw's shared `message` tool. The plugin does not
register another set of Socialmedia tool wrappers.

Other canonical operations arrive from this MCP contract through Tool Search.

## Pairing API (per-user, outside the MCP contract)

The tools above act on the configured house accounts (`personal`,
`professional`, `leila` — see `CLAUDE.md`); pairing a user's own WhatsApp or
Telegram device is not an MCP tool. It is a separate REST surface,
`social-api`: every request is keyed by the `sub` claim of a Keycloak JWT, the
session is served by a per-sub pool (`whatsapp-pairing`, `telegram-pairing`)
reached over the internal connector HMAC, and credentials persist only in the
per-user credential store. Routes, JWT contract, flags, QR limits and the
`/social/status` states are documented in
[docs/social-api.md](docs/social-api.md); the surface is registered in
`CONTRACTS.yaml` as `http.social-api.pairing-whatsapp.v1`,
`http.social-api.me-whatsapp.v1`, `http.social-api.pairing-telegram.v1`,
`http.social-api.me-telegram.v1`, `http.social-api.social-status.v1` and
`http.social-api.jwt-audience.v1`.

`GET /social/status` is the read-only bridge between the two surfaces: it
answers the caller's own channel states plus the house accounts bound to its
identity — the same bindings (`SOCIAL_IDENTITY_BINDING`) the MCP routing
enforces per `accountId`.

## Regeneration and validation

```bash
pnpm contract:generate
pnpm contract:check
```

CI rejects a stale manifest or mismatched catalog/digest. AgentGateway and
OpenClaw vendor the generated manifest and validate the same digest.
