"""Agent-invokable library conversion (flyingmouse-inspired toolbox)."""

from __future__ import annotations

import io

import pytest

from knorvia.tools.library_tool import LibraryTool, _normalize_target


def _png_bytes(color=(200, 30, 30)) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGBA", (24, 24), (*color, 255)).save(buffer, format="PNG")
    return buffer.getvalue()


def _seed_media_entry(store, monkeypatch, data: bytes, mime: str, entry_id: str) -> None:
    """create_media_asset with a stubbed id so tests know the entry id."""
    original = store.create_media_asset

    def seeded(data_in, mime_in, **kwargs):
        created = original(data_in, mime_in, **kwargs)
        created["id"] = entry_id
        # Re-key the stored bytes by faking a rename is overkill; the store
        # keys assets by the generated id, so instead re-create honestly and
        # just read back the real id for assertions in callers.
        return created

    monkeypatch.setattr(store, "create_media_asset", seeded)
    _ = data, mime


class TestTargets:
    def test_normalize_accepts_shorthand_and_mime(self):
        assert _normalize_target("png") == "image/png"
        assert _normalize_target(".jpg") == "image/jpeg"
        assert _normalize_target("image/webp") == "image/webp"
        assert _normalize_target("txt") == "text/plain"

    def test_targets_for_image_excludes_self(self):
        from knorvia.services.converters.service import targets_for

        targets = {t["mime"] for t in targets_for("image/png")}
        assert targets == {"image/jpeg", "image/webp"}

    def test_audio_targets_require_ffmpeg(self, monkeypatch):
        from knorvia.services.converters import service

        monkeypatch.setattr(service.engines, "ffmpeg_available", lambda: False)
        assert service.targets_for("audio/mpeg") == []


class TestLibraryConvertTool:
    @pytest.mark.asyncio
    async def test_convert_png_to_jpg_creates_new_entry(self, tmp_path, monkeypatch):
        from knorvia.services.creative_library.store import get_creative_library_store

        store = get_creative_library_store()
        created = store.create_media_asset(_png_bytes(), "image/png", title="red dot")
        tool = LibraryTool()

        result = await tool.execute(convert_id=created["id"], target="jpg")

        assert result.success is True
        assert "new library entry" in result.content
        new_id = result.metadata["library_entry_id"]
        assert new_id != created["id"]
        new_asset = store.get_asset(new_id)
        assert new_asset["mime"] == "image/jpeg"
        # The JPG is a real image and has no alpha (flattened onto white).
        from PIL import Image

        payload, mime = store.asset_bytes(new_id)
        assert mime == "image/jpeg"
        image = Image.open(io.BytesIO(payload))
        assert image.mode == "RGB"

    @pytest.mark.asyncio
    async def test_querying_targets_without_target_lists_them(self, tmp_path):
        from knorvia.services.creative_library.store import get_creative_library_store

        store = get_creative_library_store()
        created = store.create_media_asset(_png_bytes(), "image/png", title="dot")
        tool = LibraryTool()

        result = await tool.execute(convert_id=created["id"])

        assert result.success is True
        assert "jpg" in result.content and "webp" in result.content

    @pytest.mark.asyncio
    async def test_invalid_target_self_corrects(self, tmp_path):
        from knorvia.services.creative_library.store import get_creative_library_store

        store = get_creative_library_store()
        created = store.create_media_asset(_png_bytes(), "image/png", title="dot")
        tool = LibraryTool()

        result = await tool.execute(convert_id=created["id"], target="mp3")
        assert result.success is False
        assert "jpg" in result.content  # the agent learns the valid targets

    @pytest.mark.asyncio
    async def test_pdf_entry_converts_to_text(self, tmp_path):
        import pymupdf

        from knorvia.services.creative_library.store import get_creative_library_store

        pdf_buffer = io.BytesIO()
        with pymupdf.open() as pdf:
            page = pdf.new_page()
            page.insert_text((72, 72), "Recursive functions need a base case.")
            pdf_buffer.write(pdf.tobytes())
        store = get_creative_library_store()
        created = store.upload_entry(
            pdf_buffer.getvalue(), "recursion notes.pdf", "application/pdf"
        )
        tool = LibraryTool()

        result = await tool.execute(convert_id=created["id"], target="txt")
        assert result.success is True
        new_id = result.metadata["library_entry_id"]
        entry = store.get_entry(new_id)
        assert entry["kind"] == "text"
        assert "base case" in (entry.get("content") or "")


class TestFfmpegMedia:
    @pytest.mark.asyncio
    async def test_wav_to_mp3_via_real_ffmpeg(self):
        """Live conversion through the machine's FFmpeg (skipped when absent)."""
        import shutil
        import wave

        from knorvia.services.converters.service import convert_media
        from knorvia.services.creative_library.store import get_creative_library_store

        if not shutil.which("ffmpeg"):
            pytest.skip("ffmpeg not on PATH")
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(8000)
            wav.writeframes(b"\x00\x01" * 8000)  # 1s of near-silence
        data = buffer.getvalue()
        converted, target = convert_media(data, "audio/wav", "audio/mpeg")
        assert target == "audio/mpeg"
        assert converted[:3] == b"ID3" or converted[:2] in {b"\xff\xfb", b"\xff\xf3"}
