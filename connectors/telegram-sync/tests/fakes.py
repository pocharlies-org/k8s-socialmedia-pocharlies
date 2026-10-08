"""Minimal asyncpg stand-ins shared by the telegram-sync unit tests."""
from contextlib import AbstractAsyncContextManager


class Context(AbstractAsyncContextManager):
    def __init__(self, value):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *args):
        return False


class Pool:
    """pool.acquire() hands back the one connection it wraps."""

    def __init__(self, connection):
        self.connection = connection

    def acquire(self):
        return Context(self.connection)
