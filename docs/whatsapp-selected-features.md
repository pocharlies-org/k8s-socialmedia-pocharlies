# Selected WhatsApp capabilities

User selection 2026-09-23: inventory 1-15 (14 excludes camera), and 17.
Additional requirements: separate Archived view, read receipts when opening a
visible conversation, truthful presence/last-online timestamps, real avatars.

## Delivery boundaries

- Preserve the established WhatsApp Web visual design, SocialMedia branding,
  Keycloak authentication, dynamic accounts, AI and manual sending.
- Source remains /home/staticduo/git/socialmedia; NAS Compose and private runtime
  configuration remain /volume2/docker/social-media. No Fedora changes.
- Calls, video calls, camera, export, channels, status and communities are outside
  this selection. Do not add decorative nonfunctional controls.
- WhatsApp privacy may withhold a profile photo or last-seen value. Represent
  unavailable data explicitly. A database observation timestamp is not last online.
- Provider mutations require real acknowledgements. Unsupported actions return
  errors; no fabricated successful state. Destructive actions require explicit UI
  confirmation when the user invokes them.
- Tests use provider mocks and synthetic fixtures: no unsolicited messages,
  group modifications or read receipts as part of automated verification.

## Implementation responsibilities

1. Connector: verified Baileys operations, durable message keys/protos, state
   synchronization, presence and profile lookup, typed payloads and tests.
2. App API: account/chat/message ownership, CSRF, safe avatar proxy, queries and
   state persistence, search/gallery and operation validation.
3. UI: functional menus, panels and dialogs that preserve desktop/touch layout;
   dedicated Archived navigation, visible-chat read and opt-in notifications.
4. Integration: backups, tests, independent review, NAS-only deployment and
   functional verification of the actual route/container.

## Acceptance matrix

| Inventory | User outcome | Required evidence |
| --- | --- | --- |
| 1,2 | Group/contact info, member names/admins and real photos | Scoped API, profile privacy fallback, rendered panel |
| 3,4 | Gallery of media/links/documents and history search | Account/chat pagination and safe results |
| 5,6,7,8 | Reply, react, forward, edit and delete | Durable provider lookup, correct DB state, UI actions/errors |
| 9 | Archive/pin/mute/read/unread | Archived excluded from normal view; confirmed read only visible chat |
| 10 | Favorites/lists/starred | Persistent per-account state with explicit local/provider semantics |
| 11,12 | New chats/contacts and group management | Validated recipients, permissions, acknowledged operations |
| 13 | Emoji/GIF/stickers | Usable picker/upload, correct typed rendering/payloads |
| 14 | Shared contact, poll and event | Validated send/receive structures and usable forms/cards |
| 15 | Disappearing messages/privacy | Scoped settings and provider acknowledgement |
| 17 | Desktop notifications | Explicit opt-in, no historical flood, account-aware deduplication |
| Additional | Online/offline/last online | Subscription data; timestamp absent when unknown/private |

Implemented and deployed on NAS on 2026-09-23, retaining both paired accounts.
The connector and app were rebuilt from this source and recreated with
`docker compose up -d --no-deps` for the three affected services only.

### Verification results

- App unit/API suite: 78 passing tests; real app-to-connector HTTP contract:
  27 passing tests; connector: 97 passing tests and TypeScript validation.
- Compose generator: 14 passing tests and deployment `config --quiet` passes.
- PostgreSQL name-resolution fixtures pass against the real database using
  temporary tables and rollback, including account isolation and empty chats.
- Synthetic browser verification: 26/26 selected-feature scenarios, 1/1 delayed
  account-switch race, and the desktop/touch/mobile visual regression pass.
  Audio/video keep playing across polling and edits; confirmed sends clear only
  the submitted draft; a single filter row and bounded avatars are verified.
- Browser fixtures report no page errors, console errors or unexpected routes.
  Evidence is in `/volume2/docker/mcp/playwright/output/socialmedia-whatsapp-selected-features/`
  and `/volume2/docker/mcp/playwright/output/socialmedia-whatsapp-ui/`.
- A separate focused browser check verifies that a failed avatar shows initials
  and removes the broken image.
