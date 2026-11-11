"""telegram.MessageEdited → the row, with the WhatsApp representation.

Unit tests need nothing; the SQL tests run against a throwaway Postgres named
by TELEGRAM_SYNC_TEST_DATABASE_URL (skipped without it), e.g.:

    docker run --rm -d -p 127.0.0.1:55432:5432 \\
      -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine
    TELEGRAM_SYNC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/postgres \\
      python -m pytest tests
"""
from __future__ import annotations

import asyncio
import json
import os

import pytest

from sync import db, mapping, nats_consumer

EVENT = {
    "eventType": "TelegramMessageEdited",
    "account": "personal",
    "conversationId": "-1001234567890",
    "telegramMessageId": "42",
    "content": "texto nuevo",
    "editedAt": "2026-09-29T10:00:00.000Z",
    "source": "connector",
    "actor": "dani",
    "isOutbound": True,
}


def test_to_edit_kwargs():
    assert mapping.to_edit_kwargs(EVENT) == {
        "chat_id": -1001234567890,
        "telegram_message_id": 42,
        "content": "texto nuevo",
        "edited_at": "2026-09-29T10:00:00.000Z",
        "source": "connector",
        "actor": "dani",
    }
    # An edit never blanks a row; ids are required.
    assert mapping.to_edit_kwargs({**EVENT, "content": ""}) is None
    assert mapping.to_edit_kwargs({**EVENT, "content": None}) is None
    assert mapping.to_edit_kwargs({**EVENT, "telegramMessageId": "x"}) is None
    assert mapping.to_edit_kwargs({**EVENT, "conversationId": None}) is None
    # Unknown source → telegram; blank actor → none; long actor capped.
    other = mapping.to_edit_kwargs({**EVENT, "source": "evil", "actor": "  "})
    assert other["source"] == "telegram" and other["actor"] is None
    assert len(mapping.to_edit_kwargs({**EVENT, "actor": "a" * 500})["actor"]) == 200
    # Offsets are normalised to UTC in toISOString() form.
    assert (
        mapping.to_edit_kwargs({**EVENT, "editedAt": "2026-09-29T12:00:00+02:00"})["edited_at"]
        == "2026-09-29T10:00:00.000Z"
    )


def test_handle_edit_filters_the_account(monkeypatch):
    calls = []

    async def fake_mark(pool, **kwargs):
        calls.append(kwargs)
        return 7

    monkeypatch.setattr(db, "mark_message_edited", fake_mark)
    asyncio.run(nats_consumer._handle_edit({**EVENT, "account": "professional"}, None, "personal"))
    assert calls == []
    asyncio.run(nats_consumer._handle_edit({k: v for k, v in EVENT.items() if k != "account"}, None, "personal"))
    asyncio.run(nats_consumer._handle_edit({**EVENT, "account": "professional"}, None, "professional"))
    assert len(calls) == 2
    # A malformed event is dropped, never raised into the NATS callback.
    asyncio.run(nats_consumer._handle_edit({"account": "personal"}, None, "personal"))
    assert len(calls) == 2


# ── SQL against a real Postgres ─────────────────────────────────────────────

DSN = os.environ.get("TELEGRAM_SYNC_TEST_DATABASE_URL")
needs_db = pytest.mark.skipif(not DSN, reason="TELEGRAM_SYNC_TEST_DATABASE_URL not set")

# The columns of prod `messages` the edit touches (plus the keys it filters on).
SCHEMA = """
DROP TABLE IF EXISTS messages;
CREATE TABLE messages (
  id bigserial PRIMARY KEY,
  wa_message_id text UNIQUE NOT NULL,
  account_id text,
  platform text,
  message_type text,
  content text,
  is_edited boolean DEFAULT false,
  metadata jsonb
);
"""


