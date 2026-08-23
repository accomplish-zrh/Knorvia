from __future__ import annotations

from io import BytesIO
from typing import Any

from PIL import Image, ImageOps

TARGET_LONG_EDGES = {"1K": 1024, "2K": 2048, "4K": 4096}


def target_long_edge(value: object) -> int | None:
    return TARGET_LONG_EDGES.get(str(value or "").strip().upper())


def upscale_to_target(
    content: bytes, mime: str, target: object
) -> tuple[bytes, str, dict[str, Any] | None]:
    """Resize an undersized output while preserving its aspect ratio.

    This is deliberately reported as Lanczos fallback enhancement, not AI
    super-resolution. The metadata lets the UI distinguish native output from
    a compatibility upscale.
    """
    edge = target_long_edge(target)
    if edge is None:
        return content, mime, None
    with Image.open(BytesIO(content)) as opened:
        image = ImageOps.exif_transpose(opened)
        width, height = image.size
        longest = max(width, height)
        if longest >= edge:
            return content, mime, None
        scale = edge / longest
        output_size = (max(1, round(width * scale)), max(1, round(height * scale)))
        resized = image.resize(output_size, Image.Resampling.LANCZOS)
        output = BytesIO()
        normalized_mime = mime.lower().split(";", 1)[0].strip()
        if normalized_mime == "image/jpeg":
            if resized.mode not in {"RGB", "L"}:
                resized = resized.convert("RGB")
            resized.save(output, format="JPEG", quality=95, optimize=True)
        elif normalized_mime == "image/webp":
            resized.save(output, format="WEBP", quality=95, method=6)
        else:
            normalized_mime = "image/png"
            resized.save(output, format="PNG", optimize=True)
        return (
            output.getvalue(),
            normalized_mime,
            {
                "method": "lanczos",
                "source_width": width,
                "source_height": height,
                "width": output_size[0],
                "height": output_size[1],
                "target": str(target).upper(),
            },
        )


__all__ = ["TARGET_LONG_EDGES", "target_long_edge", "upscale_to_target"]
