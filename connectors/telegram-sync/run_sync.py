#!/usr/bin/env python3
"""Telegram Sync Worker (session-less).

Realtime capture (NATS) + history backfill + audio transcription + HTTP bridge —
ALL via the telegram-connector. This worker holds NO Telegram session of its own,
which structurally eliminates the shared-auth-key / AuthKeyDuplicated failure that
took the old Telethon-based sync down. The connector is the single session per
account; this process only consumes its NATS events and HTTP API.
"""
import asyncio
import logging
import os

from dotenv import load_dotenv
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)


async def main():
    from sync import db, history, transcriber, bridge, nats_consumer
    from sync.connector_client import ConnectorClient

    account = os.environ.get("CONNECTOR_ACCOUNT", "personal")
    connector = ConnectorClient.from_env()

    pool = await db.create_pool()
    await db.init_schema(pool)
    await db.recover_stuck_transcriptions(pool)

    bridge.set_connector(connector)
    bridge.set_db_pool(pool)

    # Best-effort identity log; never blocks startup if the connector is warming up.
    me = await connector.get_me()
    if me:
        logging.info("Connector account=%s identity=%s (id=%s)",
                     account, me.get("firstName"), me.get("id"))
    else:
        logging.warning("Connector /me unreachable at startup; continuing (will retry).")

    # HTTP bridge (serves mcp-server's live-unread + send + brain-chat).
    bridge_port = int(os.environ.get("BRIDGE_PORT", "3080"))
    import uvicorn
    config = uvicorn.Config(bridge.app, host="0.0.0.0", port=bridge_port, log_level="info")
    server = uvicorn.Server(config)
    bridge_task = asyncio.create_task(server.serve())
    logging.info(f"Bridge HTTP server starting on port {bridge_port}")

    nats_task = asyncio.create_task(nats_consumer.run(pool, connector, account))
    history_task = asyncio.create_task(history.run(pool, connector))
    tasks = [nats_task, history_task, bridge_task]

    try:
        import faster_whisper  # noqa: F401
        tasks.append(asyncio.create_task(transcriber.run(pool, connector)))
        logging.info("Sync started (session-less): nats + history + transcription + bridge")
    except ImportError:
        logging.info("faster-whisper not available, running without transcription")

    await asyncio.gather(*tasks)


if __name__ == "__main__":
    asyncio.run(main())
