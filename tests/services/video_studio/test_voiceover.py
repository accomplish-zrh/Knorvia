from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from fastapi import HTTPException
import pytest

from knorvia.api.routers import video_studio as router
from knorvia.services.video_studio import composition, service
from knorvia.services.video_studio.store import VideoStudioStore

MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isomtest-video"
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 64
WAV_BYTES = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00" + b"\x00" * 16


def _upload(store: VideoStudioStore, project_id: str, data: bytes, mime: str, name: str):
    upload = store.create_upload(
        project_id, name, mime, len(data), hashlib.sha256(data).hexdigest()
    )
    store.write_upload_part(upload["id"], 0, data)
    return store.complete_upload(upload["id"])


def _studio(tmp_path: Path, shots: list[dict[str, Any]] | None = None):
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Voice")
    document = store.save_storyboard(
        project["id"],
        {"shots": shots or [{"id": "shot-1", "order": 0, "title": "Opening", "prompt": "a lake"}]},
        expected_revision=0,
    )
    return store, project, document


@pytest.mark.asyncio
async def test_voiceover_requires_cost_confirmation(tmp_path: Path) -> None:
    store, project, _ = _studio(tmp_path)
    with pytest.raises(PermissionError, match="cost confirmation"):
        await service.create_shot_voiceover(
            store, project_id=project["id"], shot_id="shot-1", text="台词"
        )


@pytest.mark.asyncio
async def test_voiceover_synthesizes_and_binds_audio_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services import voice

    store, project, _ = _studio(tmp_path)
    captured: dict[str, Any] = {}

    async def fake_synthesize(text, *, voice=None, response_format=None):
        captured["text"] = text
        captured["voice"] = voice
        captured["format"] = response_format
        return MP3, "audio/mpeg"

    monkeypatch.setattr(voice, "synthesize_speech", fake_synthesize)
    monkeypatch.setattr(service, "_probe_audio_duration", _fake_probe(3.25))
    result = await service.create_shot_voiceover(
        store,
        project_id=project["id"],
        shot_id="shot-1",
        text="  夜色渐深。  ",
        voice="alloy",
        confirmed_cost=True,
    )
    assert captured["text"] == "夜色渐深。"
    assert captured["voice"] == "alloy"
    asset = result["asset"]
    assert asset["kind"] == "audio" and asset["origin"] == "generated"
    assert asset["duration"] == 3.25
    shot = next(shot for shot in result["storyboard"]["shots"] if shot["id"] == "shot-1")
    assert shot["voiceover_text"] == "夜色渐深。"
    assert shot["voiceover_asset_id"] == asset["id"]
    assert shot["voiceover_voice"] == "alloy"
    assert store.get_asset(asset["id"])["mime_type"] == "audio/mpeg"


@pytest.mark.asyncio
async def test_voiceover_falls_back_to_mp3_and_rejects_bad_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services import voice

    store, project, _ = _studio(tmp_path)

    async def fake_synthesize(text, *, voice=None, response_format=None):
        assert response_format == "mp3"
        return MP3, "audio/mpeg"

    monkeypatch.setattr(voice, "synthesize_speech", fake_synthesize)
    monkeypatch.setattr(service, "_probe_audio_duration", _fake_probe(None))
    result = await service.create_shot_voiceover(
        store,
        project_id=project["id"],
        shot_id="shot-1",
        text="一段旁白",
        response_format="ogg",
        confirmed_cost=True,
    )
    assert result["asset"]["duration"] is None
    with pytest.raises(ValueError, match="voiceover text"):
        await service.create_shot_voiceover(
            store, project_id=project["id"], shot_id="shot-1", text="  ", confirmed_cost=True
        )
    with pytest.raises(ValueError, match="Storyboard shot not found"):
        await service.create_shot_voiceover(
            store, project_id=project["id"], shot_id="ghost", text="x", confirmed_cost=True
        )


@pytest.mark.asyncio
async def test_keyframe_generates_image_and_binds_to_shot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.image_studio import agent as image_agent
    from knorvia.services.image_studio import store as image_store_module

    store, project, _ = _studio(
        tmp_path, [{"id": "shot-1", "order": 0, "title": "Opening", "prompt": "a quiet lake"}]
    )
    png_path = tmp_path / "frame.png"
    png_path.write_bytes(_png_bytes())
    image_asset = {"id": "img_asset_1", "mime_type": "image/png"}
    returned: list[dict[str, Any]] = []

    def fake_plan(**kwargs):
        plan = {"parameters": dict(kwargs), "prompt": kwargs.get("prompt")}
        returned.append(plan)
        return plan

    async def fake_run(plan):
        plan["job"] = {
            "id": "img_job_1",
            "status": "succeeded",
            "outputs": [{"asset_id": "img_asset_1"}],
        }
        return plan

    class _FakeImageStore:
        def get_asset(self, asset_id):
            return image_asset if asset_id == "img_asset_1" else None

        def asset_path(self, asset_id):
            return png_path

    monkeypatch.setattr(image_agent, "plan_studio_job", fake_plan)
    monkeypatch.setattr(image_agent, "run_studio_image_job", fake_run)
    monkeypatch.setattr(image_store_module, "get_image_studio_store", lambda: _FakeImageStore())

    result = await service.create_shot_keyframe(
        store,
        project_id=project["id"],
        shot_id="shot-1",
        prompt="",
        confirmed_cost=True,
    )
    assert returned[0]["prompt"] == "a quiet lake"  # falls back to the shot prompt
    assert returned[0]["parameters"]["n"] == 1
    assert "target_resolution" not in returned[0]["parameters"]
    asset = result["asset"]
    assert asset["kind"] == "image" and asset["origin"] == "uploaded"
    shot = next(shot for shot in result["storyboard"]["shots"] if shot["id"] == "shot-1")
    assert shot["keyframe_asset_id"] == asset["id"]

    with pytest.raises(PermissionError, match="cost confirmation"):
        await service.create_shot_keyframe(
            store, project_id=project["id"], shot_id="shot-1", prompt="x"
        )


