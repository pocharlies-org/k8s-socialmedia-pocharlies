# WhatsApp Web parity audit

Audit date: 2026-09-27. Scope: all feasible WhatsApp Web functionality except
voice and video calls, retaining SocialMedia accounts and the Hermes assistant.
This supersedes the earlier selected subset in `whatsapp-selected-features.md`.
The audit is ongoing; this document is not a claim of complete parity.

## Evidence

- Official WhatsApp Web was inspected in an authenticated desktop Chrome session.
  The initial QR pairing failure was bypassed by using the owner's working session.
- Official navigation includes Chats, Status, Channels, Communities, Media, and
  a personal settings/profile section. Meta AI is represented by SocialMedia's
  existing Hermes integration rather than by impersonating that service.
- The global chat menu exposes New group, Starred messages, Select chats, Mark
  all as read, App lock, and Log out.
- Settings includes Profile, Account, Privacy, Chats, Notifications, Keyboard
  shortcuts, Help, and Log out. Chat preferences include theme, wallpaper,
  upload quality, automatic downloads, spellcheck, emoji substitution and
  Enter to send.
- Status creation offers photos/videos and text; the list separates own status
  and recent updates. Its empty text editor exposes emoji, font and palette
  controls plus publish/close; inspected and closed without publishing.
  Channels offers discovery, following, and creation.
- The attachment menu exposes Document, Photos/videos, Camera, Audio, Contact,
  Poll, Event and New sticker. The initial SocialMedia menu exposed only five
  entries; multi-file staging and the missing capture/audio flows are implemented
  and verified in the second deployed batch.
- Communities displays community headings, announcement/subgroup rows, a
  full-group-list entry and community creation.
- The group-header menu exposes Add member, Group info, Search, Select messages,
  Mute notifications, Disappearing messages, Lock chat, Favorites, Lists,
  Export chat, Close chat, Clear chat and Leave group. Group info also exposes
  member changes, removal from a community and reporting. These were inspected
  without executing provider mutations.
- Global Media offers Media, Documents and Links tabs, search and selection.
  Its ordering/filter menu includes All, You, Other people, Newest, Oldest
  and Longest. The existing per-chat gallery does not cover this global view.
  On desktop it is a centered modal occupying 80% of the viewport, rather
  than a narrow side drawer; the reference header combines tabs with search,
  ordering, selection and close controls.
- In the authenticated reference on September 28, tapping Search hid the three
  tabs and opened a field labelled "Search by sender or caption". A no-match
  query displayed a recent-results empty state with a 14-day notice. No private
  search result was used as a test fixture.
- The authenticated Windows reference session was reconnected and inspected
  through Agent Jake on September 28. New chat searches name, number or
  username and exposes New group,
  New contact and New community before the contact directory.
- Official Privacy separates last-seen visibility (all, contacts, exclusions,
  nobody) from online visibility (all or the last-seen rule). It also exposes
  profile photo, About, status audience, read receipts, groups, blocked contacts,
  unknown-account message protection and disabling link previews. These were
  inspected without changing the owner's preferences; call privacy is excluded.
- Official Notifications exposes separate Messages, Groups and Status settings,
  message previews, outgoing-message sound and background synchronization.
  SocialMedia requests browser permission and offers account-scoped
  message/group/status, preview and sound preferences. Status polling works
  while the page remains open; closed-tab push is still pending.
- UI inspection does not authorize sending messages, publishing updates,
  joining/leaving communities or modifying other people's chats during QA.
  Private screenshots and contact/message contents are not repository fixtures.

## Delivery matrix

`Existing` means implementation found in source, not that every edge case has
passed this audit. `Verified` means the documented local/live checks passed.
`In validation` means changes in this work batch. `Pending`
means work remains; it must not be hidden by a disabled or cosmetic control.

