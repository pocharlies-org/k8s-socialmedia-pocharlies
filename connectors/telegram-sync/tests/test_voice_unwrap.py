"""ASR echo unwrap on ingest (INFRA-364).

Bots (Hermes gateway `echo_transcripts`, DGX Studio) echo voice-note
transcripts back as TEXT messages; when the echo embeds the raw STT response
body, the row used to store `🎙️ "{"text":"…","usage":null}"`. The mapper now
unwraps exactly that shape to clean text; prose that merely mentions JSON is
untouched. Unit tests only — no DB needed.
"""
from __future__ import annotations

import asyncio

from sync import db, mapping

# The real prod shape (row 1254112, telegram supergroup culturismo): 🎙️ +
# quoted JSON with UNESCAPED inner quotes.
PROD_ECHO = (
    '🎙️ "{"text":"La prueba de voz.","usage":null}"'
)


def test_unwrap_prod_echo_shape():
    assert mapping.unwrap_asr_json(PROD_ECHO) == '🎙️ La prueba de voz.'


def test_unwrap_raw_json_body():
    assert mapping.unwrap_asr_json('{"text":"hola","usage":null}') == 'hola'


def test_unwrap_escaped_json_string():
    # Properly escaped: the whole content is a JSON string whose value is the body.
    assert mapping.unwrap_asr_json('"{\\"text\\":\\"hola\\"}"') == 'hola'


def test_unwrap_marker_without_quotes():
    assert mapping.unwrap_asr_json('🎙️ {"text":"hola"}') == '🎙️ hola'


def test_unwrap_verbose_json_segments():
    body = '{"segments":[{"text":"uno "},{"text":"dos"}],"language":"es"}'
    assert mapping.unwrap_asr_json(body) == 'uno dos'


def test_non_matching_content_untouched():
    for content in (
        None,
        '',
        'texto normal',
        # Prose that merely mentions the JSON shape — not the shape itself.
        'Porque dice 🎙️ "{"text":"No hay otro.","usage":null}" al final usage null',
        # Marker + prose (real row 829897, OmniVoice evaluation).
        '🎙️ EVALUACIÓN OmniVoice — 28 audios (voz daniel_clean_16s).',
        # JSON-ish but no usable transcript.
        '{"usage":null}',
        '{"text":123}',
        '{"text":"   "}',
        '{not json at all}',
        # Code block mentioning "text":
        '```{ "update_id": 851595339, "message": { "text": "hola" } }```',
    ):
        assert mapping.unwrap_asr_json(content) is content or mapping.unwrap_asr_json(content) == content, content


def test_to_insert_kwargs_unwraps_text():
    kwargs = mapping.to_insert_kwargs({
        "conversationId": "-1004414142179",
        "telegramMessageId": "767",
        "messageType": "TEXT",
        "content": PROD_ECHO,
        "telegramTimestamp": "2026-09-21T23:06:18Z",
        "senderFirstName": "Hermes Pocharlies",
    })
    assert kwargs["content"] == '🎙️ La prueba de voz.'


def test_to_insert_kwargs_leaves_real_text_and_none():
    kwargs = mapping.to_insert_kwargs({
        "conversationId": "123",
        "telegramMessageId": "1",
        "messageType": "TEXT",
        "content": 'El bot dice 🎙️ "{"text":"x"}" y nada más',
    })
    assert kwargs["content"] == 'El bot dice 🎙️ "{"text":"x"}" y nada más'
    kwargs = mapping.to_insert_kwargs({
        "conversationId": "123", "telegramMessageId": "1", "messageType": "VOICE", "content": "",
    })
    assert kwargs["content"] is None


def test_to_edit_kwargs_unwraps():
    edit = mapping.to_edit_kwargs({
        "conversationId": "-1", "telegramMessageId": "2",
        "content": '{"text":"editada","usage":null}',
        "editedAt": "2026-09-30T10:00:00.000Z",
    })
    assert edit["content"] == "editada"


class _FakeConn:
    def __init__(self, sink):
        self.sink = sink

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, sql, *args):
        self.sink.append(args)


class _FakePool:
    def __init__(self):
        self.calls = []

    def acquire(self):
        return _FakeConn(self.calls)


def test_complete_transcription_stores_clean_text():
    # The transcriber's writer is the single chokepoint for transcription text:
    # an STT body written by mistake is unwrapped; clean text passes through.
    pool = _FakePool()
    asyncio.run(db.complete_transcription(pool, 7, '{"text":"hola","usage":null}'))
    assert pool.calls[0] == (7, "hola")
    pool = _FakePool()
    asyncio.run(db.complete_transcription(pool, 7, "texto limpio de whisper"))
    assert pool.calls[0] == (7, "texto limpio de whisper")
