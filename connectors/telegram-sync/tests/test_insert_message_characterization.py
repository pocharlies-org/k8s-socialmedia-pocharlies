"""insert_message_ex as production runs it today (SKIRM-101 C5).

Written before touching db.py and green on the trunk: what a NEW message writes
-- int id, chat_type as conversations.type, timestamps untouched -- must not
change when the media-recovery helpers land next to it.
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest

from fakes import Context, Pool
from sync import db

TS = datetime(2026, 10, 8, 9, 30, tzinfo=timezone(timedelta(hours=2)))


class BigInt(int):
    """What a driver may hand back; the caller must still receive a plain int."""


class Conn:
    def __init__(self, new_id=None, existing=None):
        self.new_id, self.existing = new_id, existing
        self.executed, self.fetched = [], []

    def transaction(self):
        return Context(self)

    async def execute(self, sql, *args):
        self.executed.append((sql, args))

    async def fetchval(self, sql, *args):
        self.fetched.append((sql, args))
        return self.new_id if sql == db.INSERT_MESSAGE_SQL else self.existing


def insert(conn, **over):
    kwargs = dict(telegram_message_id=42, chat_id=-1001, chat_title="Grupo", chat_type="supergroup",
                  sender_id=9, sender_name="Ana", content="hola", message_type="photo",
                  direction="inbound", timestamp=TS, reply_to_message_id=41, topic_id=5)
    return asyncio.run(db.insert_message_ex(Pool(conn), **{**kwargs, **over}))


def test_new_message_writes_what_it_always_wrote(monkeypatch):
    monkeypatch.setattr(db, "ACCOUNT", "professional")
    conn = Conn(new_id=BigInt(77))
    message_id, is_new = insert(conn)
    assert (message_id, is_new) == (77, True) and type(message_id) is int
    conversation, participant, link = conn.executed
    # (id, name, is_group, type, last_message_at, wa_chat_id, account): chat_type, not GROUP/INDIVIDUAL
    assert conversation == (db.ENSURE_CONVERSATION_SQL, (
        "professional:tg_-1001", "Grupo", True, "supergroup", TS, "tg_-1001", "professional"))
    assert participant == (db.ENSURE_PARTICIPANT_SQL, ("professional:tg_9", "Ana", "professional"))
    assert link == (db.LINK_PARTICIPANT_SQL, ("professional:tg_-1001", "professional:tg_9"))
    sql, args = conn.fetched[0]
    wa_id, conv, sender, stamp, direction, content, kind, forwarded, reply, metadata, account = args
    assert (wa_id, conv, sender, reply) == ("professional:tg_-1001_42", "professional:tg_-1001",
                                            "professional:tg_9", "professional:tg_-1001_41")
    assert stamp is TS and stamp.tzinfo is not None  # no UTC normalisation
    assert (direction, content, kind, forwarded, account) == ("INBOUND", "hola", "PHOTO", False, "professional")
    assert json.loads(metadata) == {"telegram_chat_id": -1001, "telegram_message_id": 42,
                                    "chat_type": "supergroup", "sender_name": "Ana",
                                    "topic_id": 5, "thread_id": 5}


def test_private_chat_keeps_its_chat_type(monkeypatch):
    monkeypatch.setattr(db, "ACCOUNT", "personal")
    conn = Conn(new_id=1)
    insert(conn, chat_type="private", sender_id=None, reply_to_message_id=None, topic_id=None)
    assert conn.executed[0][1][2:4] == (False, "private")
    assert conn.executed[0][1][0] == "tg_-1001"  # personal ids carry no prefix


def test_existing_message_returns_its_id_and_not_new(monkeypatch):
    monkeypatch.setattr(db, "ACCOUNT", "personal")
    conn = Conn(new_id=None, existing=BigInt(55))
    message_id, is_new = insert(conn)
    assert (message_id, is_new) == (55, False) and type(message_id) is int
    assert asyncio.run(db.insert_message(Pool(Conn(new_id=BigInt(3))), 1, 2, None, "private", None,
                                         None, "x", "text", "outbound", TS)) == 3
