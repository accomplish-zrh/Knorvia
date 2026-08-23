"""Phase E helpers: transitions, trim, subtitle overrides, and mix math.

Kept pure (no ffmpeg, no store I/O) so composition, the storyboard validator
and the web timeline can share one definition of "what this shot contributes
to the cut".
"""

from __future__ import annotations

import math
import re
from typing import Any, Iterable, Mapping, Sequence

XFADE_DURATION = 0.5
TRANSITION_ENUMS = frozenset({"none", "crossfade", "fade-black", "fade-white", "wipe-left"})
# ffmpeg ``xfade`` names for the four visual transitions. ``none`` / ``custom``
# stay hard cuts (legacy free-text transitions are classified as custom).
XFADE_FILTER_NAMES = {
    "crossfade": "fade",
    "fade-black": "fadeblack",
    "fade-white": "fadewhite",
    "wipe-left": "wipeleft",
}
VOICEOVER_VOLUME_RANGE = (0.0, 2.0)
DEFAULT_VOICEOVER_VOLUME = 1.0
SUBTITLE_FONT_SIZE_RANGE = (12, 72)
# ASS colour: ``&H`` + 6 or 8 hex digits (BBGGRR or AABBGGRR).
_ASS_COLOUR = re.compile(r"^&H[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$")
# force_style assignments: letters, digits, and the ASS colour prefix. Quotes,
# slashes, brackets and filter separators are rejected so a style can never
# break out of the ``subtitles=…:force_style='…'`` quoting.
_STYLE_TOKEN = re.compile(r"^[A-Za-z][A-Za-z0-9]*=[A-Za-z0-9.&+\-]+$")
_SAFE_SRT_NAME = re.compile(r"^[A-Za-z0-9_.-]+\.srt$")


class PostProductionError(ValueError):
    """Raised when a trim / transition / style value cannot be used."""


def normalize_transition(raw: Any) -> str:
    """Persist a shot transition.

    Known enum values are stored lowercase. Empty / ``none`` become ``""``
    (hard cut). Anything else is kept as free text (≤160 chars) and treated
    as ``custom`` at compose time so pre-E1 labels survive a round-trip.
    """
    text = str(raw or "").strip()[:160]
    if not text:
        return ""
    lowered = text.lower()
    if lowered == "none":
        return ""
    if lowered in TRANSITION_ENUMS:
        return lowered
    return text


def transition_kind(raw: Any) -> str:
    """Map a stored transition onto a composition kind."""
    text = str(raw or "").strip()
    if not text:
        return "none"
    lowered = text.lower()
    if lowered in TRANSITION_ENUMS:
        return lowered
    return "custom"


def xfade_name(raw: Any) -> str | None:
    """ffmpeg ``xfade`` transition name, or ``None`` for a hard cut."""
    return XFADE_FILTER_NAMES.get(transition_kind(raw))


def parse_optional_seconds(raw: Any, *, field: str, maximum: float = 3600.0) -> float | None:
    if raw in (None, ""):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise PostProductionError(f"Storyboard {field} must be numeric") from exc
    if not math.isfinite(value) or value < 0 or value > maximum:
        raise PostProductionError(f"Storyboard {field} is out of range")
    return value


def parse_voiceover_volume(raw: Any) -> float | None:
    if raw in (None, ""):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise PostProductionError("Storyboard voiceover volume must be numeric") from exc
    low, high = VOICEOVER_VOLUME_RANGE
    if not math.isfinite(value) or value < low or value > high:
        raise PostProductionError("Storyboard voiceover volume is out of range")
    return value


def validate_trim_window(
    trim_in: float | None,
    trim_out: float | None,
    duration: float | None,
) -> None:
    """0 ≤ in < out ≤ duration (when each bound is present)."""
    if trim_in is not None and trim_out is not None and not trim_in < trim_out:
        raise PostProductionError("Storyboard trim_in must be less than trim_out")
    if duration is None:
        return
    if trim_in is not None and trim_in >= duration:
        raise PostProductionError("Storyboard trim_in must be inside the shot duration")
    if trim_out is not None and trim_out > duration:
        raise PostProductionError("Storyboard trim_out must be inside the shot duration")


