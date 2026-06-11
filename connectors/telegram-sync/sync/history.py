"""History importer / backfill — pulls Telegram history through the connector
into PostgreSQL. This is the SAFETY NET for the at-most-once NATS realtime path:
anything the live consumer missed (consumer downtime, connector restart) is
recovered here within one cycle.

Session-less: enumerates chats via GET /api/v1/dialogs and pages each chat's
history via GET /api/v1/messages/:chatId?limit&offsetId (newest-first,
older-than cursor). Resume watermark per chat = telegram_sync_state.last_message_id.
"""
from __future__ import annotations

import asyncio
import logging
import os

import asyncpg

from sync import db, mapping, media_download, avatar_sync
from sync.connector_client import ConnectorClient

logger = logging.getLogger(__name__)

BATCH_SIZE = 100
DELAY_BETWEEN_CHATS = 1          # seconds, gentle on the shared connector session
CATCHUP_INTERVAL = 30 * 60       # 30 minutes
STARTUP_DELAY = 5               # let NATS realtime attach first
# Per-chat page cap per cycle — a runaway backstop and a bound on how hard a
# single first-run backfill can hammer the shared connector session. The
# no-progress + empty-page + watermark checks are the real terminators; normal
# catch-up finishes far under this. ~100k messages/chat/cycle.
MAX_PAGES_PER_CHAT = 1000
# Download historical media inline (parity with the old sync). Tunable because a
# first full backfill of a media-heavy account is the heaviest load on the
# connector's single session.
HISTORY_MEDIA = os.environ.get("HISTORY_MEDIA", "true").lower() == "true"


async def import_chat(connector: ConnectorClient, pool: asyncpg.Pool, dialog: dict) -> None:
    """Import messages newer than the stored watermark for a single chat."""
    chat_id = str(dialog.get("id"))
    chat_title = dialog.get("name")

    state = await db.get_sync_state(pool, int(chat_id))
    min_id = int(state["last_message_id"]) if state else 0

    offset_id: int | None = None
    new_count = 0
    highest_seen = min_id
    stop = False        # reached the watermark / true start → range fully imported
    aborted = False     # error or page cap → range incomplete, do NOT advance watermark
    pages = 0

    while not stop:
        if pages >= MAX_PAGES_PER_CHAT:
            aborted = True
            logger.warning("%s (%s): hit page cap (%s) — will resume next cycle",
                           chat_title, chat_id, MAX_PAGES_PER_CHAT)
            break
        pages += 1
        try:
            msgs = await connector.get_messages(chat_id, limit=BATCH_SIZE, offset_id=offset_id)
        except Exception as e:
            logger.warning("get_messages failed for %s (%s): %s", chat_title, chat_id, e)
            aborted = True
            break
        if not msgs:
            break  # paged to the true start of history → complete

        for m in msgs:  # newest-first (descending)
            tg_id = mapping._int_or_none(m.get("telegramMessageId"))
            if tg_id is None:
                continue
            if tg_id <= min_id:
                stop = True
                break

            kwargs = mapping.to_insert_kwargs(m)
            if kwargs is None:
                continue
            try:
                message_id, is_new = await db.insert_message_ex(pool, **kwargs)
            except Exception as e:
                logger.error("history insert failed (chat %s msg %s): %s", chat_id, tg_id, e)
                continue
            if message_id is None:
                continue
            highest_seen = max(highest_seen, tg_id)
            if is_new:
                new_count += 1
                if (HISTORY_MEDIA and m.get("attachments")
                        and kwargs["message_type"] in media_download.DOWNLOADABLE_TYPES):
                    try:
                        await media_download.download_and_store_media(
                            connector, pool, m, message_id, kwargs["message_type"]
                        )
                    except Exception as e:
                        logger.warning("history media error (msg %s): %s", message_id, e)

        # Advance the cursor to the oldest id in this page and page OLDER. Do NOT
        # stop on a short page: Telegram/connector can return < limit even when
        # more history exists (server windowing + null-parsed drops). The
        # no-progress guard (oldest not strictly older than the cursor) is the
        # hard infinite-loop backstop.
        oldest = mapping._int_or_none(msgs[-1].get("telegramMessageId"))
        if oldest is None:
            break
        if offset_id is not None and oldest >= offset_id:
            break
        offset_id = oldest

    # Watermark = highest id imported, but ONLY advance it once the whole range
    # down to the previous watermark is contiguously imported. We page newest→old,
    # so on an aborted scan the OLDER portion is still missing; advancing then
    # would skip it forever. Leave the watermark put and re-scan next cycle
    # (idempotent via ON CONFLICT) when aborted.
    if not aborted and highest_seen > min_id:
        await db.update_sync_state(pool, int(chat_id), chat_title, highest_seen, new_count)
        await db.mark_chat_completed(pool, int(chat_id))
    if new_count:
        logger.info("Backfilled %s: %s new messages%s", chat_title, new_count,
                    " (partial — capped)" if aborted else "")


async def run(pool: asyncpg.Pool, connector: ConnectorClient) -> None:
    """Periodic backfill loop. Never raises out — the connector recovers on its
    own and the bridge keeps serving; we just retry next cycle."""
    await asyncio.sleep(STARTUP_DELAY)

    while True:
        try:
            dialogs = await connector.get_dialogs()
            logger.info("Backfill cycle: %s chats", len(dialogs))

            avatars_done = 0
            for dialog in dialogs:
                try:
                    if await avatar_sync.sync_dialog_state(connector, pool, dialog):
                        avatars_done += 1
                except Exception as e:
                    logger.warning("dialog state sync failed for %s: %s", dialog.get("name"), e)

                try:
                    await import_chat(connector, pool, dialog)
                except Exception as e:
                    logger.error("Error importing chat %s: %s", dialog.get("name"), e)
                await asyncio.sleep(DELAY_BETWEEN_CHATS)

            if avatars_done:
                logger.info("Backfilled %s conversation avatars this cycle", avatars_done)
            logger.info("Backfill cycle complete. Next run in 30 minutes.")
        except Exception as e:
            logger.error("Backfill cycle failed: %s", e)

        await asyncio.sleep(CATCHUP_INTERVAL)
