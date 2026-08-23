"""SRT subtitle helpers for the Video Studio composition engine.

Phase A3 builds captions from storyboard shot text (``from_notes``). Phase D
adds segment-based (``from_asr``) captions — normalized ASR segments, per-shot
timeline offsets, overlap-free merging — plus the burn-in style presets used
by the ffmpeg ``subtitles`` filter's ``force_style`` option; the parse/
serialize round-trip below is shared by both sources and the web editor.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping, Sequence

from knorvia.services.voice.base import normalize_stt_segments

_TIMESTAMP_RE = re.compile(r"^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$")
_SENTENCE_SPLIT = re.compile(r"(?<=[。！？!?])(?!\s|$)|(?<=[.；;])(?=\s|$)")
_MAX_CUE_SECONDS = 7.0
_MIN_CUE_SECONDS = 0.8
_MAX_CHARS_PER_CUE = 42
_BOM = "\ufeff"

# Phase D2 burn-in style presets → ffmpeg `subtitles=...:force_style` value.
# Keys are the stable API/UI identifiers; empty style = ffmpeg defaults.
SUBTITLE_STYLE_PRESETS: dict[str, str] = {
    # Clean white: white text, thin outline, no box — the unobtrusive default.
    "clean": (
        "FontName=Arial,FontSize=16,PrimaryColour=&H00FFFFFF,"
        "OutlineColour=&H00000000,BorderStyle=1,Outline=1,Shadow=0"
    ),
    # Black box + yellow text: opaque backing plate for bright footage.
    "yellow_box": (
        "FontName=Arial,FontSize=16,PrimaryColour=&H0000FFFF,"
        "BackColour=&H00000000,BorderStyle=3,Outline=1,Shadow=0"
    ),
    # Big outlined type: bold, heavy outline — reads on busy motion.
    "outline_large": (
        "FontName=Arial,FontSize=24,PrimaryColour=&H00FFFFFF,"
        "OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=0,Bold=1"
    ),
    # Accessibility high contrast: bold white on a semi-opaque black plate.
    "high_contrast": (
        "FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,"
        "BackColour=&HC8000000,BorderStyle=3,Outline=2,Shadow=0,Bold=1"
    ),
}
SUBTITLE_STYLE_KEYS = frozenset(SUBTITLE_STYLE_PRESETS)


def resolve_subtitle_style(style: str) -> str:
    """Map a style preset key onto its ``force_style`` value.

    Preset keys (``clean`` …) resolve to their preset string; anything else is
    a raw ``force_style`` value passed through unchanged (the composition
    layer already charset-checks raw values), and an empty style means "use
    the ffmpeg subtitles-filter defaults".
    """
    text = str(style or "").strip()
    return SUBTITLE_STYLE_PRESETS.get(text, text)


def format_timestamp(total_seconds: float) -> str:
    total_ms = max(0, int(round(float(total_seconds) * 1000)))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    seconds, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{ms:03d}"


def _parse_timestamp(text: str) -> float:
    match = _TIMESTAMP_RE.match(text.strip())
    if not match:
        raise ValueError(f"Invalid SRT timestamp: {text!r}")
    hours, minutes, seconds, millis = (int(part) for part in match.groups())
    return hours * 3600 + minutes * 60 + seconds + millis / 1000


def split_caption_lines(text: str, *, max_chars: int = _MAX_CHARS_PER_CUE) -> list[str]:
    """Split narration into readable cue chunks.

    Sentences stay intact where possible; long sentences wrap at punctuation or
    spaces; CJK text without spaces wraps on width.
    """
    cleaned = " ".join(str(text or "").split())
    if not cleaned:
        return []
    sentences = [part.strip() for part in _SENTENCE_SPLIT.split(cleaned) if part.strip()]
    chunks: list[str] = []
    for sentence in sentences:
        if len(sentence) <= max_chars:
            chunks.append(sentence)
            continue
        current = ""
        for token in re.split(r"(?<=[，,、])|(?<= )", sentence):
            if not token:
                continue
            if current and len(current) + len(token) > max_chars:
                chunks.append(current)
                current = token.strip()
            else:
                current += token
        if current:
            chunks.append(current)
        # CJK runs without any break candidates still need hard wrapping.
    wrapped: list[str] = []
    for chunk in chunks:
        while len(chunk) > max_chars:
            wrapped.append(chunk[:max_chars])
            chunk = chunk[max_chars:]
        if chunk:
            wrapped.append(chunk)
    return wrapped


def build_cues_from_shot(text: str, duration: float) -> list[dict[str, Any]]:
    """Spread one shot's narration evenly across its screen time."""
    lines = split_caption_lines(text)
    if not lines:
        return []
    total_chars = sum(len(line) for line in lines)
    weights = [max(1, len(line)) for line in lines]
    available = max(float(duration or 0.0), _MIN_CUE_SECONDS * len(lines))
    if total_chars <= 0:
        shares = [available / len(lines)] * len(lines)
    else:
        raw = [available * weight / total_chars for weight in weights]
        shares = [max(_MIN_CUE_SECONDS, min(_MAX_CUE_SECONDS, value)) for value in raw]
    scale = available / sum(shares) if sum(shares) > 0 else 1.0
    cues: list[dict[str, Any]] = []
    offset = 0.0
    for line, share in zip(lines, shares):
        share *= scale
        cues.append({"start": offset, "end": offset + share, "text": line})
        offset += share
    return cues


