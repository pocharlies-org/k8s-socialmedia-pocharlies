"""HTTP client for the telegram-connector (mtcute) — the session-less sync's
only door to Telegram. Replaces the Telethon client entirely.

The connector holds the single Telegram session per account; this sync never
opens its own MTProto session (eliminates the shared-auth-key / AuthKeyDuplicated
class of failures). All Telegram reads/writes go through the connector's HTTP API:

  - history backfill   -> GET  /api/v1/messages/:chatId?limit&offsetId   (HMAC)
  - dialog enumeration -> GET  /api/v1/dialogs                            (HMAC)
  - media bytes        -> GET  /api/v1/messages/media/:chatId/:msgId      (HMAC)
  - profile photos     -> GET  /api/v1/peers/:id/photo                    (HMAC)
  - identity           -> GET  /api/v1/me                                 (HMAC)
  - outbound send      -> POST /api/public/send/:chatId                   (open, in-cluster)
  - liveness           -> GET  /health                                    (open)

HMAC scheme mirrors connectors/telegram/src/api/controller.ts authMiddleware +
shared/src/crypto/encryption.ts generateHMACSignature:

    message   = f"{timestamp}:{JSON.stringify(body)}"
    signature = "sha256=" + hmac_sha256(shared_secret, message).hexdigest()
    headers   = x-connector-signature, x-connector-timestamp

For GET requests the connector's express app sees an empty body, so `req.body ||
{}` is `{}` and the signed body is the literal `{}` (json.dumps({}) == "{}",
byte-identical to JS JSON.stringify({})).
"""
from __future__ import annotations

import base64
import asyncio
import math
import hashlib
import hmac
import json
import logging
import os
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


def retry_after(response: httpx.Response) -> float:
    value = response.headers.get("Retry-After", "")
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            seconds = 30.0
    return max(1.0, seconds) if math.isfinite(seconds) else 30.0

def is_throttled(error: Exception) -> bool:
    """Telegram (429) or the connector (503, not connected) said "wait": that says
    nothing about the message being fetched."""
    return isinstance(error, httpx.HTTPStatusError) and error.response.status_code in (429, 503)


# Default in-cluster connector service per account (overridable via CONNECTOR_BASE_URL).
_DEFAULT_BASE = {
    "personal": "http://telegram-connector:3002",
    "professional": "http://telegram-connector-professional:3002",
}


def _compact(body: Any) -> str:
    """Match JS JSON.stringify exactly (no spaces, insertion order preserved)."""
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False)


