"""Map a connector message object → db.insert_message kwargs.

Both the NATS event (TelegramMessageReceivedEvent) and the REST history
endpoint (GET /api/v1/messages/:chatId → TelegramMessage[]) share the SAME
field shape, so one mapper serves realtime + backfill. See
connectors/telegram/src/{telegram-client.ts,events/publisher.ts}.

Field notes vs the old Telethon path:
  - ids are bare MARKED (Bot-API) ids as strings (chat.id.toString()) — same
    convention Telethon used, so db dedup keys line up.
  - messageType arrives UPPERCASE (TEXT/VOICE/VIDEO_NOTE/...); we lowercase it
    to the canonical internal form db/media_download expect.
  - content is '' for pure-media on the NATS event (flattened from null) and may
    be null on REST; both normalize to None when empty.
  - sender display name: connector only exposes senderFirstName + senderUsername
    (no last name), so names are first-name/username only.
  - connector does NOT expose msg.action -> no 'service' classification.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

# messageType values that are downloadable media (lowercased connector enum).
DOWNLOADABLE_TYPES = {"photo", "video", "audio", "voice", "video_note", "sticker", "document"}
# Voice notes + audio files get queued for whisper transcription.
TRANSCRIBE_TYPES = {"voice", "audio"}


def parse_ts(value: Any) -> datetime:
    """Parse the connector's ISO-8601 timestamp into a tz-aware datetime.
    Falls back to now(UTC) on anything unparseable so a bad timestamp never
    drops a message."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        s = value.replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(s)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def _int_or_none(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def message_type_of(m: dict) -> str:
    """Canonical lowercase message type (text/photo/voice/video_note/...)."""
    return str(m.get("messageType") or "TEXT").lower()


def to_insert_kwargs(m: dict) -> Optional[dict]:
    """Build kwargs for db.insert_message from a connector message dict.
    Returns None if the object is missing the ids we key on."""
    chat_id = _int_or_none(m.get("conversationId"))
    tg_msg_id = _int_or_none(m.get("telegramMessageId"))
    if chat_id is None or tg_msg_id is None:
        return None

    mt = message_type_of(m)
    content = m.get("content")
    if content == "":
        content = None
    sender_name = m.get("senderFirstName") or m.get("senderUsername") or None

    return {
        "telegram_message_id": tg_msg_id,
        "chat_id": chat_id,
        "chat_title": m.get("chatTitle") or None,
        "chat_type": str(m.get("chatType") or "private"),
        "sender_id": _int_or_none(m.get("senderTelegramId")),
        "sender_name": sender_name,
        "content": content,
        "message_type": mt,
        "direction": "outbound" if m.get("isOutbound") else "inbound",
        "timestamp": parse_ts(m.get("telegramTimestamp")),
        "is_forwarded": bool(m.get("isForwarded")),
        "reply_to_message_id": _int_or_none(m.get("replyToMessageId")),
        "topic_id": _int_or_none(m.get("topicId")),
        "needs_transcription": mt in TRANSCRIBE_TYPES,
    }


def attachment_meta(m: dict) -> dict:
    """Best-effort attachment metadata from the connector attachments[].
    The connector omits dimensions/duration (lost vs Telethon) and gives no
    mime/size for PHOTO/STICKER."""
    out = {"mime_type": None, "file_name": None, "file_size": None,
           "duration": None, "width": None, "height": None}
    atts = m.get("attachments") or []
    if not atts:
        # photos carry no explicit attachment entry mime; assume jpeg
        if message_type_of(m) == "photo":
            out["mime_type"] = "image/jpeg"
        return out
    a = atts[0]
    out["mime_type"] = a.get("mimeType") or (
        "image/jpeg" if message_type_of(m) in ("photo", "sticker") else None
    )
    out["file_name"] = a.get("fileName")
    out["file_size"] = a.get("size")
    return out
