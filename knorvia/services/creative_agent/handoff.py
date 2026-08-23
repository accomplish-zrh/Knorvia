"""Copy a library asset into Image Studio or Video Studio."""

from __future__ import annotations

from typing import Any

from knorvia.services.creative_library.store import CreativeLibraryStore
from knorvia.services.image_studio.agent import import_image_bytes
from knorvia.services.image_studio.store import ImageStudioStore
from knorvia.services.video_studio.store import VideoStudioStore


def _resolve_library_media(
    library: CreativeLibraryStore, item_id: str
) -> tuple[str, str, bytes, str]:
    """Return (kind, title, data, mime) for a tree entry or a legacy asset."""
    entry = library.get_entry(item_id)
    if entry:
        payload = library.entry_bytes(item_id)
        if payload:
            return (
                str(entry.get("kind") or ""),
                str(entry.get("title") or "library"),
                payload[0],
                payload[1],
            )
    asset = library.get_asset(item_id)
    payload = library.asset_bytes(item_id)
    if asset and payload:
        return (
            str(asset.get("kind") or ""),
            str(asset.get("title") or "library"),
            payload[0],
            payload[1],
        )
    raise ValueError("Library asset not found")


def import_library_asset_to_image(
    library: CreativeLibraryStore,
    studio: ImageStudioStore,
    project_id: str,
    asset_id: str,
) -> dict[str, Any]:
    kind, _title, data, mime = _resolve_library_media(library, asset_id)
    if kind != "image":
        raise ValueError("Only image library assets can enter Image Studio")
    return import_image_bytes(studio, project_id, data, mime, kind="input")


def import_library_asset_to_video(
    library: CreativeLibraryStore,
    studio: VideoStudioStore,
    project_id: str,
    asset_id: str,
) -> dict[str, Any]:
    kind, title, data, mime = _resolve_library_media(library, asset_id)
    if kind not in {"image", "video"}:
        raise ValueError("Only image or video library assets can enter Video Studio")
    suffix = (mime.split("/", 1)[-1] if mime else "bin") or "bin"
    filename = f"{title or 'library'}.{suffix}"
    return studio.import_asset_bytes(project_id, data, mime, filename)
