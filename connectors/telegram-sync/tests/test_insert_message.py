"""What insert_message_ex writes for a NEW message (SKIRM-101 C5).

Characterization: it passed on the prod code before the media recovery was
added and must keep passing. The recovery only adds metadata keys to a row
later; it never changes how a fresh row is written.
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone

from sync import db, mapping
from fakes import Context, Pool

TS = datetime(2026, 10, 8, 12, 30, tzinfo=timezone(timedelta(hours=2)))


class Connection:
    def __init__(self, new_id=None, existing=None):
        self.new_id = new_id
        self.existing = existing
        self.calls = {}

    def transaction(self):
        return Context(self)

    async def execute(self, sql, *args):
        self.calls[sql] = args

    async def fetchval(self, sql, *args):
        self.calls[sql] = args
        return self.new_id if sql == db.INSERT_MESSAGE_SQL else self.existing


def _insert(conn, chat_type="supergroup"):
    return asyncio.run(db.insert_message_ex(
        Pool(conn), 42, -1001, "Chat", chat_type, 7, "Dani", "hola", "photo", "inbound", TS,
    ))


def test_new_message_returns_int_and_writes_prod_shape(monkeypatch):
    monkeypatch.setattr(db, "ACCOUNT", "professional")
    conn = Connection(new_id=5)
    message_id, is_new = _insert(conn)
    assert (message_id, is_new) == (5, True) and type(message_id) is int

    # Shared tables use canonical conversation types and naive UTC timestamps.
    expected_timestamp = datetime(2026, 10, 8, 10, 30)
    conversation = conn.calls[db.ENSURE_CONVERSATION_SQL]
    assert conversation == ("professional:tg_-1001", "Chat", True, "GROUP", expected_timestamp,
                            "tg_-1001", "professional")
    assert conversation[4] == expected_timestamp
    private = Connection(new_id=6)
    _insert(private, "private")
    assert private.calls[db.ENSURE_CONVERSATION_SQL][2:4] == (False, "INDIVIDUAL")

    row = conn.calls[db.INSERT_MESSAGE_SQL]
    assert row[:3] == ("professional:tg_-1001_42", "professional:tg_-1001", "professional:tg_7")
    assert row[3] == expected_timestamp
    assert row[4:7] == ("INBOUND", "hola", "PHOTO")
    assert row[-1] == "professional"


def test_existing_message_returns_its_id_not_new():
    assert _insert(Connection(new_id=None, existing=9)) == (9, False)


def _insert_poll(conn, multiple=False):
    kwargs = mapping.to_insert_kwargs({
        "conversationId": "-1001", "telegramMessageId": "42", "chatType": "supergroup",
        "senderTelegramId": "7", "senderFirstName": "Juan",
        "content": "¿Cine?", "messageType": "POLL", "telegramTimestamp": TS.isoformat(),
        "isOutbound": False,
        "poll": {"question": "¿Cine?", "options": ["🎬 Acción", "😂 Comedia"], "multiple": multiple},
    })
    return asyncio.run(db.insert_message_ex(Pool(conn), **kwargs))


def test_poll_writes_metadata_poll_and_question():
    conn = Connection(new_id=7)
    _insert_poll(conn)
    row = conn.calls[db.INSERT_MESSAGE_SQL]
    assert row[4:7] == ("INBOUND", "¿Cine?", "POLL")
    poll = json.loads(row[9])["poll"]
    assert poll["question"] == "¿Cine?"
    assert poll["options"] == ["🎬 Acción", "😂 Comedia"]
    assert poll["selectableCount"] == 1  # single answer


def test_poll_multiple_maps_to_selectable_count_zero():
    conn = Connection(new_id=8)
    _insert_poll(conn, multiple=True)
    assert json.loads(conn.calls[db.INSERT_MESSAGE_SQL][9])["poll"]["selectableCount"] == 0
