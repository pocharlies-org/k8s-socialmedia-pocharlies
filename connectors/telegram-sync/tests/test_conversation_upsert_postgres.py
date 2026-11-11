"""The conversation upsert's conflict guard, checked against real PostgreSQL.

Set TELEGRAM_SYNC_TEST_DATABASE_URL to run this integration test. It only uses
a temporary table on its dedicated connection.
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta

import asyncpg
import pytest

from sync import db

DSN = os.environ.get("TELEGRAM_SYNC_TEST_DATABASE_URL")
needs_db = pytest.mark.skipif(not DSN, reason="TELEGRAM_SYNC_TEST_DATABASE_URL not set")


@needs_db
def test_conversation_upsert_skips_replays_and_preserves_effective_values():
    async def scenario():
        conn = await asyncpg.connect(DSN)
        try:
            await conn.execute("""
                CREATE TEMP TABLE conversations (
                    id text PRIMARY KEY,
                    name text,
                    is_group boolean NOT NULL,
                    type text NOT NULL,
                    wa_chat_id text NOT NULL,
                    created_at timestamp without time zone NOT NULL,
                    updated_at timestamp without time zone NOT NULL,
                    last_message_at timestamp without time zone,
                    account text NOT NULL
                )
            """)

            async def ensure(conv_id, account, name, last_message_at):
                await conn.execute(
                    db.ENSURE_CONVERSATION_SQL,
                    conv_id,
                    name,
                    False,
                    "INDIVIDUAL",
                    last_message_at,
                    conv_id,
                    account,
                )

            async def row(conv_id):
                return await conn.fetchrow(
                    "SELECT name, last_message_at, xmin::text AS xmin "
                    "FROM pg_temp.conversations WHERE id = $1",
                    conv_id,
                )

            conv_id = "tg_7"
            first_activity = datetime(2026, 10, 10, 10, 0)
            older_activity = first_activity - timedelta(minutes=1)
            newer_activity = first_activity + timedelta(minutes=1)

            await ensure(conv_id, "personal", "Original", first_activity)
            inserted = await row(conv_id)

            # Same title and older activity must not create a new row version.
            await ensure(conv_id, "personal", "Original", older_activity)
            replayed = await row(conv_id)
            assert replayed["xmin"] == inserted["xmin"]
            assert replayed["last_message_at"] == first_activity

            # A missing title preserves the existing name while new activity advances.
            await ensure(conv_id, "personal", None, newer_activity)
            activity_advanced = await row(conv_id)
            assert activity_advanced["xmin"] != replayed["xmin"]
            assert activity_advanced["name"] == "Original"
            assert activity_advanced["last_message_at"] == newer_activity

            # A real rename applies even when its incoming activity is older.
            await ensure(conv_id, "personal", "Renamed", older_activity)
            renamed = await row(conv_id)
            assert renamed["xmin"] != activity_advanced["xmin"]
            assert renamed["name"] == "Renamed"
            assert renamed["last_message_at"] == newer_activity

            # A nullable stored name compares safely with a null incoming title.
            null_name_id = "professional:tg_7"
            await ensure(null_name_id, "professional", None, first_activity)
            null_name_insert = await row(null_name_id)
            await ensure(null_name_id, "professional", None, older_activity)
            null_name_replay = await row(null_name_id)
            assert null_name_replay["xmin"] == null_name_insert["xmin"]
            assert null_name_replay["name"] is None

            # A real rename from NULL is still distinguished from no change.
            await ensure(null_name_id, "professional", "Professional title", older_activity)
            null_name_renamed = await row(null_name_id)
            assert null_name_renamed["xmin"] != null_name_replay["xmin"]
            assert null_name_renamed["name"] == "Professional title"
            assert null_name_renamed["last_message_at"] == first_activity

            # The namespaced second account remains a distinct conversation.
            assert (await conn.fetchval("SELECT count(*) FROM pg_temp.conversations")) == 2
        finally:
            await conn.close()

    asyncio.run(scenario())
