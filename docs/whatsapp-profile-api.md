# WhatsApp own-account profile API

Date: 2026-09-27. Scope: the account's own display name, About ("status") text
and profile photo. Contact avatars keep their existing routes; this document is
about the profile of the logged-in account only.

Nothing here was executed against a real WhatsApp account: no display name,
About text or photo was changed on the owner's account while this was built.

## Layers

| Layer          | File                                             | Role                                                                |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| Browser        | `apps/whatsapp/public/profile-ui.mjs`            | Panel, upload resize, optimistic merge                              |
| Gateway        | `apps/whatsapp/server.mjs`                       | Account isolation, sending gates, payload limits, response contract |
| Connector HTTP | `connectors/whatsapp-web/src/api/controller.ts`  | HMAC auth, write gates, provider error codes                        |
| Provider logic | `connectors/whatsapp-web/src/profile-service.ts` | Provider-agnostic read/write/confirm logic                          |
| Adapter        | `connectors/whatsapp-web/src/baileys-client.ts`  | Binds the socket methods that actually exist                        |

`profile-service.ts` never reads capabilities from the `.d.ts` files. It binds a
provider method only when the installed runtime really has it, so an API that
exists in the types but not in the build degrades to `501` instead of failing
inside Baileys.

## Gateway endpoints

All responses are JSON (`GET /api/profile/photo` is the binary exception) and
every one of them names the account it belongs to. Reads never mutate the
provider; writes are gated.

| Method      | Path                             | Body / query                       | Notes                                              |
| ----------- | -------------------------------- | ---------------------------------- | -------------------------------------------------- |
| GET         | `/api/profile?account=`          | —                                  | `{account, sendingEnabled, capabilities, profile}` |
| POST, PATCH | `/api/profile`                   | `{account, name?, about?}`         | Forwards only the keys present in the body         |
| POST        | `/api/profile/photo`             | `{account, name?, mimeType, data}` | `data` is base64                                   |
| POST        | `/api/profile/photo/remove`      | `{account}`                        |                                                    |
| GET         | `/api/profile/photo?account=&v=` | —                                  | Bytes of the own photo, `404` when absent          |

PATCH repeats the origin check that POST already receives from the shared
handler.

`profile` carries `jid`, `phone`, `name`, and `about`, `aboutSetAt`, `photo` only
when the connector proved that it looked. An unreadable About is omitted rather
than sent as `null`, so a partial read cannot erase what the caller already had.

### Limits enforced at both layers

- Display name: 25 characters, non-empty after trimming. Control characters and
  line breaks are flattened before the length check.
- About: 139 characters. An empty string is a real value and clears the text.
- Photo: JPEG, PNG or WebP, at most 8 MiB decoded (16 MiB of base64 text),
  checked by magic bytes and not only by the advertised `mimeType`.
- The gateway body cap (17 MiB) and the connector `express.json` limit (15 MB)
  both sit above the 8 MiB photo, so an oversized upload fails with
  `PHOTO_TOO_LARGE` here instead of an opaque upstream 413.

## Confirmation discipline

`accepted` means the provider took the write. `confirmed` means a readback
proved the end state. They are deliberately different:

- `updateProfileName` in Baileys `7.0.0-rc13` is an app-state patch
  (`pushNameSetting`) and does not refresh `creds.me` in the current session.
  In a linked session the name can therefore be `accepted: true,
confirmed: false` with reason `SESSION_NAME_NOT_REFRESHED...`; the write is
  live on WhatsApp, this session just has not reloaded its own copy.
- Photo confirmation uses picture identity: the sha256 of the CDN URL path with
  the rotating access token removed. The same identity after a write is not
  proof; a new identity, or a photo appearing where none was, is.
- A mutation response has `confirmed: true` only when nothing failed
  (`partial` false, `failed` empty) and every returned field was read back.
- An About lookup timeout preserves the readable name/photo and returns
  `aboutKnown: false`. After an accepted About write it returns
  `accepted: true`, `confirmed: false`, with reason `READBACK_TIMEOUT`;
  a write timeout still fails and is never reported as accepted.
- When the readback itself fails, the response keeps the fields the outcome
  really observed and adds `profileReadback: {available: false, error}`; the
  capabilities the gateway never read are omitted, not reported as false.

