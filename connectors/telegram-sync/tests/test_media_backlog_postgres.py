"""The media-recovery SQL against a real Postgres (SKIRM-101 C1 and C2).

Needs TELEGRAM_SYNC_TEST_DATABASE_URL (the one ci.yml sets and test_edits.py
reads); without it every test here is skipped, and a skip is not a pass.
Session-local tables, so nothing is left behind.

Adapted from the fork's tests/test_media_backlog_postgres.py (jibanez-staticduo):
bigint ids as in prod, and the DSN variable of our CI.
"""
import asyncio
import json
import os
import time

import pytest

from sync import db
from fakes import Pool

DSN = os.environ.get('TELEGRAM_SYNC_TEST_DATABASE_URL')
needs_db = pytest.mark.skipif(not DSN, reason='TELEGRAM_SYNC_TEST_DATABASE_URL not set')

TABLES = '''
    CREATE TEMP TABLE messages (id bigserial PRIMARY KEY, platform text, account text,
        message_type text, metadata jsonb, wa_timestamp timestamp);
    CREATE TEMP TABLE attachments (message_id bigint, file_url text, storage_key text);
'''
META = {'telegram_chat_id': 7, 'telegram_message_id': 42}


async def _with_tables(check):
    import asyncpg

    conn = await asyncpg.connect(DSN)
    try:
        await conn.execute(TABLES)
        return await check(conn, Pool(conn))
    finally:
        await conn.close()


async def _message(conn, account, kind, metadata, keys=None, platform='telegram', age=0):
    message_id = await conn.fetchval(
        "INSERT INTO messages (platform, account, message_type, metadata, wa_timestamp) "
        "VALUES ($1, $2, $3, $4::jsonb, NOW() - make_interval(secs => $5)) RETURNING id",
        platform, account, kind, json.dumps(metadata), float(age))
    if keys is not None:
        await conn.execute('INSERT INTO attachments VALUES ($1, $2, $3)', message_id, *keys)
    return message_id


@needs_db
def test_backlog_separates_missing_keys_from_eligible_messages():
    async def check(conn, pool):
        for account, kind, metadata, keys in [
            ('personal', 'PHOTO', META, None),
            ('personal', 'PHOTO', {**META, 'media_next_retry': 9999999999}, None),
            ('personal', 'PHOTO', {**META, 'media_status': 'deleted'}, None),
            ('personal', 'PHOTO', {**META, 'media_status': 'unavailable'}, None),
            ('personal', 'PHOTO', {}, None),
            ('personal', 'PHOTO', META, (' ', None)),
            ('personal', 'PHOTO', META, ('s3://stored', None)),
            ('personal', 'PHOTO', META, (None, 'legacy/stored')),
            ('other', 'PHOTO', META, None),
            ('personal', 'TEXT', META, None),
        ]:
            await _message(conn, account, kind, metadata, keys)
        await _message(conn, 'personal', 'PHOTO', META, platform='whatsapp')

        # Missing a stored key: the first four, the empty-metadata one and the blank-key one.
        # Eligible now: only the plain one (the blank-key row already HAS an attachment row).
        assert await db.media_backlog(pool, 'personal') == {'total_missing': 6, 'eligible_now': 1}
        assert len(await db.pending_media(pool, 'personal')) == 1
        assert await db.media_backlog(pool, 'other') == {'total_missing': 1, 'eligible_now': 1}
        assert await db.media_backlog(pool, 'absent') == {'total_missing': 0, 'eligible_now': 0}

    asyncio.run(_with_tables(check))


@needs_db
def test_pending_media_is_ordered_by_due_time_and_limited():
    async def check(conn, pool):
        now = time.time()
        late = await _message(conn, 'personal', 'VIDEO', {**META, 'media_next_retry': now - 10}, age=1)
        early = await _message(conn, 'personal', 'VOICE', {**META, 'media_next_retry': now - 500}, age=1)
        never_tried = await _message(conn, 'personal', 'PHOTO', META, age=100)
        rows = await db.pending_media(pool, 'personal', 10)
        assert [row['id'] for row in rows] == [never_tried, early, late]
        assert isinstance(rows[0]['metadata'], dict)
        assert len(await db.pending_media(pool, 'personal', 2)) == 2

    asyncio.run(_with_tables(check))


@needs_db
def test_rate_limit_and_backoff_schedule_the_next_retry():
    async def check(conn, pool):
        async def next_retry_in(message_id):
            value = await conn.fetchval("SELECT (metadata->>'media_next_retry')::double precision FROM messages WHERE id = $1", message_id)
            return value - time.time()

        # Retry-After: 420 -> never earlier than 420 s from now.
        limited = await _message(conn, 'personal', 'PHOTO', META)
        await db.record_media_result(pool, limited, 'retry', 420.0)
        assert 419 <= await next_retry_in(limited) <= 425
        # A Retry-After above the backoff cap is honoured as well.
        await db.record_media_result(pool, limited, 'retry', 7200.0)
        assert await next_retry_in(limited) >= 7199

        # No header: 30 s doubling per attempt, capped at 3600 s.
        plain = await _message(conn, 'personal', 'PHOTO', META)
        waits = []
        for _ in range(10):
            await db.record_media_result(pool, plain, 'retry')
            waits.append(round(await next_retry_in(plain)))
        assert waits[:4] == [30, 60, 120, 240]
        assert waits[-1] == 3600 and max(waits) == 3600
        meta = json.loads(await conn.fetchval('SELECT metadata FROM messages WHERE id = $1', plain))
        assert (meta['media_status'], meta['media_attempts']) == ('retry', 10)
        assert meta['telegram_chat_id'] == 7, 'the original metadata is kept'

    asyncio.run(_with_tables(check))
