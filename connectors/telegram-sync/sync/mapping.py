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

import json
from datetime import datetime, timezone
from typing import Any, Optional

# messageType values that are downloadable media (lowercased connector enum).
DOWNLOADABLE_TYPES = {"photo", "video", "audio", "voice", "video_note", "sticker", "document"}
# Voice notes + audio files get queued for whisper transcription.
TRANSCRIBE_TYPES = {"voice", "audio"}

# --- ASR echo unwrap (INFRA-364) ---------------------------------------------
# Bots that transcribe an incoming voice note echo the transcript back as a TEXT
# message (Hermes gateway with `echo_transcripts: true`, DGX Studio). When the
# gateway embeds the RAW STT response body instead of its `.text`, the echo
# arrives as e.g. `🎙️ "{"text":"…","usage":null}"` — emoji marker + quoted JSON,
# inner quotes unescaped. The DB must store only the clean text (the brain and
# the window builder read `content` as prose), so we unwrap exactly those shapes
# on ingest, keeping the 🎙️ marker the echo intends. A message that merely
# *mentions* JSON is not the shape and passes through untouched.
VOICE_ECHO_PREFIX = "🎙️"


def _as_asr_text(s: str) -> Optional[str]:
    """The transcript inside a full ASR-response JSON object, or None.

    The whole string must parse as a JSON object carrying a non-empty string
    `text` (OpenAI-compatible /v1/audio/transcriptions `json` format), or — as
    `verbose_json` — a `segments` array whose parts carry the text."""
    s = s.strip()
    if not (s.startswith("{") and s.endswith("}")):
        return None
    try:
        obj = json.loads(s)
    except ValueError:
        return None
    if not isinstance(obj, dict):
        return None
    text = obj.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    segments = obj.get("segments")
    if isinstance(segments, list):
        parts = [
            seg["text"].strip()
            for seg in segments
            if isinstance(seg, dict) and isinstance(seg.get("text"), str) and seg["text"].strip()
        ]
        if parts:
            return " ".join(parts)
    return None


def unwrap_asr_json(content: Any) -> Any:
    """Rewrite an ASR-echo message body to `🎙️ <clean text>` (or plain text when
    the echo carried no marker). Non-matching content — and non-strings — are
    returned unchanged."""
    if not isinstance(content, str):
        return content
    rest = content.strip()
    prefix = ""
    if rest.startswith(VOICE_ECHO_PREFIX):
        i = len(VOICE_ECHO_PREFIX)
        while i < len(rest) and rest[i] in " \t":
            i += 1
        prefix, rest = rest[:i], rest[i:]
    text = None
    if len(rest) >= 2 and rest[0] == '"' and rest[-1] == '"':
        # Observed echo shape: raw body wrapped in quotes WITHOUT escaping the
        # inner ones — strip the outer quotes and parse what is left. Fall back
        # to a properly escaped JSON string whose value is itself the body.
        text = _as_asr_text(rest[1:-1])
        if text is None:
            try:
                inner = json.loads(rest)
            except ValueError:
                inner = None
            if isinstance(inner, str):
                text = _as_asr_text(inner)
    else:
        text = _as_asr_text(rest)
    if text is None:
        return content
    return f"{prefix}{text}" if prefix else text


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


def iso_utc(dt: datetime) -> str:
    """ISO-8601 in UTC with milliseconds and `Z` — JavaScript's toISOString(),
    the format the WhatsApp connector writes into metadata.edit_history."""
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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
    content = unwrap_asr_json(m.get("content"))
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


EDIT_SOURCES = {"connector", "telegram"}


def to_edit_kwargs(e: dict) -> Optional[dict]:
    """Build kwargs for db.mark_message_edited from a TelegramMessageEdited
    event (connectors/telegram/src/events/publisher.ts). None when the ids or
    the text are missing — an edit never blanks a row."""
    chat_id = _int_or_none(e.get("conversationId"))
    tg_msg_id = _int_or_none(e.get("telegramMessageId"))
    content = unwrap_asr_json(e.get("content"))
    if chat_id is None or tg_msg_id is None or not isinstance(content, str) or not content:
        return None
    source = e.get("source") if e.get("source") in EDIT_SOURCES else "telegram"
    actor = e.get("actor")
    actor = actor.strip()[:200] if isinstance(actor, str) and actor.strip() else None
    return {
        "chat_id": chat_id,
        "telegram_message_id": tg_msg_id,
        "content": content,
        "edited_at": iso_utc(parse_ts(e.get("editedAt"))),
        "source": source,
        "actor": actor,
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
