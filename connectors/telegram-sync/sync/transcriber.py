"""Transcription worker — faster-whisper audio transcription (pass 2).

Session-less: audio bytes are fetched from the connector
(GET /api/v1/messages/media/:chatId/:msgId) instead of being re-downloaded via
Telethon. The whisper core is unchanged.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil

import asyncpg
import httpx

from sync import db
from sync.connector_client import ConnectorClient

logger = logging.getLogger(__name__)

POLL_INTERVAL = 30  # seconds
DOWNLOADS_DIR = os.environ.get(
    "DOWNLOADS_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "downloads"),
)
os.makedirs(DOWNLOADS_DIR, exist_ok=True)
MIN_DISK_MB = 500

# Transient errors that should not burn retry attempts.
TRANSIENT_ERRORS = (ConnectionError, OSError, TimeoutError, asyncpg.PostgresError, httpx.HTTPError)


def _load_model():
    """Load faster-whisper model (called once at startup)."""
    from faster_whisper import WhisperModel

    model_name = os.environ.get("WHISPER_MODEL", "small")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

    logger.info(f"Loading Whisper model: {model_name} (device={device}, compute={compute_type})")
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    logger.info("Whisper model loaded")
    return model


def _check_disk_space() -> bool:
    stat = shutil.disk_usage(DOWNLOADS_DIR)
    free_mb = stat.free / (1024 * 1024)
    return free_mb >= MIN_DISK_MB


def _transcribe(model, file_path: str) -> str:
    segments, info = model.transcribe(file_path, language=None)
    texts = [seg.text.strip() for seg in segments if seg.text.strip()]
    full_text = " ".join(texts)
    logger.info(
        f"Transcribed {os.path.basename(file_path)}: {info.language} "
        f"({info.language_probability:.0%}), {len(full_text)} chars"
    )
    return full_text


async def _download_audio(connector: ConnectorClient, chat_id: int, message_id: int) -> str | None:
    """Fetch audio bytes from the connector and write to a temp file. Returns the
    path, or None if the message has no downloadable media (e.g. deleted)."""
    data = await connector.download_media(str(chat_id), message_id)
    if not data:
        return None
    os.makedirs(DOWNLOADS_DIR, exist_ok=True)
    path = os.path.join(DOWNLOADS_DIR, f"{chat_id}_{message_id}.oga")
    with open(path, "wb") as f:
        f.write(data)
    return path


async def run(pool: asyncpg.Pool, connector: ConnectorClient):
    """Main transcription loop — poll for pending audio, fetch, transcribe, save."""
    await asyncio.sleep(10)  # let realtime/history populate the queue first

    model = await asyncio.get_event_loop().run_in_executor(None, _load_model)

    while True:
        try:
            row = await db.get_pending_transcription(pool)
            if row is None:
                await asyncio.sleep(POLL_INTERVAL)
                continue

            msg_id = row["id"]
            tg_msg_id = row["telegram_message_id"]
            chat_id = row["chat_id"]
            chat_title = row.get("chat_title", "unknown")

            logger.info(f"Transcribing msg {tg_msg_id} from {chat_title}")
            await db.mark_transcription_processing(pool, msg_id)

            if not _check_disk_space():
                logger.warning("Low disk space — pausing transcription")
                await db.fail_transcription(pool, msg_id, "low_disk_space", increment_attempts=False)
                await asyncio.sleep(POLL_INTERVAL * 10)
                continue

            file_path = None
            try:
                file_path = await _download_audio(connector, chat_id, tg_msg_id)
            except TRANSIENT_ERRORS as e:
                # Increment attempts: some chats' media consistently 500s from the
                # connector. Without incrementing, get_pending_transcription would
                # re-pick the same failing message every cycle and block the queue.
                # After 3 attempts it drops out (attempts<3 filter) and the worker
                # moves on.
                logger.warning(f"Download error for {tg_msg_id}: {e}")
                await db.fail_transcription(pool, msg_id, f"download:{e}", increment_attempts=True)
                continue

            if file_path is None:
                await db.fail_transcription(pool, msg_id, "message_deleted", increment_attempts=True)
                continue

            try:
                text = await asyncio.get_event_loop().run_in_executor(
                    None, _transcribe, model, file_path
                )
                if text:
                    await db.complete_transcription(pool, msg_id, text)
                    logger.info(f"Transcription complete for {tg_msg_id}: {len(text)} chars")
                else:
                    await db.fail_transcription(pool, msg_id, "empty_transcription", increment_attempts=True)
            except Exception as e:
                logger.error(f"Transcription failed for {tg_msg_id}: {e}")
                await db.fail_transcription(pool, msg_id, str(e)[:500], increment_attempts=True)
            finally:
                if file_path and os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                    except OSError:
                        pass

        except Exception as e:
            logger.error(f"Transcription worker error: {e}")
            await asyncio.sleep(POLL_INTERVAL)
