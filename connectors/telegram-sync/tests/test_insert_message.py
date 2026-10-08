"""What insert_message_ex writes for a NEW message (SKIRM-101 C5).

Characterization: it passed on the prod code before the media recovery was
added and must keep passing. The recovery only adds metadata keys to a row
later; it never changes how a fresh row is written.
"""
import asyncio
from datetime import datetime, timedelta, timezone

from sync import db
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

    # chat_type goes into conversations.type as it comes; the timestamp is not converted.
    conversation = conn.calls[db.ENSURE_CONVERSATION_SQL]
    assert conversation == ("professional:tg_-1001", "Chat", True, "supergroup", TS,
                            "tg_-1001", "professional")
    assert conversation[4] is TS
    private = Connection(new_id=6)
    _insert(private, "private")
    assert private.calls[db.ENSURE_CONVERSATION_SQL][2:4] == (False, "private")

    row = conn.calls[db.INSERT_MESSAGE_SQL]
    assert row[:3] == ("professional:tg_-1001_42", "professional:tg_-1001", "professional:tg_7")
    assert row[3] is TS
    assert row[4:7] == ("INBOUND", "hola", "PHOTO")
    assert row[-1] == "professional"


def test_existing_message_returns_its_id_not_new():
    assert _insert(Connection(new_id=None, existing=9)) == (9, False)