| Area | Current state | Remaining work / verification |
| --- | --- | --- |
| Accounts, independent chat identity, Hermes sessions | Existing | Regression coverage across account changes |
| Chat filters, archived, favorites and lists | Partial | Bulk archive/mute/read deployed 8ad9dd9; context-menu list creation now includes the selected chat after server confirmation. Provider synchronization of lists remains |
| Pinned ordering, pin and mute markers | Verified | Deployed b46056b: personal snapshot reports three pins and all three render first with icons; secondary reports none. Historical pinned messages are a separate limitation |
| Full available message history | Verified | Cursor paging, scroll preservation and concurrent polling covered |
| More than 500 chats | Verified | Deployed 0e7762c: 243 Node 22 tests, 41 browser checks, 650 active/50 archived PG fixture; both accounts pass read-only live QA |
| Quote reply, edit, delete, forward and selection | Existing | Official menu details and limits |
| Copy message / jump from quote to original | Verified | Browser keyboard and historical quote tests |
| Reactions and polls | Existing | Full emoji picker; current official results/detail UX |
| Pinned messages and event RSVP | Partial | The pin bar works for captured events, but live storage has no pin events and Baileys exposes no current-pin query. Historical backfill is not guaranteed; real-provider write acceptance remains unverified |
| Search and media/link/document gallery per chat | Partial | Sidebar account-scoped message search, cursor paging and exact-result navigation deployed 1f46b8f. Global media search matches saved and push names of senders, captions and file names, including results across media, documents and links. Global-library multiselect supports download, delete, star and forward with synthetic QA; longest-first sorting uses stored audio/video duration where available. Older attachments without saved duration retain timestamp order after known-duration clips |
| Composer optimistic sends, paste and voice recording | In validation | Multi-file picker/paste/drop, captions, per-file retry and background batch tests pass; Enter sends and Shift+Enter adds a newline in browser QA |
| Camera, media editing and view-once | In validation | Camera capture/cleanup tested; view-once image/video sends pass synthetic app, browser and connector QA. Draft JPEG/PNG/WebP photos can be cropped, rotated, drawn on and annotated with text before sending, with undo/redo and per-file captions/view-once preserved in synthetic browser QA. Exact visual parity, real-provider delivery and iPhone editing remain unverified |
| Emoji / GIF / stickers | In validation | Full local emoji catalog with Spanish/English search, categories, skin variants and per-account recents passes synthetic QA. New sticker creation accepts JPEG/PNG/WebP, opens the image editor, exports a transparent 512px WebP under 100 KiB, and requires preview plus an explicit send; synthetic mobile/browser QA passes. GIF discovery, sticker packs, exact visual parity and real-provider sticker acceptance remain |
| Location and live location | Partial | Received locations render; the authenticated WhatsApp Web attachment menu inspected on 28 Sep 2026 has no location-send action |
| Link and map previews | Existing | Reference QA and failure states |
| Image viewer navigation | In validation | Previous/next buttons and keyboard arrows page through the selected chat's stored images, including older images outside the loaded timeline. The media cursor orders equal timestamps and multiple attachments without skipping rows; synthetic browser/API coverage passes. Historical media absent from storage is still unavailable |
| New chats / contact creation | Verified | Directory deployed 8ad9dd9; both accounts pass read-only authenticated browser QA; extended drawer scenarios remain in development |
| Group subject and description editing | Verified | Admin controls/errors tested with provider fixtures; no live mutation |
| Group member administration | Existing | Invite links, group photo, leave and full settings |
| Settings drawer / wallpaper / spellcheck / Enter preference | Partial | Desktop/mobile, light/dark and persistence tested; composer Enter behavior under correction |
| Emoji substitution / upload quality / automatic downloads | Partial | Standard/HD image processing and four account-scoped download switches deployed 1f46b8f with bounded cancellation/cache tests. Baileys has no native HD badge, video remains source quality, and real-provider HD acceptance is unverified |
| Web-session logout | Verified | OIDC local-session revocation; keeps connector paired; Basic auth browser cache remains |
| Own profile and account settings | Verified | Name/photo/about API and controls deployed; own identity/name and panel verified on both accounts, mutations tested synthetically |
| Privacy and disappearing messages | Partial | Online/group-add and status-audience fields are available; existing exclusions remain visible without inventing their members. Blocked-list viewing and confirmed unblock are deployed. Exclusion editor and About visibility remain |
| Notifications | In validation | Account-scoped message/group/sound/preview preferences are deployed. A new unread chat notifies while the tab is hidden, including after an initially empty list; older chats added by pagination stay silent. Reaction alerts are deployed, but real-provider attribution and delivery still need verification. Status notifications use account-scoped author summaries and a silent initial baseline; a posting-time, arrival-time and ID watermark distinguishes same-second updates in synthetic PostgreSQL, API and browser QA. Real-provider delivery remains unverified; alerts work only while the page is open. Closed-tab push remains |
| Keyboard shortcuts | Verified | Supported shortcuts only; focus/IME guards |
| Presence | In validation | Account/chat-scoped presence events reach the open header over authenticated SSE, with polling fallback; typing/recording indicators expire after 8 seconds and stream listeners are released on disconnect. Real-provider delivery and privacy behavior remain unverified |
| Real-time updates | In validation | Account-scoped message/chat change hints use authenticated SSE with reconnect resync, bounded bursts and polling fallback. Reaction insert/removal now emits a post-commit message hint for its existing target; a disposable PostgreSQL integration test covers account isolation, unchanged writes and rollback. Live reaction delivery from WhatsApp remains to verify |
| Communities | Verified | Both accounts list/details live; create/admin use provider fixtures only |
| Status | Partial | Account/author-scoped catalogue and viewer are available; saved contact names resolve by account. Text/image/video publishing to explicitly selected contacts passes synthetic app, connector and browser tests; real-provider delivery and complete historical coverage remain unverified |
| Channels | In validation | Account-scoped catalogue and timeline are available. Explicit provider lookup and confirmed follow/unfollow have synthetic proxy, API and browser coverage. A read-only live lookup of an existing personal-account channel returned HTTP 200 with the exact requested identity on 29 Sep; live follow/unfollow and remote directory discovery remain unverified |
| Chat list options and contact names | Partial | Context-menu actions and saved-name precedence deployed 9b3056c; targeted live name backfill verified. Block/unblock in contact info and the row menu requires provider confirmation. Clear/delete need provider/local-history synchronization; chat lock has no public Baileys rc13 operation |
| Chat export / block / clear / delete / lock | Partial | TXT export of synchronized history verified; block/clear/delete/lock require backend semantics and safe tests |
| Accessibility, responsive layouts and iOS install | In validation | iPhone-sized Playwright QA passes in Chromium and WebKit: navigation, browser Back/Forward between chat and list, reload after an open chat, account switching, no horizontal overflow, safe areas and 16px inputs. Manifest, PNG icons and iOS standalone metadata pass. Real Safari Home Screen install remains unverified |

