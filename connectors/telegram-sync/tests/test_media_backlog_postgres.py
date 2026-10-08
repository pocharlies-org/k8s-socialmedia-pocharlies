"""The media-recovery SQL against a real Postgres (SKIRM-101 C1 and C2).

Needs TELEGRAM_SYNC_TEST_DATABASE_URL (the one ci.yml sets and test_edits.py
reads); without it every test here is skipped, and a skip is not a pass.
Session-local tables, so nothing is left behind. `attachments` has the columns of
prod (nota-sre-skirm99.md, 1.c): only `file_url` holds the stored key, there is no
`storage_key`.

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
    CREATE TEMP TABLE attachments (id bigserial PRIMARY KEY, message_id bigint, file_type text,
        mime_type text, file_name text, file_size bigint, file_url text, thumbnail_url text,
        duration_seconds int, width int, height int, caption text, created_at timestamp DEFAULT NOW());
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


async def _message(conn, account, kind, metadata, file_url=None, platform='telegram', age=0):
    message_id = await conn.fetchval(
        "INSERT INTO messages (platform, account, message_type, metadata, wa_timestamp) "
        "VALUES ($1, $2, $3, $4::jsonb, NOW() - make_interval(secs => $5)) RETURNING id",
        platform, account, kind, json.dumps(metadata), float(age))
    if file_url is not None:
        await conn.execute('INSERT INTO attachments (message_id, file_url) VALUES ($1, $2)', message_id, file_url)
    return message_id


@needs_db
def test_backlog_separates_missing_keys_from_eligible_messages():
    async def check(conn, pool):
        for account, kind, metadata, file_url in [
            ('personal', 'PHOTO', META, None),
            ('personal', 'PHOTO', {**META, 'media_next_retry': 9999999999}, None),
            ('personal', 'PHOTO', {**META, 'media_status': 'deleted'}, None),
            ('personal', 'PHOTO', {**META, 'media_status': 'unavailable'}, None),
            ('personal', 'PHOTO', {}, None),
            ('personal', 'PHOTO', META, ' '),
            ('personal', 'PHOTO', META, 's3://stored'),
            ('other', 'PHOTO', META, None),
            ('personal', 'TEXT', META, None),
        ]:
            await _message(conn, account, kind, metadata, file_url)
        await _message(conn, 'personal', 'PHOTO', META, platform='whatsapp')

        # Missing a stored file_url: the first four, the empty-metadata one and the blank-url one.
        # Eligible now: only the plain one (the blank-url row already HAS an attachment row).
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
def test_rate_limit_and_backoff_schedule_the_next_retry(monkeypatch):
    monkeypatch.setattr(db, 'MEDIA_MAX_ATTEMPTS', 99)  # the cap is tested below; here only the schedule

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


@needs_db
def test_eighth_failure_makes_the_message_unavailable_and_it_is_not_chosen_again():
    async def check(conn, pool):
        message_id = await _message(conn, 'personal', 'PHOTO', META)
        for attempt in range(1, 9):
            await db.record_media_result(pool, message_id, 'retry')
            meta = json.loads(await conn.fetchval('SELECT metadata FROM messages WHERE id = $1', message_id))
            assert meta['media_attempts'] == attempt
            assert meta['media_status'] == ('unavailable' if attempt == 8 else 'retry')
            # Let the wait of a still-retryable failure elapse, then ask who is next.
            await conn.execute("UPDATE messages SET metadata = metadata || '{\"media_next_retry\": 0}'::jsonb WHERE id = $1", message_id)
            chosen = [row['id'] for row in await db.pending_media(pool, 'personal')]
            assert (message_id in chosen) == (attempt < 8)
        # Still missing (it is counted), never eligible again.
        assert await db.media_backlog(pool, 'personal') == {'total_missing': 1, 'eligible_now': 0}
        assert db.MEDIA_MAX_ATTEMPTS == 8, 'the default of MEDIA_RECOVERY_MAX_ATTEMPTS'

    asyncio.run(_with_tables(check))


@needs_db
def test_the_cap_is_configurable(monkeypatch):
    monkeypatch.setattr(db, 'MEDIA_MAX_ATTEMPTS', 2)

    async def check(conn, pool):
        message_id = await _message(conn, 'personal', 'PHOTO', META)
        await db.record_media_result(pool, message_id, 'retry')
        await db.record_media_result(pool, message_id, 'retry')
        meta = json.loads(await conn.fetchval('SELECT metadata FROM messages WHERE id = $1', message_id))
        assert (meta['media_status'], meta['media_attempts']) == ('unavailable', 2)

    asyncio.run(_with_tables(check))


@needs_db
def test_throttled_attempts_wait_but_do_not_count():
    async def check(conn, pool):
        message_id = await _message(conn, 'personal', 'PHOTO', META)
        for _ in range(12):  # more than the cap: a flood wait is not the message's fault
            await db.record_media_result(pool, message_id, 'retry', 60.0, counted=False)
        meta = json.loads(await conn.fetchval('SELECT metadata FROM messages WHERE id = $1', message_id))
        assert (meta['media_status'], meta['media_attempts']) == ('retry', 0)
        assert meta['media_next_retry'] - time.time() >= 59
        await db.record_media_result(pool, message_id, 'retry')  # a real failure does count
        meta = json.loads(await conn.fetchval('SELECT metadata FROM messages WHERE id = $1', message_id))
        assert meta['media_attempts'] == 1

    asyncio.run(_with_tables(check))