def effective_trim(
    *,
    source_duration: float,
    trim_in: float | None,
    trim_out: float | None,
) -> tuple[float, float]:
    """Resolve a shot's source window to ``(in, out)`` seconds."""
    start = 0.0 if trim_in is None else max(0.0, float(trim_in))
    end = (
        float(source_duration) if trim_out is None else min(float(source_duration), float(trim_out))
    )
    if end <= start:
        raise PostProductionError("The trimmed shot has no measurable duration")
    return start, end


def overlap_for_transition(raw: Any, *, left_duration: float, right_duration: float) -> float:
    """Overlap consumed by the transition from ``left`` into ``right``.

    Shots shorter than the xfade window cannot fade — the overlap is 0 and
    the caller should treat the cut as hard (or reject, depending on context).
    """
    if xfade_name(raw) is None:
        return 0.0
    if left_duration <= XFADE_DURATION or right_duration <= XFADE_DURATION:
        return 0.0
    return XFADE_DURATION


def composed_timeline(
    durations: Sequence[float],
    transitions: Sequence[Any],
) -> tuple[list[float], list[float], float]:
    """Return ``(starts, overlaps, total)`` for a cut of N shots.

    ``transitions[i]`` is the transition *out of* shot i (into i+1). The last
    value is ignored. Total duration is Σ durations − Σ overlaps.
    """
    if not durations:
        return [], [], 0.0
    if len(durations) != len(transitions):
        raise PostProductionError("Each shot needs a transition slot")
    starts: list[float] = []
    overlaps: list[float] = []
    cursor = 0.0
    for index, duration in enumerate(durations):
        if duration <= 0:
            raise PostProductionError("A composed shot must have a positive duration")
        starts.append(cursor)
        if index + 1 < len(durations):
            overlap = overlap_for_transition(
                transitions[index],
                left_duration=duration,
                right_duration=float(durations[index + 1]),
            )
        else:
            overlap = 0.0
        overlaps.append(overlap)
        cursor += duration - overlap
    return starts, overlaps, cursor


def composed_duration(durations: Sequence[float], transitions: Sequence[Any]) -> float:
    return composed_timeline(durations, transitions)[2]


def parse_font_size(raw: Any) -> int | None:
    if raw in (None, ""):
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise PostProductionError("Subtitle font size must be an integer") from exc
    low, high = SUBTITLE_FONT_SIZE_RANGE
    if value < low or value > high:
        raise PostProductionError(f"Subtitle font size must be between {low} and {high}")
    return value


def parse_primary_colour(raw: Any) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    if not _ASS_COLOUR.fullmatch(text):
        raise PostProductionError(
            "Subtitle colour must be an ASS &H hex value (for example &H00FFFFFF)"
        )
    return text.upper()


def assert_safe_srt_name(name: str) -> str:
    text = str(name or "").strip()
    if not _SAFE_SRT_NAME.fullmatch(text):
        raise PostProductionError("The subtitle path is invalid")
    if ".." in text or "/" in text or "\\" in text:
        raise PostProductionError("The subtitle path is invalid")
    return text


def assert_safe_force_style(style: str) -> str:
    """Reject filter-injection attempts in a raw ``force_style`` string."""
    text = str(style or "").strip()
    if not text:
        return ""
    if len(text) > 500:
        raise PostProductionError("The subtitle style preset is invalid")
    if any(char in text for char in "'\"[];/\\"):
        raise PostProductionError("The subtitle style preset is invalid")
    tokens = [part.strip() for part in text.split(",") if part.strip()]
    if not tokens or not all(_STYLE_TOKEN.fullmatch(part) for part in tokens):
        raise PostProductionError("The subtitle style preset is invalid")
    return text


