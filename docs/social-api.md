# Social pairing API (`social-api`)

Reference for the HTTP surface of SC-1197: the per-user (`sub`) pairing and
status API for WhatsApp and Telegram. Every route, code, claim and limit below
is a contract registered in [`CONTRACTS.yaml`](../CONTRACTS.yaml) — the ids
`http.social-api.pairing-whatsapp.v1`, `http.social-api.me-whatsapp.v1`,
`http.social-api.pairing-telegram.v1`, `http.social-api.me-telegram.v1`,
`http.social-api.social-status.v1` and `http.social-api.jwt-audience.v1`
(plus the internal `http.whatsapp-pairing.internal-sessions.v1` and
`http.telegram-pairing.internal-sessions.v1`). Where this file and the
registry disagree, **the registry wins**.

The MCP tool surface (the `social_*` tools) is a different contract and is
documented in [MCP.md](../MCP.md); this file covers only the REST pairing API.

## Topology

```
 AgentGateway (ns messages, app dgx-messages)
        │  Authorization: Bearer <Keycloak JWT>   (in-cluster only, netpol)
        ▼
 social-api :3020  (mcp-server image)  ← the ONLY process that verifies a user JWT
        │  connector HMAC over the signed body; sessionKey = JWT `sub`
        ├──────────────────────────────► whatsapp-pairing :3001  (baileys pool per sub)
        └──────────────────────────────► telegram-pairing :3002  (mtcute pool per sub)
                                              │
                                              ▼
                                   credential store (DB whatsappmcp,
                                   table user_channel_credentials, encrypted)
```

- **`social-api`** is the single public face of the epic. It verifies the
  JWT, applies the hardening guards and proxies the caller's own session to
  the pool. It **writes no credential row** — the pools are the only writers —
  and opens exactly one read-only DB pool, used solely by `GET /social/status`
  to read the caller's own Instagram row (a DB failure there is an
  `unavailable` state, never a crash or a 503).
- **`whatsapp-pairing`** and **`telegram-pairing`** are inert pools: they
  never see a JWT or any user token. They authenticate `social-api` with the
  existing connector HMAC (`CONNECTOR_SHARED_SECRET`,
  `x-connector-timestamp` + `x-connector-signature: sha256=HMAC(secret,
  "<ts>:<JSON body>")`, 300 s window, verified through shared's
  `verifyHMACSignature`). Because the HMAC covers the **body only**, every
  pool route is a POST and the internal `sessionKey` travels **inside the
  signed body** — never in the path or the query:
  - `POST /internal/whatsapp/sessions/{start,state,me}`
    (`http.whatsapp-pairing.internal-sessions.v1`)
  - `POST /internal/telegram/sessions/{start,state,me,password}`
    (`http.telegram-pairing.internal-sessions.v1`)
- **Persistence is the credential store only.** The pools keep their
  `SESSION_PATH` in a memory `emptyDir` with no PVC (no second copy of
  credentials) and use `strategy: Recreate` (never two processes on the same
  session). After a pool restart the session is reloaded from the row —
  `/me/telegram` and the pools' lazy load answer without the user
  re-authorizing.
- **In-cluster only.** There is no IngressRoute for any of the three. The
  netpol `whatsapp-mcp-allow-messages-social-api` admits only pods of the
  `messages` namespace (app `dgx-messages`, the AgentGateway) into
  `social-api:3020`; the pools accept only `social-api`.
- **Manifests**: `k8s/base/social-pairing.yaml` and
  `k8s/base/networkpolicy-social-pairing.yaml` (SC-1197 P3). They ship all
  three Deployments at `replicas: 0` with `SOCIAL_PAIRING_API=off` — the whole
  surface is **inert** until an operator PR turns it on (see "Enabling").

## Route table

All authed routes are `social-api` routes; the pool routes above are internal.

