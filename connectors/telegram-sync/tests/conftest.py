import os
import sys

# Tests import the service package as `sync` (the container runs from /app).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


import asyncio

import pytest


@pytest.fixture(autouse=True)
def fresh_media_lock(monkeypatch):
    # media_download keeps one process-wide asyncio.Lock; each test runs its own
    # event loop, and a lock that has waited is bound to the loop that used it.
    from sync import media_download
    monkeypatch.setattr(media_download, "_MEDIA_LOCK", asyncio.Lock())
