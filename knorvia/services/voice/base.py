"""Base abstractions and shared helpers for voice providers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence
import io
import logging
import re
from typing import Any
import wave

from knorvia.services.voice.config import (
    AUTH_API_KEY_HEADER,
    AUTH_TOKEN,
    STTConfig,
    TTSConfig,
)

logger = logging.getLogger(__name__)

_DEFAULT_PCM_SAMPLE_RATE = 24_000
_DEFAULT_PCM_CHANNELS = 1
_PCM16_SAMPLE_WIDTH = 2


class VoiceProviderError(RuntimeError):
    """Raised when a TTS/STT provider request fails or is misconfigured."""


class VoiceProviderHTTPError(VoiceProviderError):
    """Provider returned a non-2xx HTTP response."""

    def __init__(self, message: str, *, status_code: int, body: str = "") -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class TranscriptionResult(str):
    """A transcription that may carry per-segment timestamps (Phase D1).

    Subclasses :class:`str` so every pre-D1 caller — the ``/voice/stt`` route,
    partner chat transcription, the config test runner — keeps working with the
    plain-text semantics untouched. Phase D callers additionally read:

    * ``.text`` — the full transcript (identical to the ``str`` value);
    * ``.segments`` — ``[{start, end, text}, ...]`` normalized to ascending
      non-negative seconds, or ``None`` when no timestamps exist;
    * ``.segments_supported`` — ``True`` only when this call actually obtained
      ``verbose_json`` segments. ``False`` + ``segments=None`` marks the
      capability fallback (gateway rejected verbose_json or answered without
      segments); the transcript itself is still returned, never raised.
    """

    __slots__ = ("segments", "segments_supported")

    def __new__(
        cls,
        text: str,
        *,
        segments: list[dict[str, float | str]] | None = None,
        segments_supported: bool = False,
    ) -> "TranscriptionResult":
        result = super().__new__(cls, str(text or ""))
        result.segments = segments
        result.segments_supported = bool(segments_supported)
        return result

    @property
    def text(self) -> str:
        """The transcript as a plain string (``str(result)`` equivalent)."""
        return str(self)

    def __repr__(self) -> str:  # pragma: no cover - debugging nicety
        return (
            f"TranscriptionResult(text={str(self)!r}, "
            f"segments={len(self.segments) if self.segments else 0}, "
            f"segments_supported={self.segments_supported})"
        )


class BaseTTSAdapter(ABC):
    """Abstract text-to-speech adapter."""

    @abstractmethod
    async def synthesize(self, text: str, config: TTSConfig) -> tuple[bytes, str]:
        """Synthesize ``text`` to audio.

        Returns:
            ``(audio_bytes, content_type)`` — content type is best-effort, e.g.
            ``audio/mpeg`` for mp3.
        """

    def list_voices(self, config: TTSConfig) -> list[dict[str, str]]:
        """Enumerate selectable voices for this adapter (§Phase D4).

        Pure configuration read — zero provider calls, so enumeration is always
        a free action. The base implementation surfaces the gateway-configured
        ``custom_voices`` plus the active/default ``voice``; adapters with a
        known whitelist (OpenAI-compatible) override it to add that whitelist.
        Returns ``[{"id": ..., "label": ..., "provider": ...}]`` with stable,
        de-duplicated order (whitelist/custom first, active voice last).
        """
        voices: list[dict[str, str]] = [
            {"id": name, "label": name, "provider": config.provider_name}
            for name in _dedupe_voices(config.custom_voices)
        ]
        active = (config.voice or "").strip()
        if active and active not in {entry["id"] for entry in voices}:
            voices.append({"id": active, "label": active, "provider": config.provider_name})
        return voices


def _dedupe_voices(names: list[str]) -> list[str]:
    """Normalize and de-duplicate a custom voice list, keeping order."""
    seen: set[str] = set()
    ordered: list[str] = []
    for name in names or []:
        cleaned = str(name).strip()
        if cleaned and cleaned.lower() not in seen:
            seen.add(cleaned.lower())
            ordered.append(cleaned)
    return ordered


class BaseSTTAdapter(ABC):
    """Abstract speech-to-text adapter."""

    @abstractmethod
    async def transcribe(
        self,
        audio: bytes,
        config: STTConfig,
        *,
        filename: str = "audio.webm",
        content_type: str = "application/octet-stream",
        want_segments: bool = False,
    ) -> TranscriptionResult:
        """Transcribe ``audio`` bytes to text.

        ``want_segments=True`` asks for timestamped segments when the gateway
        supports them (``response_format=verbose_json``); adapters that cannot
        provide them fall back to plain text and return a result with
        ``segments_supported=False`` instead of raising.
        """


def normalize_stt_segments(
    raw_segments: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Coerce ASR ``segments`` into clean, ascending, non-negative cues.

    Shared by the adapters (verbose_json parsing) and the Video Studio
    ``from_asr`` caption chain. Drops entries without usable timings or text,
    clamps negative times to zero, trims to milliseconds and sorts by start.
    """

    def _seconds(value: Any) -> float | None:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        if number != number:  # NaN
            return None
        return max(0.0, round(number, 3))

    cleaned: list[dict[str, Any]] = []
    for item in raw_segments:
        if not isinstance(item, Mapping):
            continue
        text = " ".join(str(item.get("text") or "").split())
        if not text:
            continue
        start = _seconds(item.get("start"))
        end = _seconds(item.get("end"))
        if start is None or end is None or end <= start:
            continue
        cleaned.append({"start": start, "end": end, "text": text})
    cleaned.sort(key=lambda cue: (float(cue["start"]), float(cue["end"])))
    return cleaned


