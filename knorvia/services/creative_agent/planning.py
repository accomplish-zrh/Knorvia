"""Five-stage internal brief.

The brief constrains generation. It is stored on the message/run and never
shown as a user-facing model rationale. The user prompt is passed through
verbatim when a job is created.
"""

from __future__ import annotations

import re
from typing import Any

_VIDEO_MARKERS = (
    "video",
    "clip",
    "animate",
    "animation",
    "cinemagraph",
    "i2v",
    "t2v",
    "视频",
    "短片",
    "动画",
    "镜头",
    "首帧",
    "尾帧",
    "分镜",
)
_IMAGE_MARKERS = (
    "image",
    "picture",
    "photo",
    "poster",
    "illustration",
    "render",
    "图",
    "海报",
    "插画",
    "主图",
    "设定",
)


def infer_creation_mode(
    prompt: str,
    requested: str = "agent",
    *,
    has_video_ref: bool = False,
    has_last_frame: bool = False,
) -> str:
    mode = str(requested or "agent").strip().lower()
    if mode in {"image", "video"}:
        return mode
    text = str(prompt or "")
    lowered = text.lower()
    if has_last_frame or has_video_ref:
        return "video"
    if any(marker in lowered or marker in text for marker in _VIDEO_MARKERS):
        return "video"
    if any(marker in lowered or marker in text for marker in _IMAGE_MARKERS):
        return "image"
    return "image"


def build_internal_brief(
    prompt: str,
    *,
    mode: str,
    language: str = "en",
    reference_ids: list[str] | None = None,
    smart_planning: bool = True,
    first_frame_id: str = "",
    last_frame_id: str = "",
) -> dict[str, Any]:
    text = str(prompt or "").strip()
    zh = str(language or "").lower().startswith("zh")
    refs = [item for item in (reference_ids or []) if item]
    keep_subject = bool(refs or first_frame_id)
    direction = {
        "style": "clean commercial still" if mode == "image" else "stable cinematic motion",
        "composition": "subject-first, readable staging",
        "light": "natural motivated light",
        "avoid": "extra logos, extra characters, prompt leakage",
    }
    if zh:
        direction = {
            "style": "干净的商业静帧" if mode == "image" else "稳定的电影运动",
            "composition": "主体优先，调度可读",
            "light": "自然有依据的光线",
            "avoid": "多余商标、多余角色、提示词泄漏",
        }
    return {
        "stage": {
            "brief": "ready",
            "direction": "ready",
            "materials": "ready",
            "generate": "pending",
            "review": "skipped",
        },
        "goal": text[:500],
        "audience": "general",
        "visual_direction": direction,
        "material_plan": {
            "mode": mode,
            "references": refs,
            "first_frame_id": first_frame_id or "",
            "last_frame_id": last_frame_id or "",
            "outputs": 1,
        },
        "consistency": {
            "keep_subject": keep_subject,
            "keep_wardrobe": mode == "video" and keep_subject,
            "keep_product": keep_subject,
        },
        "smart_planning": bool(smart_planning),
        "review": {"enabled": False, "status": "skipped"},
        "user_prompt": text,
    }


def public_create_reply(
    *, mode: str, language: str = "en", job: dict[str, Any] | None = None
) -> str:
    zh = str(language or "").lower().startswith("zh")
    status = str((job or {}).get("status") or "queued")
    if zh:
        if mode == "video":
            return "已把视频任务送进视频创作，完成后会显示在这条记录里。"
        return "已把出图任务送进视觉创作，完成后会显示在这条记录里。"
    if mode == "video":
        return "The video job is in Video Studio. The result will land on this turn."
    return "The image job is in Image Studio. The result will land on this turn."


def compact_brief_text(brief: dict[str, Any], *, language: str = "en") -> str:
    """Short canvas-only note. Never a substitute for the user prompt."""
    direction = brief.get("visual_direction") or {}
    zh = str(language or "").lower().startswith("zh")
    parts = [
        str(direction.get("style") or ""),
        str(direction.get("composition") or ""),
        str(direction.get("light") or ""),
    ]
    avoid = str(direction.get("avoid") or "")
    if avoid:
        parts.append(f"{'避开' if zh else 'Avoid'}: {avoid}")
    return " · ".join(part for part in parts if part)


_PIXEL_RE = re.compile(r"(\d{3,5})\s*[x×]\s*(\d{3,5})", re.I)


def parse_custom_pixels(value: str) -> tuple[int, int] | None:
    match = _PIXEL_RE.search(str(value or ""))
    if not match:
        return None
    width, height = int(match.group(1)), int(match.group(2))
    if width < 256 or height < 256 or width > 8192 or height > 8192:
        return None
    return width, height
