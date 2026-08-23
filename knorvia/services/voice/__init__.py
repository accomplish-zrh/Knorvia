"""Voice services — text-to-speech and speech-to-text.

Public facade used by the API router and the config test runner. Config is
resolved from the model catalog (``services.tts`` / ``services.stt``) exactly
like embedding/LLM, so voice providers are configured through the same
Settings catalog UI.
"""

from __future__ import annotations

from typing import Any

from knorvia.services.voice.adapters import get_stt_adapter, get_tts_adapter
from knorvia.services.voice.base import (
    TranscriptionResult,
    VoiceProviderError,
    strip_markdown_for_speech,
)
from knorvia.services.voice.config import STTConfig, TTSConfig

# §Phase D4: the fixed audition sentence for POST /api/v1/voice/preview.
# One short, language-neutral line so every voice gets the same reading test.
PREVIEW_SAMPLE_TEXT = "The quick brown fox jumps over the lazy dog."


def list_voices(*, catalog: dict[str, Any] | None = None) -> dict[str, Any]:
    """Enumerate the selectable voices of the active TTS provider (§Phase D4).

    Pure configuration read — the provider whitelist plus the gateway's
    ``custom_voices`` — so enumeration makes **zero** provider calls and is
    always free. Raises ``ValueError`` when no active TTS model is configured
    (the same failure shape as :func:`synthesize_speech`).
    """
    from knorvia.services.config.provider_runtime import resolve_tts_runtime_config

    config = resolve_tts_runtime_config(catalog=catalog)
    adapter = get_tts_adapter(config.adapter)
    return {
        "voices": adapter.list_voices(config),
        "active_voice": config.voice,
        "model": config.model,
        "provider": config.provider_name,
    }


async def synthesize_speech(
    text: str,
    *,
    catalog: dict[str, Any] | None = None,
    voice: str | None = None,
    response_format: str | None = None,
    strip_markdown: bool = True,
) -> tuple[bytes, str]:
    """Synthesize ``text`` using the active TTS catalog selection.

    Returns ``(audio_bytes, content_type)``. ``voice`` / ``response_format``
    override the catalog defaults for this call.
    """
    from knorvia.services.config.provider_runtime import resolve_tts_runtime_config

    config = resolve_tts_runtime_config(catalog=catalog)
    if voice:
        config.voice = voice
    if response_format:
        config.response_format = response_format
    prepared = (
        strip_markdown_for_speech(text, max_chars=config.max_input_chars)
        if strip_markdown
        else text.strip()
    )
    if not prepared:
        raise VoiceProviderError("Nothing to speak after cleaning the text.")
    adapter = get_tts_adapter(config.adapter)
    return await adapter.synthesize(prepared, config)


async def transcribe_audio(
    audio: bytes,
    *,
    catalog: dict[str, Any] | None = None,
    filename: str = "audio.webm",
    content_type: str = "application/octet-stream",
    language: str | None = None,
    want_segments: bool = False,
) -> TranscriptionResult:
    """Transcribe ``audio`` using the active STT catalog selection.

    Returns a :class:`TranscriptionResult` — a ``str`` subclass, so existing
    callers keep the plain-text contract — that additionally carries
    ``.segments`` (``[{start, end, text}]``) when ``want_segments=True`` and
    the gateway supports ``verbose_json``. Gateways without that capability
    degrade to text with ``segments_supported=False`` instead of raising.
    """
    from knorvia.services.config.provider_runtime import resolve_stt_runtime_config

    config = resolve_stt_runtime_config(catalog=catalog)
    if language:
        config.language = language
    adapter = get_stt_adapter(config.adapter)
    return await adapter.transcribe(
        audio,
        config,
        filename=filename,
        content_type=content_type,
        want_segments=want_segments,
    )


__all__ = [
    "VoiceProviderError",
    "TTSConfig",
    "STTConfig",
    "TranscriptionResult",
    "PREVIEW_SAMPLE_TEXT",
    "list_voices",
    "synthesize_speech",
    "transcribe_audio",
    "strip_markdown_for_speech",
]
