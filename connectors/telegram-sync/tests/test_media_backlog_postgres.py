"""Verify backlog SQL on production attachment columns, with session-local tables."""
import asyncio
import json
import os
from uuid import uuid4

import asyncpg
import pytest

from sync import db
from test_db_message_ids import Pool


@pytest.mark.skipif(not os.environ.get('TELEGRAM_MEDIA_TEST_DATABASE_URL'),
                    reason='TELEGRAM_MEDIA_TEST_DATABASE_URL not set')
def test_backlog_separates_missing_keys_from_eligible_messages():
    async def check():
        conn = await asyncpg.connect(os.environ['TELEGRAM_MEDIA_TEST_DATABASE_URL'])
        try:
            await conn.execute('''
                CREATE TEMP TABLE messages (id uuid, platform text, account text,
                    message_type text, metadata jsonb, wa_timestamp timestamp);
                CREATE TEMP TABLE attachments (message_id uuid, file_url text, storage_key text);
            ''')
            meta = {'telegram_chat_id': 7, 'telegram_message_id': 42}
            cases = [
                ('personal', 'PHOTO', meta, None),
                ('personal', 'PHOTO', {**meta, 'media_next_retry': 9999999999}, None),
                ('personal', 'PHOTO', {**meta, 'media_status': 'deleted'}, None),
                ('personal', 'PHOTO', {}, None),
                ('personal', 'PHOTO', meta, (' ', None)),
                ('personal', 'PHOTO', meta, ('s3://stored', None)),
                ('personal', 'PHOTO', meta, (None, 'legacy/stored')),
                ('other', 'PHOTO', meta, None),
                ('personal', 'TEXT', meta, None),
            ]
            for account, kind, metadata, keys in cases:
                message_id = uuid4()
                await conn.execute("INSERT INTO messages VALUES ($1, 'telegram', $2, $3, $4, NOW())",
                                   message_id, account, kind, json.dumps(metadata))
                if keys is not None:
                    await conn.execute('INSERT INTO attachments VALUES ($1, $2, $3)', message_id, *keys)
            pool = Pool(conn)
            assert await db.media_backlog(pool, 'personal') == {'total_missing': 5, 'eligible_now': 1}
            assert len(await db.pending_media(pool, 'personal')) == 1
            assert await db.media_backlog(pool, 'other') == {'total_missing': 1, 'eligible_now': 1}
            assert await db.media_backlog(pool, 'absent') == {'total_missing': 0, 'eligible_now': 0}
        finally:
            await conn.close()
    asyncio.run(check())
