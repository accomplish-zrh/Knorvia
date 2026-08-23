"""Experimental 720p → 1080p frame-by-frame upscale (Phase E5).

Video super-resolution is a local, offline pre-step for composition. It is
intentionally slow: every frame is sent through the same Real-ESRGAN engine
the Image Studio already ships, then ffmpeg stitches the frames back. The
compose panel labels the switch experimental; 4K stays a gateway capability.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Awaitable, Callable

from .ffmpeg_tool import FFmpegFailedError

logger = logging.getLogger(__name__)

UPSCALE_TARGET_EDGE = 1080
UPSCALE_TARGET_SIZE = (1920, 1080)


class UpscaleError(ValueError):
    """Raised when the experimental upscale pre-step cannot run."""


UpscaleImage = Callable[[bytes], Awaitable[bytes]]


async def _default_upscale_image(content: bytes) -> bytes:
    """Real-ESRGAN when installed; identity otherwise (tests inject a fake)."""
    try:
        from knorvia.services.image_studio.ncnn_upscaler import get_ncnn_upscaler
    except Exception as exc:  # pragma: no cover - optional engine
        raise UpscaleError("Experimental video upscale needs the local Real-ESRGAN engine") from exc
    engine = get_ncnn_upscaler()
    try:
        result, _mime, _meta = await engine.upscale(
            content, "image/png", UPSCALE_TARGET_EDGE, timeout=180
        )
    except Exception as exc:
        raise UpscaleError(f"Experimental video upscale failed: {exc}") from exc
    return result


async def upscale_clip_to_1080p(
    tool: Any,
    source: Path,
    dest: Path,
    *,
    upscale_image: UpscaleImage | None = None,
    on_progress: Callable[[float], None] | None = None,
    fps: float = 30.0,
) -> Path:
    """Extract frames, upscale each, reassemble at 1080p.

    ``upscale_image`` is injected by tests (a fake that returns larger PNG
    bytes). Production uses Real-ESRGAN when the engine is installed.
    """
    runner = upscale_image or _default_upscale_image
    workspace = dest.parent / f"{dest.stem}_frames"
    workspace.mkdir(parents=True, exist_ok=True)
    try:
        frames = await tool.extract_frames(source, workspace, fps=fps)
        if not frames:
            raise UpscaleError("Experimental upscale produced no frames")
        for index, frame in enumerate(frames):
            if on_progress is not None:
                on_progress(index / max(1, len(frames)))
            scaled = await runner(frame.read_bytes())
            frame.write_bytes(scaled)
        await tool.assemble_frames(
            workspace,
            dest,
            fps=fps,
            audio_from=source,
            size=UPSCALE_TARGET_SIZE,
        )
        if not dest.is_file() or dest.stat().st_size == 0:
            raise FFmpegFailedError("Experimental upscale produced no output")
        if on_progress is not None:
            on_progress(1.0)
        return dest
    finally:
        for leftover in workspace.glob("*"):
            leftover.unlink(missing_ok=True)
        try:
            workspace.rmdir()
        except OSError:
            logger.debug("Deferred cleanup of upscale workspace %s", workspace)


__all__ = [
    "UPSCALE_TARGET_EDGE",
    "UPSCALE_TARGET_SIZE",
    "UpscaleError",
    "upscale_clip_to_1080p",
]
