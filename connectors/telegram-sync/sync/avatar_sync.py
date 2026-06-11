"""Profile photos (chats + users) via the connector → MinIO → persist the
storage key into conversations.avatar_url / participants.profile_pic_url.

Session-less: photo bytes come from the connector HMAC route
GET /api/v1/peers/:id/photo (JPEG base64). Used by:
  - history.run(): once per dialog each cycle (also persists unread badge)
  - nats_consumer: lazily on message ingest when avatar is missing

Lost vs Telethon: per-dialog unread_mentions and archived flag (the connector
dialog object only exposes unreadCount).
"""
from __future__ import annotations

import logging
from typing import Optional

import asyncpg

from sync import media_storage, db
from sync.connector_client import ConnectorClient

logger = logging.getLogger(__name__)


async def _download_peer_photo(connector: ConnectorClient, peer_id: str) -> Optional[bytes]:
    try:
        return await connector.peer_photo(peer_id)
    except Exception as e:
        logger.warning("peer_photo failed for %s: %s", peer_id, e)
        return None


async def ensure_conversation_avatar(
    connector: ConnectorClient,
    pool: asyncpg.Pool,
    chat_id: str,
    *,
    conv_id: Optional[str] = None,
    chat_title: Optional[str] = None,
    force: bool = False,
) -> bool:
    """Download a conversation/group avatar if we don't have one yet.
    chat_id is the bare marked id string (e.g. '-1003984393379')."""
    if conv_id is None:
        conv_id = db.account_key(f"tg_{chat_id}")

    if not force:
        row = await pool.fetchrow("SELECT avatar_url FROM conversations WHERE id = $1", conv_id)
        if row and row["avatar_url"]:
            return False

    data = await _download_peer_photo(connector, chat_id)
    if not data:
        return False

    storage_key = media_storage.upload_avatar("conversations", conv_id, data)
    await pool.execute(
        "UPDATE conversations SET avatar_url = $2, updated_at = NOW() WHERE id = $1",
        conv_id, storage_key,
    )
    logger.info("ensured avatar for conversation %s → %s", conv_id, storage_key)
    return True


async def ensure_participant_avatar(
    connector: ConnectorClient,
    pool: asyncpg.Pool,
    user_id: str,
    *,
    name: Optional[str] = None,
    username: Optional[str] = None,
    force: bool = False,
) -> bool:
    """Download a user's profile photo and persist into participants.profile_pic_url.
    user_id is the bare positive user id string."""
    pid = db.account_key(f"tg_{user_id}")

    if not force:
        row = await pool.fetchrow("SELECT profile_pic_url FROM participants WHERE id = $1", pid)
        if row and row["profile_pic_url"]:
            return False

    data = await _download_peer_photo(connector, user_id)
    if not data:
        return False

    storage_key = media_storage.upload_avatar("participants", pid, data)
    await pool.execute(
        "INSERT INTO participants (id, name, push_name, profile_pic_url, first_seen, last_seen, account) "
        "VALUES ($1, $2, $3, $4, NOW(), NOW(), $5) "
        "ON CONFLICT (id) DO UPDATE SET "
        "  profile_pic_url = EXCLUDED.profile_pic_url, "
        "  name = COALESCE(participants.name, EXCLUDED.name), "
        "  push_name = COALESCE(participants.push_name, EXCLUDED.push_name), "
        "  last_seen = NOW()",
        pid, name, username, storage_key, db.ACCOUNT,
    )
    logger.info("ensured avatar for participant %s → %s", pid, storage_key)
    return True


async def sync_dialog_state(
    connector: ConnectorClient,
    pool: asyncpg.Pool,
    dialog: dict,
    *,
    force: bool = False,
) -> bool:
    """Invoked from history.run() once per dialog. Persists the unread badge and
    downloads the avatar if missing. `dialog` is a connector dialog dict
    {id, name, type, unreadCount}. Returns True if a new avatar was downloaded."""
    chat_id = str(dialog.get("id"))
    conv_id = db.account_key(f"tg_{chat_id}")

    try:
        await db.update_conversation_state(
            pool, conv_id, int(dialog.get("unreadCount", 0) or 0), 0, False,
        )
    except Exception as e:
        logger.warning("conversation state update failed for %s: %s", conv_id, e)

    return await ensure_conversation_avatar(
        connector, pool, chat_id, conv_id=conv_id,
        chat_title=dialog.get("name"), force=force,
    )
