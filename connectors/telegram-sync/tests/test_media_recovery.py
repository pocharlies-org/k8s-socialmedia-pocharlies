"""Durable retry of Telegram media (SKIRM-101).

Unit tests use fake connections; the concurrency test at the bottom runs against
the throwaway Postgres named by TELEGRAM_SYNC_TEST_DATABASE_URL (skipped without
it; see test_edits.py for how to start one).

Adapted from the fork's tests/test_media_recovery.py (jibanez-staticduo): ids are
bigint here, so the UUID fixtures became ints and the fakes live in fakes.py.
"""
import asyncio
import importlib
import json
import os
import time
import unittest
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from sync import db, media_download, media_recovery
from sync.connector_client import ConnectorClient
from fakes import Context, Pool

MESSAGE_ID = 42
MESSAGE = {'conversationId': '7', 'telegramMessageId': '42', 'messageType': 'PHOTO',
           'content': 'caption', 'attachments': [{'mimeType': 'image/jpeg', 'fileName': 'photo.jpg'}]}


class MediaConnection:
    def __init__(self):
        self.attached = False
        self.cooldown = False
        self.statuses = []
        self.inserted = []
        self.rows = [{'id': MESSAGE_ID, 'message_type': 'PHOTO',
                      'metadata': json.dumps({'telegram_chat_id': 7, 'telegram_message_id': 42})}]

    def transaction(self):
        return Context(self)

    async def fetchrow(self, sql, *args):
        if 'FROM attachments' in sql:
            return {'exists': True} if self.attached else None
        if 'SELECT metadata' in sql:
            return {'metadata': {}} if self.cooldown else None
        return {'id': MESSAGE_ID}

    async def fetch(self, sql, *args):
        self.query_args = args
        self.query = sql
        return self.rows if not self.attached and not self.cooldown else []

    async def execute(self, sql, *args):
        if sql == db.INSERT_ATTACHMENT_SQL:
            self.attached = True
            self.inserted.append(args)
        else:
            self.statuses.append(args)
            self.cooldown = args[1] != 'stored'


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.conn = MediaConnection()
        self.pool = Pool(self.conn)
        self.connector = AsyncMock()
        self.connector.get_message.return_value = MESSAGE
        self.connector.download_media.return_value = b'jpeg-data'
        self.upload = patch('sync.media_storage.upload_media', return_value=('s3://bucket/new.jpg', 9)).start()
        self.sleep = patch('sync.media_recovery.asyncio.sleep', new=AsyncMock()).start()
        self.addCleanup(patch.stopall)

    async def test_backlog_returns_account_scoped_aggregate_counts(self):
        self.conn.fetchrow = AsyncMock(return_value={'total_missing': 9, 'eligible_now': 2})
        self.assertEqual(await db.media_backlog(self.pool, 'professional'),
                         {'total_missing': 9, 'eligible_now': 2})
        sql, account, types = self.conn.fetchrow.call_args.args
        self.assertEqual(account, 'professional')
        self.assertIn('m.account = $1', sql)
        self.assertEqual(types, sorted(media_recovery.mapping.DOWNLOADABLE_TYPES))

    async def test_run_logs_counts_without_identifiers(self):
        with patch('sync.media_recovery.recover_batch', new=AsyncMock(return_value=0)), \
             patch('sync.db.media_backlog', new=AsyncMock(return_value={'total_missing': 9, 'eligible_now': 2})), \
             patch('sync.media_recovery.asyncio.sleep', new=AsyncMock(side_effect=[None, asyncio.CancelledError])), \
             self.assertLogs('sync.media_recovery', level='INFO') as logs:
            with self.assertRaises(asyncio.CancelledError):
                await media_recovery.run(self.pool, self.connector, 'private-account')
        self.assertIn('total_missing=9 eligible_now=2', logs.output[0])
        self.assertNotIn('private-account', logs.output[0])

    async def test_failure_backoff_then_retry_stores_original_metadata(self):
        self.connector.download_media.side_effect = [httpx.ReadTimeout('late'), b'jpeg-data']
        self.assertEqual(await media_recovery.recover_batch(self.pool, self.connector, 'professional'), 0)
        self.assertEqual(self.conn.statuses[-1][1], 'retry')
        self.assertEqual(await media_recovery.recover_batch(self.pool, self.connector, 'professional'), 0)
        self.assertEqual(self.connector.download_media.await_count, 1)
        self.conn.cooldown = False  # the durable retry timestamp has elapsed
        self.assertEqual(await media_recovery.recover_batch(self.pool, self.connector, 'professional'), 1)
        self.assertEqual(self.conn.inserted[0][0], MESSAGE_ID)
        self.assertEqual(self.conn.inserted[0][2:4], ('image/jpeg', 'photo.jpg'))
        self.assertEqual(self.conn.inserted[0][-1], 'caption')
        self.assertEqual(self.conn.query_args[0], 'professional')
        self.assertIn('m.account = $1', self.conn.query)

    async def test_already_attached_skips_download_and_upload(self):
        self.conn.attached = True
        self.assertFalse(await media_download.download_and_store_media(self.connector, self.pool, MESSAGE, MESSAGE_ID, 'photo'))
        self.connector.download_media.assert_not_awaited()
        self.upload.assert_not_called()

    async def test_concurrent_attempts_store_once(self):
        results = await asyncio.gather(*[
            media_download.download_and_store_media(self.connector, self.pool, MESSAGE, MESSAGE_ID, 'photo')
            for _ in range(2)
        ])
        self.assertEqual(results.count(True), 1)
        self.assertEqual(len(self.conn.inserted), 1)

    async def test_deleted_is_terminal(self):
        self.connector.get_message.return_value = None
        await media_recovery.recover_batch(self.pool, self.connector, 'personal')
        self.assertEqual(self.conn.statuses[-1][1], 'deleted')
        self.connector.download_media.assert_not_awaited()
        self.assertIn("'deleted', 'unavailable'", db.PENDING_MEDIA_SQL)

    async def test_rate_limit_persists_retry_after_and_stops_batch(self):
        self.conn.rows *= 2
        response = httpx.Response(429, headers={'Retry-After': '420'}, request=httpx.Request('GET', 'http://connector'))
        self.connector.get_message.side_effect = httpx.HTTPStatusError('limited', request=response.request, response=response)
        await media_recovery.recover_batch(self.pool, self.connector, 'personal')
        self.assertEqual(self.conn.statuses[-1][1:4], ('retry', 420.0, False))  # waits, does not count
        self.assertEqual(self.connector.get_message.await_count, 1)

    async def test_only_real_failures_count_toward_the_cap(self):
        counted = lambda: self.conn.statuses[-1][3]  # media_result(conn, id, status, delay, counted, cap)
        self.connector.download_media.side_effect = httpx.ReadTimeout('late')
        await media_recovery.recover_batch(self.pool, self.connector, 'personal')
        self.assertTrue(counted())
        for code in (429, 503):  # flood wait, connector not connected: not the message's fault
            self.conn.cooldown = False
            response = httpx.Response(code, request=httpx.Request('GET', 'http://connector'))
            self.connector.download_media.side_effect = httpx.HTTPStatusError('wait', request=response.request, response=response)
            await media_recovery.recover_batch(self.pool, self.connector, 'personal')
            self.assertFalse(counted(), code)
        self.conn.cooldown = False
        response = httpx.Response(502, request=httpx.Request('GET', 'http://connector'))
        self.connector.download_media.side_effect = httpx.HTTPStatusError('bad', request=response.request, response=response)
        await media_recovery.recover_batch(self.pool, self.connector, 'personal')
        self.assertTrue(counted())
        self.assertEqual(self.conn.statuses[-1][4], db.MEDIA_MAX_ATTEMPTS)


