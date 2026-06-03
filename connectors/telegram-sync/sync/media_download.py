"""Download Telegram media via the connector → upload to MinIO → INSERT
attachment row.

Session-less: bytes come from the connector's HMAC route
GET /api/v1/messages/media/:chatId/:msgId (base64-in-JSON), not Telethon.
Used by nats_consumer.py (realtime) and history.py (backfill). Errors are caught
& logged so a media failure never breaks the caller's ingest flow.
"""
from __future__ import annotations

import logging

import asyncpg

from sync import db, media_storage, mapping
from sync.connector_client import ConnectorClient

logger = logging.getLogger(__name__)

# Re-exported for callers that gate on downloadability.
DOWNLOADABLE_TYPES = mapping.DOWNLOADABLE_TYPES


async def download_and_store_media(
    connector: ConnectorClient,
    pool: asyncpg.Pool,
    msg: dict,
    message_id: int,
    message_type: str,
) -> bool:
    """Download msg's media via the connector and INSERT an attachments row.
    `msg` is a connector message dict (conversationId/telegramMessageId/attachments).
    Returns True on success, False otherwise."""
    mt = (message_type or "").lower()
    if mt not in DOWNLOADABLE_TYPES:
        return False
    if not msg.get("attachments") and mt != "photo":
        return False

    chat_id = msg.get("conversationId")
    tg_msg_id = mapping._int_or_none(msg.get("telegramMessageId"))
    if chat_id is None or tg_msg_id is None:
        return False

    # Idempotent on retry / duplicate events.
    try:
        if await db.attachment_exists_for_message(pool, message_id):
            return False
    except Exception:
        pass

    try:
        data = await connector.download_media(str(chat_id), tg_msg_id)
    except Exception as e:
        logger.warning("connector download_media failed for msg %s: %s", message_id, e)
        return False
    if not data:
        return False

    meta = mapping.attachment_meta(msg)
    try:
        storage_key, size = media_storage.upload_media(
            message_id=message_id,
            data=data,
            mime_type=meta["mime_type"],
            file_name=meta["file_name"],
        )
    except Exception as e:
        logger.warning("MinIO upload failed for msg %s: %s", message_id, e)
        return False

    caption = msg.get("content") or None
    try:
        await db.insert_attachment(
            pool,
            message_id=message_id,
            file_type=message_type.upper(),
            mime_type=meta["mime_type"],
            file_name=meta["file_name"],
            file_size=meta["file_size"] or size,
            file_url=storage_key,
            duration_seconds=meta["duration"],
            width=meta["width"],
            height=meta["height"],
            caption=caption,
        )
    except Exception as e:
        logger.error("insert_attachment failed for msg %s: %s", message_id, e)
        return False

    logger.info("Stored media %s (%s bytes) for msg %s", storage_key, size, message_id)
    return True
