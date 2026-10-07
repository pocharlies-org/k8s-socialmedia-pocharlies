"""Recover stored Telegram messages whose attachments were never downloaded."""
from __future__ import annotations

import asyncio
import logging
import os
import time

import httpx

from sync import db, mapping, media_download
from sync.connector_client import retry_after

logger = logging.getLogger(__name__)
BATCH_SIZE = 5
# One cycle every 60 s by default (sre, SKIRM-99: the personal-account queries scan
# messages and take 0.3-0.8 s; the floor keeps a bad value from hammering Telegram).
INTERVAL = max(10.0, float(os.environ.get('MEDIA_RECOVERY_INTERVAL_S', '60')))


async def recover_batch(pool, connector, account: str) -> int:
    stored = 0
    for row in await db.pending_media(pool, account, BATCH_SIZE):
        try:
            meta = row['metadata']
            message = await connector.get_message(
                str(meta['telegram_chat_id']), int(meta['telegram_message_id']),
            )
            if message is None:
                await db.record_media_result(pool, row['id'], 'deleted')
            elif mapping.message_type_of(message) not in mapping.DOWNLOADABLE_TYPES:
                await db.record_media_result(pool, row['id'], 'unavailable')
            else:
                stored += bool(await media_download.download_and_store_media(
                    connector, pool, message, row['id'], mapping.message_type_of(message),
                ))
        except Exception as error:
            delay = retry_after(error.response) if isinstance(error, httpx.HTTPStatusError) else 0
            await db.record_media_result(pool, row['id'], 'retry', delay)
            logger.warning('media recovery failed: %s', type(error).__name__)
            if isinstance(error, httpx.HTTPStatusError) and error.response.status_code in (429, 503):
                break
        await asyncio.sleep(1)
    return stored


async def run(pool, connector, account: str) -> None:
    await asyncio.sleep(5)
    next_backlog_log = 0.0
    while True:
        try:
            stored = await recover_batch(pool, connector, account)
            if stored:
                logger.info('Recovered %s Telegram attachments', stored)
            if time.monotonic() >= next_backlog_log:
                backlog = await db.media_backlog(pool, account)
                logger.info('Telegram media backlog total_missing=%s eligible_now=%s',
                            backlog['total_missing'], backlog['eligible_now'])
                next_backlog_log = time.monotonic() + 300
        except Exception as error:
            logger.warning('media recovery cycle failed: %s', type(error).__name__)
        await asyncio.sleep(INTERVAL)
