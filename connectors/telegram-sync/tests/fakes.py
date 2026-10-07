"""Minimal asyncpg stand-ins shared by the unit tests (no database needed)."""
from contextlib import AbstractAsyncContextManager


class Context(AbstractAsyncContextManager):
    def __init__(self, value):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *args):
        return False


class Pool:
    def __init__(self, connection):
        self.connection = connection

    def acquire(self):
        return Context(self.connection)
