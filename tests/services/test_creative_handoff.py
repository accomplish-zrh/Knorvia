from __future__ import annotations

from io import BytesIO

from PIL import Image

from knorvia.services.creative_agent.handoff import (
    import_library_asset_to_image,
    import_library_asset_to_video,
)
from knorvia.services.creative_library.store import CreativeLibraryStore
from knorvia.services.image_studio.store import ImageStudioStore
from knorvia.services.video_studio.store import VideoStudioStore


def _png() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (8, 8), (12, 80, 160)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_handoff_imports_library_tree_entry(tmp_path) -> None:
    library = CreativeLibraryStore(tmp_path / "library")
    images = ImageStudioStore(tmp_path / "images")
    videos = VideoStudioStore(tmp_path / "videos")
    entry = library.upload_entry(_png(), "hero.png", "image/png", title="Hero")
    assert entry["kind"] == "image"
    image_project = images.create_project("Still")
    video_project = videos.create_project("Motion")
    imported_image = import_library_asset_to_image(
        library, images, image_project["id"], entry["id"]
    )
    imported_video = import_library_asset_to_video(
        library, videos, video_project["id"], entry["id"]
    )
    assert imported_image["kind"] in {"input", "image"} or imported_image.get("id")
    assert imported_video.get("id")
    assert imported_image["id"] != entry["id"]