class ConnectorTests(unittest.IsolatedAsyncioTestCase):
    async def test_rate_limit_pauses_other_read_routes(self):
        routes = []
        def handle(request):
            routes.append(request.url.path)
            if len(routes) == 1:
                return httpx.Response(429, headers={'Retry-After': '18'})
            return httpx.Response(200, json={'dialogs': []})
        client = ConnectorClient('http://connector', 'test')
        await client._client.aclose()
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        async def finish_pause(seconds):
            self.assertGreater(seconds, 17)
            client._cooldown_until = time.monotonic() - 1
        try:
            with self.assertRaises(httpx.HTTPStatusError):
                await client.get_messages('7')
            with patch('sync.connector_client.asyncio.sleep', new=AsyncMock(side_effect=finish_pause)) as pause:
                await client.get_dialogs()
            pause.assert_awaited_once()
            self.assertEqual(routes, ['/api/v1/messages/7', '/api/v1/dialogs'])
        finally:
            await client.aclose()

    async def test_exact_message_and_media_timeout(self):
        seen = []
        def handle(request):
            seen.append(request)
            if '/single/' in request.url.path:
                return httpx.Response(200, json={'message': MESSAGE})
            return httpx.Response(200, json={'data': 'anBlZw=='})
        client = ConnectorClient('http://connector', 'test')
        await client._client.aclose()
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        try:
            self.assertEqual(await client.get_message('7', 42), MESSAGE)
            self.assertEqual(await client.download_media('7', 42), b'jpeg')
            self.assertEqual(seen[-1].extensions['timeout']['read'], 150)
            self.assertIn('x-connector-signature', seen[0].headers)
        finally:
            await client.aclose()

    async def test_wrong_message_is_rejected(self):
        client = ConnectorClient('http://connector', 'test')
        client._get_v1 = AsyncMock(return_value=httpx.Response(200, json={'message': MESSAGE}, request=httpx.Request('GET', 'http://connector')))
        try:
            with self.assertRaises(ValueError):
                await client.get_message('7', 43)
        finally:
            await client.aclose()

    def test_timeout_validation(self):
        for timeout in [0, 20, float('inf'), float('nan')]:
            with self.assertRaises(ValueError):
                ConnectorClient('http://connector', 'test', media_timeout=timeout)


