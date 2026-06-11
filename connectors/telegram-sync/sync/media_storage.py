"""MinIO uploader for Telegram media — used by history.py + realtime.py + backfill.

Bucket `socialmedia-media` is shared across WA + TG + IG. Object keys follow
`attachments/{message_id}/{ts}.{ext}` so they don't collide. We upload bytes
directly from BytesIO (no disk write).
"""
from __future__ import annotations

import io
import logging
import os
import time
from typing import Optional

from minio import Minio

logger = logging.getLogger(__name__)

MINIO_ENDPOINT = os.environ.get("S3_ENDPOINT") or os.environ.get("MINIO_ENDPOINT", "minio:9000")
MINIO_ACCESS_KEY = os.environ.get("AWS_ACCESS_KEY_ID") or os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.environ.get("AWS_SECRET_ACCESS_KEY") or os.environ.get("MINIO_SECRET_KEY", "minioadmin")
MINIO_USE_SSL = os.environ.get("S3_USE_SSL", os.environ.get("MINIO_USE_SSL", "true")).lower() == "true"
MINIO_BUCKET = os.environ.get("S3_BUCKET") or os.environ.get("MINIO_BUCKET", "socialmedia-media")
S3_PREFIX = os.environ.get("S3_PREFIX", "").strip("/")
LEGACY_MINIO_ENDPOINT = os.environ.get("LEGACY_MINIO_ENDPOINT") or os.environ.get("MINIO_ENDPOINT", MINIO_ENDPOINT)
LEGACY_MINIO_ACCESS_KEY = os.environ.get("LEGACY_MINIO_ACCESS_KEY") or os.environ.get("MINIO_ACCESS_KEY", MINIO_ACCESS_KEY)
LEGACY_MINIO_SECRET_KEY = os.environ.get("LEGACY_MINIO_SECRET_KEY") or os.environ.get("MINIO_SECRET_KEY", MINIO_SECRET_KEY)
LEGACY_MINIO_USE_SSL = os.environ.get("LEGACY_MINIO_USE_SSL", os.environ.get("MINIO_USE_SSL", "true")).lower() == "true"
LEGACY_MINIO_BUCKET = os.environ.get("LEGACY_MINIO_BUCKET") or os.environ.get("MINIO_BUCKET", "socialmedia-media")
# Use cert_check=False to accept the cluster's self-signed CA. The CA file is
# at /certs/ca.crt inside the container; for a stricter setup use
# `Minio(..., http_client=urllib3.PoolManager(ca_certs="/certs/ca.crt"))`.
_CERT_CHECK = os.environ.get("MINIO_CERT_CHECK", "false").lower() == "true"

_client: Optional[Minio] = None
_legacy_client: Optional[Minio] = None


def _endpoint(endpoint: str) -> str:
    return endpoint.removeprefix("http://").removeprefix("https://").rstrip("/")


def _get_client() -> Minio:
    global _client
    if _client is None:
        _client = Minio(
            _endpoint(MINIO_ENDPOINT),
            access_key=MINIO_ACCESS_KEY,
            secret_key=MINIO_SECRET_KEY,
            secure=MINIO_USE_SSL or MINIO_ENDPOINT.startswith("https://"),
            cert_check=_CERT_CHECK,
        )
    return _client


def _get_legacy_client() -> Minio:
    global _legacy_client
    if _legacy_client is None:
        _legacy_client = Minio(
            _endpoint(LEGACY_MINIO_ENDPOINT),
            access_key=LEGACY_MINIO_ACCESS_KEY,
            secret_key=LEGACY_MINIO_SECRET_KEY,
            secure=LEGACY_MINIO_USE_SSL or LEGACY_MINIO_ENDPOINT.startswith("https://"),
            cert_check=_CERT_CHECK,
        )
    return _legacy_client


def _with_prefix(key: str) -> str:
    key = key.lstrip("/")
    return f"{S3_PREFIX}/{key}" if S3_PREFIX else key


def _s3_uri(key: str) -> str:
    return f"s3://{MINIO_BUCKET}/{key}"


def parse_storage_ref(ref: str) -> tuple[str, str, bool]:
    if ref.startswith("s3://"):
        from urllib.parse import urlparse
        parsed = urlparse(ref)
        return parsed.netloc, parsed.path.lstrip("/"), False
    return LEGACY_MINIO_BUCKET, ref, True


def ensure_bucket() -> None:
    c = _get_client()
    if not c.bucket_exists(MINIO_BUCKET):
        c.make_bucket(MINIO_BUCKET)
        logger.info(f"Created MinIO bucket: {MINIO_BUCKET}")


_EXT_BY_MIME = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "application/pdf": "pdf",
}


def pick_ext(mime_type: Optional[str], file_name: Optional[str]) -> str:
    if file_name and "." in file_name:
        return file_name.rsplit(".", 1)[-1][:6].lower()
    if mime_type and mime_type in _EXT_BY_MIME:
        return _EXT_BY_MIME[mime_type]
    if mime_type and mime_type.startswith("image/"):
        return "bin"
    return "bin"


def upload_media(
    message_id: int,
    data: bytes,
    mime_type: Optional[str],
    file_name: Optional[str],
) -> tuple[str, int]:
    """Upload bytes to MinIO and return (storage_key, size). Storage key goes
    into attachments.file_url; the dashboard streams via /api/messages/media-blob/{id}."""
    c = _get_client()
    ext = pick_ext(mime_type, file_name)
    storage_key = _with_prefix(f"attachments/{message_id}/{int(time.time() * 1000)}.{ext}")
    buf = io.BytesIO(data)
    metadata = {}
    if mime_type:
        metadata["Content-Type"] = mime_type
    c.put_object(
        MINIO_BUCKET,
        storage_key,
        buf,
        length=len(data),
        content_type=mime_type or "application/octet-stream",
        metadata=metadata or None,
    )
    return _s3_uri(storage_key), len(data)


def download_media(storage_ref: str) -> bytes:
    bucket, key, legacy = parse_storage_ref(storage_ref)
    response = (_get_legacy_client() if legacy else _get_client()).get_object(bucket, key)
    try:
        return response.read()
    finally:
        response.close()
        response.release_conn()


def upload_avatar(kind: str, ident: str, data: bytes) -> str:
    """Upload a profile picture to MinIO under avatars/{kind}/{base64url(id)}.jpg.

    kind ∈ {conversations, participants}. The base64url(id) encoding handles
    WhatsApp `@`-suffixed JIDs and Telegram negative IDs safely.
    """
    import base64 as _b64
    c = _get_client()
    ensure_bucket()
    safe = _b64.urlsafe_b64encode(ident.encode()).decode().rstrip("=")
    storage_key = _with_prefix(f"avatars/{kind}/{safe}.jpg")
    buf = io.BytesIO(data)
    c.put_object(
        MINIO_BUCKET,
        storage_key,
        buf,
        length=len(data),
        content_type="image/jpeg",
    )
    return _s3_uri(storage_key)
