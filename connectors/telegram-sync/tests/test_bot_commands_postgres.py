"""sync_bot_commands against real PostgreSQL (DGX-1921).

Set TELEGRAM_SYNC_TEST_DATABASE_URL to run. Temporary table with the schema of
migration 047; the fake connector answers get_bot_commands from memory.
"""
from __future__ import annotations

import asyncio
import os

import asyncpg
import pytest

from sync import bot_commands

DSN = os.environ.get("TELEGRAM_SYNC_TEST_DATABASE_URL")
needs_db = pytest.mark.skipif(not DSN, reason="TELEGRAM_SYNC_TEST_DATABASE_URL not set")

TABLE_SQL = """
CREATE TEMP TABLE telegram_bot_commands (
    conversation_id text NOT NULL,
    bot text NOT NULL,
    command text NOT NULL,
    description text NOT NULL DEFAULT '',
    synced_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, bot, command)
)
"""


class FakeConnector:
    def __init__(self, commands):
        self.commands = commands
        self.calls = 0

    async def get_bot_commands(self, chat_id):
        self.calls += 1
        return self.commands


class Pool:
    """Minimal asyncpg.Pool stand-in over one connection."""

    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        outer = self

        class Ctx:
            async def __aenter__(self):
                return outer._conn

            async def __aexit__(self, *exc):
                return False

        return Ctx()


@needs_db
def test_replace_only_on_change_and_clears_when_bots_gone():
    async def scenario():
        conn = await asyncpg.connect(DSN)
        try:
            await conn.execute(TABLE_SQL)
            pool = Pool(conn)
            dialog = {"id": -1001234567890, "name": "Grupo"}

            async def stored():
                rows = await conn.fetch(
                    "SELECT bot, command, description FROM telegram_bot_commands "
                    "WHERE conversation_id = 'tg_-1001234567890' ORDER BY bot, command"
                )
                return [(r["bot"], r["command"], r["description"]) for r in rows]

            cmds = [
                {"bot": "dgx_alarma_bot", "command": "alarma", "description": "Pone una alarma"},
                {"bot": "dgx_alarma_bot", "command": "ayuda", "description": ""},
            ]
            connector = FakeConnector(cmds)
            await bot_commands.sync_bot_commands(connector, pool, dialog)
            assert await stored() == [
                ("dgx_alarma_bot", "alarma", "Pone una alarma"),
                ("dgx_alarma_bot", "ayuda", ""),
            ]

            # Same set again → early return, synced_at untouched.
            before = await conn.fetchval("SELECT max(synced_at) FROM telegram_bot_commands")
            await bot_commands.sync_bot_commands(connector, pool, dialog)
            after = await conn.fetchval("SELECT max(synced_at) FROM telegram_bot_commands")
            assert before == after

            # Changed set → replaced wholesale.
            connector.commands = [{"bot": "otro_bot", "command": "start", "description": "Inicio"}]
            await bot_commands.sync_bot_commands(connector, pool, dialog)
            assert await stored() == [("otro_bot", "start", "Inicio")]

            # Bots gone → table emptied for this chat.
            connector.commands = []
            await bot_commands.sync_bot_commands(connector, pool, dialog)
            assert await stored() == []
        finally:
            await conn.close()

    asyncio.run(scenario())
