"""Voice router tests — /tts, /stt, and §Phase D4 /voices + /preview contracts."""

from __future__ import annotations

import io
from typing import Any
import wave

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest

from knorvia.api.routers import voice as voice_router
from knorvia.services.voice import PREVIEW_SAMPLE_TEXT, VoiceProviderError


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    app.include_router(voice_router.router, prefix="/api/v1/voice")
    return TestClient(app)


def test_tts_returns_audio_bytes(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    async def fake_synth(text: str, *, voice=None, response_format=None, **_: Any):
        captured["text"] = text
        captured["voice"] = voice
        captured["format"] = response_format
        return b"audio-bytes", "audio/mpeg"

    monkeypatch.setattr(voice_router, "synthesize_speech", fake_synth)
    resp = client.post("/api/v1/voice/tts", json={"text": "hello", "voice": "nova"})
    assert resp.status_code == 200
    assert resp.content == b"audio-bytes"
    assert resp.headers["content-type"] == "audio/mpeg"
    assert captured == {"text": "hello", "voice": "nova", "format": None}


def test_tts_wraps_pcm_bytes_as_browser_playable_wav(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pcm = b"\x00\x00\x01\x00" * 12

    async def fake_synth(text: str, *, voice=None, response_format=None, **_: Any):
        return pcm, "audio/pcm;rate=24000;channels=1"

    monkeypatch.setattr(voice_router, "synthesize_speech", fake_synth)
    resp = client.post("/api/v1/voice/tts", json={"text": "hello"})

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"
    assert resp.content.startswith(b"RIFF")
    with wave.open(io.BytesIO(resp.content), "rb") as wav:
        assert wav.getframerate() == 24000
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.readframes(wav.getnframes()) == pcm


def test_tts_rejects_empty_text(client: TestClient) -> None:
    resp = client.post("/api/v1/voice/tts", json={"text": ""})
    assert resp.status_code == 422  # pydantic min_length


def test_tts_provider_error_is_502(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(*_: Any, **__: Any):
        raise VoiceProviderError("upstream down")

    monkeypatch.setattr(voice_router, "synthesize_speech", boom)
    resp = client.post("/api/v1/voice/tts", json={"text": "hi"})
    assert resp.status_code == 502
    assert "upstream down" in resp.json()["detail"]


def test_tts_missing_config_is_400(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_config(*_: Any, **__: Any):
        raise ValueError("No active TTS model is configured.")

    monkeypatch.setattr(voice_router, "synthesize_speech", no_config)
    resp = client.post("/api/v1/voice/tts", json={"text": "hi"})
    assert resp.status_code == 400


def test_stt_returns_text(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    async def fake_transcribe(audio: bytes, *, filename: str, content_type: str, language=None):
        captured["bytes"] = len(audio)
        captured["filename"] = filename
        return "hello world"

    monkeypatch.setattr(voice_router, "transcribe_audio", fake_transcribe)
    resp = client.post(
        "/api/v1/voice/stt",
        files={"file": ("clip.webm", b"audiobytes", "audio/webm")},
    )
    assert resp.status_code == 200
    assert resp.json() == {"text": "hello world"}
    assert captured["filename"] == "clip.webm"
    assert captured["bytes"] == 10


def test_stt_rejects_empty_upload(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/voice/stt",
        files={"file": ("empty.webm", b"", "audio/webm")},
    )
    assert resp.status_code == 400


# ── §Phase D4: voice enumeration + audition ───────────────────────────────


def test_voices_route_passes_enumeration_through(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    canned = {
        "voices": [
            {"id": "alloy", "label": "alloy", "provider": "openai"},
            {"id": "CarvedVoice", "label": "CarvedVoice", "provider": "openai"},
        ],
        "active_voice": "alloy",
        "model": "gpt-4o-mini-tts",
        "provider": "openai",
    }
    monkeypatch.setattr(voice_router, "list_voices", lambda: canned)
    resp = client.get("/api/v1/voice/voices")
    assert resp.status_code == 200
    assert resp.json() == canned


def test_voices_route_reports_missing_config_as_400(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def no_config() -> Any:
        raise ValueError("No active TTS model is configured.")

    monkeypatch.setattr(voice_router, "list_voices", no_config)
    resp = client.get("/api/v1/voice/voices")
    assert resp.status_code == 400
    assert "No active TTS model" in resp.json()["detail"]


def test_preview_requires_cost_confirmation_before_any_provider_call(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[dict[str, Any]] = []

    async def fake_synth(text: str, *, voice=None, response_format=None, **_: Any):
        calls.append({"text": text, "voice": voice})
        return b"audio-bytes", "audio/mpeg"

    monkeypatch.setattr(voice_router, "synthesize_speech", fake_synth)
    resp = client.post("/api/v1/voice/preview", json={"voice": "nova"})
    assert resp.status_code == 409
    assert "cost confirmation" in resp.json()["detail"]
    assert calls == []  # rejected before any provider lookup


def test_preview_synthesizes_fixed_sample_once_confirmed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}

    async def fake_synth(text: str, *, voice=None, response_format=None, **_: Any):
        captured["text"] = text
        captured["voice"] = voice
        return b"preview-bytes", "audio/mpeg"

    monkeypatch.setattr(voice_router, "synthesize_speech", fake_synth)
    resp = client.post("/api/v1/voice/preview", json={"voice": "nova", "confirmed_cost": True})
    assert resp.status_code == 200
    assert resp.content == b"preview-bytes"
    assert resp.headers["content-type"] == "audio/mpeg"
    assert "no-store" not in resp.headers.get("cache-control", "")
    assert captured == {"text": PREVIEW_SAMPLE_TEXT, "voice": "nova"}


def test_preview_rejects_blank_voice(client: TestClient) -> None:
    resp = client.post("/api/v1/voice/preview", json={"voice": "", "confirmed_cost": True})
    assert resp.status_code == 422  # pydantic min_length


def test_preview_wraps_pcm_and_maps_provider_errors(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    pcm = b"\x00\x00\x01\x00" * 12

    async def pcm_synth(text: str, *, voice=None, **_: Any):
        return pcm, "audio/pcm;rate=24000;channels=1"

    monkeypatch.setattr(voice_router, "synthesize_speech", pcm_synth)
    resp = client.post("/api/v1/voice/preview", json={"voice": "onyx", "confirmed_cost": True})
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"
    assert resp.content.startswith(b"RIFF")

    async def boom(*_: Any, **__: Any):
        raise VoiceProviderError("upstream down")

    monkeypatch.setattr(voice_router, "synthesize_speech", boom)
    resp = client.post("/api/v1/voice/preview", json={"voice": "onyx", "confirmed_cost": True})
    assert resp.status_code == 502
    assert "upstream down" in resp.json()["detail"]


def test_voices_enumeration_makes_zero_provider_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The full GET /voices path (route → facade → resolve → adapter) must be
    configuration-only: any httpx POST attempt fails the test."""

    async def no_network(self: httpx.AsyncClient, url: str, **kwargs: Any):
        raise AssertionError(f"enumeration must not call the provider: {url}")

    monkeypatch.setattr(httpx.AsyncClient, "post", no_network)
    catalog = {
        "version": 1,
        "services": {
            "tts": {
                "active_profile_id": "p1",
                "active_model_id": "m1",
                "profiles": [
                    {
                        "id": "p1",
                        "binding": "openai",
                        "base_url": "",
                        "api_key": "sk-test",
                        "models": [
                            {
                                "id": "m1",
                                "model": "gpt-4o-mini-tts",
                                "voice": "alloy",
                                "custom_voices": ["CarvedVoice"],
                            }
                        ],
                    }
                ],
            }
        },
    }
    from knorvia.services.voice import list_voices

    payload = list_voices(catalog=catalog)
    ids = [entry["id"] for entry in payload["voices"]]
    assert "alloy" in ids and "CarvedVoice" in ids and len(ids) == 12
    assert payload["active_voice"] == "alloy"
    assert payload["model"] == "gpt-4o-mini-tts"