def parse_srt(content: str) -> list[dict[str, Any]]:
    """Parse an SRT document into ``{index, start, end, text}`` cues.

    Tolerant by design: a UTF-8 BOM, stray blank lines, dot/comma millisecond
    separators, missing or malformed indexes and unparseable blocks are all
    skipped without raising.
    """
    cues: list[dict[str, Any]] = []
    blocks = re.split(r"\r?\n\r?\n", str(content or "").strip().lstrip(_BOM))
    for block in blocks:
        lines = [line for line in block.splitlines() if line.strip()]
        if len(lines) < 2:
            continue
        try:
            index = int(lines[0].strip())
            lines = lines[1:]
        except ValueError:
            index = len(cues) + 1
        timing = lines[0].strip()
        match = re.match(r"^(.+?)\s*-->\s*(.+?)(?:\s|$)", timing)
        if not match:
            continue
        try:
            start = _parse_timestamp(match.group(1))
            end = _parse_timestamp(match.group(2))
        except ValueError:
            continue
        text = " ".join(line.strip() for line in lines[1:] if line.strip())
        if not text or end <= start:
            continue
        cues.append({"index": index, "start": start, "end": end, "text": text})
    return cues


def serialize_srt(cues: Iterable[dict[str, Any]]) -> str:
    blocks: list[str] = []
    for position, cue in enumerate(cues, start=1):
        start = float(cue.get("start") or 0.0)
        end = float(cue.get("end") or 0.0)
        text = " ".join(str(cue.get("text") or "").split())
        if not text or end <= start:
            continue
        blocks.append(f"{position}\n{format_timestamp(start)} --> {format_timestamp(end)}\n{text}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def shift_cues(cues: Sequence[dict[str, Any]], offset: float) -> list[dict[str, Any]]:
    """Move cues on the timeline (used when merging per-shot ASR segments)."""
    return [
        {
            "index": cue.get("index") or position,
            "start": max(0.0, float(cue.get("start") or 0.0) + offset),
            "end": max(0.0, float(cue.get("end") or 0.0) + offset),
            "text": str(cue.get("text") or ""),
        }
        for position, cue in enumerate(cues, start=1)
    ]


def srt_from_segments(
    segments: Sequence[Mapping[str, Any]],
) -> str:
    """Serialize ASR ``segments`` (``{start, end, text}``) into an SRT document.

    Segments are defensively normalized — ascending order, non-negative
    times, empty/degenerate entries dropped — before serialization, so
    hand-rolled or degraded gateway payloads cannot poison the burn-in.
    """
    cues = [
        {"start": cue["start"], "end": cue["end"], "text": cue["text"]}
        for cue in normalize_stt_segments(segments)
    ]
    return serialize_srt(cues)


def resolve_cue_overlaps(
    cues: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Concatenate cues from several shots and remove timeline overlaps.

    ``from_asr`` transcribes every shot independently and shifts the segments
    by the shot's composition start, so adjacent (or repeated) shots can
    produce overlapping cues. Rules, applied on a start-time-sorted stream:

    * a cue may not start before the previous cue ends — its start is aligned
      to the previous cue's end;
    * a cue left with no positive duration after alignment is dropped (there
      is no room on the timeline for it).
    """
    ordered = sorted(
        (
            {
                "start": max(0.0, float(cue.get("start") or 0.0)),
                "end": max(0.0, float(cue.get("end") or 0.0)),
                "text": str(cue.get("text") or "").strip(),
            }
            for cue in cues
        ),
        key=lambda cue: (cue["start"], cue["end"]),
    )
    merged: list[dict[str, Any]] = []
    for cue in ordered:
        if not cue["text"] or cue["end"] <= cue["start"]:
            continue
        if merged and cue["start"] < merged[-1]["end"]:
            cue["start"] = merged[-1]["end"]
            if cue["end"] <= cue["start"]:
                continue  # fully shadowed by the previous cue
        merged.append(cue)
    return [{**cue, "index": position} for position, cue in enumerate(merged, start=1)]


def merge_shifted_segments(
    per_shot: Iterable[tuple[float, Sequence[Mapping[str, Any]]]],
) -> list[dict[str, Any]]:
    """Build the composition-wide cue list for ``from_asr`` subtitles.

    ``per_shot`` yields ``(shot_start_on_timeline, asr_segments)`` pairs; each
    shot's segments are shifted onto the composition timeline and the
    concatenation is de-overlapped by :func:`resolve_cue_overlaps`.
    """
    shifted: list[dict[str, Any]] = []
    for offset, segments in per_shot:
        normalized = normalize_stt_segments(segments)
        if not normalized:
            continue
        shifted.extend(shift_cues(normalized, float(offset or 0.0)))
    return resolve_cue_overlaps(shifted)


def build_srt_from_shots(shots: Sequence[dict[str, Any]]) -> str:
    """Build one SRT document from storyboard shots.

    Per shot the caption source is ``voiceover_text`` → ``notes`` → ``title``;
    cues are distributed over the shot's screen time and concatenated on the
    composition timeline.
    """
    cues: list[dict[str, Any]] = []
    timeline = 0.0
    for shot in shots:
        text = (
            str(shot.get("voiceover_text") or "")
            or str(shot.get("notes") or "")
            or str(shot.get("title") or "")
        )
        try:
            duration = float(shot.get("duration") or 0.0)
        except (TypeError, ValueError):
            duration = 0.0
        shot_cues = build_cues_from_shot(text, duration)
        cues.extend(shift_cues(shot_cues, timeline))
        timeline += max(duration, sum(cue["end"] - cue["start"] for cue in shot_cues))
    return serialize_srt(cues)


__all__ = [
    "SUBTITLE_STYLE_KEYS",
    "SUBTITLE_STYLE_PRESETS",
    "build_cues_from_shot",
    "build_srt_from_shots",
    "format_timestamp",
    "merge_shifted_segments",
    "parse_srt",
    "resolve_cue_overlaps",
    "resolve_subtitle_style",
    "serialize_srt",
    "shift_cues",
    "split_caption_lines",
    "srt_from_segments",
]
