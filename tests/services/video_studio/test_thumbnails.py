"""§Phase F1: cached thumbnails (service + endpoint)."""

from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path

from fastapi import HTTPException
from PIL import Image
import pytest

from knorvia.api.routers import video_studio as router
from knorvia.services.video_studio import thumbnails
from knorvia.services.video_studio.ffmpeg_tool import FFmpegUnavailableError
from knorvia.services.video_studio.store import VideoStudioStore

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    + b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    + b"\x00\x00\x00\x0aIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n\x2d\xb4"
    + b"\x00\x00\x00\x00IEND\xaeB`\x82"
)
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isomtest-video"
WAV = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00" + b"\x00" * 16


def _upload(store: VideoStudioStore, project_id: str, data: bytes, mime: str, name: str):
    upload = store.create_upload(
        project_id, name, mime, len(data), hashlib.sha256(data).hexdigest()
    )
    store.write_upload_part(upload["id"], 0, data)
    return store.complete_upload(upload["id"])


def _bigger_png(size: int = 640) -> bytes:
    image = Image.new("RGB", (size, size), (200, 30, 30))
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class _FakeTool:
    def __init__(self, *, unavailable: bool = False) -> None:
        self.unavailable = unavailable
        self.frames: list[float] = []

    def ensure(self) -> object:
        if self.unavailable:
            raise FFmpegUnavailableError("no ffmpeg")
        return object()

    async def extract_frame(self, video: Path, timestamp: float, output: Path) -> Path:
        self.frames.append(float(timestamp))
        output.write_bytes(_bigger_png(320))
        return output


def _studio(tmp_path: Path):
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Thumbs")
    return store, project


@pytest.mark.asyncio
async def test_image_thumbnail_writes_jpeg_and_cache_hits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, project = _studio(tmp_path)
    asset = _upload(store, project["id"], _bigger_png(), "image/png", "art.png")
    first = await thumbnails.ensure_asset_thumbnail(store, project["id"], asset["id"])
    assert first.suffix == ".jpg" and first.is_file()
    with Image.open(first) as image:
        assert image.format == "JPEG"
        assert max(image.size) <= thumbnails.THUMB_MAX_EDGE

    # Second call with the same timestamp is a cache hit: identical path.
    second = await thumbnails.ensure_asset_thumbnail(
        store, project["id"], asset["id"], timestamp=0.0
    )
    assert second == first

    # A different timestamp lands on a different cache key.
    other = await thumbnails.ensure_asset_thumbnail(
        store, project["id"], asset["id"], timestamp=1.26
    )
    assert other != first


@pytest.mark.asyncio
async def test_video_thumbnail_extracts_frame_at_timestamp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, project = _studio(tmp_path)
    asset = _upload(store, project["id"], MP4, "video/mp4", "clip.mp4")
    tool = _FakeTool()
    monkeypatch.setattr(thumbnails, "get_ffmpeg_tool", lambda: tool)
    path = await thumbnails.ensure_asset_thumbnail(store, project["id"], asset["id"], timestamp=2.5)
    assert tool.frames == [2.5]
    assert path.is_file()


@pytest.mark.asyncio
async def test_thumbnail_rejects_audio_and_foreign_assets(tmp_path: Path) -> None:
    store, project = _studio(tmp_path)
    audio = _upload(store, project["id"], WAV, "audio/wav", "vo.wav")
    with pytest.raises(thumbnails.ThumbnailError, match="only available"):
        await thumbnails.ensure_asset_thumbnail(store, project["id"], audio["id"])

    other_store = VideoStudioStore(tmp_path / "other")
    other_project = other_store.create_project("Other")
    foreign = _upload(other_store, other_project["id"], PNG, "image/png", "far.png")
    with pytest.raises(thumbnails.ThumbnailError, match="belong"):
        await thumbnails.ensure_asset_thumbnail(store, project["id"], foreign["id"])


@pytest.mark.asyncio
async def test_thumbnail_endpoint_routes_and_maps_ffmpeg_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, project = _studio(tmp_path)
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)
    image = _upload(store, project["id"], _bigger_png(), "image/png", "pic.png")
    video = _upload(store, project["id"], MP4, "video/mp4", "v.mp4")
    audio = _upload(store, project["id"], WAV, "audio/wav", "a.wav")

    response = await router.asset_thumbnail(image["id"], t=0.0)
    assert response.media_type == "image/jpeg"
    assert Path(response.path).is_file()

    tool = _FakeTool()
    monkeypatch.setattr(router, "get_ffmpeg_tool", lambda: tool)
    monkeypatch.setattr(thumbnails, "get_ffmpeg_tool", lambda: tool)
    video_response = await router.asset_thumbnail(video["id"], t=3.0)
    assert video_response.media_type == "image/jpeg"
    assert tool.frames == [3.0]

    with pytest.raises(HTTPException) as exc_info:
        await router.asset_thumbnail("ghost", t=0.0)
    assert exc_info.value.status_code == 404

    with pytest.raises(HTTPException) as exc_info:
        await router.asset_thumbnail(audio["id"], t=0.0)
    assert exc_info.value.status_code == 422

    broken = _FakeTool(unavailable=True)
    monkeypatch.setattr(router, "get_ffmpeg_tool", lambda: broken)
    monkeypatch.setattr(thumbnails, "get_ffmpeg_tool", lambda: broken)
    with pytest.raises(HTTPException) as exc_info:
        await router.asset_thumbnail(video["id"], t=0.0)
    assert exc_info.value.status_code == 409

    with pytest.raises(HTTPException) as exc_info:
        await router.asset_thumbnail(image["id"], t=-1.0)
    assert exc_info.value.status_code == 422