The global library's longest-first option orders by saved audio/video seconds,
then timestamp and attachment ID for stable pagination. The connector records
provider duration for newly stored media and fills it when an existing media
message is seen again. The deployed historical corpus has 37 audio and 203
video attachments without a saved duration; those remain after clips with a
known duration. No duration is inferred from a file name or an unavailable
binary. Node tests, mobile/desktop browser QA and read-only PostgreSQL `EXPLAIN`
cover the query shape; provider ingestion of a new clip remains live-unverified.

## Verified provider boundaries

The installed connector dependency is Baileys 7.0.0-rc13. Its installed source,
not assumptions about the newest documentation, determines the contract.

- Communities APIs exist for list, metadata, linked groups, creation, linking,
  unlinking, membership and settings. A group without a linked parent is **not**
  sufficient evidence that it is a community: require explicit metadata flags.
- Newsletter APIs exist for metadata, follow/unfollow, mute, create, reactions,
  updates and fetching messages. Fetching returns a raw binary node; do not
  treat it as an already normalized message array. No complete followed-channel
  directory/search API was verified in this version.
- Channel server message IDs can repeat across channel JIDs. Existing durable
  storage keyed by account + message ID must be made channel-aware before
  enabling these messages; reactions require the original channel server ID.
- Status messages can be received and published, but no complete active-status
  enumeration API was verified. A catalogue built from received events must
  expire at 24 hours and disclose that unsynchronized items can be missing.
  An absent publication audience must never mean all contacts.
- Provider privacy can withhold photos, presence and last-seen information.
  Display unavailable information honestly, without invented values.
- Installed Baileys 7.0.0-rc13 exposes scalar privacy setters and
  `fetchPrivacySettings(true)`, but no public method to read or edit the About
  visibility or the members of per-field `contact_blacklist` exclusions.
  `fetchBlocklist()` is the separate blocked-contacts list, not an exclusion
  roster. Keep these editors unavailable until a provider-backed read and
  confirmed write contract can be tested; preserve an existing exclusion
  setting rather than replacing its unknown members.
- Baileys rc13 exposes `chatModify({ clear: true, lastMessages })` and
  `chatModify({ delete: true, lastMessages })`, but the returned promise is only
  an app-state patch acknowledgement. It does not prove that another WhatsApp
  device removed the chat; upstream reports silent no-ops for clear and
  per-message delete in linked-device sessions. Keep these actions unavailable until a provider
  read-back or a controlled cross-device test can distinguish success from a
  silent failure. Do not erase local history on an unverified acknowledgement.
- Pin-message documentation differs from the installed rc13 source: this
  version accepts `{ pin: messageKey, type, time }`, not nested pin options.
  Its enum uses `PIN_FOR_ALL=1`, `UNPIN_FOR_ALL=2`; the README's unpin value
  `0` is incorrect for this version. Allowed durations are 24 hours, 7 days
  and 30 days. The adapter, authenticated read/write routes and UI are wired
  in the published candidate. Pin protocol envelopes stay outside chat history.
  Reads use all-page account/chat-scoped raw history, including verified PN/LID
  aliases, and report local-partial coverage. Latest-action reduction applies
  expiry after unpin resolution, preventing old pins from reappearing. The UI
  cycles the latest three pins, opens the source message and removes expired
  entries. Forced refreshes supersede stale pending reads. Send reservations
  bind account/chat/target/action/duration and refuse uncertain replay.
- Event RSVP needs a version-specific adapter. Installed rc13 emits responses
  with `response` and `senderTimestampMs`; its protobuf and aggregation helper
  use different field names. The adapter normalizes this shape, decrypts
  captured replies within account/chat/event scope and keeps each responder's
  latest attendance. Missing keys/identity produce explicit unavailability;
  partial history never pretends to be a complete provider census. Authenticated
  routes and event cards are wired in the published candidate. The card loads
  results on demand and supports going/not-going/maybe and allowed companions,
  preserving the owner's selected companion count. Stable payload-bound tokens
  and pre-relay claims prevent uncertain retries from silently resending.
  Encrypted response envelopes are excluded from visible chat history.
- These adapters pass synthetic tests against the installed provider code;
  real WhatsApp acceptance of pin/unpin and RSVP remains unverified because
  production QA does not send real mutations. See the candidate validation below.

## Validation and release

Novedades persistence foundation (`b727ce6`): the exact Node 22 connector
image passes 230 tests and TypeScript. The disposable PostgreSQL 17 harness
verifies additive/idempotent startup, account/channel identity, atomic
client/server reconciliation, status expiry and preservation of legacy history.
Both deployed connectors are healthy; all three new tables exist. Authenticated
read-only browser QA passes for both accounts with no profile writes or page
errors. Catalog APIs, viewers and publishing are separate unfinished work.

First implementation batch, validated locally:

- App tests: 192/192 passing.
- Connector tests in the production Node 22 image: 155/155 passing.
- `selected-features.playwright.mjs`: 39 browser checks passing.
- `parity-panels.playwright.mjs`: desktop/mobile in both themes; settings
  geometry/preferences/logout contract, admin versus member communities,
  late account responses and opening an archived linked group.
- Connector TypeScript, lint, MCP contract and Compose configuration pass.
- Application and both connector images build successfully.
- Synthetic screenshots: [settings](screenshots/parity-settings-desktop.png)
  and [communities](screenshots/parity-communities-mobile.png).

The batch is deployed and authenticated read-only browser QA passes on both
accounts: account switching, community listing and linked-group details, settings
layout and Escape handling, with zero JavaScript errors. Direct read-only checks
also covered every listed community's detail response. No provider mutation was
executed by these tests; write flows remain verified by contract/socket fixtures.

Live verification uncovered a rc13 parser defect that nominal API tests missed:
`communityFetchAllParticipating` sends the group-list IQ but looks for
`communities/community` nodes instead of `groups/group`, returning a false empty
list. The integration now uses `groupFetchAllParticipating` and `groupMetadata`
with the explicit `isCommunity` flag, and `groupUpdateDescription` to preserve
description metadata. A regression feeds realistic binary nodes through the
installed `extractGroupMetadata`. `communityLeave` keeps its separate provider
method and checks the subsequent membership list; no live leave was performed.

Each delivery batch needs account-scoped API/connector tests, browser QA with
synthetic data, and authenticated read-only deployment checks. Test fixtures
must not call live mutation routes. Do not declare a provider operation
successful for a malformed, null, partial or failed result.

Second composer batch (`dd52a98`), deployed and validated:

- App tests: 195/195 passing; selected-feature browser suite: 39 checks.
- Synthetic composer browser QA covers picker/paste/drop, valid image previews,
  captions, unique send tokens, partial failures and retry with the original
  token, fake camera capture/cancellation and focus containment.
- A delayed multi-file upload continues against the captured account/chat when
  the view changes and preserves the next draft. No real messages were sent.
- Desktop light/dark and mobile staging screenshots were visually inspected.
- Authenticated production QA verifies the new menu entries, outside-click
  dismissal and staging/removing two files with zero sends and no page errors.
  Both connectors and the app are healthy; fork CI passes on this exact commit.
- At this stage the new-sticker entry opened a WebP uploader. The later photo
  editor and sticker creation flow supersede this limitation; see the current
  parity table.

Attachment menu visual correction (`2c4cbf4`), deployed and validated:

- Official option order and measured icon colors; theme-aware background.
- Both themes pass the minimum 4.5:1 text contrast check in Playwright.
- Authenticated staging/removal check passes with no sends or page errors.
- Fork and upstream PR checks pass for the published menu correction.

TXT export batch, validated with synthetic data:

- Reads every available message page using the real `before` cursor contract.
- Keeps the starting account/chat, orders messages chronologically, deduplicates
  IDs and uses the browser timezone. Attachment content is not downloaded.
- Reports progress and supports cancellation, including the final pending page.
  Closing the panel or switching account/chat cancels the download.
- Repeated/malformed cursors, failed pages and the 50,000-message memory ceiling
  produce an explicit error, never a partial file. Missing media retains a
  placeholder in the transcript rather than silently dropping the message.
- Fifteen module tests and browser download/error/cancellation checks pass.
  The existing selected-feature browser suite still passes all 39 checks.
- Real user conversations were not exported during QA.
- Authenticated production verification opens/cancels the export panel without
  downloading user content; zero page errors. Responsive synthetic screenshots:
  [mobile light](screenshots/parity-export-mobile.png) and
  [desktop dark](screenshots/parity-export-desktop.png).

UTC timestamp decoding correction (`38fdbab`), deployed and validated:

- The connector writes UTC to `timestamp without time zone` columns. The app
  container runs in Europe/Madrid, where the default PostgreSQL decoder was
  interpreting stored UTC as local time. A read-only production comparison of
  20 timestamps against their original provider epoch found a -7,200,000 ms
  offset for every sample; no message contents were extracted.
- The app pool now decodes these scalar timestamps as UTC, without changing
  the database, host timezone, global PostgreSQL parsers or browser formatting.
- Tests cover UTC, Madrid, New York and Kolkata, winter/summer and DST changes.
  Existing zoned timestamps retain their original parser; cursor text retains
  PostgreSQL's microsecond precision.
- The exact Node 22 image passes 212 tests. After deployment, all 20 production
  samples have zero offset; authenticated read-only browser QA passes with no
  page errors or downloads. Refreshing an already open tab replaces timestamps
  and pagination cursors fetched before the correction.

Typed chat-list previews (`c964c09`), deployed and validated:

- The list query carries the last visible message's real type alongside its
  text, with a deterministic tie-breaker for equal timestamps. Icons represent
  photos, videos, audio, documents, stickers, polls, locations, contacts and
  events, retaining captions. Ordinary text such as "Imagen" stays ordinary text.
- Known types no longer trigger a second database lookup to label captionless
  media. Account-scoped fallback lookups remain for incomplete projections.
- The isolated Node 22 candidate passes 214 app tests and 40 synthetic browser
  checks. A read-only query against both deployed accounts confirms that all
  current chat rows expose a type, including six media previews.