def apply_style_overrides(
    base: str,
    *,
    font_size: int | None = None,
    primary_colour: str = "",
) -> str:
    """Merge size/colour overrides onto a preset or raw force_style string."""
    text = str(base or "").strip()
    if text:
        assert_safe_force_style(text)
    parts: dict[str, str] = {}
    if text:
        for token in text.split(","):
            if "=" not in token:
                continue
            key, value = token.split("=", 1)
            parts[key.strip()] = value.strip()
    if font_size is not None:
        parts["FontSize"] = str(int(font_size))
    if primary_colour:
        parts["PrimaryColour"] = parse_primary_colour(primary_colour)
    merged = ",".join(f"{key}={value}" for key, value in parts.items())
    return assert_safe_force_style(merged) if merged else ""


def ducking_filter(*, sidechain: str = "vosc", output: str = "bgmduck") -> str:
    """``sidechaincompress`` that pulls BGM down ~6 dB under speech."""
    return (
        f"[bgm][{sidechain}]sidechaincompress="
        f"threshold=0.05:ratio=6:attack=20:release=250:level_sc=1[{output}]"
    )


def estimate_cost_yuan(seconds: float, price_hint: Any) -> float | None:
    """Yuan estimate from a user-supplied 元/秒 hint. ``None`` when unset."""
    if price_hint in (None, ""):
        return None
    try:
        rate = float(price_hint)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(rate) or rate <= 0 or not math.isfinite(float(seconds)):
        return None
    return round(max(0.0, float(seconds)) * rate, 2)


def shots_as_timeline(shots: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Frontend-facing layout rows: start, duration, overlap, bands."""
    rows = list(shots)
    durations = []
    transitions = []
    for shot in rows:
        try:
            duration = float(shot.get("duration") or 0.0)
        except (TypeError, ValueError):
            duration = 0.0
        trim_in = shot.get("trim_in")
        trim_out = shot.get("trim_out")
        try:
            start, end = effective_trim(
                source_duration=duration or 0.0,
                trim_in=None if trim_in in (None, "") else float(trim_in),
                trim_out=None if trim_out in (None, "") else float(trim_out),
            )
            durations.append(end - start)
        except (PostProductionError, TypeError, ValueError):
            durations.append(max(0.0, duration))
        transitions.append(shot.get("transition") or "")
    starts, overlaps, _ = composed_timeline(durations, transitions) if durations else ([], [], 0.0)
    layout: list[dict[str, Any]] = []
    for index, shot in enumerate(rows):
        layout.append(
            {
                "id": shot.get("id"),
                "start": starts[index] if index < len(starts) else 0.0,
                "duration": durations[index] if index < len(durations) else 0.0,
                "overlap": overlaps[index] if index < len(overlaps) else 0.0,
                "transition": transition_kind(shot.get("transition")),
                "has_voiceover": bool(shot.get("voiceover_asset_id") or shot.get("voiceover_text")),
                "has_subtitle": bool(
                    shot.get("voiceover_text") or shot.get("notes") or shot.get("title")
                ),
            }
        )
    return layout


__all__ = [
    "DEFAULT_VOICEOVER_VOLUME",
    "PostProductionError",
    "SUBTITLE_FONT_SIZE_RANGE",
    "TRANSITION_ENUMS",
    "VOICEOVER_VOLUME_RANGE",
    "XFADE_DURATION",
    "XFADE_FILTER_NAMES",
    "apply_style_overrides",
    "assert_safe_force_style",
    "assert_safe_srt_name",
    "composed_duration",
    "composed_timeline",
    "ducking_filter",
    "effective_trim",
    "estimate_cost_yuan",
    "normalize_transition",
    "overlap_for_transition",
    "parse_font_size",
    "parse_optional_seconds",
    "parse_primary_colour",
    "parse_voiceover_volume",
    "shots_as_timeline",
    "transition_kind",
    "validate_trim_window",
    "xfade_name",
]