def test_recovery_interval_defaults_to_60_seconds_and_is_configurable(monkeypatch):
    monkeypatch.delenv('MEDIA_RECOVERY_INTERVAL_S', raising=False)
    try:
        assert importlib.reload(media_recovery).INTERVAL == 60
        monkeypatch.setenv('MEDIA_RECOVERY_INTERVAL_S', '5')
        assert importlib.reload(media_recovery).INTERVAL == 5
    finally:
        monkeypatch.delenv('MEDIA_RECOVERY_INTERVAL_S', raising=False)
        importlib.reload(media_recovery)


# ── C4 against a real Postgres: the row lock, not the process lock, serializes ──

DSN = os.environ.get('TELEGRAM_SYNC_TEST_DATABASE_URL')
needs_db = pytest.mark.skipif(not DSN, reason='TELEGRAM_SYNC_TEST_DATABASE_URL not set')

RACE_SCHEMA = """
DROP SCHEMA IF EXISTS media_race CASCADE;
CREATE SCHEMA media_race;
CREATE TABLE media_race.messages (id bigserial PRIMARY KEY, metadata jsonb NOT NULL DEFAULT '{}');
CREATE TABLE media_race.attachments (
  id bigserial PRIMARY KEY, message_id bigint, file_type text, mime_type text, file_name text,
  file_size bigint, file_url text, duration_seconds int, width int, height int, caption text);
INSERT INTO media_race.messages DEFAULT VALUES;
"""


class _NoLock:
    """Stands in for the in-process lock so only the database serializes."""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


@needs_db
def test_realtime_and_recovery_race_stores_one_attachment(monkeypatch):
    import asyncpg

    monkeypatch.setattr(media_download, '_MEDIA_LOCK', _NoLock())
    monkeypatch.setattr('sync.media_storage.upload_media', lambda **kw: ('s3://bucket/race.jpg', 9))

    async def scenario():
        admin = await asyncpg.connect(DSN)
        pool = await asyncpg.create_pool(DSN, min_size=2, max_size=4,
                                         server_settings={'search_path': 'media_race'})
        try:
            await admin.execute(RACE_SCHEMA)
            message_id = await admin.fetchval('SELECT id FROM media_race.messages')

            async def slow_download(chat_id, msg_id):
                await asyncio.sleep(0.3)  # long enough for the second caller to arrive
                return b'jpeg-data'

            connector = AsyncMock()
            connector.download_media.side_effect = slow_download
            results = await asyncio.gather(*[
                media_download.download_and_store_media(connector, pool, MESSAGE, message_id, 'photo')
                for _ in range(2)
            ])
            assert results.count(True) == 1
            assert connector.download_media.await_count == 1
            assert await admin.fetchval('SELECT count(*) FROM media_race.attachments') == 1
        finally:
            await pool.close()
            await admin.execute('DROP SCHEMA IF EXISTS media_race CASCADE')
            await admin.close()

    asyncio.run(scenario())