- Authenticated production browser QA switches both accounts through the
  visible account buttons and checks the rendered icons against the API types:
  eight typed icons, no page errors and no live mutations. The deployed image
  carries the matching `c964c09` revision label and the app is healthy.

Own-account profile (`0e1e779`), deployed and validated:

- Name, about, authenticated photo display, upload and
  removal with explicit confirmation. Partial or unknown provider reads do not
  erase known fields or report an unconfirmed write as successful. The isolated
  Node 22 candidate passes 235 app tests, 190 connector tests, TypeScript and
  lint with no errors. Synthetic browser QA checks both themes, mobile sizing,
  account changes and partial readbacks; no live profile was changed.
- Independent review approved the profile batch. The exact committed images
  pass the same 235/190 tests and are deployed to the app and both connectors.
  All three are healthy with revision `0e1e779`. Authenticated read-only browser
  QA verifies connected own identity/name and the profile panel on both accounts,
  with zero profile writes or page errors.
- Fork CI and upstream PR #74 CI both pass on the exact `0e1e779` head.

Chat pagination delivery (`0e7762c`):

- Account/archive-scoped keyset cursors preserve microseconds, order equal
  timestamps by chat ID and handle null dates. Progressive loading retains
  old rows until a refresh finishes and rejects stale account responses and
  repeated cursors. A read-only PG17 fixture traverses 650 active and 50 archived
  chats without loss or duplication. The exact Node 22 release image passes
  243 tests; synthetic browser QA passes 41 checks including opening chat 650.
  Deployed app revision and both connectors are healthy. Live read-only QA
  verifies both accounts with zero mutations and page errors. Fork and upstream
  PR CI pass; upstream S3 passed on retry after a network failure to sum.golang.org.

Profile timeout follow-up (`8a9410a`):

- An About read timeout preserves the other profile fields. Accepted writes
  remain accepted but unconfirmed when readback times out; a write timeout is
  still rejected. Independently reviewed; the exact Node 22 connector image
  passes 192 tests and TypeScript. Both connectors are deployed and healthy.
  Authenticated browser QA verifies both accounts with zero writes/page errors.
  Fork and upstream PR CI both pass on this head.

Next delivery, not yet deployed:

- Global media library: centered desktop modal matching the inspected official
  layout, fullscreen mobile, media/documents/links tabs, search, author/order
  filters, pagination, preview and source-message navigation. Browser QA covers
  38 requests across two accounts, rejects stale requests and provider URLs,
  and checks both themes. Independent review's preview-focus and raised-card
  contrast findings are corrected and retested: minimum text contrast is
  4.65:1 light and 6.49:1 dark across all three tabs, desktop and mobile.
  The rail stays clickable outside the modal. Integration review of mutually
  exclusive panels and authenticated deployment checks remain pending. Multi-selection
  and duration ordering are not implemented by this batch.
- Privacy: online and group-add visibility controls preserve an existing
  contact-exclusion setting when other preferences change. Browser regression
  verifies only the two changed fields are sent, scoped to the current account.
  Saving now locks concurrent submissions, stops subsequent writes after closing
  the dialog or changing account, and advances the baseline after each accepted
  field so retries do not resend successful changes. Existing feature tests
  (15 Node 22 tests and 42 browser checks) pass. The dedicated browser suite
  passes 13 checks including double submission, retrying only a rejected field,
  account changes, close during save, detached old forms and delayed reads.
- Bulk chat selection: archive/unarchive, mute/unmute and read/unread capture
  the account, cancel future writes when scope changes and retry only failed
  selections. Four unit tests and synthetic browser QA pass; independent review
  approved the behavior. No real chat was modified during QA.
- Contact directory: 33 Node 22 tests pass, including deterministic LID/phone
  deduplication and Unicode-safe pagination boundaries. Read-only database
  traversal found 1,340 personal-account identities and seven secondary-account
  identities without duplicate keys. All 165 openable rows matched the archived
  flag of the exact conversation chosen for opening. The long-label and
  dual-chat fixes use synthetic regression cases because those cases are not
  present in the current production data. Dedicated drawer browser QA remains
  pending; these changes are not yet deployed.

The goal remains open until the matrix is resolved with implemented/verified
behavior or a concrete documented provider limitation. Calls/video calls are
the only product area excluded by the owner.

## Interface deployment (`8ad9dd9`)

The exact committed Node 22 image passes 312 tests; synthetic browser checks
pass for 42 selected features, 29 panel interactions and 13 privacy scenarios.
The app and both account connectors are healthy. Authenticated read-only QA
opens the contact directory and all three media-library tabs on both accounts,
with zero writes and page errors. The fork main and upstream PR74 point to this
commit; fork CI `36356628284` and upstream PR CI `36356631847` both pass
on the exact `8ad9dd9` head. Novedades API/UI and RSVP are not
part of this release.

## Events and pinned messages deployment (`5adcb7f`)

Published on fork main and PR74 in `1e7a0d5`, with CI formatting correction
`5adcb7f`. Fork CI `36362818169` passes lint, tests, build, manifests, contract
surface, app and S3 checks. The formatting correction preserves the emitted
JavaScript syntax trees in all ten affected modules. Upstream PR CI `36362822264` also passes on the same head. Independent
review found no release blockers; follow-up work covers uncertain RSVP recovery
and indexed reads for large histories.

