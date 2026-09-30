"""complete_transcription: UPDATE messages + INSERT brain_window_dirty, atomically (INFRA-368 P2).

No database needed: a fake asyncpg pool records statements and models the
transaction (writes are buffered and only applied on a clean exit).
"""
from __future__ import annotations

import asyncio

import pytest

from sync import db

# 20 voice notes: ids 1..20 over 4 conversations of the `personal` account.
AUDIOS = [
    {"id": i, "account": "personal", "conversation_id": f"chat{i % 4}"} for i in range(1, 21)
]


class FakeConn:
    def __init__(self, store, fail_insert=False):
        self.store, self.fail_insert, self._pending = store, fail_insert, None

    def transaction(self):
        conn = self

        class Tx:
            async def __aenter__(self_):
                conn._pending = {"messages": dict(conn.store["messages"]), "dirty": list(conn.store["dirty"])}
                return self_

            async def __aexit__(self_, et, ev, tb):
                if et is None:
                    conn.store.update(conn._pending)  # COMMIT
                conn._pending = None  # else ROLLBACK: nothing applied
                return False

        return Tx()

    async def fetchrow(self, sql, msg_id, text, model):
        assert sql.startswith("UPDATE messages") and "RETURNING account, conversation_id" in sql
        row = self._pending["messages"].get(msg_id)
        if row is None:
            return None
        self._pending["messages"][msg_id] = {**row, "content": text, "model": model, "status": "done"}
        return row

    async def execute(self, sql, account, conversation_id):
        assert sql.startswith("INSERT INTO brain_window_dirty")
        if self.fail_insert:
            raise RuntimeError("insert boom")
        self._pending["dirty"].append((account, conversation_id))


class FakePool:
    def __init__(self, store, fail_insert=False):
        self.conn = FakeConn(store, fail_insert)

    def acquire(self):
        conn = self.conn

        class Ctx:
            async def __aenter__(self_):
                return conn

            async def __aexit__(self_, *a):
                return False

        return Ctx()


def _store():
    return {"messages": {a["id"]: dict(a, content="") for a in AUDIOS}, "dirty": []}


def test_twenty_audios_update_and_dirty_together():
    store = _store()
    pool = FakePool(store)

    async def run():
        for a in AUDIOS:
            await db.complete_transcription(pool, a["id"], f"texto {a['id']}", "faster-whisper")

    asyncio.run(run())
    assert all(m["content"] == f"texto {m['id']}" and m["status"] == "done" for m in store["messages"].values())
    assert len(store["dirty"]) == 20
    assert {c for _, c in store["dirty"]} == {"chat0", "chat1", "chat2", "chat3"}


def test_insert_failure_rolls_back_the_update():
    store = _store()
    pool = FakePool(store, fail_insert=True)
    with pytest.raises(RuntimeError):
        asyncio.run(db.complete_transcription(pool, 1, "hola", "m"))
    assert store["messages"][1]["content"] == ""  # UPDATE not applied
    assert store["dirty"] == []


def test_missing_message_writes_nothing():
    store = _store()
    asyncio.run(db.complete_transcription(FakePool(store), 999, "x", "m"))
    assert store["dirty"] == []
