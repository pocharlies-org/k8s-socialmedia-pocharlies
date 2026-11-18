# Telegram downloads and WhatsApp response notifications

## Defects and correction

The installed mtcute 0.29.7 download workers request infinite retries. A
provider `upload.getFile` timeout therefore produces a warning every second
instead of returning control to the persistent media recovery queue. Scoped
read clients now propagate -503 immediately and bound other internal retries.
The HTTP media/photo routes return 503 with `Retry-After: 60` for transient
provider failures. Genuine absence remains 404; operation deadlines remain
504. Downloads and the durable recovery queue stay enabled.

The NAS uses UUID message IDs while the WhatsApp poll/event notification
trigger declared a BIGINT variable. Migration 035 uses `messages.id%TYPE`
and scopes all target lookups by provider/account. Notifications use the
target message's conversation and require an exact match. Existing published
migrations are unchanged.

## Validation before deployment

- Telegram tests: 80 passed, including the real mtcute internal-error
  middleware, subsequent successful retry and HTTP status contracts.
- Telegram TypeScript: passed.
- Database migration suite against disposable PostgreSQL 16.15: 13 passed,
  one existing skip. UUID and BIGINT cases cover commit/rollback, withdrawal
  notifications and account/provider isolation.
- Independent review identified an incorrect middleware error fixture; it
  was corrected to the installed library's `mt_rpc_error` and rerun green.

## Related WhatsApp delivery

Commit `a5ffeac` contains inline videos, centered audio controls, poll voters,
history/message recovery, preserved view-once/revoked content, receipts and
presence. Recovery requires content already captured or returned by the
phone. Voters reflect captured votes; last-seen and online state require
provider data and respect its privacy settings. A missing provider value is
not fabricated.

## Deployment acceptance

Publish maintained images to `docker.staticduo.com` and verify their digests.
Run migration 035 through the maintained migrator without restarting the
existing backend. Deploy only the Telegram connector, leaving sync/recovery
enabled. Observe PostgreSQL and Telegram logs for 10-15 minutes, probe actual
media retrieval and confirm continued synchronization before claiming a
production result. A continuing Telegram provider outage must be reported
separately from successful local retry handling.

## Production result

Observed 2026-10-10 09:23:54-09:34:04 UTC (610 seconds) after deployment:

- Connector, sync and PostgreSQL remained running/healthy. Zero recurring
  `upload.getFile -503`, UUID/BIGINT or media-attempt errors in this window.
- Sync stored 29 attachments, including four recovered pending attachments.
  The backlog decreased from the earlier 18 to 13; those remaining had no
  currently eligible retry. This does not assert that every Telegram file is
  now downloadable.
- A real Telegram file downloaded successfully: 35,270 bytes in 3.01 seconds.
  Signed identity/dialog reads succeeded (67 dialogs). Message history
  ingestion continued, increasing the stored message count during the probe.
- Migration 035 was the only applied migration. Its recorded SHA-256 is
  `8db1df53c5729c5e6c41eac8926bd85a908bcc31794532fe6f7881567e361dbb`.
- Compose changed only `telegram-connector.image` and `migrate.image`.
  Backend and sync configuration/image remained unchanged.

Published source `b0d5841`:

- Telegram: `docker.staticduo.com/socialmedia-telegram@sha256:1ab0898a1018abd68df95454f6f759d7ddf2815a6e6db12e4cc193d0b5897d72`.
- Migrator: `docker.staticduo.com/socialmedia-mcp@sha256:f3d1f0f176e5887d7902fbad1d215325df85efe2fa127afe4cae59d9f876ee34`.

WhatsApp follow-up verification: 103 targeted application tests passed.
Playwright in official `v1.57.0-noble` with matching package passed playback,
audio geometry, voter details, preservation markers and history recovery.
Host Chromium exited with SIGTRAP before launch; Docker was the successful
environment retry. Deployed files match source for the web and both WhatsApp
connectors. A real video served `206 video/mp4` with 1,024 requested bytes.
Two real poll API results exposed 29 and 19 captured voters. No messages or
votes were sent for these checks. No GitHub checks were reported for the fork
head; local test results are not a claim that remote CI ran.
