# Telegram media recovery

Telegram sync stores media directly in MinIO, then adds the attachment to the
unified PostgreSQL database. It does not need a writable download directory.

Set `HISTORY_MEDIA=true` on `telegram-sync` to download media during history
ingestion. An independent recovery loop also repairs existing Telegram messages
without attachments, including messages already passed by the history cursor.
It handles five messages sequentially per cycle, with a 30-second interval.

Recovery is account scoped. Attempts and the next retry time are stored in
message metadata. A database row lock and attachment check prevent duplicate
attachments from concurrent history, realtime and recovery workers. Deleted
messages and existing messages without downloadable media are terminal; network,
storage and database failures retry with exponential backoff.

The connector exposes `GET /api/v1/messages/single/:chatId/:msgId` under its
existing HMAC authentication. Telegram flood waits return HTTP 429 and
`Retry-After`; all sync reads share the resulting cooldown. mtcute's file
download workers are scoped to propagate flood waits instead of sleeping
indefinitely. No writes to Telegram are needed for recovery.

`TELEGRAM_MEDIA_DOWNLOAD_TIMEOUT_SECONDS` sets the connector media deadline
(default 120 seconds, allowed 1-600). `CONNECTOR_MEDIA_TIMEOUT` sets the sync
HTTP timeout (default 150 seconds, allowed 121-1800); keep it longer than the
connector deadline. Avatar downloads retain their separate 20-second limit.

Each sync instance logs `Telegram media backlog total_missing=N eligible_now=N`
after the first recovery cycle and then at most every five minutes. Counts are
scoped to that instance's account; logs contain no account, chat or message IDs.
The current unified schema stores the media key in `attachments.file_url`, with
`attachments.storage_key` as the production legacy fallback. There is no
`media_key` column. Null and blank values do not count as stored media.

`total_missing` counts downloadable Telegram messages with no attachment carrying
a usable key, including messages with terminal results, future retry times,
missing Telegram identifiers or empty attachment placeholders. `eligible_now`
counts the subset the recovery selector can process now: identifiers present,
retry time elapsed, no terminal result, and no attachment row. Empty attachment
placeholders remain visible in the total but require separate repair. Zero
eligible rows therefore does not prove the total backlog is complete.

Five messages per 30 seconds gives a theoretical ceiling of 14,400 attempts per
day per account. This is a capacity estimate, not a completion SLA: the loop
also spends time downloading and pauses one second per message; flood waits,
backoff, failures and new incoming media reduce throughput. Compare successive
aggregate totals to measure actual progress. An empty backlog means
`total_missing=0`; terminal or ineligible rows can keep it above zero indefinitely.