The exact isolated candidate passes 317 app tests, 270 connector tests and
TypeScript. The selected-feature Playwright suite passes 43 checks, including
pin, banner refresh and unpin. Dedicated event/pin browser suites cover retry
tokens, account switches, stale responses, expiry, source navigation and four
light/dark desktop/mobile layouts. Separate disposable PostgreSQL 17 fixtures
traverse 1,201 wrapped/direct RSVP replies and 1,201 pin actions without account
or chat leakage. No real RSVP, pin or unpin was sent during QA.

Images `socialmedia-whatsapp-app:5adcb7f` and
`socialmedia-whatsapp-connector:5adcb7f` are built from the published commit.
The unfinished Novedades reader/UI is excluded. The app and both account
connectors are deployed at this exact revision and healthy. Authenticated
read-only browser QA checks both accounts, contact directories, all three media
library tabs and scoped pin endpoints for 11 conversations, with zero writes
and page errors. No events or pins were present in the sampled conversations,
so real-provider RSVP/pin acceptance remains unverified.

## Fresh official comparison (September 28)

- In-chat search includes an "Ir a la fecha" calendar, with previous/next month
  navigation and future dates disabled. The working tree adds an accessible
  browser date picker and jumps to the first synchronized message of that local
  day. The API uses an exclusive UTC interval scoped to account/chat aliases;
  23/25-hour daylight-saving days are covered. Synthetic browser QA checks
  historical navigation, empty days, focus and late-response cancellation
  (47 selected-feature checks pass, including a panel left open across midnight).
  A read-only PostgreSQL fixture verifies
  exact day boundaries, alias coverage and filtering of deleted/protocol messages
  and other accounts/chats/platforms against the actual query.
  The calendar currently uses the browser's native presentation.
- Event creation offers name, optional description, start date/time, optional
  end date/time and a free-text location. Call links are outside this audit.
  The working-tree event form now includes description and optional end-date
  controls, browser-local timezone conversion and a named location. Dedicated
  browser tests cover retries, context changes and four layouts; draft tests
  cover daylight-saving transitions. Publication awaits connector integration.
