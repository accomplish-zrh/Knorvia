"""Cached ffmpeg/PIL thumbnails for the shot-level timeline (Phase F1)."""

from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image

from .ffmpeg_tool import FFmpegFailedError, FFmpegUnavailableError, get_ffmpeg_tool

THUMB_MAX_EDGE = 320
THUMB_CACHE_LIMIT = 200
THUMB_QUALITY = 82


class ThumbnailError(ValueError):
    """Raised when a thumbnail cannot be produced."""


def _quantize_timestamp(seconds: float) -> str:
    value = max(0.0, float(seconds))
    return f"{int(round(value * 10)):06d}"


def thumbnail_cache_dir(store: Any, project_id: str) -> Path:
    path = (store.projects_root / project_id / "thumbs").resolve()
    if path.parent.parent != store.projects_root:
        raise ThumbnailError("Unsafe thumbnail cache path")
    path.mkdir(parents=True, exist_ok=True)
    return path


def thumbnail_cache_path(store: Any, project_id: str, asset_id: str, timestamp: float) -> Path:
    stamp = _quantize_timestamp(timestamp)
    digest = hashlib.sha256(f"{asset_id}:{stamp}".encode("utf-8")).hexdigest()[:20]
    return thumbnail_cache_dir(store, project_id) / f"{digest}.jpg"


def _prune_cache(folder: Path) -> None:
    files = sorted(
        (path for path in folder.glob("*.jpg") if path.is_file()),
        key=lambda item: item.stat().st_mtime,
    )
    overflow = len(files) - THUMB_CACHE_LIMIT
    for path in files[: max(0, overflow)]:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            continue


def _write_jpeg(source: Path | bytes, dest: Path) -> Path:
    if isinstance(source, Path):
        with Image.open(source) as image:
            image = image.convert("RGB")
            image.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE))
            dest.parent.mkdir(parents=True, exist_ok=True)
            image.save(dest, format="JPEG", quality=THUMB_QUALITY, optimize=True)
        return dest
    with Image.open(BytesIO(source)) as image:
        image = image.convert("RGB")
        image.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE))
        dest.parent.mkdir(parents=True, exist_ok=True)
        image.save(dest, format="JPEG", quality=THUMB_QUALITY, optimize=True)
    return dest


async def ensure_asset_thumbnail(
    store: Any,
    project_id: str,
    asset_id: str,
    *,
    timestamp: float = 0.0,
) -> Path:
    """Return a cached JPEG for ``asset_id`` at ``timestamp`` (videos only)."""
    asset = store.get_asset(asset_id)
    if not asset or asset["project_id"] != project_id:
        raise ThumbnailError("The asset must belong to this project")
    dest = thumbnail_cache_path(store, project_id, asset_id, timestamp)
    if dest.is_file() and dest.stat().st_size > 0:
        return dest
    source = store.asset_path(asset_id)
    kind = str(asset.get("kind") or "")
    if kind == "image":
        _write_jpeg(source, dest)
    elif kind == "video":
        tool = get_ffmpeg_tool()
        tool.ensure()
        tmp = dest.with_suffix(".src.jpg")
        try:
            await tool.extract_frame(source, max(0.0, float(timestamp)), tmp)
            _write_jpeg(tmp, dest)
        except (FFmpegFailedError, FFmpegUnavailableError) as exc:
            raise ThumbnailError(str(exc)) from exc
        finally:
            tmp.unlink(missing_ok=True)
    else:
        raise ThumbnailError("Thumbnails are only available for image and video assets")
    _prune_cache(dest.parent)
    return dest


__all__ = [
    "THUMB_CACHE_LIMIT",
    "ThumbnailError",
    "ensure_asset_thumbnail",
    "thumbnail_cache_path",
]
