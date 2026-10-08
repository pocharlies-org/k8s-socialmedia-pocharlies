"""Download Telegram media via the connector → upload to MinIO → INSERT
attachment row.

Session-less: bytes come from the connector's HMAC route
GET /api/v1/messages/media/:chatId/:msgId (base64-in-JSON), not Telethon.
Used by nats_consumer.py (realtime) and history.py (backfill). Errors are caught
& logged so a media failure never breaks the caller's ingest flow.
"""
from __future__ import annotations

import logging
import asyncio

import httpx

import asyncpg

from sync import db, media_storage, mapping
from sync.connector_client import ConnectorClient, is_throttled, retry_after

logger = logging.getLogger(__name__)

# Re-exported for callers that gate on downloadability.
DOWNLOADABLE_TYPES = mapping.DOWNLOADABLE_TYPES


# Bound realtime + history + recovery together; do not queue simultaneous media
# requests on the connector's shared Telegram session.
_MEDIA_LOCK = asyncio.Lock()


async def _download_and_store_media(
    connector: ConnectorClient,
    pool: asyncpg.Pool,
    msg: dict,
    message_id: int,
    message_type: str,
) -> bool:
    """Store one attachment, preserving a durable retry on every failure."""
    if (message_type or "").lower() not in DOWNLOADABLE_TYPES:
        return False
    chat_id = msg.get("conversationId")
    tg_msg_id = mapping._int_or_none(msg.get("telegramMessageId"))
    if chat_id is None or tg_msg_id is None:
        return False

    async with _MEDIA_LOCK:
        async with db.media_transaction(pool, message_id) as conn:
            if await conn.fetchrow("SELECT 1 FROM attachments WHERE message_id = $1 LIMIT 1", message_id):
                return False
            state = await conn.fetchrow(
                "SELECT metadata FROM messages WHERE id = $1 AND "
                "(COALESCE((metadata->>'media_next_retry')::double precision, 0) > EXTRACT(EPOCH FROM NOW()) "
                "OR metadata->>'media_status' IN ('deleted', 'unavailable'))", message_id,
            )
            if state:
                return False
            try:
                data = await connector.download_media(str(chat_id), tg_msg_id)
                if data is None:
                    await db.media_result(conn, message_id, "unavailable")
                    return False
                if not data:
                    raise ValueError("empty media download")
                meta = mapping.attachment_meta(msg)
                storage_key, size = await asyncio.to_thread(
                    media_storage.upload_media,
                    message_id=message_id, data=data,
                    mime_type=meta["mime_type"], file_name=meta["file_name"],
                )
                await conn.execute(
                    db.INSERT_ATTACHMENT_SQL, message_id, message_type.upper(),
                    meta["mime_type"], meta["file_name"], meta["file_size"] or size, storage_key,
                    meta["duration"], meta["width"], meta["height"],
                    msg.get("content") or None,
                )
                await db.media_result(conn, message_id, "stored")
                logger.info("Stored media %s (%s bytes) for msg %s", storage_key, size, message_id)
                return True
            except Exception as error:
                # A failed SQL statement aborts the transaction. Roll back storage
                # bookkeeping before recording the retry on a fresh transaction.
                logger.warning("media attempt failed for msg %s: %s", message_id, type(error).__name__)
                delay = retry_after(error.response) if isinstance(error, httpx.HTTPStatusError) else 0
                raise MediaAttemptFailed(delay, is_throttled(error)) from error


class MediaAttemptFailed(Exception):
    def __init__(self, delay: float, throttled: bool = False):
        self.delay = delay
        self.throttled = throttled


async def download_and_store_media(
    connector: ConnectorClient, pool: asyncpg.Pool, msg: dict,
    message_id: int, message_type: str,
) -> bool:
    try:
        return await _download_and_store_media(connector, pool, msg, message_id, message_type)
    except MediaAttemptFailed as error:
        await db.record_media_result(pool, message_id, "retry", error.delay, counted=not error.throttled)
        return False
