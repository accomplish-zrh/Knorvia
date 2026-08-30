"""Library conversion service — capability discovery + offline convert.

The targets-per-source-model and the quality-aware FFmpeg probing are
inspired by the flyingmouse-format tool (non-commercial license — ideas
only, no code reused). Conversions run fully offline: Pillow for images,
PyMuPDF for PDFs, FFmpeg (resolved on the machine) for audio/video.
"""

from __future__ import annotations

import io
import logging
import subprocess
from typing import Any

from knorvia.services.converters import engines

logger = logging.getLogger(__name__)

#: Library-storable output mimes (must match the creative library's sets).
IMAGE_TARGETS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
AUDIO_TARGETS = {
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
}
VIDEO_TARGETS = {"video/mp4": ".mp4", "video/webm": ".webm"}

_CONVERT_TIMEOUT_S = 300


def targets_for(mime: str) -> list[dict[str, str]]:
    """Capability discovery (the "targets" idea): what can this file become?

    FFmpeg-gated targets disappear when no engine is on the machine; PDF
    extras are listed by the router (which holds the file bytes).
    """
    ffmpeg = engines.ffmpeg_available()
    if mime in IMAGE_TARGETS:
        return [
            {"mime": target, "ext": ext} for target, ext in IMAGE_TARGETS.items() if target != mime
        ]
    if mime.startswith("audio/"):
        return (
            [
                {"mime": target, "ext": ext}
                for target, ext in AUDIO_TARGETS.items()
                if target != mime
            ]
            if ffmpeg
            else []
        )
    if mime.startswith("video/"):
        if not ffmpeg:
            return []
        targets = [
            {"mime": target, "ext": ext} for target, ext in VIDEO_TARGETS.items() if target != mime
        ]
        targets.extend({"mime": target, "ext": ext} for target, ext in AUDIO_TARGETS.items())
        return targets
    return []


_PIL_FORMAT = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}


def convert_image(data: bytes, target: str) -> bytes:
    from PIL import Image

    image = Image.open(io.BytesIO(data))
    image.load()
    if target == "image/jpeg":
        # JPEG has no alpha: flatten onto white (quality-aware conversion).
        if image.mode in {"RGBA", "LA", "P"}:
            image = image.convert("RGBA")
            background = Image.new("RGB", image.size, (255, 255, 255))
            background.paste(image, mask=image.split()[-1])
            image = background
        else:
            image = image.convert("RGB")
    elif image.mode not in {"RGB", "RGBA", "L"}:
        image = image.convert("RGBA")
    buffer = io.BytesIO()
    params: dict[str, Any] = {}
    if target == "image/jpeg":
        params = {"quality": 92}
    elif target == "image/webp":
        params = {"quality": 90}
    image.save(buffer, format=_PIL_FORMAT[target], **params)
    return buffer.getvalue()


def render_pdf_page_png(data: bytes, page: int = 0, dpi: int = 144) -> bytes:
    """PDF → PNG (one page) via the existing PyMuPDF engine."""
    import pymupdf

    with pymupdf.open(stream=data, filetype="pdf") as pdf:
        if not 0 <= page < pdf.page_count:
            raise ValueError(f"Page {page + 1} out of range (1-{pdf.page_count})")
        pix = pdf[page].get_pixmap(dpi=dpi)
        return pix.tobytes("png")


def pdf_text(data: bytes) -> str:
    """PDF → plain text via the existing PyMuPDF engine."""
    import pymupdf

    with pymupdf.open(stream=data, filetype="pdf") as pdf:
        return "\n\n".join(page.get_text() for page in pdf).strip()


def _ffmpeg(args: list[str], input_path: str, output_path: str) -> None:
    ffmpeg = engines.resolve_engine("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("FFmpeg is not available on this machine")
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        input_path,
        *args,
        output_path,
    ]
    probe = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=_CONVERT_TIMEOUT_S,
    )
    if probe.returncode != 0:
        detail = (probe.stderr or probe.stdout or "")[-400:]
        raise RuntimeError(f"FFmpeg conversion failed: {detail}")


def convert_media(data: bytes, mime: str, target: str) -> tuple[bytes, str]:
    """Audio/video → target container via the machine's FFmpeg.

    Alpha-aware (flyingmouse insight): opaque pixel formats drop the alpha
    channel, so a transparent video would turn black on yuv encoders — when
    the source has alpha, composite onto white first.
    """
    from pathlib import Path
    import tempfile

    ext_map = {**AUDIO_TARGETS, **VIDEO_TARGETS}
    suffix = ext_map.get(target, ".bin")
    has_alpha = False
    if mime.startswith("video/"):
        try:
            probe = subprocess.run(
                [
                    engines.resolve_engine("ffmpeg") or "ffmpeg",
                    "-hide_banner",
                    "-i",
                    "pipe:0",
                ],
                input=data,
                capture_output=True,
                text=True,
                timeout=30,
            )
            description = " ".join((probe.stderr or "").split())
            import re as _re

            format_match = _re.search(r"Video: ([^,\n]+)", description)
            pixel_format = format_match.group(1).strip().split(" ")[0] if format_match else ""
            has_alpha = bool(_re.match(r"^(rgba|argb|bgra|abgr|yuva|yuv\d+a)", pixel_format))
        except Exception:  # noqa: BLE001 - probing is best-effort
            has_alpha = False

    with tempfile.TemporaryDirectory(prefix="knorvia-convert-") as workdir:
        input_path = Path(workdir) / f"input{_guess_ext(mime)}"
        output_path = Path(workdir) / f"output{suffix}"
        input_path.write_bytes(data)
        args: list[str] = []
        if has_alpha and target in VIDEO_TARGETS:
            args += ["-vf", "color=white [bg]; [bg][0:v] overlay=shortest=1"]
        if target in AUDIO_TARGETS:
            args += ["-vn"]
        if target == "video/webm":
            args += ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34"]
        elif target == "video/mp4":
            args += ["-c:v", "libx264", "-preset", "fast", "-crf", "22", "-pix_fmt", "yuv420p"]
        elif target == "audio/mp4":
            args += ["-c:a", "aac", "-b:a", "160k"]
        elif target == "audio/mpeg":
            args += ["-c:a", "libmp3lame", "-q:a", "3"]
        _ffmpeg(args, str(input_path), str(output_path))
        return output_path.read_bytes(), target


def _guess_ext(mime: str) -> str:
    known = {
        **{mime: ext for mime, ext in IMAGE_TARGETS.items()},
        **{mime: ext for mime, ext in AUDIO_TARGETS.items()},
        **{mime: ext for mime, ext in VIDEO_TARGETS.items()},
        "video/quicktime": ".mov",
        "video/x-matroska": ".mkv",
        "audio/x-m4a": ".m4a",
        "audio/aac": ".aac",
        "audio/flac": ".flac",
        "audio/x-flac": ".flac",
        "image/bmp": ".bmp",
        "image/tiff": ".tif",
        "image/gif": ".gif",
    }
    return known.get(mime, ".bin")


__all__ = [
    "convert_image",
    "convert_media",
    "pdf_text",
    "render_pdf_page_png",
    "targets_for",
]
