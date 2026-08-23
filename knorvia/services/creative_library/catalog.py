"""Built-in prompt catalog.

Original Knorvia copy — not taken from any third-party prompt dump.
Users can edit their own prompts; these rows are re-seeded when missing.
"""

from __future__ import annotations

from typing import Any


def builtin_prompts() -> list[dict[str, Any]]:
    return [
        {
            "id": "prompt_product_hero",
            "title": "Product hero",
            "category": "image",
            "tags": ["product", "studio"],
            "language": "en",
            "body": (
                "Studio product photograph of the subject on a clean seamless backdrop, "
                "soft three-point lighting, sharp edges, accurate materials, no extra logos."
            ),
        },
        {
            "id": "prompt_character_sheet",
            "title": "Character sheet",
            "category": "image",
            "tags": ["character", "consistency"],
            "language": "en",
            "body": (
                "Character design sheet of the same person, front three-quarter and side, "
                "consistent face, hair, wardrobe and palette, plain background, even light."
            ),
        },
        {
            "id": "prompt_storyboard_still",
            "title": "Storyboard still",
            "category": "image",
            "tags": ["storyboard", "cinema"],
            "language": "en",
            "body": (
                "Cinematic still for one shot: readable staging, motivated light, "
                "clear subject, no text overlays, keep continuity with previous frames."
            ),
        },
        {
            "id": "prompt_poster",
            "title": "Poster",
            "category": "image",
            "tags": ["poster", "graphic"],
            "language": "en",
            "body": (
                "Bold poster composition with a single focal subject, generous negative space "
                "for a title, high contrast, print-ready detail, no watermarks."
            ),
        },
        {
            "id": "prompt_first_frame",
            "title": "Video first frame",
            "category": "video",
            "tags": ["video", "first-frame"],
            "language": "en",
            "body": (
                "Opening frame for image-to-video: locked subject, stable pose, "
                "clear foreground and background, lighting that can hold for a short clip."
            ),
        },
        {
            "id": "prompt_i2v_hold",
            "title": "Hold the subject",
            "category": "video",
            "tags": ["video", "consistency"],
            "language": "en",
            "body": (
                "Animate the attached first frame. Keep identity, wardrobe, product and "
                "composition. Natural motion only, no morphing, no extra characters."
            ),
        },
        {
            "id": "prompt_zh_product",
            "title": "商品主图",
            "category": "image",
            "tags": ["product", "studio"],
            "language": "zh",
            "body": "干净背景的商品主图，三点柔光，材质准确，边缘清晰，不要多余商标或文字。",
        },
        {
            "id": "prompt_zh_character",
            "title": "角色设定",
            "category": "image",
            "tags": ["character", "consistency"],
            "language": "zh",
            "body": "同一角色的设定图：正面四分之三与侧面，五官、发型、服装和配色保持一致，浅色背景。",
        },
        {
            "id": "prompt_zh_i2v",
            "title": "首帧驱动",
            "category": "video",
            "tags": ["video", "first-frame"],
            "language": "zh",
            "body": "以附图为首帧生成短视频。保持人物、服装、产品和构图不变，动作自然，不要变形或新增角色。",
        },
    ]
