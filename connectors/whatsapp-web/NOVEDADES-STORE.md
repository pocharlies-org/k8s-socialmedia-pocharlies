# WhatsApp Novedades persistence

`src/novedades-store.ts` is the additive store for the Novedades view: channel
posts (`whatsapp_novedades_messages`), a followed-channel directory
(`whatsapp_novedades_channels`) and author-scoped statuses
(`whatsapp_novedades_status`). `novedadesKind(key)` routes an incoming key: a
`@newsletter` remote JID is a channel post, `status@broadcast` is a status, and
anything else returns `null` so the caller keeps using the existing chat path.
Nothing in this module reads, alters, or rewrites a pre-existing table.

`migrations/002_novedades_persistence.sql` creates the same objects that
`ensureNovedadesTables()` creates at connect time, under
`pg_advisory_xact_lock(20260927, 1)`. Both paths are `IF NOT EXISTS` and
idempotent, so a connector can start before or after the migration is applied.
The migration has not been applied to any runtime database yet, and applying it
is a separate release step. Identities are raw WhatsApp ids scoped by the
`account` column, which is part of every primary key, so ids are never prefixed
with the account key.

A post's canonical id is `key.server_id` when Baileys supplies it (rc13 exposes
it) and `key.id` otherwise; `server_id` and `client_id` are kept in separate
columns with partial unique indexes that are scoped per account and channel,
because newsletter ids are only unique inside one channel. Re-delivery merges
into the live row instead of overwriting it: keys merge with
`jsonb_strip_nulls`, and payload, timestamp, type, author and visibility are
only replaced when the incoming event actually carries them. A payload-less
ACK therefore cannot erase a participant, a server id, `from_me`, or a
visibility that the real message already established. When the id arrives first
as a client id and later as a server id, `reconcileNovedadesMessageIds` collapses
the two rows: if only one row exists it is renamed in place, and if a duplicate
exists the client row is archived first (`superseded_by`, plus
`metadata.reconciled_into`) so its ids release the unique indexes, and only then
does the live row claim the ids and merge metadata, flags, and delete state. The
archived row keeps its original payload verbatim and no reconcile path issues a
physical `DELETE`; reads look through `superseded_by`, so the old id keeps
resolving to the live row.

Ingestion performs that collapse by itself. When a key carries both ids and a
unique partial index says the client id is already held by another live row of
the channel, `storeNovedadesMessage` opens one transaction, archives the client
row, lets the survivor claim both ids with the flags and metadata OR-merged, and
then applies the current event to it. A concurrent ingest that claimed the alias
mid-transaction makes the claim collide, and the whole claim is retried once; a
collision that survives the retry is reported as a
`NovedadesStoreError('NOVEDADES_IDENTITY_CONFLICT')` with HTTP 409 and the
offending constraint name. A raw driver `23505` never reaches the caller, and the
sequence store(client id) then store(server id) then store(both ids) always ends
with one live row, so the channel timeline never shows the same post twice.

Deletes are soft. `markNovedadesMessageDeleted` and `markNovedadesStatusDeleted`
flip `is_deleted` inside a transaction and, when the id is not stored yet,
insert an honest tombstone with a null payload and `visibility = 'unknown'` so
the revoke is not silently dropped. Upserts never touch `is_deleted`, so a
revoke that arrives before the post can never be resurrected by a later
re-delivery.

Only whitelisted content types are `visible`; `protocolMessage`,
`reactionMessage`, and `senderKeyDistributionMessage` are `event`, and anything
unrecognised stays `unknown` and is hidden by default. Classification reads
through `normalizeMessageContent()` so ephemeral, view-once, and caption wrappers
are seen for what they are, while the stored payload stays byte-for-byte what
Baileys sent. This is why a reaction with a heart does not become a channel post.

Statuses expire 24h after posting (`NOVEDADES_STATUS_TTL_MS`). The author comes
from `key.participant` or `key.sender`; the caller's own JID is only accepted as
a fallback when `key.fromMe` is true, and the stored key is never mutated. A
status without its timestamp is refused unless the caller explicitly opts into
storing it as freshness unknown, which leaves `posted_at` and `expires_at` NULL:
such a row never counts as active and the pruner never touches it, because
invented freshness would silently delete a status whose real expiry is unknown.
`listNovedadesStatus` hides expired, unknown-freshness, event, and seen rows
behind explicit options, `listNovedadesStatusAuthors` rolls up visible rows per
author, and `pruneExpiredNovedadesStatus({ now, graceMs })` is opt-in only:
nothing calls it on a schedule, and it deletes only known-expired status rows.
Channel history, statuses that are still fresh, and legacy chat history are
never pruned. `normalizeNovedadesChannel` accepts Baileys newsletter metadata and
keeps the provider object in `raw_metadata`; until a real wrapper-metadata parser
exists, callers should pass already normalized metadata.

Verify with the unit suite (`src/novedades-store.test.ts`, in the connector test
script; it stubs `pg` and needs no database) and against a throwaway PostgreSQL 17:

```sh
docker run -d --rm --name sm-novedades-pgtest -e POSTGRES_PASSWORD=*** \
  -e POSTGRES_DB=novedades_scratch -p 127.0.0.1::5432 postgres:17-alpine
PORT=$(docker port sm-novedades-pgtest 5432 | head -1 | awk -F: '{print $2}')
DATABASE_URL="postgres://postgres:scratchpw@127.0.0.1:${PORT}/novedades_scratch" \
  npx tsx src/novedades-store.postgres.mjs
```

The harness follows the `state-aliases.postgres.mjs` precedent and stays out of
the npm test script. It recreates the additive bootstrap over a legacy
`whatsapp_message_payloads` row, proves cross-channel and cross-account id
coexistence, the reconcile and ACK guards, the revoke-before-post tombstone,
status author and expiry semantics, and that prune leaves posts, unknown-freshness
statuses, and legacy history alone. No backfill of older channel history is
performed yet, and this module is not wired into `baileys-client` by itself:
the ingest caller owns the routing.
