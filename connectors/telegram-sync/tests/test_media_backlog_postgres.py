"""Media-recovery SQL against a throwaway Postgres, on the production shapes.

Production (measured 08-10, SKIRM-99): messages.id and attachments.message_id are
bigint, attachments carries file_url (no storage_key) and messages.message_type
is stored in capitals. The tables below reproduce that in a private schema.

    TELEGRAM_SYNC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/postgres \\
      python -m pytest tests/test_media_backlog_postgres.py -q -rs
"""
import asyncio
import json
import os
import time
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import asyncpg
import pytest

from sync import db, media_download

DSN = os.environ.get('TELEGRAM_SYNC_TEST_DATABASE_URL')
META = {'telegram_chat_id': 7, 'telegram_message_id': 42}

SCHEMA_SQL = '''
CREATE TABLE messages (id bigserial PRIMARY KEY, platform text, account text, message_type text,
                       metadata jsonb, wa_timestamp timestamp);
CREATE TABLE attachments (id bigserial PRIMARY KEY, message_id bigint, file_type text, mime_type text,
                          file_name text, file_size bigint, file_url text, thumbnail_url text,
                          duration_seconds int, width int, height int, caption text,
                          created_at timestamp DEFAULT NOW());
'''


def on_prod_schema(check):
    """Run `await check(pool)` against a pool whose search_path is a private schema."""
    async def run():
        schema = f'skirm101_{uuid4().hex[:8]}'
        admin = await asyncpg.connect(DSN)
        try:
            await admin.execute(f'CREATE SCHEMA {schema}')
            pool = await asyncpg.create_pool(DSN, min_size=1, max_size=4,
                                             server_settings={'search_path': schema})
            try:
                async with pool.acquire() as conn:
                    await conn.execute(SCHEMA_SQL)
                await check(pool)
            finally:
                await pool.close()
        finally:
            await admin.execute(f'DROP SCHEMA {schema} CASCADE')
            await admin.close()
    asyncio.run(run())


async def add(pool, account, kind, metadata, file_url=None, age_s=0):
    async with pool.acquire() as conn:
        message_id = await conn.fetchval(
            "INSERT INTO messages (platform, account, message_type, metadata, wa_timestamp) "
            "VALUES ('telegram', $1, $2, $3, NOW() - make_interval(secs => $4)) RETURNING id",
            account, kind, json.dumps(metadata), float(age_s))
        if file_url is not None:
            await conn.execute('INSERT INTO attachments (message_id, file_url) VALUES ($1, $2)',
                               message_id, file_url)
    return message_id


pytestmark = pytest.mark.skipif(not DSN, reason='TELEGRAM_SYNC_TEST_DATABASE_URL not set')


def test_backlog_separates_missing_keys_from_eligible_messages():
    async def check(pool):
        for account, kind, meta, url in [
            ('personal', 'PHOTO', META, None),
            ('personal', 'PHOTO', {**META, 'media_next_retry': 9999999999}, None),
            ('personal', 'PHOTO', {**META, 'media_status': 'deleted'}, None),
            ('personal', 'PHOTO', {}, None),
            ('personal', 'PHOTO', META, ' '),
            ('personal', 'PHOTO', META, 's3://stored'),
            ('other', 'PHOTO', META, None),
            ('personal', 'TEXT', META, None),
        ]:
            await add(pool, account, kind, meta, url)
        assert await db.media_backlog(pool, 'personal') == {'total_missing': 5, 'eligible_now': 1}
        assert len(await db.pending_media(pool, 'personal')) == 1
        assert await db.media_backlog(pool, 'other') == {'total_missing': 1, 'eligible_now': 1}
        assert await db.media_backlog(pool, 'absent') == {'total_missing': 0, 'eligible_now': 0}
    on_prod_schema(check)


def test_pending_media_is_ordered_by_due_time_and_limited():
    async def check(pool):
        fresh = await add(pool, 'personal', 'VOICE', META, age_s=100)
        fresh_newer = await add(pool, 'personal', 'VIDEO', META, age_s=10)
        due = await add(pool, 'personal', 'PHOTO', {**META, 'media_next_retry': 100}, age_s=1000)
        await add(pool, 'personal', 'PHOTO', {**META, 'media_status': 'unavailable'})
        ids = [row['id'] for row in await db.pending_media(pool, 'personal')]
        assert ids == [fresh, fresh_newer, due]  # never tried first, then by due time, then by age
        assert [r['id'] for r in await db.pending_media(pool, 'personal', 2)] == [fresh, fresh_newer]
    on_prod_schema(check)


def test_retry_after_and_exponential_backoff_are_persisted():
    async def check(pool):
        message_id = await add(pool, 'personal', 'PHOTO', META)

        async def next_retry():
            async with pool.acquire() as conn:
                meta = json.loads(await conn.fetchval('SELECT metadata FROM messages WHERE id = $1', message_id))
            return meta['media_status'], meta['media_attempts'], meta['media_next_retry'] - time.time()

        await db.record_media_result(pool, message_id, 'retry')           # attempt 1: 30 s
        status, attempts, wait = await next_retry()
        assert (status, attempts) == ('retry', 1) and 25 < wait <= 31
        await db.record_media_result(pool, message_id, 'retry', 420)      # Retry-After wins over backoff
        status, attempts, wait = await next_retry()
        assert attempts == 2 and 415 < wait <= 421
        async with pool.acquire() as conn:                                # many attempts: capped at 3600 s
            await conn.execute("UPDATE messages SET metadata = metadata || '{\"media_attempts\": 40}'")
        await db.record_media_result(pool, message_id, 'retry')
        assert 3595 < (await next_retry())[2] <= 3601
        assert await db.pending_media(pool, 'personal') == []             # not due yet
    on_prod_schema(check)


def test_media_transaction_serialises_on_the_message_row():
    async def check(pool):
        message_id = await add(pool, 'personal', 'PHOTO', META)
        order, first_in = [], asyncio.Event()

        async def first():
            async with db.media_transaction(pool, message_id):
                order.append('first in')
                first_in.set()
                await asyncio.sleep(0.3)
                order.append('first out')

        async def second():
            await first_in.wait()
            async with db.media_transaction(pool, message_id):
                order.append('second in')

        await asyncio.gather(first(), second())
        assert order == ['first in', 'first out', 'second in']
    on_prod_schema(check)


def test_download_and_store_writes_one_attachment_on_prod_types():
    async def check(pool):
        message_id = await add(pool, 'personal', 'PHOTO', META)
        msg = {'conversationId': '7', 'telegramMessageId': '42', 'content': 'caption',
               'attachments': [{'mimeType': 'image/jpeg', 'fileName': 'photo.jpg'}]}
        connector = AsyncMock()
        connector.download_media.return_value = b'jpeg-data'
        with patch('sync.media_storage.upload_media', return_value=('s3://bucket/new.jpg', 9)):
            results = await asyncio.gather(*[
                media_download.download_and_store_media(connector, pool, msg, message_id, 'photo')
                for _ in range(2)])
        assert sorted(results) == [False, True]
        async with pool.acquire() as conn:
            rows = await conn.fetch('SELECT file_type, file_url, file_size, caption FROM attachments')
            status = json.loads(await conn.fetchval('SELECT metadata FROM messages'))['media_status']
        assert [tuple(r) for r in rows] == [('PHOTO', 's3://bucket/new.jpg', 9, 'caption')]
        assert status == 'stored'
        assert await db.pending_media(pool, 'personal') == []
        assert await db.media_backlog(pool, 'personal') == {'total_missing': 0, 'eligible_now': 0}
    on_prod_schema(check)
