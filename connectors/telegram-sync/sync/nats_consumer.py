"""Real-time capture via NATS — replaces the Telethon events handler.

Subscribes to the connector's flat subject `telegram.MessageReceived` and keeps
only the events tagged with THIS instance's account (event.account, added to the
connector publisher). Because each connector (personal / professional) stamps its
own account, a shared-group message — which both connectors publish — is processed
exactly once per sync instance, under the correct account namespace. No second
Telegram session is opened here.

Text edits arrive on `telegram.MessageEdited` (our own through the connector's
POST /messages/edit, and the ones Telegram dispatches) and are recorded on the
row like the WhatsApp connector does: content = new text, is_edited = true, the
replaced text appended to metadata.edit_history, metadata.edited_at.

Caveats (inherent to the connector's NATS contract):
  - core NATS, at-most-once: messages lost while this consumer is down are
    recovered by history.run's periodic backfill, not replayed here; an edit
    lost that way is not (the backfill never rewrites an existing row).
  - no delete/reaction events are published, so those are not captured.
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
# CONTRACT: nats.telegram-connector.message-edited.v1
EDIT_SUBJECT = "telegram.MessageEdited"


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

    if mt in mapping.DOWNLOADABLE_TYPES:
        asyncio.create_task(
            media_download.download_and_store_media(connector, pool, event, message_id, mt)
        )

    if not is_new:
        return

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


async def _handle_edit(event: dict, pool: asyncpg.Pool, account: str) -> None:
    # Same account filter as messages: each sync records only its own account.
    if (event.get("account") or "personal") != account:
        return
    kwargs = mapping.to_edit_kwargs(event)
    if kwargs is None:
        return
    try:
        row_id = await db.mark_message_edited(pool, **kwargs)
    except Exception as e:
        logger.error("edit failed for tg msg %s/%s: %s",
                     kwargs["chat_id"], kwargs["telegram_message_id"], e)
        return
    logger.info(
        "Edit: chat=%s msg=%s source=%s recorded=%s",
        kwargs["chat_id"], kwargs["telegram_message_id"], kwargs["source"], row_id is not None,
    )


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

    logger.info("NATS connected (%s); subscribing to %s and %s for account=%s",
                nats_url, SUBJECT, EDIT_SUBJECT, account)

    async def _cb(msg):
        try:
            event = json.loads(msg.data)
        except Exception as e:
            logger.warning("bad NATS payload: %s", e)
            return
        await _handle_event(event, pool, connector, account)

    async def _edit_cb(msg):
        try:
            event = json.loads(msg.data)
        except Exception as e:
            logger.warning("bad NATS edit payload: %s", e)
            return
        await _handle_edit(event, pool, account)

    await nc.subscribe(SUBJECT, cb=_cb)
    await nc.subscribe(EDIT_SUBJECT, cb=_edit_cb)

    # Keep the task alive forever; nats-py handles reconnects under the hood.
    try:
        await asyncio.Event().wait()
    finally:
        try:
            await nc.drain()
        except Exception:
            pass
