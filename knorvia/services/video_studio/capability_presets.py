"""Capability presets for /settings/video.

Presets fill the capability block of a user-configured video model. They are
shaped after public Seedance-style / MiniMax-style / HappyHorse-style tiers but
carry no vendor ids, prices, or endpoints: the user still points ``base_url``
and the model id at their own gateway.
"""

from __future__ import annotations

import copy
from typing import Any

_FULL_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]
_HAPPYHORSE_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"]
_BASE_OPERATIONS = ["text_to_video", "image_to_video"]

_PARAMETER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "duration": {"type": ["number", "string"]},
        "aspect_ratio": {"type": "string"},
        "resolution": {"type": "string"},
        "fps": {"type": "number"},
        "audio_mode": {"type": "string"},
        "reference_mode": {"type": "string"},
        "seed": {"type": "integer"},
    },
}


def _capabilities(
    *,
    durations: list[int],
    resolutions: list[str],
    aspect_ratios: list[str],
    reference_modes: list[str],
    max_inputs: dict[str, int],
    audio_modes: list[str],
    operations: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "operations": list(operations or _BASE_OPERATIONS),
        "durations": durations,
        "resolutions": resolutions,
        "aspect_ratios": aspect_ratios,
        "fps": [],
        "audio_modes": audio_modes,
        "reference_modes": reference_modes,
        "max_inputs": dict(max_inputs),
        "max_prompt_length": 2000,
        "max_input_bytes": 64 * 1024 * 1024,
        "supports_cancel": True,
        "supports_seed": False,
        "parameter_schema": copy.deepcopy(_PARAMETER_SCHEMA),
    }


# Tiers that accept video references can also drive the clip-based operations.
_VIDEO_OPERATIONS = ["text_to_video", "image_to_video", "video_to_video", "extend", "remix", "edit"]


def _with_camera_schema(capabilities: dict[str, Any]) -> dict[str, Any]:
    """Extend a preset's parameter schema with Kling-style camera controls.

    ``camera_control`` matches the Kling payload object type selector;
    ``camera_motion`` is the enum the Composer renders as camera chips.
    """
    schema = capabilities["parameter_schema"]
    schema["properties"] = {
        **schema["properties"],
        "camera_control": {"type": "string", "enum": ["none", "simple", "custom"]},
        "camera_motion": {
            "type": "string",
            "enum": ["push", "pull", "pan", "tilt", "follow", "orbit"],
        },
    }
    return capabilities