- Poll creation uses individual option rows, reordering and a multiple-answer
  toggle enabled by default. It also offers anonymous voters and a closing
  time. Official FAQ limits are question 255 characters, up to 12 options,
  and 100 characters per option (https://faq.whatsapp.com/796470361614974).
  Installed rc13 `PollMessageOptions` has name/values/selectableCount/secret
  and announcement-group fields; anonymous/closing-time transport is not yet
  verified and must not be represented by nonfunctional switches.
- The working-tree poll composer now provides separate rows, add/remove/reorder,
  single/multiple answers, provider limits, pending state and payload-bound retry
  tokens. API validation preserves commas within options. Synthetic browser QA
  passes option controls, duplicate-submit prevention, retry tokens, stale
  account context rejection and four theme/viewport layouts. Connector durable
  idempotency, independent review, publication and deployment remain pending.
- Official event and poll dialogs were opened and closed without creating or
  publishing anything. Private message contents are not part of this audit.

The app integration snapshot builds successfully and its packaged production
files pass all 346 app tests. This is an uncommitted integration candidate,
not evidence of publication or deployment of the new composers, date lookup
or Novedades UI. Connector completion and independent review remain pending.

Further UI verification adds previous/next image navigation within the loaded
chat window, with keyboard arrows, matching download links and Escape/focus
restoration (26 renderer tests and browser DOM integration pass). Full desktop
and mobile visual QA found and fixed Settings remaining open over the chat list
after changing accounts. Its obsolete AI request assertion now checks the
existing streaming/turn-ID contract. The complete visual suite passes with no
page or console errors; these follow-up changes remain uncommitted.

Independent review of the in-progress connector confirmed two release gates:
poll/event creation routes must consume the stable send token rather than call
the provider directly, and named event locations must not fabricate NaN
coordinates. Both are assigned to the structured-send integration; this working
tree must not be deployed until the corrected routes and provider fixtures pass.

The emoji/reaction picker now uses a self-hosted, version-pinned Emojibase 17
catalog (1,914 base emojis plus skin variants), with Spanish labels, accent-insensitive
Spanish/English search, category navigation, skin-tone preference and per-account
recent selections. Browser tests cover keyboard navigation, variant selection,
failed-load retry, concurrent/stale selection guards and four light/dark
desktop/mobile layouts with no external requests or page errors. The light
mobile screenshot was visually inspected. Selecting a local GIF from the picker
now stages it in the unified composer so the user can review it with the text
caption before sending; sticker upload still uses its separate creation flow.
The integrated selected-feature suite passes 47 checks and the full app suite
passes 351 tests. These changes are still in the working tree; online GIF
discovery and sticker packs remain pending. The upload path now converts a
staged `image/gif` to MP4 with `gifPlayback` even without `featureKind`, while
preserving its caption, quote, digest and send token. A contract test covers
that path; no real GIF was sent during QA.

Earlier integration candidate (September 28): the connector passes 327 tests,
TypeScript and lint with no errors. Disposable PostgreSQL 17 fixtures verify
the indexed pin/RSVP cursors with 200,000 ordinary messages and 1,201 cases of
each type, including account/chat isolation. The app passes 351 tests.
Synthetic browser QA covers the emoji picker, poll/event forms, date search,
Novedades author/channel navigation, mobile close controls, rapid channel
switching, expiration of open statuses, image navigation and account isolation.
Novedades lists are based on synchronized data and may omit unseen historical
statuses; no provider mutation was performed. Real-provider acceptance of structured sends and RSVP,
full WhatsApp parity, fork CI, PR CI and deployment remain unverified for this
candidate until publication.

The official Chats settings show "Reemplaza texto con emojis" enabled by
default. This app change adds that persisted toggle and replaces common
typed emoticons at the caret without changing pasted text. Synthetic browser
QA verifies enabled and disabled behavior, draft updates and persistence;
353 app tests pass. The complete WhatsApp shortcut catalog has not been
established.

## Search, image quality, and automatic downloads (September 28)

The sidebar searches account-scoped messages with cursor paging, opens the exact
result even when its chat was not loaded, and cancels stale requests on query,
archive-view, or account changes. Image uploads have per-account Standard/HD
choices; the connector changes the actual image bytes with bounded Sharp
processing, preserves transparency, and does not upscale. `source` remains the
default for MCP callers. Baileys 7.0.0-rc13 has no native HD marker, so the
choice controls resolution/encoding rather than the official badge. Videos
remain at source quality. Raw GIF bytes are rejected by the connector; staged
GIF uploads are converted to MP4 before sending.

Four per-account automatic-download preferences cover photos, audio, video,
and documents. Disabled media waits for a user action without requesting bytes;
stickers still load automatically. Reads have byte/entry budgets and shared
URL caching. Disabling a category or leaving the final message mount cancels a
running request; keyboard activation preserves focus on the replacement media
control. The cache entry cap also holds when different downloads finish
concurrently.

Validation: 392 app tests, 331 connector tests, TypeScript, lint, contract and
Compose checks; 49 selected-feature and 28 download Playwright checks pass.
An independent reviewer reproduced the three download race/focus fixes. QA is
synthetic: no real image, GIF, or message was sent during this validation, and
provider acceptance of HD-transformed images remains unverified. Other rows
above remain open; this does not establish full WhatsApp parity.

## Follow-up: chat controls, saved names, and mobile install

Blocked-contact follow-up (integration candidate): Privacy now opens an
account-scoped provider blocklist, including addresses without a local chat.
Unblock is a separate confirmed action; the browser asks first, the app checks
the live list again, and the connector confirms the provider state before the
UI removes the row. App, connector and browser fixtures cover wrong-account
responses, disconnected providers, invalid JIDs, a stale account switch,
retry after failure and mobile width. Search and incremental rendering keep large
lists usable. A canceled confirmation returns to the list; failed writes report
an uncertain provider state. Legacy phone JIDs and device suffixes share one
normalization rule, and dual LID/phone entries require both to be cleared before
success. No real contact was unblocked in QA.
The production read and deployment are still pending.

Commit 9b3056c adds a contextual menu to each chat row for supported
archive, mute, pin, unread, favorite, and list actions. Blocking a direct
contact has a provider-confirmed, account-scoped backend; no real contact was
blocked in QA. Clear/delete cannot be offered safely until provider changes
and local history stay in sync. Baileys 7.0.0-rc13 does not expose a public
chat-lock operation. Existing pinned-message UI is data-limited: the live
database has no captured pin events, and Baileys cannot query the current pin
state directly. A history backfill may help but cannot guarantee the event or
original message will be available.

Chat pinning is separate from pinned messages. The connector previously
discarded Baileys' numeric pin timestamp and null unpin event; b46056b reads
those updates and pin actions from a complete read-only app-state snapshot.
It restores account-scoped chat state without overwriting events newer than
the snapshot start. After deployment, the personal provider snapshot reported
three pinned chats, PostgreSQL held three for that account, and authenticated
Chrome rendered their markers in the first three rows; secondary reported zero.
This does not recover historical pinned-message events absent from storage.

Saved WhatsApp contact names now take precedence over chat titles, including
Unicode and emoji names, and history contacts are ingested per account. A
previously paired account may need a targeted backfill because the original
contact snapshot was discarded. The composer uses Enter to send and
Shift+Enter for a newline by default, with the existing alternate Enter
preference preserved. Mobile layout uses a full-width chat/list, safe-area
spacing and 16px inputs. PNG icons,
standalone manifest and Apple metadata enable Home Screen installation; an
iPhone device install still requires real-world verification.

User-reported iPhone follow-up (2026-09-28): Safari still allows pinch zoom
that makes the page feel broken rather than like a mobile app. The existing
Playwright iPhone emulation verifies layout only at its normal scale; it does
not reproduce Safari's real pinch zoom or a Home Screen launch. WebKit ignores
`user-scalable` and scale limits in Safari, so the viewport meta tag alone is
not a fix. The app and its dialogs now cancel Safari gesture and two-finger
touch events while preserving ordinary one-finger scrolling; the separate image
viewer remains zoomable. Treat real-device zoom stability and installation/login
in standalone mode as open until checked on an actual iPhone. Keep Enter to send and Shift+Enter for
a newline in the mobile composer as explicit acceptance criteria.
The manifest and icon endpoints are readable before OIDC login, which lets
Safari fetch installation metadata without making chats or scripts public.
The check must include a fresh Keycloak login from the Home Screen app: its
external-domain redirect may leave standalone mode on iOS, which the static
manifest and Chromium test cannot validate.
On 2026-09-29 the same mobile fixture also passed in WebKit. WebKit exposed a
navigation edge: its `visibilitychange` fires while a pending status-catalog
request can be aborted by reload. The status monitor now defers the hidden-tab
check and cancels it at `pagehide`; a regression test covers that ordering.
On 2026-09-28 the mobile Playwright fixture passed at iPhone dimensions and
320/375/430px widths, including account switching, chat/history navigation,
safe-area layout, input sizing, and pinch-gesture cancellation outside the
image viewer. The deployed `whatsapp-app` container's mobile CSS, gesture
handler, manifest, and HTML match the source hashes; the public manifest and
Apple touch icon return HTTP 200. These checks do not replace the outstanding
real-iPhone Home Screen installation and Keycloak return-flow test.
On 2026-09-29 the same fixture also passed on Playwright WebKit with an iPhone
13 device profile. Its SSE fixture now returns `text/event-stream`, matching
the live route instead of relying on Chromium ignoring an invalid JSON stream.
WebKit emulation confirms layout and navigation in that engine; it cannot
prove Safari Home Screen installation, real pinch behavior or the Keycloak
return path on a physical iPhone.

## Publishing WhatsApp statuses

The Novedades editor supports text, image and video statuses for an explicit,
account-scoped selection of direct contacts. It previews the content and chosen
audience before a final send. An empty audience is rejected rather than treated
as all contacts. Text cards are limited to 700 characters, media captions to
1024 characters, and media to 10 MiB. The connector makes one Baileys
`status@broadcast` attempt and reports an uncertain result without automatic
retry if WhatsApp returns no message ID. The app only clears the draft when the
response confirms the message ID for the same account; changing account during
an in-flight request cannot claim that result for the new account.

The app suite (433 tests), connector suite (including status-publishing tests),
TypeScript, and browser publication flow pass with synthetic providers. Browser
QA covers the recipient picker, confirmation, errors, account switch and mobile
layout. No real status was published. The contact directory may be incomplete,
so this editor cannot yet offer WhatsApp's full-audience privacy modes; a live
send and visibility readback are still required to verify provider behavior.

The global media library now has a selection mode with visible item state and
an explicit download action for available binary files. Selection is cleared
when the account, tab, filters or panel changes; unavailable files disable the
download action instead of silently downloading a subset. The same toolbar
offers delete, star and forward, using each message's source chat and the
active account. Delete-for-everyone is offered only for outbound selections;
provider confirmation controls removal from the local view. Browser QA uses
synthetic accounts, downloads and mocked provider actions, including an action
that finishes after an account switch. No real message was changed during QA.

On 28 Sep 2026, the authenticated official chat-row menu showed "Añadir a la
lista" even when no new list had been created, with a "Nueva lista" entry.
That route opened a create-list drawer with the chosen chat preselected.
SocialMedia now exposes the same menu path and stages a local list only after
the account-scoped server membership succeeds. Browser QA covers an empty
list collection, a rejected membership, and isolation between two accounts.
List names and membership now persist in SocialMedia's account-scoped server
state and reconcile on account selection, so they follow the account across
browsers. Legacy browser-only lists remain visible until explicitly changed.
These are SocialMedia lists: synchronization with WhatsApp's own lists across
its clients is still absent. Baileys rc13 exposes `addLabel` and
`addChatLabel`, but those are label actions, not a proven representation of
WhatsApp Messenger's custom chat lists; mapping the two would risk mutating a
different provider feature. No list write is sent through these methods.

Status privacy reads the provider's current audience category per account.
Baileys 7.0.0-rc13 accepts `all`, `contacts`, `contact_blacklist` and `none`;
the UI can change to the categories that do not require a member editor.
An existing `contact_blacklist` selection remains visible and unchanged until
the owner explicitly selects a different category. Editing the excluded
contacts and publishing a status with an explicit audience are still pending.

View-once sending lets the owner mark each staged photo or video separately.
The app preserves that choice through optimistic delivery and retry, and sends
the flag only for supported image/video types. The proxy and connector reject
invalid flags and unsupported media; the connector includes the flag in
Baileys' image/video payload and in the idempotency fingerprint only when it is
true, preserving existing normal-send fingerprints. Synthetic browser QA checks
a mixed media/document batch and the mobile composer; app and connector suites
pass without sending real media. Provider acceptance and how received view-once
messages appear in historical storage still need live read-only verification.

Presence now has an authenticated stream from the connector through the app to
the open direct chat. The connector subscribes to the provider and forwards
only snapshots for the requested chat; the app validates account and chat
access before opening its signed upstream stream. Browser QA verifies immediate
typing labels, stream teardown on chat change, and that a late polling response
cannot overwrite a newer event. The existing 20-second read remains a fallback
and corrects stale states. Connector and proxy tests use synthetic events; live
provider delivery and NPM streaming behavior still require observation.