class ConnectorClient:
    def __init__(self, base_url: str, shared_secret: str, account: str = "personal",
                 timeout: float = 30.0, media_timeout: float = 150.0):
        if not math.isfinite(media_timeout) or not 121 <= media_timeout <= 1800:
            raise ValueError("media_timeout must be finite and between 121 and 1800 seconds")
        self.base_url = base_url.rstrip("/")
        self.shared_secret = shared_secret or ""
        self.account = account
        self.media_timeout = media_timeout
        self._cooldown_until = 0.0
        self._client = httpx.AsyncClient(timeout=timeout)

    @classmethod
    def from_env(cls) -> "ConnectorClient":
        account = os.environ.get("CONNECTOR_ACCOUNT", "personal")
        base = os.environ.get("CONNECTOR_BASE_URL") or _DEFAULT_BASE.get(
            account, _DEFAULT_BASE["personal"]
        )
        secret = os.environ.get("CONNECTOR_SHARED_SECRET", "")
        if not secret:
            logger.warning("CONNECTOR_SHARED_SECRET is empty — HMAC /api/v1 calls will 401")
        return cls(base, secret, account,
                   media_timeout=float(os.environ.get("CONNECTOR_MEDIA_TIMEOUT", "150")))

    # --- HMAC ----------------------------------------------------------------

    def _sign(self, body: Any) -> dict[str, str]:
        ts = str(int(time.time()))
        message = f"{ts}:{_compact(body)}"
        sig = hmac.new(self.shared_secret.encode(), message.encode(), hashlib.sha256).hexdigest()
        return {
            "x-connector-signature": f"sha256={sig}",
            "x-connector-timestamp": ts,
        }

    async def _get_v1(self, path: str, params: Optional[dict] = None,
                      timeout: float | None = None) -> httpx.Response:
        while self._cooldown_until > time.monotonic():
            await asyncio.sleep(self._cooldown_until - time.monotonic())
        # Authed GET: connector sees an empty body -> sign "{}"
        headers = self._sign({})
        options = {"timeout": timeout} if timeout is not None else {}
        response = await self._client.get(f"{self.base_url}/api/v1{path}", params=params,
                                          headers=headers, **options)
        if response.status_code == 429 or (response.status_code == 503 and "Retry-After" in response.headers):
            self._cooldown_until = max(self._cooldown_until, time.monotonic() + retry_after(response))
        return response

    # --- Reads ---------------------------------------------------------------

    async def get_me(self) -> Optional[dict]:
        try:
            r = await self._get_v1("/me")
            if r.status_code == 200:
                return r.json()
            logger.warning("get_me -> %s %s", r.status_code, r.text[:200])
        except Exception as e:
            logger.warning("get_me failed: %s", e)
        return None

    async def get_dialogs(self) -> list[dict]:
        """[{id, name, type, unreadCount}] — id is the bare marked id string."""
        r = await self._get_v1("/dialogs")
        r.raise_for_status()
        return r.json().get("dialogs", [])

    async def get_messages(self, chat_id: str, limit: int = 100,
                           offset_id: Optional[int] = None) -> list[dict]:
        """Newest-first window (descending). offset_id is EXCLUSIVE and pages
        OLDER-than (the connector/mtcute getHistory has no newer-than cursor)."""
        params: dict[str, Any] = {"limit": limit}
        if offset_id:
            params["offsetId"] = offset_id
        r = await self._get_v1(f"/messages/{chat_id}", params=params)
        r.raise_for_status()
        return r.json().get("messages", [])

    async def get_message(self, chat_id: str, msg_id: int) -> Optional[dict]:
        r = await self._get_v1(f"/messages/single/{chat_id}/{msg_id}", timeout=self.media_timeout)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        message = r.json()["message"]
        if (str(message.get("conversationId")) != str(chat_id)
                or int(message.get("telegramMessageId", 0)) != msg_id):
            raise ValueError("connector returned a different Telegram message")
        return message

    async def download_media(self, chat_id: str, msg_id: int) -> Optional[bytes]:
        """Raw media bytes for a message, or None if it has no downloadable media."""
        r = await self._get_v1(f"/messages/media/{chat_id}/{msg_id}", timeout=self.media_timeout)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        data = r.json().get("data")
        if not data:
            raise ValueError("connector returned empty media data")
        return base64.b64decode(data, validate=True)

    async def peer_photo(self, peer_id: str) -> Optional[bytes]:
        """Profile photo bytes (JPEG) for a user or chat, or None."""
        r = await self._get_v1(f"/peers/{peer_id}/photo")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        data = r.json().get("data")
        return base64.b64decode(data) if data else None

    # --- Writes --------------------------------------------------------------

    async def send(self, chat_id: str, text: str, topic_id: Optional[int] = None) -> dict:
        """Outbound send via the connector's open in-cluster public route."""
        body: dict[str, Any] = {"text": text}
        if topic_id:
            body["topicId"] = topic_id
        r = await self._client.post(f"{self.base_url}/api/public/send/{chat_id}", json=body)
        r.raise_for_status()
        return r.json()

    # --- Health --------------------------------------------------------------

    async def health(self) -> bool:
        try:
            r = await self._client.get(f"{self.base_url}/health")
            return r.status_code == 200 and bool(r.json().get("connected"))
        except Exception:
            return False

    async def aclose(self) -> None:
        await self._client.aclose()