def build_auth_headers(auth_style: str, api_key: str) -> dict[str, str]:
    """Map an ``auth_style`` + key onto request headers.

    ``bearer`` (default) → ``Authorization: Bearer``; ``api_key_header`` →
    ``api-key`` (Azure); ``token`` → ``Authorization: Token`` (Deepgram-style).
    """
    if not api_key:
        return {}
    if auth_style == AUTH_API_KEY_HEADER:
        return {"api-key": api_key}
    if auth_style == AUTH_TOKEN:
        return {"Authorization": f"Token {api_key}"}
    return {"Authorization": f"Bearer {api_key}"}


def join_audio_path(base_url: str, suffix: str) -> str:
    """Append an OpenAI audio path to a configured base URL.

    ``base_url`` is the API base (e.g. ``https://api.openai.com/v1``). If the
    admin already pasted a full ``.../audio/...`` endpoint (some gateways /
    Azure deployments), it is used verbatim and the query string preserved.
    """
    base = (base_url or "").strip()
    if not base:
        raise VoiceProviderError("No endpoint URL configured for this provider.")
    head, sep, query = base.partition("?")
    if "/audio/" in head:
        return base
    joined = f"{head.rstrip('/')}/{suffix.lstrip('/')}"
    return f"{joined}?{query}" if sep else joined


# Content blocks that should never be spoken aloud, stripped before synthesis.
_FENCED_CODE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s*", re.MULTILINE)
_BLOCKQUOTE = re.compile(r"^\s{0,3}>\s?", re.MULTILINE)
_LIST_MARKER = re.compile(r"^\s{0,3}(?:[-*+]|\d+[.)])\s+", re.MULTILINE)
_EMPHASIS = re.compile(r"(\*{1,3}|_{1,3}|~~)(\S.*?\S|\S)\1")
_HTML_TAG = re.compile(r"<[^>]+>")
_TABLE_PIPE = re.compile(r"^\s*\|.*\|\s*$", re.MULTILINE)
_WHITESPACE = re.compile(r"[ \t]+")
_BLANK_LINES = re.compile(r"\n{3,}")


def strip_markdown_for_speech(text: str, *, max_chars: int = 0) -> str:
    """Reduce Markdown to plain prose suitable for TTS.

    Drops code blocks and tables outright (they read terribly), unwraps links
    and emphasis to their visible text, and removes structural markers. This is
    deliberately lossy — the goal is natural speech, not faithful rendering.
    """
    if not text:
        return ""
    out = _FENCED_CODE.sub(" ", text)
    out = _TABLE_PIPE.sub(" ", out)
    out = _IMAGE.sub(" ", out)
    out = _LINK.sub(r"\1", out)
    out = _INLINE_CODE.sub(r"\1", out)
    out = _HEADING.sub("", out)
    out = _BLOCKQUOTE.sub("", out)
    out = _LIST_MARKER.sub("", out)
    out = _EMPHASIS.sub(r"\2", out)
    out = _HTML_TAG.sub("", out)
    out = _WHITESPACE.sub(" ", out)
    out = _BLANK_LINES.sub("\n\n", out).strip()
    if max_chars and len(out) > max_chars:
        # Cut on a sentence/space boundary near the cap so speech ends cleanly.
        window = out[:max_chars]
        cut = max(window.rfind("."), window.rfind("\n"), window.rfind(" "))
        out = window[: cut + 1].strip() if cut > max_chars // 2 else window.strip()
    return out


def parse_pcm_content_type(content_type: str) -> tuple[int, int] | None:
    """Return ``(sample_rate, channels)`` when a provider sent raw PCM audio."""
    media_type, *params = (content_type or "").split(";")
    if media_type.strip().lower() not in {"audio/pcm", "audio/x-pcm", "audio/l16"}:
        return None
    sample_rate = _DEFAULT_PCM_SAMPLE_RATE
    channels = _DEFAULT_PCM_CHANNELS
    for item in params:
        key, sep, value = item.strip().partition("=")
        if not sep:
            continue
        key = key.strip().lower()
        value = value.strip().strip('"')
        try:
            parsed = int(value)
        except ValueError:
            continue
        if key in {"rate", "sample-rate", "samplerate"} and parsed > 0:
            sample_rate = parsed
        elif key in {"channels", "channel"} and parsed > 0:
            channels = parsed
    return sample_rate, channels


def pcm16_to_wav(audio: bytes, *, sample_rate: int, channels: int) -> bytes:
    """Wrap provider PCM16 bytes in a WAV container browsers can play."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(_PCM16_SAMPLE_WIDTH)
        wav.setframerate(sample_rate)
        wav.writeframes(audio)
    return buffer.getvalue()


__all__ = [
    "VoiceProviderError",
    "VoiceProviderHTTPError",
    "BaseTTSAdapter",
    "BaseSTTAdapter",
    "TranscriptionResult",
    "build_auth_headers",
    "join_audio_path",
    "normalize_stt_segments",
    "parse_pcm_content_type",
    "pcm16_to_wav",
    "strip_markdown_for_speech",
]
