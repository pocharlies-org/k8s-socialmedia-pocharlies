"""Comandos de los bots por conversación (DGX-1921).

history.run() llama a sync_bot_commands() una vez por dialog en su ciclo de
30 min (el mecanismo ya existente: sin reloj nuevo). El conector resuelve los
comandos contra Telegram (GET /chats/:id/bot-commands); aquí se reemplaza el
conjunto guardado SOLO cuando cambia, para no reescribir 2.7k chats cada ciclo.
Lo lee dgx-messages de telegram_bot_commands para el selector junto al
compositor; aquí no se envía nada."""
from __future__ import annotations

import logging

import asyncpg

from sync import db
from sync.connector_client import ConnectorClient

logger = logging.getLogger(__name__)


async def sync_bot_commands(
    connector: ConnectorClient,
    pool: asyncpg.Pool,
    dialog: dict,
) -> None:
    chat_id = str(dialog.get("id"))
    conv_id = db.account_key(f"tg_{chat_id}")
    commands = await connector.get_bot_commands(chat_id)
    rows = [
        (conv_id, str(c.get("bot") or ""), str(c.get("command") or ""), str(c.get("description") or ""))
        for c in commands
        if c.get("command")
    ]
    async with pool.acquire() as conn:
        async with conn.transaction():
            current = await conn.fetch(
                "SELECT bot, command, description FROM telegram_bot_commands "
                "WHERE conversation_id = $1",
                conv_id,
            )
            if {(r["bot"], r["command"], r["description"]) for r in current} == {
                (b, c, d) for _, b, c, d in rows
            }:
                return
            await conn.execute(
                "DELETE FROM telegram_bot_commands WHERE conversation_id = $1", conv_id
            )
            if rows:
                await conn.executemany(
                    "INSERT INTO telegram_bot_commands (conversation_id, bot, command, description) "
                    "VALUES ($1, $2, $3, $4)",
                    rows,
                )