CAPABILITY_PRESETS: dict[str, dict[str, Any]] = {
    "seedance-fast-like": {
        "label": "Seedance 2.0 Fast-like",
        "description": "Fast tier: 4-15s, 480p/720p, up to 9 images plus video/audio references.",
        "capabilities": _capabilities(
            durations=[4, 5, 8, 10, 15],
            resolutions=["480p", "720p"],
            aspect_ratios=list(_FULL_RATIOS),
            reference_modes=["auto", "first-frame", "first-last", "multi", "universal"],
            max_inputs={"image": 9, "video": 10, "audio": 10, "total": 29},
            audio_modes=["none", "generate"],
            operations=_VIDEO_OPERATIONS,
        ),
    },
    "seedance-standard-like": {
        "label": "Seedance 2.0 Standard-like",
        "description": "Standard tier: 4-15s, 720p to 4K, up to 9 images plus video/audio references.",
        "capabilities": _capabilities(
            durations=[4, 5, 8, 10, 15],
            resolutions=["720p", "1080p", "4k"],
            aspect_ratios=list(_FULL_RATIOS),
            reference_modes=["auto", "first-frame", "first-last", "multi", "universal"],
            max_inputs={"image": 9, "video": 10, "audio": 10, "total": 29},
            audio_modes=["none", "generate"],
            operations=_VIDEO_OPERATIONS,
        ),
    },
    "seedance-mini-like": {
        "label": "Seedance Mini-like",
        "description": "Light tier: 4-15s, 720p, images only (no video or audio references).",
        "capabilities": _capabilities(
            durations=[4, 5, 8, 10, 15],
            resolutions=["720p"],
            aspect_ratios=list(_FULL_RATIOS),
            reference_modes=["auto", "first-frame", "first-last", "multi"],
            max_inputs={"image": 9, "video": 0, "audio": 0, "total": 9},
            audio_modes=["none"],
        ),
    },
    "seedance-2.5-like": {
        "label": "Seedance 2.5-like",
        "description": "Flagship tier: 4-30s, 480p/720p, up to 30 images plus video/audio references.",
        "capabilities": _capabilities(
            durations=[4, 5, 8, 10, 15, 30],
            resolutions=["480p", "720p"],
            aspect_ratios=list(_FULL_RATIOS),
            reference_modes=["auto", "multi", "universal"],
            max_inputs={"image": 30, "video": 10, "audio": 10, "total": 50},
            audio_modes=["none", "generate"],
            operations=_VIDEO_OPERATIONS,
        ),
    },
    "minimax-h3-like": {
        "label": "MiniMax H3-like",
        "description": "5-15s, 768p/1440p, up to 9 images plus audio references, no video references.",
        "capabilities": _capabilities(
            durations=[5, 8, 10, 15],
            resolutions=["768p", "1440p"],
            aspect_ratios=list(_FULL_RATIOS),
            reference_modes=["auto", "multi", "universal"],
            max_inputs={"image": 9, "video": 0, "audio": 10, "total": 19},
            audio_modes=["none", "generate"],
        ),
    },
    "happyhorse-like": {
        "label": "HappyHorse-like",
        "description": "5-15s, 720p, images only; ratios limited to 16:9, 9:16, 1:1, 4:3, 3:4.",
        "capabilities": _capabilities(
            durations=[5, 8, 10, 15],
            resolutions=["720p"],
            aspect_ratios=list(_HAPPYHORSE_RATIOS),
            reference_modes=["auto", "first-frame", "multi"],
            max_inputs={"image": 9, "video": 0, "audio": 0, "total": 9},
            audio_modes=["none"],
        ),
    },
    "kling-2.x-like": {
        "label": "Kling 2.x-like",
        "description": "5/10s, 720p/1080p, first/last frame references, camera control, native extend.",
        "capabilities": _with_camera_schema(
            _capabilities(
                durations=[5, 10],
                resolutions=["720p", "1080p"],
                aspect_ratios=["16:9", "9:16", "1:1"],
                reference_modes=["first-frame", "first-last"],
                max_inputs={"image": 2, "video": 1, "audio": 0, "total": 3},
                audio_modes=["none"],
                operations=["text_to_video", "image_to_video", "extend"],
            )
        ),
    },
    # §Phase D5 (§2.1 track two): Kling 3.0 brings native audio (dialogue,
    # effects, ambience) on top of the 2.x tier, so this preset opens
    # audio_modes=["none", "generate"] — the Composer can then offer
    # "generate (native)" vs "reference audio" explicitly.
    "kling-3.x-like": {
        "label": "Kling 3.x-like",
        "description": "5/10s, 720p/1080p, first/last frame references, camera control, native audio and extend.",
        "capabilities": _with_camera_schema(
            _capabilities(
                durations=[5, 10],
                resolutions=["720p", "1080p"],
                aspect_ratios=["16:9", "9:16", "1:1"],
                reference_modes=["first-frame", "first-last"],
                max_inputs={"image": 2, "video": 1, "audio": 0, "total": 3},
                audio_modes=["none", "generate"],
                operations=["text_to_video", "image_to_video", "extend"],
            )
        ),
    },
    "wan-2.x-like": {
        "label": "Wan 2.x-like",
        "description": "DashScope task tier: 5/10s, 720p/1080p, one image reference, native audio.",
        "capabilities": _capabilities(
            durations=[5, 10],
            resolutions=["720p", "1080p"],
            aspect_ratios=["16:9", "9:16"],
            reference_modes=["first-frame"],
            max_inputs={"image": 1, "video": 0, "audio": 1, "total": 2},
            audio_modes=["none", "generate"],
        ),
    },
    "hailuo-h3-like": {
        "label": "Hailuo H3-like",
        "description": "Multi-reference tier: 6/10s, 768p/1080p, up to 9 images plus 3 videos and 3 audio clips.",
        "capabilities": _capabilities(
            durations=[6, 10],
            resolutions=["768p", "1080p"],
            aspect_ratios=list(_FULL_RATIOS),
            reference_modes=["multi"],
            max_inputs={"image": 9, "video": 3, "audio": 3, "total": 15},
            audio_modes=["none", "generate"],
        ),
    },
}


def get_capability_preset(preset_id: str) -> dict[str, Any] | None:
    preset = CAPABILITY_PRESETS.get(str(preset_id or ""))
    if preset is None:
        return None
    return copy.deepcopy(preset)


def list_capability_presets() -> list[dict[str, Any]]:
    return [
        {
            "id": key,
            "label": preset["label"],
            "description": preset["description"],
            "capabilities": copy.deepcopy(preset["capabilities"]),
        }
        for key, preset in CAPABILITY_PRESETS.items()
    ]


__all__ = ["CAPABILITY_PRESETS", "get_capability_preset", "list_capability_presets"]