- Both recreated connectors report `CONNECTED` and no QR requirement. The app
  retains effective user `1000:10`; the public route redirects to Keycloak.
- Read-only live verification passes for both accounts: chats, messages,
  gallery/search, presence, group information and both stored/provider photos.
  No sends, read receipts or group mutations were issued by this diagnostic.

### Known data and provider limitations

- Favorites and custom lists are local, account-scoped application state.
- Forwarding and quoting require the original WhatsApp payload. Older imported
  messages without that payload return an explicit unavailable error; new
  incoming/history events retain it for subsequent operations.
- Profile images and last-online values can be withheld by WhatsApp privacy.
  Unknown presence is displayed without inventing an observation timestamp.
- Automated tests use synthetic recipients. Real sends, group mutations and
  read receipts are intentionally excluded from deployment verification.

## Deployment preparation

- Compose expansion validated before changes; app and both WhatsApp services
  were running and healthy.
- Pre-change backup: `/volume2/docker/social-media/backups/20260923-094426-before-features`.
  Contains the PostgreSQL dump, private deployment configuration, image IDs and
  a protected archive of both pairing directories and app state. The pairing
  archive was taken while connectors were online.
- The app's effective runtime user remains `1000:10` for the NAS volume ACLs.
- Existing WhatsApp messages have no populated `raw_payload` values. Actions
  requiring the original provider payload must report unavailable originals
  honestly unless a subsequent history event supplies them.
- Applied both additive capability migrations in one PostgreSQL transaction
  with `ON_ERROR_STOP`, before restarting either connector.

## Integration checks

`scripts/whatsapp-api-contract.test.mts` connects the actual app HTTP server to
the actual connector Express router and HMAC middleware, using a synthetic
database and WhatsApp client. This catches mismatched paths and payload shapes
that permissive HTTP mocks cannot detect. Run it with
`./node_modules/.bin/tsx --test scripts/whatsapp-api-contract.test.mts`.

## Version-specific references

Baileys installed and declared version: 7.0.0-rc13. Confirm signatures against
the installed declarations rather than assuming current documentation matches.
Context7 lookup was unavailable due to monthly quota; official documentation
was retrieved through LazyMCP Kindly:

- https://baileys.wiki/features/presence
- https://baileys.wiki/messaging/sending-messages
- https://baileys.wiki/messaging/message-actions
- https://baileys.wiki/concepts/events

Presence subscription does not require broadcasting this client as available.
Keeping the client unavailable preserves mobile push notifications. History
append events must not be mistaken for new live-message notifications.

### Baileys rc13 profile-picture correction

Runtime verification exposed intermittent profile-picture lookup timeouts.
The installed rc13 release emits an incorrect picture/tctoken IQ structure.
The merged upstream correction https://github.com/WhiskeySockets/Baileys/pull/2607
is preserved in `patches/@whiskeysockets__baileys@7.0.0-rc13.patch` through pnpm
patchedDependencies and the lockfile hash. All workspace Dockerfiles copy the
patch before dependency installation. A test validates the actual installed
package's timestamped token nested within the picture query.

Photo lookup has an eight-second deadline. Downloads retain a ten-second
deadline through the body and enforce a ten-megabyte streaming cap. Provider
timeouts and network failures stay distinct from explicitly absent/private
photos. Optional photo lookup failure cannot prevent group metadata rendering.

Partial non-WhatsApp workspace builds use `allowUnusedPatches: true`; an actual
Instagram Docker build verifies that the shared patch does not break unrelated
services. The installed Baileys patch remains covered by its protocol test.

### Historical group identifier repair

Live checks found 37 personal group rows whose `wa_chat_id` had been replaced by
a participant's phone JID, plus three missing group IDs. A read-only comparison
confirmed that the incorrect ID timed out while the canonical group ID returned
metadata immediately. The connector now prevents this write; the API validates
group routing independently, including send/upload and forwarding.

Backed up all 40 original values to protected
`backups/20260923-094426-before-features/group-routing-before-repair.json`, then
updated only those verified rows in one transaction using `wa_chat_id=id`.
Account namespaces are preserved for uniqueness. Regression tests also cover
the first send to a newly created, empty conversation.