@pytest.mark.asyncio
async def test_voiceover_endpoint_routes_and_maps_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services import voice

    store, project, _ = _studio(tmp_path)
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)

    async def fake_synthesize(text, *, voice=None, response_format=None):
        return WAV_BYTES, "audio/wav"

    monkeypatch.setattr(voice, "synthesize_speech", fake_synthesize)
    monkeypatch.setattr(service, "_probe_audio_duration", _fake_probe(2.0))

    payload = router.ShotVoiceoverCreate(text="第一句", voice="nova", confirmed_cost=True)
    response = await router.create_shot_voiceover_endpoint(project["id"], "shot-1", payload)
    assert response["asset"]["kind"] == "audio"

    denied = router.ShotVoiceoverCreate(text="第二句")
    with pytest.raises(HTTPException) as exc_info:
        await router.create_shot_voiceover_endpoint(project["id"], "shot-1", denied)
    assert exc_info.value.status_code == 409

    missing = router.ShotVoiceoverCreate(text="x", confirmed_cost=True)
    with pytest.raises(HTTPException) as exc_info:
        await router.create_shot_voiceover_endpoint(project["id"], "ghost", missing)
    assert exc_info.value.status_code == 422


@pytest.mark.asyncio
async def test_keyframe_endpoint_calls_service(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, project, _ = _studio(tmp_path)
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)
    calls: list[dict[str, Any]] = []

    async def fake_keyframe(_store, **kwargs):
        calls.append(kwargs)
        return {"asset": {"id": "a1", "kind": "image"}}

    monkeypatch.setattr(router, "create_shot_keyframe", fake_keyframe)
    payload = router.ShotKeyframeCreate(confirmed_cost=True)
    response = await router.create_shot_keyframe_endpoint(project["id"], "shot-1", payload)
    assert response == {"asset": {"id": "a1", "kind": "image"}}
    assert calls[0]["confirmed_cost"] is True


@pytest.mark.asyncio
async def test_compose_endpoint_validates_ffmpeg_and_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio.ffmpeg_tool import FFmpegUnavailableError

    store, project, _ = _studio(
        tmp_path, [{"id": "shot-1", "order": 0, "title": "Opening", "prompt": "a lake"}]
    )
    clip = _upload(store, project["id"], MP4, "video/mp4", "clip.mp4")
    store.save_storyboard(
        project["id"],
        {
            "shots": [
                {
                    "id": "shot-1",
                    "order": 0,
                    "title": "Opening",
                    "prompt": "a lake",
                    "output_asset_id": clip["id"],
                }
            ]
        },
        expected_revision=1,
    )
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)
    monkeypatch.setattr(composition, "start_video_job", lambda *_: None)

    class _NoFfmpeg:
        def ensure(self):
            raise FFmpegUnavailableError("missing")

    monkeypatch.setattr(router, "get_ffmpeg_tool", lambda: _NoFfmpeg())
    payload = router.ComposeCreate(client_request_id="compose-a")
    with pytest.raises(HTTPException) as exc_info:
        await router.compose_project_endpoint(project["id"], payload)
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "ffmpeg_unavailable"

    class _OkFfmpeg:
        def ensure(self):
            return object()

    monkeypatch.setattr(router, "get_ffmpeg_tool", lambda: _OkFfmpeg())
    response = await router.compose_project_endpoint(project["id"], payload)
    assert response["operation"] == "compose"
    assert response["status"] == "queued"

    # The queued job shows up in the compositions listing once finished.
    store.transition_terminal(response["id"], "cancelled")
    listing = await router.list_project_compositions(project["id"])
    assert [entry["id"] for entry in listing["compositions"]] == [response["id"]]


@pytest.mark.asyncio
async def test_compose_endpoint_rejects_unready_storyboard(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, project, _ = _studio(
        tmp_path, [{"id": "shot-1", "order": 0, "title": "Opening", "prompt": "a lake"}]
    )
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)

    class _OkFfmpeg:
        def ensure(self):
            return object()

    monkeypatch.setattr(router, "get_ffmpeg_tool", lambda: _OkFfmpeg())
    payload = router.ComposeCreate(client_request_id="compose-b")
    with pytest.raises(HTTPException) as exc_info:
        await router.compose_project_endpoint(project["id"], payload)
    assert exc_info.value.status_code == 422
    assert "no generated video or keyframe" in str(exc_info.value.detail)


def _fake_probe(value: float | None):
    async def probe(_store, _data):
        return value

    return probe


def _png_bytes() -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        + b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
        + b"\x00\x00\x00\x0aIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n\x2d\xb4"
        + b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )
