"""Local composition engine: storyboard shots → one MP4 (Phase A3 / E).

Composition is free local work: ffmpeg normalises every shot to the target
resolution/fps, concatenates them (hard cuts, or ``xfade`` for Phase E
transitions), optionally burns subtitles built from shot text, and mixes
native audio with per-shot voiceovers (``adelay`` aligned to each shot's
start) plus an optional BGM bed that ducks under speech. The result enters
the asset store like any provider output, so zip export and playback work
unchanged.

Phase D2 adds the caption sources on top of A3's ``from_notes``: ``from_asr``
transcribes each shot's audio through the STT gateway (D1 verbose_json) and
merges the per-shot segments onto the composition timeline, and ``from_asset``
burns a saved/edited subtitle document (the subtitle editor's output). Burn-in
styles resolve through the ffmpeg ``subtitles`` filter's ``force_style``.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
import logging
from pathlib import Path
import re
import tempfile
from typing import Any, Mapping, Sequence
from uuid import uuid4

from knorvia.multi_user.context import get_current_user
from knorvia.services.voice import VoiceProviderError, transcribe_audio

from .engine import start_video_job
from .ffmpeg_tool import (
    DEFAULT_PLACEHOLDER_SECONDS,
    MAX_PLACEHOLDER_SECONDS,
    FFmpegFailedError,
    FFmpegUnavailableError,
    get_ffmpeg_tool,
)
from .post_production import (
    DEFAULT_VOICEOVER_VOLUME,
    PostProductionError,
    apply_style_overrides,
    assert_safe_force_style,
    assert_safe_srt_name,
    composed_duration,
    composed_timeline,
    ducking_filter,
    effective_trim,
    overlap_for_transition,
    parse_font_size,
    parse_optional_seconds,
    parse_primary_colour,
    parse_voiceover_volume,
    xfade_name,
)
from .store import (
    MAX_OUTPUT_BYTES,
    MAX_STORYBOARD_SHOTS,
    PROJECT_BGM_DEFAULT_FADE,
    PROJECT_BGM_DEFAULT_VOLUME,
    PROJECT_BGM_FADE_RANGE,
    PROJECT_BGM_VOLUME_RANGE,
    VideoStudioStore,
)
from .subtitles import (
    SUBTITLE_STYLE_KEYS,
    build_srt_from_shots,
    merge_shifted_segments,
    resolve_subtitle_style,
    serialize_srt,
)
from .upscale import (
    UPSCALE_TARGET_EDGE,
    UPSCALE_TARGET_SIZE,
    UpscaleError,
    upscale_clip_to_1080p,
)

logger = logging.getLogger(__name__)

MAX_COMPOSE_TOTAL_SECONDS = 30 * 60
COMPOSE_TIMEOUT_SECONDS = 3600.0
RESOLUTION_SIZES = {"480p": (854, 480), "720p": (1280, 720), "1080p": (1920, 1080)}
FPS_CHOICES = (24, 30, 60)
SUBTITLE_MODES = frozenset({"off", "from_notes", "from_asr", "from_asset"})
# §Phase D3: BGM bounds live on the store (they bound the project slot too).
BGM_VOLUME_RANGE = PROJECT_BGM_VOLUME_RANGE
BGM_FADE_RANGE = PROJECT_BGM_FADE_RANGE
DEFAULT_BGM_VOLUME = PROJECT_BGM_DEFAULT_VOLUME
DEFAULT_BGM_FADE = PROJECT_BGM_DEFAULT_FADE
_AUDIO_RATE = 48_000
# force_style values: option assignments with ASS colour literals (&HBBGGRR).
# Kept as a first-pass charset; Phase E2 also tokenises via assert_safe_force_style.
_STYLE_CHARSET = re.compile(r"^[A-Za-z0-9_=,.:&\- ]*$")


class ComposeInvalidError(ValueError):
    """Raised when a composition request cannot be turned into a valid plan."""


@dataclass(frozen=True, slots=True)
class ShotSegment:
    shot_id: str
    title: str
    path: Path
    start: float
    duration: float
    is_placeholder: bool
    has_native_audio: bool
    voiceover_path: Path | None = None
    voiceover_duration: float = 0.0
    transition: str = ""
    trim_in: float = 0.0
    voiceover_volume: float = DEFAULT_VOICEOVER_VOLUME
    # §Phase E5: source pixel size (0 when unknown) lets the upscale pre-step
    # skip shots whose short edge already meets the 1080p target.
    source_width: int = 0
    source_height: int = 0


@dataclass(frozen=True, slots=True)
class ComposePlan:
    project_id: str
    segments: tuple[ShotSegment, ...]
    subtitle_mode: str
    voiceovers_enabled: bool
    bgm_path: Path | None
    bgm_volume: float
    # §Phase D3: independent fade-in / fade-out lengths (seconds; 0 = none).
    bgm_fade_in: float
    bgm_fade_out: float
    width: int
    height: int
    fps: int
    # Phase D2: burn-in style preset key / raw force_style, and the saved
    # subtitle asset burned by the "from_asset" source.
    subtitle_style: str = ""
    srt_asset_id: str = ""
    subtitle_font_size: int | None = None
    subtitle_primary_colour: str = ""
    upscale: bool = False

    @property
    def total_duration(self) -> float:
        return composed_duration(
            [segment.duration for segment in self.segments],
            [segment.transition for segment in self.segments],
        )


def _clamp(value: Any, low: float, high: float, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:  # NaN
        return default
    return max(low, min(high, number))


def normalize_compose_request(
    store: VideoStudioStore, project_id: str, request: dict[str, Any] | None
) -> dict[str, Any]:
    """Validate the client's compose request without touching ffmpeg.

    Runs both at job creation (fast 422 feedback) and again before execution
    (the storyboard may have changed in between).
    """
    payload = request if isinstance(request, dict) else {}
    project = store.get_project(project_id)
    if not project:
        raise KeyError(project_id)
    storyboard = store.get_storyboard(project_id)
    shots = sorted(storyboard["shots"], key=lambda item: item.get("order") or 0)

    raw_order = payload.get("shot_order")
    if raw_order is None:
        shot_order = [str(shot["id"]) for shot in shots]
    else:
        if not isinstance(raw_order, list) or not raw_order:
            raise ComposeInvalidError("The composition shot order cannot be empty")
        shot_order = [str(item) for item in raw_order]
        if any(not item or len(item) > 128 for item in shot_order):
            raise ComposeInvalidError("The composition shot order is invalid")
    if len(set(shot_order)) != len(shot_order):
        raise ComposeInvalidError("The composition shot order contains duplicates")
    if not shot_order:
        raise ComposeInvalidError("The storyboard has no shots to compose")
    if len(shot_order) > MAX_STORYBOARD_SHOTS:
        raise ComposeInvalidError("The composition exceeds the shot limit")
    by_id = {str(shot["id"]): shot for shot in shots}
    for shot_id in shot_order:
        shot = by_id.get(shot_id)
        if shot is None:
            raise ComposeInvalidError(f"Unknown storyboard shot: {shot_id}")
        if not shot.get("output_asset_id") and not shot.get("keyframe_asset_id"):
            label = str(shot.get("title") or shot_id)
            raise ComposeInvalidError(
                f'Shot "{label}" has no generated video or keyframe to compose yet'
            )

    subtitle = payload.get("subtitle") if isinstance(payload.get("subtitle"), dict) else {}
    subtitle_mode = str(subtitle.get("mode") or "off").strip().lower()
    if subtitle_mode not in SUBTITLE_MODES:
        raise ComposeInvalidError(
            "Unsupported subtitle source; use off, from_notes, from_asr or from_asset"
        )
    subtitle_style = str(subtitle.get("style") or "").strip()
    if len(subtitle_style) > 500 or (
        subtitle_style
        and subtitle_style not in SUBTITLE_STYLE_KEYS
        and not _STYLE_CHARSET.fullmatch(subtitle_style)
    ):
        raise ComposeInvalidError("The subtitle style preset is invalid")
    if subtitle_style and subtitle_style not in SUBTITLE_STYLE_KEYS:
        try:
            assert_safe_force_style(subtitle_style)
        except PostProductionError as exc:
            raise ComposeInvalidError(str(exc)) from exc
    try:
        subtitle_font_size = parse_font_size(subtitle.get("font_size"))
        subtitle_primary_colour = parse_primary_colour(
            subtitle.get("primary_colour") or subtitle.get("color")
        )
    except PostProductionError as exc:
        raise ComposeInvalidError(str(exc)) from exc
    srt_asset_id = str(subtitle.get("srt_asset_id") or "").strip()
    if subtitle_mode == "from_asset":
        if not srt_asset_id:
            raise ComposeInvalidError("Burning a saved subtitle document requires a subtitle asset")
        srt_asset = store.get_asset(srt_asset_id)
        if not srt_asset or srt_asset["project_id"] != project_id:
            raise ComposeInvalidError("The subtitle document must belong to this project")
        if srt_asset["kind"] != "subtitle":
            raise ComposeInvalidError("The selected asset is not a subtitle document")
    elif srt_asset_id:
        raise ComposeInvalidError(
            "A subtitle document can only be burned with the from_asset source"
        )

    # §Phase D3 BGM resolution: an explicitly provided request key wins; a
    # missing key inherits the project's saved slot (asset, mix level and both
    # fades). `bgm_asset_id=""` sent on purpose therefore means "no music this
    # time", while omitting the key keeps the project's configured bed.
    audio = payload.get("audio") if isinstance(payload.get("audio"), dict) else None

    def _bgm_value(key: str, legacy_key: str = "") -> Any:
        if audio is not None:
            if key in audio and audio[key] is not None:
                return audio[key]
            if legacy_key and legacy_key in audio and audio[legacy_key] is not None:
                # Pre-D3 plans persisted one symmetric fade; honour it for
                # queued jobs created before the split.
                return audio[legacy_key]
        return project.get(key)

    if audio is not None and "bgm_asset_id" in audio:
        bgm_asset_id = str(audio.get("bgm_asset_id") or "").strip()
    else:
        bgm_asset_id = str(project.get("bgm_asset_id") or "").strip()
    if bgm_asset_id:
        bgm_asset = store.get_asset(bgm_asset_id)
        if not bgm_asset or bgm_asset["project_id"] != project_id:
            raise ComposeInvalidError("The background music asset must belong to this project")
        if bgm_asset["kind"] != "audio":
            raise ComposeInvalidError("The background music must be an audio asset")

    raw_output = payload.get("output") if isinstance(payload.get("output"), dict) else {}
    upscale = bool(raw_output.get("upscale"))
    if upscale:
        raw_output = {**raw_output, "resolution": "1080p", "upscale": True}
    return {
        "shot_order": shot_order,
        "subtitle": {
            "mode": subtitle_mode,
            "style": subtitle_style,
            "srt_asset_id": srt_asset_id,
            "font_size": subtitle_font_size,
            "primary_colour": subtitle_primary_colour,
        },
        "audio": {
            "voiceovers": bool(audio.get("voiceovers", True)) if audio is not None else True,
            "bgm_asset_id": bgm_asset_id,
            "bgm_volume": _clamp(
                _bgm_value("bgm_volume"), *BGM_VOLUME_RANGE, default=DEFAULT_BGM_VOLUME
            ),
            "bgm_fade_in": _clamp(
                _bgm_value("bgm_fade_in", "bgm_fade"),
                *BGM_FADE_RANGE,
                default=DEFAULT_BGM_FADE,
            ),
            "bgm_fade_out": _clamp(
                _bgm_value("bgm_fade_out", "bgm_fade"),
                *BGM_FADE_RANGE,
                default=DEFAULT_BGM_FADE,
            ),
        },
        "output": dict(raw_output),
    }


def _normalize_output(payload: dict[str, Any]) -> tuple[str, int, bool]:
    output = payload.get("output") if isinstance(payload.get("output"), dict) else {}
    upscale = bool(output.get("upscale"))
    resolution = str(output.get("resolution") or "720p").strip().lower()
    if upscale:
        resolution = "1080p"
    if resolution not in RESOLUTION_SIZES:
        raise ComposeInvalidError("Unsupported output resolution")
    try:
        fps = int(output.get("fps") or 30)
    except (TypeError, ValueError):
        fps = 30
    if fps not in FPS_CHOICES:
        raise ComposeInvalidError("Unsupported output frame rate")
    if str(output.get("format") or "mp4").strip().lower() != "mp4":
        raise ComposeInvalidError("Only MP4 composition output is supported")
    return resolution, fps, upscale


async def build_compose_plan(
    store: VideoStudioStore, project_id: str, request: dict[str, Any] | None
) -> ComposePlan:
    """Resolve the request into executable segments (probes media with ffprobe).

    Probing runs concurrently across shots — long storyboards used to pay the
    full serial cost of up to two ffprobe launches per shot before rendering
    could even start. Per-shot error semantics are preserved exactly: a video
    probe failure aborts its shot, a failed voiceover probe degrades to zero.
    """
    normalized = normalize_compose_request(store, project_id, request)
    resolution, fps, upscale = _normalize_output(normalized)
    width, height = RESOLUTION_SIZES[resolution]
    tool = get_ffmpeg_tool()
    tool.ensure()

    storyboard = store.get_storyboard(project_id)
    by_id = {str(shot["id"]): shot for shot in storyboard["shots"]}

    # ── pass 1: resolve every asset/path/trim without touching ffmpeg ──
    prepared: list[dict[str, Any]] = []
    for shot_id in normalized["shot_order"]:
        shot = by_id[shot_id]
        label = str(shot.get("title") or shot_id)
        output_asset_id = str(shot.get("output_asset_id") or "")
        keyframe_id = str(shot.get("keyframe_asset_id") or "")
        is_placeholder = False
        try:
            shot_duration = float(shot.get("duration") or 0.0)
        except (TypeError, ValueError):
            shot_duration = 0.0
        media_path: Path | None = None
        source_width = 0
        source_height = 0
        if output_asset_id:
            asset = store.get_asset(output_asset_id)
            if not asset or asset["kind"] != "video":
                raise ComposeInvalidError(f'Shot "{label}" no longer has its video output')
            media_path = store.asset_path(output_asset_id)
        else:
            asset = store.get_asset(keyframe_id)
            if not asset or asset["kind"] != "image":
                raise ComposeInvalidError(f'Shot "{label}" no longer has its keyframe')
            media_path = store.asset_path(keyframe_id)
            is_placeholder = True
            requested = shot_duration or DEFAULT_PLACEHOLDER_SECONDS
            shot_duration = max(0.5, min(requested, MAX_PLACEHOLDER_SECONDS))
        try:
            trim_in = parse_optional_seconds(shot.get("trim_in"), field="trim_in")
            trim_out = parse_optional_seconds(shot.get("trim_out"), field="trim_out")
            voiceover_volume = (
                parse_voiceover_volume(shot.get("voiceover_volume")) or DEFAULT_VOICEOVER_VOLUME
            )
        except PostProductionError as exc:
            raise ComposeInvalidError(f'Shot "{label}": {exc}') from exc
        voiceover_path: Path | None = None
        if normalized["audio"]["voiceovers"] and shot.get("voiceover_asset_id"):
            voice_asset = store.get_asset(str(shot.get("voiceover_asset_id")))
            if voice_asset and voice_asset["kind"] == "audio":
                voiceover_path = store.asset_path(voice_asset["id"])
        prepared.append(
            {
                "shot_id": shot_id,
                "title": label,
                "path": media_path,
                "is_placeholder": is_placeholder,
                "placeholder_duration": shot_duration,
                "trim_in": trim_in,
                "trim_out": trim_out,
                "voiceover_volume": voiceover_volume,
                "voiceover_path": voiceover_path,
                "transition": str(shot.get("transition") or ""),
                "voiceover_text": str(shot.get("voiceover_text") or ""),
                "notes": str(shot.get("notes") or ""),
            }
        )

    # ── pass 2: probe every media file concurrently (bounded fan-out) ──
    semaphore = asyncio.Semaphore(8)

    async def _bounded_probe(media: Path):
        async with semaphore:
            return await tool.probe_media(media)

    probes: list[Any] = []
    for item in prepared:
        if not item["is_placeholder"]:
            probes.append(_bounded_probe(item["path"]))
        if item["voiceover_path"] is not None:
            probes.append(_bounded_probe(item["voiceover_path"]))
    results = await asyncio.gather(*probes, return_exceptions=True)

    # ── pass 3: assemble segments, replaying the sequential error rules ──
    cursor = {"index": 0}

    def _take() -> Any:
        value = results[cursor["index"]]
        cursor["index"] += 1
        return value

    pending: list[dict[str, Any]] = []
    for item in prepared:
        label = item["title"]
        source_duration = item["placeholder_duration"]
        has_audio = False
        source_width = 0
        source_height = 0
        if not item["is_placeholder"]:
            probe = _take()
            if isinstance(probe, BaseException):
                raise probe
            source_duration = float(probe.duration or 0.0) or item["placeholder_duration"]
            has_audio = bool(probe.has_audio)
            try:
                source_width = int(probe.width or 0)
            except (TypeError, ValueError):
                source_width = 0
            try:
                source_height = int(probe.height or 0)
            except (TypeError, ValueError):
                source_height = 0
        if source_duration <= 0:
            raise ComposeInvalidError(f'Shot "{label}" has no measurable duration')
        try:
            window_in, window_out = effective_trim(
                source_duration=source_duration, trim_in=item["trim_in"], trim_out=item["trim_out"]
            )
        except PostProductionError as exc:
            raise ComposeInvalidError(f'Shot "{label}": {exc}') from exc
        duration = window_out - window_in

        voiceover_duration = 0.0
        if item["voiceover_path"] is not None:
            voice_probe = _take()
            if isinstance(voice_probe, FFmpegFailedError):
                voiceover_duration = 0.0
            elif isinstance(voice_probe, BaseException):
                raise voice_probe
            else:
                voiceover_duration = float(voice_probe.duration or 0.0)
            if voiceover_duration <= 0:
                voiceover_duration = duration

        pending.append(
            {
                "shot_id": item["shot_id"],
                "title": label,
                "path": item["path"],
                "duration": duration,
                "is_placeholder": item["is_placeholder"],
                "has_native_audio": has_audio,
                "voiceover_path": item["voiceover_path"],
                "voiceover_duration": voiceover_duration,
                "transition": item["transition"],
                "trim_in": window_in,
                "voiceover_volume": item["voiceover_volume"],
                "voiceover_text": item["voiceover_text"],
                "notes": item["notes"],
                "source_width": source_width,
                "source_height": source_height,
            }
        )

    durations = [item["duration"] for item in pending]
    transitions = [item["transition"] for item in pending]
    starts, _overlaps, timeline = composed_timeline(durations, transitions)
    segments: list[ShotSegment] = []
    for index, item in enumerate(pending):
        segments.append(
            ShotSegment(
                shot_id=item["shot_id"],
                title=item["title"],
                path=item["path"],
                start=starts[index],
                duration=item["duration"],
                is_placeholder=item["is_placeholder"],
                has_native_audio=item["has_native_audio"],
                voiceover_path=item["voiceover_path"],
                voiceover_duration=item["voiceover_duration"],
                transition=item["transition"],
                trim_in=item["trim_in"],
                voiceover_volume=item["voiceover_volume"],
                source_width=int(item.get("source_width") or 0),
                source_height=int(item.get("source_height") or 0),
            )
        )

    if timeline > MAX_COMPOSE_TOTAL_SECONDS:
        raise ComposeInvalidError("The composition exceeds the 30 minute duration limit")

    bgm_path: Path | None = None
    if normalized["audio"]["bgm_asset_id"]:
        bgm_asset = store.get_asset(normalized["audio"]["bgm_asset_id"])
        if bgm_asset:
            bgm_path = store.asset_path(bgm_asset["id"])

    return ComposePlan(
        project_id=project_id,
        segments=tuple(segments),
        subtitle_mode=normalized["subtitle"]["mode"],
        voiceovers_enabled=normalized["audio"]["voiceovers"],
        bgm_path=bgm_path,
        bgm_volume=normalized["audio"]["bgm_volume"],
        bgm_fade_in=normalized["audio"]["bgm_fade_in"],
        bgm_fade_out=normalized["audio"]["bgm_fade_out"],
        width=width,
        height=height,
        fps=fps,
        subtitle_style=normalized["subtitle"]["style"],
        srt_asset_id=normalized["subtitle"]["srt_asset_id"],
        subtitle_font_size=normalized["subtitle"].get("font_size"),
        subtitle_primary_colour=normalized["subtitle"].get("primary_colour") or "",
        upscale=upscale,
    )


def _video_chain(plan: ComposePlan, index: int) -> str:
    return (
        f"[{index}:v]scale={plan.width}:{plan.height}"
        f":force_original_aspect_ratio=decrease,"
        f"pad={plan.width}:{plan.height}:(ow-iw)/2:(oh-ih)/2:black,"
        f"fps={plan.fps},setsar=1,format=yuv420p[v{index}]"
    )


def _segment_xfade(plan: ComposePlan, index: int) -> str | None:
    if index + 1 >= len(plan.segments):
        return None
    left = plan.segments[index]
    right = plan.segments[index + 1]
    if (
        overlap_for_transition(
            left.transition,
            left_duration=left.duration,
            right_duration=right.duration,
        )
        <= 0
    ):
        return None
    return xfade_name(left.transition)


def _uses_xfade(plan: ComposePlan) -> bool:
    return any(_segment_xfade(plan, index) for index in range(len(plan.segments)))


def _link_video_segments(plan: ComposePlan, filters: list[str]) -> str:
    """Hard-cut concat, or sequential xfade when any adjacent pair fades."""
    count = len(plan.segments)
    if not _uses_xfade(plan):
        concat_inputs = "".join(f"[v{index}]" for index in range(count))
        filters.append(f"{concat_inputs}concat=n={count}:v=1:a=0[vcat]")
        return "vcat"
    current = "v0"
    current_duration = plan.segments[0].duration
    for index in range(1, count):
        name = _segment_xfade(plan, index - 1)
        out = f"vx{index}"
        if name:
            offset = current_duration - overlap_for_transition(
                plan.segments[index - 1].transition,
                left_duration=plan.segments[index - 1].duration,
                right_duration=plan.segments[index].duration,
            )
            filters.append(
                f"[{current}][v{index}]xfade=transition={name}"
                f":duration={overlap_for_transition(plan.segments[index - 1].transition, left_duration=plan.segments[index - 1].duration, right_duration=plan.segments[index].duration):.3f}"
                f":offset={offset:.3f}[{out}]"
            )
            current_duration = (
                current_duration
                + plan.segments[index].duration
                - overlap_for_transition(
                    plan.segments[index - 1].transition,
                    left_duration=plan.segments[index - 1].duration,
                    right_duration=plan.segments[index].duration,
                )
            )
        else:
            filters.append(f"[{current}][v{index}]concat=n=2:v=1:a=0[{out}]")
            current_duration += plan.segments[index].duration
        current = out
    return current


def _link_audio_segments(plan: ComposePlan, filters: list[str]) -> None:
    count = len(plan.segments)
    if not _uses_xfade(plan):
        audio_inputs = "".join(f"[a{index}]" for index in range(count))
        filters.append(f"{audio_inputs}concat=n={count}:v=0:a=1[abase]")
        return
    current = "a0"
    for index in range(1, count):
        out = f"ax{index}"
        overlap = overlap_for_transition(
            plan.segments[index - 1].transition,
            left_duration=plan.segments[index - 1].duration,
            right_duration=plan.segments[index].duration,
        )
        if overlap > 0:
            filters.append(f"[{current}][a{index}]acrossfade=d={overlap:.3f}[{out}]")
        else:
            filters.append(f"[{current}][a{index}]concat=n=2:v=0:a=1[{out}]")
        current = out
    if current != "abase":
        filters.append(f"[{current}]anull[abase]")


def _resolved_burn_style(plan: ComposePlan) -> str:
    base = resolve_subtitle_style(plan.subtitle_style)
    return apply_style_overrides(
        base,
        font_size=plan.subtitle_font_size,
        primary_colour=plan.subtitle_primary_colour,
    )


def _build_ffmpeg_arguments(plan: ComposePlan, *, srt_name: str, output_path: Path) -> list[str]:
    """Assemble the full ffmpeg argument array (never a shell string)."""
    if srt_name:
        assert_safe_srt_name(srt_name)
    args: list[str] = []
    for segment in plan.segments:
        if segment.is_placeholder:
            args += ["-loop", "1", "-t", f"{segment.duration:.3f}", "-i", str(segment.path)]
        else:
            if segment.trim_in > 0:
                args += ["-ss", f"{segment.trim_in:.3f}"]
            args += ["-t", f"{segment.duration:.3f}", "-i", str(segment.path)]
    voiced = [segment for segment in plan.segments if segment.voiceover_path]
    for segment in voiced:
        assert segment.voiceover_path is not None
        args += ["-i", str(segment.voiceover_path)]
    if plan.bgm_path is not None:
        args += ["-stream_loop", "-1", "-i", str(plan.bgm_path)]

    filters: list[str] = []
    count = len(plan.segments)
    for index in range(count):
        filters.append(_video_chain(plan, index))
    video_base = _link_video_segments(plan, filters)

    video_label = video_base
    if srt_name:
        # Phase D2/E2 burn-in styles: preset key or raw force_style, plus the
        # optional size/colour overrides. Quoted so commas survive parsing.
        burn = f"subtitles={srt_name}"
        style = _resolved_burn_style(plan)
        if style:
            burn += f":force_style='{style}'"
        filters.append(f"[{video_base}]{burn}[vsub]")
        video_label = "vsub"

    audio_label = ""
    wants_audio = (
        plan.bgm_path is not None
        or bool(voiced)
        or any(segment.has_native_audio and not segment.is_placeholder for segment in plan.segments)
    )
    if wants_audio:
        for index, segment in enumerate(plan.segments):
            if segment.has_native_audio and not segment.is_placeholder:
                filters.append(
                    f"[{index}:a]aresample={_AUDIO_RATE},"
                    f"aformat=sample_fmts=fltp:channel_layouts=stereo[a{index}]"
                )
            else:
                filters.append(
                    f"anullsrc=r={_AUDIO_RATE}:cl=stereo:d={segment.duration:.3f}[a{index}]"
                )
        _link_audio_segments(plan, filters)
        mix_inputs = ["[abase]"]
        for voice_index, segment in enumerate(voiced):
            input_index = count + voice_index
            delay_ms = int(round(segment.start * 1000))
            volume = (
                f",volume={segment.voiceover_volume:.2f}"
                if abs(segment.voiceover_volume - DEFAULT_VOICEOVER_VOLUME) > 1e-9
                else ""
            )
            filters.append(
                f"[{input_index}:a]aresample={_AUDIO_RATE},"
                f"aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"adelay={delay_ms}|{delay_ms}{volume}[vo{voice_index}]"
            )
            mix_inputs.append(f"[vo{voice_index}]")
        if plan.bgm_path is not None:
            input_index = count + len(voiced)
            # §Phase D3: independent fade-in / fade-out (0 disables either).
            chain = (
                f"[{input_index}:a]aresample={_AUDIO_RATE},"
                f"aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"volume={plan.bgm_volume:.2f}"
            )
            if plan.bgm_fade_in > 0:
                chain += f",afade=t=in:st=0:d={plan.bgm_fade_in:.2f}"
            if plan.bgm_fade_out > 0:
                fade_out_start = max(0.0, plan.total_duration - plan.bgm_fade_out)
                chain += f",afade=t=out:st={fade_out_start:.2f}:d={plan.bgm_fade_out:.2f}"
            chain += f",atrim=0:{plan.total_duration:.3f}[bgm]"
            filters.append(chain)
            if voiced:
                # E4: duck BGM ~6 dB under speech via sidechaincompress.
                if len(voiced) == 1:
                    filters.append("[vo0]asplit=2[vomix][vosc]")
                    mix_inputs = ["[abase]", "[vomix]"]
                else:
                    joined = "".join(f"[vo{index}]" for index in range(len(voiced)))
                    filters.append(
                        f"{joined}amix=inputs={len(voiced)}:duration=longest:normalize=0[voall]"
                    )
                    filters.append("[voall]asplit=2[vomix][vosc]")
                    mix_inputs = ["[abase]", "[vomix]"]
                filters.append(ducking_filter())
                mix_inputs.append("[bgmduck]")
            else:
                mix_inputs.append("[bgm]")
        audio_label = "aout"
        filters.append(
            f"{''.join(mix_inputs)}amix=inputs={len(mix_inputs)}"
            f":duration=longest:normalize=0[{audio_label}]"
        )

    args += ["-filter_complex", ";".join(filters)]
    args += ["-map", f"[{video_label}]"]
    if audio_label:
        args += ["-map", f"[{audio_label}]"]
    else:
        args += ["-an"]
    args += [
        "-t",
        f"{plan.total_duration:.3f}",
        "-c:v",
        "libx264",
        "-crf",
        "20",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
    ]
    if audio_label:
        args += ["-c:a", "aac", "-b:a", "192k"]
    args += ["-movflags", "+faststart", "-progress", "pipe:1", str(output_path)]
    return args


def compose_project(
    store: VideoStudioStore,
    *,
    project_id: str,
    request: dict[str, Any] | None,
    client_request_id: str,
) -> dict[str, Any]:
    """Validate, persist and enqueue a local composition job.

    Composition never calls a provider, so — like ``plan_episode`` — it is
    exempt from cost confirmation. Everything still flows through the regular
    job state machine (queue, progress events, cancellation, outputs).
    """
    normalized = normalize_compose_request(store, project_id, request)
    resolution, fps, upscale = _normalize_output(normalized)
    normalized["output"] = {
        "resolution": resolution,
        "fps": fps,
        "format": "mp4",
        "upscale": upscale,
    }
    job = store.create_job(
        project_id,
        {
            "operation": "compose",
            "profile_id": "",
            "model_id": "",
            "prompt": f"Local composition of {len(normalized['shot_order'])} storyboard shots",
            "inputs": [],
            "parameters": {"compose_plan": normalized},
            "client_request_id": client_request_id,
            "owner_user_id": get_current_user().id,
            "config_revision": "local-compose",
        },
    )
    start_video_job(store, job["id"])
    return job


def _read_subtitle_asset(store: VideoStudioStore, asset_id: str) -> str:
    """Load a saved subtitle asset's SRT text (BOM tolerated)."""
    asset = store.get_asset(asset_id) if asset_id else None
    if not asset or asset["kind"] != "subtitle":
        raise ComposeInvalidError("The subtitle document is no longer available")
    try:
        return store.asset_path(asset_id).read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        raise ComposeInvalidError("The subtitle document could not be read") from exc


async def _transcribe_composition_audio(
    tool: Any,
    plan: ComposePlan,
    workspace: Path,
    *,
    on_progress: Any = None,
) -> str:
    """Phase D2 ``from_asr``: per-shot STT → timeline merge → one SRT document.

    Each shot contributes the audio it will actually carry in the composition —
    its native video track when present, else its voiceover — transcribed with
    ``want_segments=True`` (D1 verbose_json). Every shot's segments are then
    shifted by its composition start and de-overlapped into one document.
    """
    candidates: list[tuple[ShotSegment, Path]] = []
    for segment in plan.segments:
        if segment.has_native_audio and not segment.is_placeholder:
            candidates.append((segment, segment.path))
        elif segment.voiceover_path is not None:
            candidates.append((segment, segment.voiceover_path))
    per_shot: list[tuple[float, Sequence[Mapping[str, Any]]]] = []
    degraded = False
    for position, (segment, source) in enumerate(candidates):
        if on_progress is not None:
            on_progress(
                position / max(1, len(candidates)), f"Transcribing audio for {segment.title}"
            )
        wav = workspace / f"stt_{position}.wav"
        await tool.extract_audio(source, wav)
        try:
            result = await transcribe_audio(
                wav.read_bytes(),
                filename="audio.wav",
                content_type="audio/wav",
                want_segments=True,
            )
        finally:
            wav.unlink(missing_ok=True)
        if result.segments_supported and result.segments:
            per_shot.append((segment.start, result.segments))
        elif str(result).strip():
            degraded = True  # gateway answered text-only (no verbose_json)
    if not per_shot:
        if degraded:
            raise ComposeInvalidError(
                "The STT gateway returned no timestamps; use narration-based subtitles instead"
            )
        raise ComposeInvalidError("No shot audio could be transcribed for automatic subtitles")
    if on_progress is not None:
        on_progress(1.0, "Automatic subtitles are ready")
    return serialize_srt(merge_shifted_segments(per_shot))


async def _upscale_plan_segments(
    plan: ComposePlan,
    workspace: Path,
    *,
    on_progress: Any = None,
) -> ComposePlan:
    """§Phase E5: frame-by-frame upscale of every sub-1080p video shot.

    Shots already at (or above) the target edge and keyframe placeholders are
    left untouched — the normalisation filter chain scales those anyway. This
    pre-step is deliberately labelled experimental in the UI: it is slow local
    CPU work and never calls a provider.
    """
    tool = get_ffmpeg_tool()
    targets = [
        (index, segment)
        for index, segment in enumerate(plan.segments)
        if not segment.is_placeholder
        and 0 < segment.source_width
        and 0 < segment.source_height
        and min(segment.source_width, segment.source_height) < UPSCALE_TARGET_EDGE
    ]
    if not targets:
        return plan
    replaced: dict[int, ShotSegment] = {}
    for position, (index, segment) in enumerate(targets):
        dest = workspace / f"upscaled_{index}.mp4"
        if on_progress is not None:

            def step(
                fraction: float,
                base_position: int = position,
                title: str = segment.title,
                total: int = len(targets),
            ) -> None:
                clamped = max(0.0, min(1.0, float(fraction)))
                on_progress(
                    (base_position + clamped) / total,
                    f"Upscaling {title} to 1080p",
                )

        else:
            step = None
        await upscale_clip_to_1080p(tool, segment.path, dest, fps=float(plan.fps), on_progress=step)
        replaced[index] = replace(
            segment,
            path=dest,
            source_width=UPSCALE_TARGET_SIZE[0],
            source_height=UPSCALE_TARGET_SIZE[1],
        )
    segments = tuple(replaced.get(index, segment) for index, segment in enumerate(plan.segments))
    return replace(plan, segments=segments)


async def run_compose_job(store: VideoStudioStore, job_id: str) -> None:
    """Execute one queued composition job through the local ffmpeg runtime."""
    job = store._internal_job(job_id)
    if not job or job["status"] not in {"queued", "submitting", "running"}:
        return
    if job["status"] == "queued" and not store.claim_submission(job_id):
        return
    store.record_provider_task(job_id, f"local:{job_id}")
    project_id = str(job["project_id"])
    output_path = store.uploads_root / f"compose_{uuid4().hex}.mp4"
    workspace: tempfile.TemporaryDirectory[str] | None = None
    try:
        request = (job.get("parameters") or {}).get("compose_plan") or {}
        plan = await build_compose_plan(store, project_id, request)
        store.update_progress(job_id, 0.03, "composing", "Preparing the local composition")
        workspace = tempfile.TemporaryDirectory(prefix="knorvia-compose-")
        base = Path(workspace.name)
        srt_name = ""
        if plan.subtitle_mode in {"from_notes", "from_asset", "from_asr"}:
            if plan.subtitle_mode == "from_notes":
                storyboard = store.get_storyboard(project_id)
                by_id = {str(shot["id"]): shot for shot in storyboard["shots"]}
                subtitle_shots = [
                    {
                        "voiceover_text": str(
                            by_id.get(segment.shot_id, {}).get("voiceover_text") or ""
                        ),
                        "notes": str(by_id.get(segment.shot_id, {}).get("notes") or ""),
                        "title": str(by_id.get(segment.shot_id, {}).get("title") or ""),
                        "duration": segment.duration,
                    }
                    for segment in plan.segments
                ]
                document = build_srt_from_shots(subtitle_shots)
            elif plan.subtitle_mode == "from_asset":
                document = _read_subtitle_asset(store, plan.srt_asset_id)
            else:  # from_asr — Phase D2 automatic subtitles

                def transcribing(fraction: float, message: str) -> None:
                    store.update_progress(job_id, 0.03 + 0.02 * fraction, "transcribing", message)

                document = await _transcribe_composition_audio(
                    get_ffmpeg_tool(), plan, base, on_progress=transcribing
                )
                if document.strip():
                    # Keep the generated SRT as a project asset: the subtitle
                    # editor loads it for polishing, and from_asset can re-burn
                    # the edited version. A failed byproduct save must not
                    # sink an otherwise finished composition.
                    try:
                        store.save_subtitle_document(
                            project_id,
                            document,
                            filename=f"subtitles-{job_id}.srt",
                            origin="generated",
                        )
                    except ValueError:
                        logger.warning(
                            "Generated subtitle document for job %s could not be saved",
                            job_id,
                        )
            if document.strip():
                (base / "subtitles.srt").write_text(document, encoding="utf-8")
                srt_name = "subtitles.srt"
        if plan.upscale:
            # §Phase E5: upscale owns the 0.05→0.60 progress band when active,
            # squeezing the render into 0.60→0.95 so the bar keeps moving.
            def upscaling(fraction: float, message: str) -> None:
                store.update_progress(job_id, 0.05 + 0.55 * fraction, "upscaling", message)

            plan = await _upscale_plan_segments(plan, base, on_progress=upscaling)
            render_floor = 0.60
        else:
            render_floor = 0.05
        args = _build_ffmpeg_arguments(plan, srt_name=srt_name, output_path=output_path)
        store.update_progress(job_id, render_floor, "composing", "Rendering the composition")

        def report(fraction: float) -> None:
            store.update_progress(
                job_id,
                render_floor + (0.95 - render_floor) * fraction,
                "composing",
                "Rendering the composition",
            )

        await get_ffmpeg_tool().run(
            args,
            timeout=COMPOSE_TIMEOUT_SECONDS,
            on_progress=report,
            expected_total=plan.total_duration,
            cwd=base,
        )
        if not output_path.is_file() or output_path.stat().st_size == 0:
            raise FFmpegFailedError("The local composition produced no output.")
        if output_path.stat().st_size > MAX_OUTPUT_BYTES:
            raise ComposeInvalidError("The composed video exceeds the storage limit")
        asset = store.adopt_output_file(
            project_id, output_path, "video/mp4", filename=f"composition-{job_id}.mp4"
        )
        if not store.complete_job_with_output(job_id, asset["id"]):
            store.delete_asset(asset["id"])
    except asyncio.CancelledError:
        output_path.unlink(missing_ok=True)
        if workspace is not None:
            workspace.cleanup()
        raise
    except FFmpegUnavailableError as exc:
        store.transition_terminal(
            job_id, "failed", error_code="ffmpeg_unavailable", error_message=str(exc)
        )
    except VoiceProviderError as exc:
        # from_asr needs a working STT gateway; without one the job fails with
        # a dedicated code so the UI can point the user at the voice settings.
        store.transition_terminal(
            job_id,
            "failed",
            error_code="stt_unavailable",
            error_message=f"Automatic subtitles need a speech-to-text gateway: {exc}"[:1000],
        )
    except UpscaleError as exc:
        # §Phase E5: the experimental pre-step needs the local Real-ESRGAN
        # engine; give it a dedicated code so the UI can point at the settings.
        store.transition_terminal(
            job_id, "failed", error_code="upscale_unavailable", error_message=str(exc)
        )
    except ValueError as exc:
        store.transition_terminal(
            job_id, "failed", error_code="compose_invalid", error_message=str(exc)
        )
    except FFmpegFailedError as exc:
        store.transition_terminal(
            job_id, "failed", error_code="ffmpeg_failed", error_message=str(exc)
        )
    except Exception as exc:  # defensive: never leave a job stuck in running
        store.transition_terminal(
            job_id,
            "failed",
            error_code="ffmpeg_failed",
            error_message=f"The local composition failed: {exc}"[:1000],
        )
    finally:
        output_path.unlink(missing_ok=True)
        if workspace is not None:
            workspace.cleanup()


