"""Tests for the voice (TTS/STT) service layer.

Covers Markdown cleaning, the OpenAI-compatible adapters' wire shape, the
OpenRouter base64-JSON STT branch, Azure auth headers, and catalog-driven
config resolution.
"""

from __future__ import annotations

import base64
import json
from typing import Any

import httpx
import pytest

from knorvia.services.config.provider_runtime import (
    resolve_stt_runtime_config,
    resolve_tts_runtime_config,
)
from knorvia.services.voice import synthesize_speech, transcribe_audio
from knorvia.services.voice.adapters.openai_compat import (
    OPENAI_TTS_VOICE_ORDER,
    OpenAICompatSTTAdapter,
    OpenAICompatTTSAdapter,
    OpenRouterTTSAdapter,
)
from knorvia.services.voice.base import (
    build_auth_headers,
    join_audio_path,
    strip_markdown_for_speech,
)
from knorvia.services.voice.config import STTConfig, TTSConfig


def _capture_post(monkeypatch: pytest.MonkeyPatch, response: httpx.Response) -> dict[str, Any]:
    """Patch ``httpx.AsyncClient.post`` to record args and return ``response``."""
    captured: dict[str, Any] = {}

    async def fake_post(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        captured["url"] = url
        captured["json"] = kwargs.get("json")
        captured["data"] = kwargs.get("data")
        captured["files"] = kwargs.get("files")
        captured["headers"] = kwargs.get("headers")
        response.request = httpx.Request("POST", url)
        return response

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    return captured


# ── text cleaning ─────────────────────────────────────────────────────────


def test_strip_markdown_drops_code_and_unwraps_links() -> None:
    md = "# Title\n\nHello **world**, read [the docs](http://x).\n\n```py\nprint(1)\n```\n- one\n- two"
    out = strip_markdown_for_speech(md)
    assert "Title" in out and "Hello world" in out and "the docs" in out
    assert "print(1)" not in out  # fenced code dropped
    assert "**" not in out and "[" not in out and "#" not in out


def test_strip_markdown_truncates_on_boundary() -> None:
    out = strip_markdown_for_speech("Sentence one. Sentence two. Sentence three.", max_chars=20)
    assert len(out) <= 20
    assert out.endswith(".")


def test_join_audio_path_appends_and_preserves_full_url() -> None:
    assert join_audio_path("https://api.openai.com/v1", "audio/speech").endswith("/v1/audio/speech")
    full = "https://r.azure.com/openai/deployments/tts/audio/speech?api-version=2025"
    assert join_audio_path(full, "audio/speech") == full


def test_auth_headers_styles() -> None:
    assert build_auth_headers("bearer", "k") == {"Authorization": "Bearer k"}
    assert build_auth_headers("api_key_header", "k") == {"api-key": "k"}
    assert build_auth_headers("token", "k") == {"Authorization": "Token k"}
    assert build_auth_headers("bearer", "") == {}


# ── TTS adapter ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_tts_adapter_posts_openai_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    resp = httpx.Response(200, content=b"ID3audio-bytes", headers={"content-type": "audio/mpeg"})
    captured = _capture_post(monkeypatch, resp)
    config = TTSConfig(
        model="gpt-4o-mini-tts",
        base_url="https://api.openai.com/v1",
        api_key="sk-test",
        voice="alloy",
        response_format="mp3",
    )
    audio, content_type = await OpenAICompatTTSAdapter().synthesize("hi there", config)
    assert audio == b"ID3audio-bytes"
    assert content_type == "audio/mpeg"
    assert captured["url"] == "https://api.openai.com/v1/audio/speech"
    assert captured["json"] == {
        "model": "gpt-4o-mini-tts",
        "input": "hi there",
        "response_format": "mp3",
        "voice": "alloy",
    }
    assert captured["headers"]["Authorization"] == "Bearer sk-test"


@pytest.mark.asyncio
async def test_tts_adapter_azure_uses_api_key_header(monkeypatch: pytest.MonkeyPatch) -> None:
    resp = httpx.Response(200, content=b"x", headers={"content-type": "audio/mpeg"})
    captured = _capture_post(monkeypatch, resp)
    config = TTSConfig(
        model="tts-1",
        base_url="https://r.azure.com/openai/deployments/tts/audio/speech?api-version=2025-04-01",
        api_key="azkey",
        auth_style="api_key_header",
        voice="alloy",
    )
    await OpenAICompatTTSAdapter().synthesize("hello", config)
    assert captured["headers"]["api-key"] == "azkey"
    assert "Authorization" not in captured["headers"]
    # Full /audio/ URL is preserved verbatim.
    assert captured["url"].endswith("api-version=2025-04-01")


@pytest.mark.asyncio
async def test_tts_adapter_raises_on_http_error(monkeypatch: pytest.MonkeyPatch) -> None:
    from knorvia.services.voice.base import VoiceProviderError

    _capture_post(monkeypatch, httpx.Response(401, text="bad key"))
    config = TTSConfig(model="m", base_url="https://x/v1", api_key="k", voice="alloy")
    with pytest.raises(VoiceProviderError, match="401"):
        await OpenAICompatTTSAdapter().synthesize("hi", config)


@pytest.mark.asyncio
async def test_openrouter_tts_falls_back_to_chat_audio_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    post_calls: list[dict[str, Any]] = []

    async def fake_post(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        post_calls.append(
            {
                "url": url,
                "json": kwargs.get("json"),
                "headers": kwargs.get("headers"),
            }
        )
        if len(post_calls) == 1:
            response = httpx.Response(
                500,
                json={"error": {"message": "Internal Server Error"}},
            )
        else:
            chunk = {
                "choices": [
                    {
                        "delta": {
                            "audio": {
                                "data": base64.b64encode(b"pcm-audio").decode("ascii"),
                                "transcript": "hi",
                            }
                        }
                    }
                ]
            }
            response = httpx.Response(
                200,
                text=f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n",
                headers={"content-type": "text/event-stream"},
            )
        response.request = httpx.Request("POST", url)
        return response

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    config = TTSConfig(
        model="openai/gpt-4o-mini-tts",
        provider_name="openrouter",
        base_url="https://openrouter.ai/api/v1",
        api_key="or-key",
        voice="alloy",
        response_format="pcm",
    )

    audio, content_type = await OpenRouterTTSAdapter().synthesize("hello", config)

    assert audio == b"pcm-audio"
    assert content_type == "audio/pcm"
    assert post_calls[0]["url"] == "https://openrouter.ai/api/v1/audio/speech"
    assert post_calls[1]["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert post_calls[1]["json"]["modalities"] == ["text", "audio"]
    assert post_calls[1]["json"]["audio"] == {"voice": "alloy", "format": "pcm16"}
    assert post_calls[1]["headers"]["Authorization"] == "Bearer or-key"


@pytest.mark.asyncio
async def test_openrouter_gemini_tts_openai_voice_gets_clear_hint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from knorvia.services.voice.base import VoiceProviderError

    _capture_post(
        monkeypatch,
        httpx.Response(500, json={"error": {"message": "Internal Server Error"}}),
    )
    config = TTSConfig(
        model="google/gemini-3.1-flash-tts-preview",
        provider_name="openrouter",
        base_url="https://openrouter.ai/api/v1",
        api_key="or-key",
        voice="alloy",
        response_format="pcm",
    )
    with pytest.raises(VoiceProviderError, match="Kore"):
        await OpenRouterTTSAdapter().synthesize("hello", config)


# ── STT adapter ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stt_adapter_multipart(monkeypatch: pytest.MonkeyPatch) -> None:
    resp = httpx.Response(200, json={"text": "hello world"})
    captured = _capture_post(monkeypatch, resp)
    config = STTConfig(model="whisper-1", base_url="https://api.openai.com/v1", api_key="sk")
    text = await OpenAICompatSTTAdapter().transcribe(
        b"RIFFxxxx", config, filename="a.wav", content_type="audio/wav"
    )
    assert text == "hello world"
    assert captured["url"] == "https://api.openai.com/v1/audio/transcriptions"
    assert captured["files"]["file"][0] == "a.wav"
    assert captured["data"]["model"] == "whisper-1"


@pytest.mark.asyncio
async def test_stt_adapter_openrouter_base64(monkeypatch: pytest.MonkeyPatch) -> None:
    resp = httpx.Response(200, json={"text": "from base64"})
    captured = _capture_post(monkeypatch, resp)
    config = STTConfig(
        model="openai/whisper-large-v3",
        base_url="https://openrouter.ai/api/v1",
        api_key="sk",
        request_style="base64_json",
    )
    text = await OpenAICompatSTTAdapter().transcribe(
        b"audiobytes", config, filename="clip.webm", content_type="audio/webm"
    )
    assert text == "from base64"
    assert captured["files"] is None  # not multipart
    assert captured["json"]["model"] == "openai/whisper-large-v3"
    assert captured["json"]["input_audio"]["format"] == "webm"
    assert captured["json"]["input_audio"]["data"]  # base64 string present
    assert "response_format" not in captured["json"]  # plain calls stay plain


@pytest.mark.asyncio
async def test_stt_adapter_verbose_json_returns_normalized_segments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D1: want_segments asks verbose_json and parses segments[{start,end,text}]."""
    resp = httpx.Response(
        200,
        json={
            "text": "hello there",
            "segments": [
                {"start": 0.0, "end": 1.5, "text": " hello "},
                {"start": 1.5, "end": 3.2, "text": "there"},
                {"start": 3.2, "end": 3.1, "text": "inverted"},  # end<=start dropped
                {"start": -2.0, "end": 0.4, "text": "clamped"},  # negative start clamped
                {"start": 5.0, "end": 6.0, "text": "   "},  # blank text dropped
                "junk",  # non-mapping entries dropped
            ],
        },
    )
    captured = _capture_post(monkeypatch, resp)
    config = STTConfig(model="whisper-1", base_url="https://api.openai.com/v1", api_key="sk")
    result = await OpenAICompatSTTAdapter().transcribe(
        b"RIFFxxxx", config, filename="a.wav", want_segments=True
    )
    assert result == "hello there"
    assert result.text == "hello there"
    assert result.segments_supported is True
    assert result.segments == [
        {"start": 0.0, "end": 0.4, "text": "clamped"},
        {"start": 0.0, "end": 1.5, "text": "hello"},
        {"start": 1.5, "end": 3.2, "text": "there"},
    ]
    assert captured["data"]["response_format"] == "verbose_json"


@pytest.mark.asyncio
async def test_stt_adapter_verbose_json_without_text_field_synthesizes_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resp = httpx.Response(
        200,
        json={"segments": [{"start": 0.0, "end": 1.0, "text": "only segments"}]},
    )
    _capture_post(monkeypatch, resp)
    config = STTConfig(model="whisper-1", base_url="https://api.openai.com/v1", api_key="sk")
    result = await OpenAICompatSTTAdapter().transcribe(b"RIFFxxxx", config, want_segments=True)
    assert result == "only segments"
    assert result.segments_supported is True


def _capture_post_sequence(
    monkeypatch: pytest.MonkeyPatch, responses: list[httpx.Response]
) -> list[dict[str, Any]]:
    """Patch ``httpx.AsyncClient.post`` to replay ``responses`` and record calls."""
    calls: list[dict[str, Any]] = []

    async def fake_post(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        calls.append({"url": url, "json": kwargs.get("json"), "data": kwargs.get("data")})
        response = responses[min(len(calls) - 1, len(responses) - 1)]
        response.request = httpx.Request("POST", url)
        return response

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    return calls


@pytest.mark.asyncio
async def test_stt_adapter_verbose_rejected_falls_back_and_remembers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D1 capability probe: verbose_json rejected → one plain retry → cached."""
    calls = _capture_post_sequence(
        monkeypatch,
        [
            httpx.Response(400, json={"error": "response_format not supported"}),
            httpx.Response(200, json={"text": "plain fallback"}),
            httpx.Response(200, json={"text": "plain again"}),
        ],
    )
    adapter = OpenAICompatSTTAdapter()
    config = STTConfig(model="SenseVoice-small", base_url="https://gw.example/v1", api_key="sk")
    result = await adapter.transcribe(b"abc", config, want_segments=True)
    assert result == "plain fallback"
    assert result.segments is None
    assert result.segments_supported is False
    assert calls[0]["data"]["response_format"] == "verbose_json"
    assert calls[1]["data"]["response_format"] == "json"
    # The capability miss is remembered: the next call skips verbose entirely.
    result2 = await adapter.transcribe(b"abc", config, want_segments=True)
    assert result2 == "plain again"
    assert result2.segments_supported is False
    assert len(calls) == 3
    assert calls[2]["data"]["response_format"] == "json"


@pytest.mark.asyncio
async def test_stt_adapter_verbose_without_segments_degrades_to_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 200 answer without a usable segments list is also a capability miss."""
    calls = _capture_post_sequence(
        monkeypatch,
        [
            httpx.Response(200, json={"text": "text only"}),
            httpx.Response(200, json={"text": "text only"}),
        ],
    )
    adapter = OpenAICompatSTTAdapter()
    config = STTConfig(model="whisper-1", base_url="https://gw2.example/v1", api_key="sk")
    result = await adapter.transcribe(b"abc", config, want_segments=True)
    assert result == "text only"
    assert result.segments_supported is False
    assert calls[0]["data"]["response_format"] == "verbose_json"
    assert calls[1]["data"]["response_format"] == "json"


@pytest.mark.asyncio
async def test_transcribe_audio_facade_returns_transcription_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D1: the facade is signature-compatible and wraps results transparently."""
    from knorvia.services.voice import TranscriptionResult

    resp = httpx.Response(
        200,
        json={
            "text": "facade",
            "segments": [{"start": 0.0, "end": 1.0, "text": "facade"}],
        },
    )
    _capture_post(monkeypatch, resp)
    result = await transcribe_audio(
        b"bytes", catalog=_voice_catalog(), filename="x.webm", want_segments=True
    )
    assert isinstance(result, TranscriptionResult)
    assert result == "facade"
    assert result.segments_supported is True
    assert result.segments == [{"start": 0.0, "end": 1.0, "text": "facade"}]
    # Plain callers keep the str contract.
    assert str(result) == "facade"


# ── catalog resolution ────────────────────────────────────────────────────


def _voice_catalog() -> dict[str, Any]:
    return {
        "version": 1,
        "services": {
            "tts": {
                "active_profile_id": "p1",
                "active_model_id": "m1",
                "profiles": [
                    {
                        "id": "p1",
                        "binding": "siliconflow",
                        "base_url": "",
                        "api_key": "sf-key",
                        "models": [
                            {
                                "id": "m1",
                                "model": "FunAudioLLM/CosyVoice2-0.5B",
                                "voice": "FunAudioLLM/CosyVoice2-0.5B:anna",
                                "response_format": "wav",
                            }
                        ],
                    }
                ],
            },
            "stt": {
                "active_profile_id": "p2",
                "active_model_id": "m2",
                "profiles": [
                    {
                        "id": "p2",
                        "binding": "openrouter",
                        "base_url": "",
                        "api_key": "or-key",
                        "models": [{"id": "m2", "model": "openai/whisper-large-v3"}],
                    }
                ],
            },
        },
    }


def test_resolve_tts_config_uses_provider_default_base() -> None:
    cfg = resolve_tts_runtime_config(catalog=_voice_catalog())
    assert cfg.model == "FunAudioLLM/CosyVoice2-0.5B"
    assert cfg.provider_name == "siliconflow"
    assert cfg.base_url == "https://api.siliconflow.cn/v1"  # filled from spec default
    assert cfg.voice == "FunAudioLLM/CosyVoice2-0.5B:anna"
    assert cfg.response_format == "wav"
    assert cfg.api_key == "sf-key"


def test_resolve_stt_config_picks_openrouter_base64_style() -> None:
    cfg = resolve_stt_runtime_config(catalog=_voice_catalog())
    assert cfg.provider_name == "openrouter"
    assert cfg.request_style == "base64_json"
    assert cfg.base_url == "https://openrouter.ai/api/v1"


def test_resolve_tts_config_picks_openrouter_adapter() -> None:
    catalog = _voice_catalog()
    catalog["services"]["tts"]["profiles"][0]["binding"] = "openrouter"
    catalog["services"]["tts"]["profiles"][0]["models"][0]["model"] = (
        "google/gemini-3.1-flash-tts-preview"
    )
    cfg = resolve_tts_runtime_config(catalog=catalog)
    assert cfg.provider_name == "openrouter"
    assert cfg.adapter == "openrouter_tts"


def test_resolve_tts_config_raises_without_model() -> None:
    catalog = {"version": 1, "services": {"tts": {"profiles": []}}}
    with pytest.raises(ValueError, match="No active TTS model"):
        resolve_tts_runtime_config(catalog=catalog)


# ── §Phase D4: voice enumeration ──────────────────────────────────────────


def test_resolve_tts_config_reads_custom_voices() -> None:
    catalog = _voice_catalog()
    model = catalog["services"]["tts"]["profiles"][0]["models"][0]
    model["custom_voices"] = ["CarvedVoice", " slate ", "", "CarvedVoice"]
    cfg = resolve_tts_runtime_config(catalog=catalog)
    assert cfg.custom_voices == ["CarvedVoice", "slate"]
    # The catalog UI may also store a CSV string; it coerces the same way.
    model["custom_voices"] = '["Alex", "Bella"]'
    assert resolve_tts_runtime_config(catalog=catalog).custom_voices == ["Alex", "Bella"]
    model["custom_voices"] = "Alex, Bella"
    assert resolve_tts_runtime_config(catalog=catalog).custom_voices == ["Alex", "Bella"]
    model["custom_voices"] = []
    assert resolve_tts_runtime_config(catalog=catalog).custom_voices == []


def test_openai_compat_list_voices_whitelist_plus_custom_dedupe() -> None:
    """§Phase D4: 11-voice whitelist first, gateway customs appended, active
    voice always selectable — case-insensitive de-dup, stable order."""
    config = TTSConfig(
        model="gpt-4o-mini-tts",
        provider_name="openai",
        voice="autumn",
        custom_voices=["CarvedVoice", " ALLOY ", "", "CarvedVoice"],
    )
    voices = OpenAICompatTTSAdapter().list_voices(config)
    ids = [entry["id"] for entry in voices]
    assert ids[:11] == list(OPENAI_TTS_VOICE_ORDER)
    assert ids[11:] == ["CarvedVoice", "autumn"]  # deduped customs + active voice
    assert all(entry["provider"] == "openai" for entry in voices)
    assert all(set(entry) == {"id", "label", "provider"} for entry in voices)


def test_adapter_list_voices_fallback_without_whitelist() -> None:
    """Adapters without a known whitelist (OpenRouter fronts many vendors)
    surface only the gateway customs plus the active voice."""
    config = TTSConfig(
        model="openai/gpt-4o-mini-tts",
        provider_name="openrouter",
        adapter="openrouter_tts",
        voice="Kore",
        custom_voices=["Kore", "Puck"],
    )
    voices = OpenRouterTTSAdapter().list_voices(config)
    assert [entry["id"] for entry in voices] == ["Kore", "Puck"]  # active already custom


def test_list_voices_facade_shape_and_siliconflow_active_voice() -> None:
    """The §Phase D4 facade answers from config alone; a provider-specific
    active voice (SiliconFlow's "model:speaker") stays selectable."""
    from knorvia.services.voice import list_voices

    payload = list_voices(catalog=_voice_catalog())
    ids = [entry["id"] for entry in payload["voices"]]
    assert "FunAudioLLM/CosyVoice2-0.5B:anna" in ids
    assert payload["active_voice"] == "FunAudioLLM/CosyVoice2-0.5B:anna"
    assert payload["model"] == "FunAudioLLM/CosyVoice2-0.5B"
    assert payload["provider"] == "siliconflow"
    assert len(ids) == len(set(ids))


# ── facade ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_synthesize_speech_facade_strips_markdown(monkeypatch: pytest.MonkeyPatch) -> None:
    resp = httpx.Response(200, content=b"audio", headers={"content-type": "audio/wav"})
    captured = _capture_post(monkeypatch, resp)
    audio, ctype = await synthesize_speech("# Hi\n\n**bold**", catalog=_voice_catalog())
    assert audio == b"audio"
    assert captured["json"]["input"] == "Hi\n\nbold"  # markdown stripped


@pytest.mark.asyncio
async def test_transcribe_audio_facade(monkeypatch: pytest.MonkeyPatch) -> None:
    resp = httpx.Response(200, json={"text": "transcribed"})
    _capture_post(monkeypatch, resp)
    text = await transcribe_audio(b"bytes", catalog=_voice_catalog(), filename="x.webm")
    assert text == "transcribed"
