import unittest
import json
from contextlib import AbstractAsyncContextManager
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sync import db


class Context(AbstractAsyncContextManager):
    def __init__(self, value):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *args):
        return False


class Connection:
    def __init__(self, message_id, existing=False):
        self.message_id = message_id
        self.existing = existing
        self.id_params = []
        self.timestamps = []
        self.conversation_params = []
        self.message_params = []

    def transaction(self):
        return Context(self)

    async def execute(self, sql, *args):
        if sql == db.ENSURE_CONVERSATION_SQL:
            self.timestamps.append(args[4])
            self.conversation_params.append(args)
        if sql == db.INSERT_ATTACHMENT_SQL or "WHERE id = $1" in sql:
            self.id_params.append(args[0])

    async def fetchval(self, sql, *args):
        if sql == db.INSERT_MESSAGE_SQL:
            self.timestamps.append(args[3])
            self.message_params.append(args)
            return None if self.existing else self.message_id
        if sql == db.GET_MESSAGE_ID_SQL:
            return self.message_id
        raise AssertionError(sql)

    async def fetchrow(self, sql, *args):
        self.id_params.append(args[0])
        return {"exists": True}


class Pool:
    def __init__(self, connection):
        self.connection = connection

    def acquire(self):
        return Context(self.connection)


class MessageIdTests(unittest.IsolatedAsyncioTestCase):
    async def test_edit_preserves_uuid(self):
        from unittest.mock import AsyncMock
        message_id = UUID('56cd55b5-e62b-45fc-8a76-4584b6b6abf2')
        connection = Connection(message_id)
        connection.fetchval = AsyncMock(return_value=message_id)
        result = await db.mark_message_edited(Pool(connection), 7, 42, 'new',
                                             '2026-10-07T10:00:00.000Z', 'connector')
        self.assertIs(result, message_id)

    async def check_id(self, message_id, existing):
        connection = Connection(message_id, existing)
        pool = Pool(connection)
        kwargs = dict(
            telegram_message_id=42, chat_id=7, chat_title="Test",
            chat_type="private", sender_id=8, sender_name="Sender",
            content="Test", message_type="text", direction="inbound",
            timestamp=datetime(2026, 10, 1, 12, 30, tzinfo=timezone(timedelta(hours=2))),
        )
        stored_id, is_new = await db.insert_message_ex(pool, **kwargs)
        self.assertIs(stored_id, message_id)
        self.assertEqual(is_new, not existing)
        self.assertIs(await db.insert_message(pool, **kwargs), message_id)
        self.assertEqual(connection.timestamps, [datetime(2026, 10, 1, 10, 30)] * 4)

        await db.insert_attachment(pool, stored_id, "image", None, None, None, None)
        self.assertTrue(await db.attachment_exists_for_message(pool, stored_id))
        await db.mark_transcription_processing(pool, stored_id)
        await db.complete_transcription(pool, stored_id, "Transcript")
        await db.fail_transcription(pool, stored_id, "Retry")
        await db.fail_transcription(pool, stored_id, "Retry", increment_attempts=False)
        self.assertEqual(len(connection.id_params), 6)
        for parameter in connection.id_params:
            self.assertIs(parameter, message_id)

    async def test_uuid_survives_new_and_duplicate_ingestion(self):
        message_id = UUID("56cd55b5-e62b-45fc-8a76-4584b6b6abf2")
        for existing in (False, True):
            with self.subTest(existing=existing):
                await self.check_id(message_id, existing)

    async def test_bigint_survives_new_and_duplicate_ingestion(self):
        for existing in (False, True):
            with self.subTest(existing=existing):
                await self.check_id(123456789, existing)

    def test_naive_utc_timestamp_is_unchanged(self):
        timestamp = datetime(2026, 10, 1, 10, 30)
        self.assertIs(db.utc_timestamp(timestamp), timestamp)

    async def test_telegram_chat_types_fit_unified_schema(self):
        for chat_type, expected_type, is_group in (
            ("private", "INDIVIDUAL", False),
            ("group", "GROUP", True),
            ("supergroup", "GROUP", True),
            ("channel", "INDIVIDUAL", False),
        ):
            with self.subTest(chat_type=chat_type):
                connection = Connection(UUID("56cd55b5-e62b-45fc-8a76-4584b6b6abf2"))
                await db.insert_message_ex(
                    Pool(connection), telegram_message_id=42, chat_id=7,
                    chat_title="Test", chat_type=chat_type, sender_id=8,
                    sender_name="Sender", content="Test", message_type="text",
                    direction="inbound", timestamp=datetime(2026, 10, 1),
                )
                conversation = connection.conversation_params[0]
                message = connection.message_params[0]
                self.assertEqual(conversation[2], is_group)
                self.assertEqual(conversation[3], expected_type)
                self.assertEqual(message[4], "INBOUND")
                self.assertEqual(json.loads(message[9])["chat_type"], chat_type)


if __name__ == "__main__":
    unittest.main()
