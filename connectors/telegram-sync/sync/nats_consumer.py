"""Real-time capture via NATS — replaces the Telethon events handler.

Subscribes to the connector's flat subject `telegram.MessageReceived` and keeps
only the events tagged with THIS instance's account (event.account, added to the
connector publisher). Because each connector (personal / professional) stamps its
own account, a shared-group message — which both connectors publish — is processed
exactly once per sync instance, under the correct account namespace. No second
Telegram session is opened here.

Caveats (inherent to the connector's NATS contract):
  - core NATS, at-most-once: events lost while this consumer is down are
    recovered by history.run's periodic backfill, not replayed here.
  - no edit/delete/reaction events are published, so those are not captured.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import ssl

import asyncpg
import nats

from sync import db, mapping, media_download, avatar_sync
from sync.connector_client import ConnectorClient

logger = logging.getLogger(__name__)

SUBJECT = "telegram.MessageReceived"


def _tls_context(nats_url: str) -> ssl.SSLContext | None:
    if not nats_url.startswith("tls://"):
        return None
    ca = os.environ.get("NATS_CA_CERT")
    ctx = ssl.create_default_context()
    if ca and os.path.exists(ca):
        ctx.load_verify_locations(ca)
    return ctx


async def _handle_event(event: dict, pool: asyncpg.Pool, connector: ConnectorClient,
                        account: str) -> None:
    # Account filter — drop events that belong to the other Telegram account.
    # `or 'personal'` (not a default arg) so a null/empty account is treated as
    # personal too: during the phased rollout (connector not yet emitting the
    # account field) the personal sync keeps ingesting while the professional one
    # waits for account-tagged events.
    if (event.get("account") or "personal") != account:
        return

    kwargs = mapping.to_insert_kwargs(event)
    if kwargs is None:
        return

    try:
        message_id, is_new = await db.insert_message_ex(pool, **kwargs)
    except Exception as e:
        logger.error("insert failed for tg msg %s: %s", event.get("telegramMessageId"), e)
        return
    if message_id is None:
        return

    mt = kwargs["message_type"]
    chat_id = kwargs["chat_id"]

    logger.info(
        "Message: dir=%s type=%s text=%s chat=%s new=%s",
        kwargs["direction"], mt, bool(kwargs["content"]), chat_id, is_new,
    )

    # Side effects only on a genuinely new row (idempotent vs history backfill).
    if not is_new:
        return

    # Media → MinIO + attachment row (guarded internally too).
    if event.get("attachments") and mt in mapping.DOWNLOADABLE_TYPES:
        asyncio.create_task(
            media_download.download_and_store_media(connector, pool, event, message_id, mt)
        )

    # Lazy avatars for the conversation and the sender.
    asyncio.create_task(
        avatar_sync.ensure_conversation_avatar(
            connector, pool, str(chat_id), chat_title=kwargs["chat_title"]
        )
    )
    if kwargs["sender_id"]:
        asyncio.create_task(
            avatar_sync.ensure_participant_avatar(
                connector, pool, str(kwargs["sender_id"]),
                name=kwargs["sender_name"], username=event.get("senderUsername"),
            )
        )

    # Auto-reply webhook for inbound text only.
    if kwargs["direction"] == "inbound" and mt == "text" and kwargs["content"]:
        from sync.bridge import notify_autoreply
        asyncio.create_task(notify_autoreply(
            chat_id=chat_id,
            chat_title=kwargs["chat_title"],
            sender_id=kwargs["sender_id"],
            sender_name=kwargs["sender_name"],
            content=kwargs["content"],
            message_type="text",
            telegram_message_id=kwargs["telegram_message_id"],
            timestamp=kwargs["timestamp"].isoformat(),
            account=account,
        ))


async def run(pool: asyncpg.Pool, connector: ConnectorClient, account: str) -> None:
    """Connect to NATS and stream realtime events until cancelled. nats-py
    auto-reconnects; we only retry the INITIAL connect."""
    nats_url = os.environ.get("NATS_URL", "nats://localhost:4222")
    tls = _tls_context(nats_url)

    while True:
        try:
            nc = await nats.connect(
                servers=[nats_url],
                tls=tls,
                name=f"telegram-sync-{account}",
                max_reconnect_attempts=-1,
                reconnect_time_wait=2,
            )
            break
        except Exception as e:
            logger.error("NATS connect failed (%s) — retrying in 5s", e)
            await asyncio.sleep(5)

    logger.info("NATS connected (%s); subscribing to %s for account=%s",
                nats_url, SUBJECT, account)

    async def _cb(msg):
        try:
            event = json.loads(msg.data)
        except Exception as e:
            logger.warning("bad NATS payload: %s", e)
            return
        await _handle_event(event, pool, connector, account)

    await nc.subscribe(SUBJECT, cb=_cb)

    # Keep the task alive forever; nats-py handles reconnects under the hood.
    try:
        await asyncio.Event().wait()
    finally:
        try:
            await nc.drain()
        except Exception:
            pass