## Errors

Connector codes are propagated with their status:
`INVALID_PROFILE_INPUT` 400, `PHOTO_TOO_LARGE` 413,
`PROFILE_APP_STATE_UNAVAILABLE` 409, `PROFILE_UPSTREAM_REJECTED` 502,
`PROFILE_UPSTREAM_TIMEOUT` 504, `PROFILE_PROVIDER_UNAVAILABLE` 501,
`PROFILE_PICTURE_PROCESSING_UNAVAILABLE` 501, `PROFILE_DISCONNECTED` 503.
The gateway adds `UPSTREAM_INVALID` 502 for an unusable answer (wrong envelope,
missing payload, `ACCOUNT_MISMATCH`, malformed identity, malformed photo
payload) and 403 `Sending is disabled` before a write when
`APP_ENABLE_SENDING` is not `true` or `EMERGENCY_DISABLE_SENDING` is `true`.
`404` is treated as a real connector answer, meaning "this account has no
profile photo", and is never flattened into a 502.

Account isolation is checked on every connector call: an answer that names a
different account is a `502 ACCOUNT_MISMATCH`, never somebody else's profile.

## Image processing dependency

`updateProfilePicture` needs `sharp` or `jimp` installed; without one, Baileys
raises `No image processing library available`. The connector now declares
`sharp@0.35.3` directly, and `pnpm-lock.yaml` records it, so
`pnpm install --frozen-lockfile` and the connector image (which runs a plain
`pnpm install` on `node:22-bookworm-slim`) both get it.

Verified inside that image on `linux-x64` with Node `v22.23.3`:

```text
connector import.meta.resolve(sharp) = .../sharp@0.35.3.../dist/index.mjs
sharp loads; libvips 8.18.3 sharp 0.35.3
baileys generateProfilePicture -> 640x640 JPEG
```

`import.meta.resolve('sharp')` from the connector source was unresolved before
the explicit dependency was added; it only worked by accident through the
package manager's hoisted directory. If the library is ever missing, the
connector answers `501 PROFILE_PICTURE_PROCESSING_UNAVAILABLE` for photo writes
instead of pretending success.

## Provider facts worth keeping (Baileys 7.0.0-rc13)

- `fetchStatus` answers `result.list` whose entries are
  `{ id, status: { status, setAt } }`, the parser output nested under the
  protocol name. A flat `{status, setAt}` entry is also accepted; an
  unrecognised shape is reported as unknown, never as an empty About.
- `updateProfileName` needs `creds.myAppStateKeyId` and throws
  `App state key not present!` otherwise; that surfaces as
  `PROFILE_APP_STATE_UNAVAILABLE` 409.
- For our own picture, `403` from the CDN means "lookup refused", which is
  unknown, and only `404` proves absence. The contact-avatar helper treats 403
  as "no photo"; the own-profile path deliberately does not reuse it.

## Test evidence

- Connector: `src/profile-service.test.ts` (real `USyncStatusProtocol.parser`
  entries, a synthetic RGB gradient encoded as JPEG, refusal-versus-absence adapter tests, real
  `generateProfilePicture` re-encode) and
  `src/api/controller-profile.test.ts` (HTTP routes and write gates).
- Gateway: `apps/whatsapp/test/profile-api.test.mjs` (18 tests) covers the
  response contract, malformed and unattributed upstream answers, account
  isolation, device JIDs, both sending gates, payload limits, origin checking on
  PATCH, binary photo serving, oversized and malformed photo payloads, and the
  readback-failure response.
- Isolated profile candidate on Node 22: 190 registered connector tests and
  235 WhatsApp app tests pass. TypeScript passes and connector lint has no
  errors with the repository ESLint and Prettier configuration.
- Synthetic browser QA covers profile writes, partial readbacks, photo
  upload/removal and account switching, including desktop/mobile and light/dark
  layouts. These tests do not modify any live WhatsApp account.

## Not covered here

- Channel, group and Business profiles; only the signed-in personal account.
- About timestamp reliability: `aboutSetAt` is passed through when present.
- Real-device validation of each field on a live account, which is still pending
  by decision, not by omission.