async def _with_db(fn):
    import asyncpg

    pool = await asyncpg.create_pool(DSN, min_size=1, max_size=2)
    try:
        async with pool.acquire() as conn:
            await conn.execute(SCHEMA)
            await conn.executemany(
                "INSERT INTO messages (wa_message_id, account_id, platform, message_type, content, metadata) "
                "VALUES ($1, $2, 'telegram', $3, $4, $5::jsonb)",
                [
                    ("tg_-1001234567890_42", "telegram:personal", "TEXT", "texto viejo",
                     json.dumps({"telegram_message_id": 42, "sender_name": "Dani"})),
                    ("tg_-1001234567890_43", "telegram:personal", "VOICE", "transcripción", None),
                    ("professional:tg_-1001234567890_42", "telegram:professional", "TEXT", "de pro", None),
                ],
            )
        return await fn(pool)
    finally:
        await pool.close()


async def _row(pool, wa_id):
    row = await pool.fetchrow(
        "SELECT content, is_edited, metadata FROM messages WHERE wa_message_id = $1", wa_id
    )
    return row["content"], row["is_edited"], json.loads(row["metadata"]) if row["metadata"] else None


@needs_db
def test_mark_message_edited_shape_and_idempotency(monkeypatch):
    monkeypatch.setattr(db, "ACCOUNT", "personal")

    async def scenario(pool):
        first = await db.mark_message_edited(
            pool, -1001234567890, 42, "texto nuevo", "2026-09-29T10:00:00.000Z", "connector", "dani"
        )
        assert first is not None
        # Telegram's echo / a replay of the same text: nothing changes.
        assert await db.mark_message_edited(
            pool, -1001234567890, 42, "texto nuevo", "2026-09-29T10:00:01.000Z", "telegram"
        ) is None
        content, edited, meta = await _row(pool, "tg_-1001234567890_42")
        assert (content, edited) == ("texto nuevo", True)
        assert meta["sender_name"] == "Dani", "existing metadata is kept"
        assert meta["edited_at"] == "2026-09-29T10:00:00.000Z"
        assert meta["edit_history"] == [
            {"content": "texto viejo", "replaced_at": "2026-09-29T10:00:00.000Z",
             "source": "connector", "actor": "dani"},
        ]

        # A later edit from the phone appends (oldest first); no actor key.
        await db.mark_message_edited(
            pool, -1001234567890, 42, "tercera", "2026-09-29T11:00:00.000Z", "telegram"
        )
        content, _, meta = await _row(pool, "tg_-1001234567890_42")
        assert content == "tercera"
        assert meta["edited_at"] == "2026-09-29T11:00:00.000Z"
        assert meta["edit_history"][1] == {
            "content": "texto nuevo", "replaced_at": "2026-09-29T11:00:00.000Z", "source": "telegram",
        }

        # An older edit arriving late never overwrites the newer one.
        assert await db.mark_message_edited(
            pool, -1001234567890, 42, "vieja", "2026-09-29T10:30:00.000Z", "telegram"
        ) is None
        assert (await _row(pool, "tg_-1001234567890_42"))[0] == "tercera"

        # Voice rows keep their transcription; unknown rows are a no-op.
        assert await db.mark_message_edited(
            pool, -1001234567890, 43, "caption", "2026-09-29T10:00:00.000Z", "telegram"
        ) is None
        assert (await _row(pool, "tg_-1001234567890_43"))[:2] == ("transcripción", False)
        assert await db.mark_message_edited(
            pool, -1001234567890, 999, "x", "2026-09-29T10:00:00.000Z", "telegram"
        ) is None
        # The personal sync never touches the professional row of the same message.
        assert (await _row(pool, "professional:tg_-1001234567890_42"))[:2] == ("de pro", False)

    asyncio.run(_with_db(scenario))


@needs_db
def test_mark_message_edited_professional_namespace(monkeypatch):
    monkeypatch.setattr(db, "ACCOUNT", "professional")

    async def scenario(pool):
        assert await db.mark_message_edited(
            pool, -1001234567890, 42, "editado pro", "2026-09-29T10:00:00.000Z", "connector"
        ) is not None
        assert (await _row(pool, "professional:tg_-1001234567890_42"))[:2] == ("editado pro", True)
        assert (await _row(pool, "tg_-1001234567890_42"))[:2] == ("texto viejo", False)

    asyncio.run(_with_db(scenario))