def list_compositions(
    store: VideoStudioStore, project_id: str, *, limit: int = 50
) -> list[dict[str, Any]]:
    """Finished compose jobs newest-first, with their output assets attached.

    The store filters ``operation='compose'`` server-side and every output
    asset loads in one bulk query — the previous implementation paged through
    the whole job history and reopened the asset table per output.
    """
    entries: list[dict[str, Any]] = []
    cursor: float | None = None
    while len(entries) < limit:
        page = store.list_jobs(project_id, operation="compose", limit=100, before=cursor)
        if not page:
            break
        cursor = page[-1].get("created_at")
        for job in page:
            if job.get("status") not in {"succeeded", "failed", "cancelled", "interrupted"}:
                continue
            entry = dict(job)
            entry["output_asset_ids"] = list(job.get("output_asset_ids") or [])
            entries.append(entry)
        if len(page) < 100:
            break
    wanted = [asset_id for entry in entries for asset_id in entry["output_asset_ids"]]
    assets = store.get_assets_by_ids(wanted)
    for entry in entries:
        entry["output_assets"] = [
            assets[asset_id] for asset_id in entry["output_asset_ids"] if asset_id in assets
        ]
    return entries[:limit]


__all__ = [
    "ComposeInvalidError",
    "ComposePlan",
    "MAX_COMPOSE_TOTAL_SECONDS",
    "RESOLUTION_SIZES",
    "ShotSegment",
    "build_compose_plan",
    "compose_project",
    "list_compositions",
    "normalize_compose_request",
    "run_compose_job",
]