| Method | Path | Auth | Success (200) | Other codes | Contract |
|---|---|---|---|---|---|
| GET | `/health` | none — answers even with the API **off** | `{status:"ok", service:"social-api", pairingApi:"on"\|"off", store:"available"\|"unavailable"}` | — | — |
| POST | `/pairing/whatsapp/start` | JWT | `PairingStatus` (pool's answer verbatim) | 400 401 403 404 429 503 | `http.social-api.pairing-whatsapp.v1` |
| GET | `/pairing/whatsapp` | JWT | `PairingStatus` — poll, QR by polling **not SSE** | 401 403 404 429 503 | `http.social-api.pairing-whatsapp.v1` |
| GET | `/me/whatsapp` | JWT | `{"jid": "<device-less user jid>"}` | 404 `{"error":"not_paired"}`; 401 403 503 | `http.social-api.me-whatsapp.v1` |
| POST | `/pairing/telegram/start` | JWT | `TelegramPairingStatus` verbatim | 400 401 403 404 429 503 | `http.social-api.pairing-telegram.v1` |
| GET | `/pairing/telegram` | JWT | `TelegramPairingStatus` — poll | 401 403 404 429 503 | `http.social-api.pairing-telegram.v1` |
| POST | `/pairing/telegram/password` | JWT, body `{"password": "<2fa>"}` | `TelegramPairingStatus` verbatim | 400 `{"error":"invalid_password"}` (missing, empty or > 1024 chars); 409 `{"error":"password_not_requested"}` (flow not in the `password` state — passed through from the pool); 401 403 404 429 503 | `http.social-api.pairing-telegram.v1` |
| GET | `/me/telegram` | JWT | `{"id": "<telegram user id>", "username": "<username or null>"}` | 404 `{"error":"not_paired"}`; 401 403 503 | `http.social-api.me-telegram.v1` |
| GET | `/social/status` | JWT | `{channels, houseAccounts}` — see its section; **always 200** once the JWT gates pass, even with the store off | 401 403 404 503 (`identity_unavailable` only, JWKS down) | `http.social-api.social-status.v1` |

No parameter on any route carries identity: the `sessionKey` sent to the pool
is **always the JWT `sub`**. Nothing is ever listed or enumerated — a token of
A can never return anything of B.

### Status shapes

`PairingStatus` (whatsapp) and `TelegramPairingStatus` (telegram), passed
through from the pool verbatim:

```json
{
  "sessionKey": "<sub>",
  "state": "starting|qr|paired|expired|unpaired",
  "qr": null,
  "me": null
}
```

- `state` for telegram has one extra value, `password` — the 2FA step of the
  QR flow, completed through `POST /pairing/telegram/password`.
- `qr` is `null` or `{value, dataUrl, issuedAt, expiresAt}` — `value` the raw
  pairing string, `dataUrl` a PNG data URL rendered in memory, `issuedAt` /
  `expiresAt` ISO timestamps (whatsapp QR lives ~20 s, baileys rotation;
  telegram carries Telegram's own expiry).
- `me` is `null` or, for whatsapp, `{id, jid, phone, name}` (`id` the raw
  `creds.me.id`, `jid` the device-less user JID, `phone` E.164 or null); for
  telegram, `{id, username}`.

### Error set (all authed routes)

| Code | Body | When |
|---|---|---|
| 400 | `{"error":"invalid_json"}` | malformed JSON body (express `entity.parse.failed`) — **only when the API is on**; with `SOCIAL_PAIRING_API=off` the JSON error handler is not mounted (the off-branch returns before it), so a malformed body yields express's default 400 HTML instead |
| 401 | `{"error":"unauthorized"}` + `WWW-Authenticate: Bearer` | missing/bad/expired/foreign token, disallowed `azp`, empty `sub` |
| 403 | `{"error":"forbidden_origin"}` | a **present** `Origin` header outside `SOCIAL_API_ALLOWED_ORIGINS` (empty default). social-api never answers CORS headers — it is in-cluster only; the gate is defense against a browser-driven request, not a cross-origin enabler |
| 403 | `{"error":"forbidden_identity"}` | `sub`, `sessionKey` or `jid` present in the query or body with a value that is not the caller's own `sub` (equal-to-own is accepted and ignored) |
| 404 | `{"error":"not_found"}` | `SOCIAL_PAIRING_API` off (every well-formed request but `/health`), or an unknown path |
| 429 | `{"error":"rate_limited", "reason": "start_interval\|daily_starts\|pool_full\|qr_limit", "retryAfterSeconds": N}` + `Retry-After` | passed through from the pool's limits |
| 503 | `{"error":"identity_unavailable"}` | the JWKS endpoint cannot be reached — fail closed (design D2) |
| 503 | `{"error":"pairing_unavailable"}` | store off / no master key / no `CONNECTOR_SHARED_SECRET` / the route's pool URL unset or unreachable / any non-200-non-429 answer from the pool |

### Gate order

One decision per layer, in this order (`mcp-server/src/social-api/app.ts`);
a request rejected at 2–5 never reaches the pool — no signature is produced,
no credential row is written:

1. `SOCIAL_PAIRING_API=off` → 404 `not_found` for every well-formed request but `GET /health`; a malformed JSON body throws in `express.json()` before the catch-all and, since the off-branch returns before the JSON error handler is mounted, gets express's default 400 HTML (see the 400 row)
2. `Origin` outside the allowlist → 403 `forbidden_origin`
3. no / bad JWT → 401; JWKS unreachable → 503 `identity_unavailable`
4. foreign `sub`/`sessionKey`/`jid` → 403 `forbidden_identity`
5. store gate, **per route and per pool** (`RouteSpec.pool`): the route's pool
   client missing → 503 `pairing_unavailable`. A missing
   `TELEGRAM_PAIRING_URL` 503s only the telegram routes, never the whatsapp
   ones — and vice versa. `GET /social/status` opts out (`storeRequired:
   false`, design D7) and answers 200 with `unavailable` states instead.
6. the route itself, proxying the pool over the connector HMAC

## JWT contract — `http.social-api.jwt-audience.v1`

`social-api` is the only place in this repo that verifies a user token
(`mcp-server/src/api/auth/keycloak-jwt.ts`):

- `Authorization: Bearer <JWT>`, verified with **jose** (`jwtVerify` +
  `createRemoteJWKSet`; one module-level cache per JWKS URL, cooldown 30 s,
  cache max age 10 min).
- **RS256 only**, `clockTolerance` 30 s
  (`SOCIAL_API_JWT_CLOCK_TOLERANCE_SECONDS`).
- `iss` = `SOCIAL_API_JWT_ISSUER`, default
  `https://auth-next.e-dani.com/realms/edani`.
- JWKS = `SOCIAL_API_JWKS_URL`, default in-cluster
  `http://keycloak.keycloak.svc.cluster.local/realms/edani/protocol/openid-connect/certs`.
- `aud` must **contain** `social-api` (`SOCIAL_API_JWT_AUDIENCE`) — requires
  the Audience mapper on the `dgx-messages` client (SC-1198 historia 0).
- `azp` must be in `SOCIAL_API_ALLOWED_AZP` (default `dgx-messages`).
- **`typ` is NOT enforced** — measured 2026-09-25: the live realm (Keycloak
  26.6.2) emits `typ: "JWT"` by default; pinning `typ=Bearer` would 401 every
  real token (architect verdict on PR #79). Identity is pinned by the
  signature against the realm's own JWKS plus `iss`/`aud`/`azp`/`exp`.
- The `sub` claim **is** the `sessionKey` of every pairing operation. No
  header-carried identity is ever read: **`x-user-sub` is not an input**
  here (SC-1144) — unlike the MCP routing, which still consumes it.
- Outcomes: bad token → 401 with `WWW-Authenticate: Bearer`; JWKS
  unreachable → 503 `identity_unavailable` (fail closed).

## Flags

| Flag | Read by | Default | Meaning |
|---|---|---|---|
| `SOCIAL_PAIRING_API` | social-api **and both pools** | `off` | must be exactly `on` (trim/lowercase) anywhere it is read. Off: social-api 404s every well-formed request but `/health` (a malformed JSON body gets express's default 400 HTML — see Gate order); the pools 404 everything but their `/health`. The three P3 Deployments ship `replicas: 0` + `off` — inert. |
| `CREDENTIAL_STORE_ENABLED` | shared store (`credentialStoreEnabled`) | off | must be exactly `true`. A usable store is the flag **and** a parseable `CREDENTIAL_STORE_MASTER_KEY` (fail closed on a bad key); otherwise authed pairing routes 503 `pairing_unavailable` and `/social/status` answers `unavailable` states. |
| `SOCIAL_API_ALLOWED_ORIGINS` | social-api | empty | comma-separated Origin allowlist. Empty = any present `Origin` is 403. Absent header passes (non-browser callers). |
| `SOCIAL_IDENTITY_BINDING` | mcp-server tool routing (SC-1144) | off | **not** read by social-api: it gates `applyIdentityBinding` on the MCP tools. `GET /social/status` reads the bindings table (`SOCIAL_IDENTITY_BINDINGS_FILE`) for `houseAccounts` regardless of the flag — fail-closed (unreadable table binds nobody → `[]`). |

Supporting env (the P3 manifests are the contract for names):
`SOCIAL_API_JWT_ISSUER`, `SOCIAL_API_JWKS_URL`, `SOCIAL_API_JWT_AUDIENCE`,
`SOCIAL_API_ALLOWED_AZP`, `SOCIAL_API_JWT_CLOCK_TOLERANCE_SECONDS`,
`WHATSAPP_PAIRING_URL`, `TELEGRAM_PAIRING_URL`, `CONNECTOR_SHARED_SECRET`,
`CREDENTIAL_STORE_MASTER_KEY`, `DATABASE_URL`, `SOCIAL_ACCOUNTS_FILE`,
`SOCIAL_IDENTITY_BINDINGS_FILE`; on the pools additionally `SESSION_PATH`,
`SESSION_ENCRYPTION_KEY` (whatsapp) and `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`
(telegram).

## QR and pairing limits

Applied by the pools (identical defaults in both,
`DEFAULT_POOL_LIMITS` / `DEFAULT_TELEGRAM_POOL_LIMITS`), answered as 429
`rate_limited` with `Retry-After` and passed through by social-api:

- **10 concurrent pairing sessions per pool process** (`pool_full`).
- **5 QR codes per start** (`qr_limit`): when a start's QR budget is spent the
  socket is closed and further polls get `qr_limit` until a new start.
- **1 start per 60 s per sub** (`start_interval`) — every `start` call is
  rate-limited even when a socket is already live, so a client cannot spin QR
  generation by hammering it.
- **10 starts per rolling 24 h per sub** (`daily_starts`).
- Idle pairing sessions are evicted after 10 min. Polling (`state`) does **not**
  renew the idle clock on **either** channel (whatsapp since SC-1243 / PR #87,
  telegram since P4b), so a client polling `GET /pairing/{channel}` forever
  cannot park a session past its TTL and hold one of the pool's 10 slots.
- QR stays in memory: the pairing pool builds its clients with `quietQr` (no
  stdout print, no `qr.png` written) and the QR is delivered by **polling
  `GET /pairing/{channel}`, not SSE**.

## `GET /social/status` — `http.social-api.social-status.v1`

The caller's own channel states, keyed by the JWT `sub`. The body carries **no
identifiers** (no jid, no username, no sessionKey), so isolation is
structural, not a filter.

```json
{
  "channels": {
    "whatsapp":  { "state": "paired" },
    "telegram":  { "state": "unpaired" },
    "instagram": { "state": "unavailable" }
  },
  "houseAccounts": [
    { "channel": "whatsapp", "accountId": "professional", "label": "…" }
  ]
}
```

`state` ∈ `paired | expired | unpaired | unavailable` (the four values are
contract — SC-1198 consumes `unavailable`):

- **whatsapp / telegram** — from the pool's `state` route: row → `paired`;
  provider-invalidated during the process's life → `expired`; no row →
  `unpaired`; pool down, pool not configured, store off, or **any non-200
  answer from the pool** (429/4xx/5xx) → `unavailable`. A pairing in flight
  (`starting`/`qr`, and telegram's `password` — the 2FA step, still in
  flight) reads as `unpaired`: the row is written only after the first
  connection open.
- **instagram** — `credentialStore.get(sub, 'instagram')`: row → `paired`;
  row with `expiresAt` in the past → `expired`; no row → `unpaired`; store off
  or a row the adapter refuses to read → `unavailable` (fail closed).
- **houseAccounts** — read-only intersection of the caller's identity binding
  with the declarative account registry (`social-accounts.json`); no account
  name is fixed in code. An unreadable bindings table binds nobody → `[]`.

Unlike `/pairing/*` and `/me/*`, this route **answers 200 with `unavailable`
states while the store is off** (design D7 — the one route that skips the
store gate): a status view is not a pairing action, and the caller must be
able to tell "not configured" from "error". The only 503 it can give is
`identity_unavailable`, when the JWKS is down — the JWT/Origin/identity gates
in front of it are the same as everywhere.

## Enabling

The surface is code-complete but inert. Turning it on is a single operator PR
(after the PR2 of SC-705 ships `CREDENTIAL_STORE_ENABLED=true` in prod and the
Audience mapper of SC-1198 historia 0 exists on the `dgx-messages` client)
that sets `SOCIAL_PAIRING_API=on`, `replicas: 1` on the three P3 Deployments
and re-pins to images carrying the P1a/P1b/P4b entrypoints. Until then every
authed route answers 404 `not_found` and the house connectors are untouched
(design D6: the legacy `/api/v1/auth/qr` and `/api/v1/me` of the house
connectors are a different, unchanged surface).

## Verifying

```bash
# with the API on, port-forwarded:
curl -s localhost:3020/health                       # 200 even with the API off
curl -s -H "Authorization: Bearer $JWT" localhost:3020/social/status
curl -s -X POST -H "Authorization: Bearer $JWT" localhost:3020/pairing/whatsapp/start
curl -s -H "Authorization: Bearer $JWT" localhost:3020/pairing/whatsapp   # poll: {state, qr}
# scan qr.dataUrl with the phone, keep polling until state=paired
curl -s -H "Authorization: Bearer $JWT" localhost:3020/me/whatsapp        # {"jid": …}
```

The regression specs are `mcp-server/src/social-api/social-api.spec.ts` (the
whole gate order against fake pools) and the pools'
`connectors/*/src/pairing/app.test.ts` / `session-pool.test.ts`.
