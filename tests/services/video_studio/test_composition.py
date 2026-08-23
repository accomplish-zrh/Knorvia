from __future__ import annotations

import asyncio
from dataclasses import replace
import hashlib
from pathlib import Path
from typing import Any

import pytest

from knorvia.services.video_studio import composition
from knorvia.services.video_studio.ffmpeg_tool import (
    FFmpegFailedError,
    FFmpegUnavailableError,
    MediaProbe,
)
from knorvia.services.video_studio.store import VideoStudioStore
from knorvia.services.video_studio.subtitles import (
    SUBTITLE_STYLE_PRESETS,
    build_srt_from_shots,
    format_timestamp,
    merge_shifted_segments,
    parse_srt,
    resolve_cue_overlaps,
    resolve_subtitle_style,
    serialize_srt,
    split_caption_lines,
    srt_from_segments,
)
from knorvia.services.voice import TranscriptionResult, VoiceProviderError

MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isomtest-video"
PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    + b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    + b"\x00\x00\x00\x0aIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n\x2d\xb4"
    + b"\x00\x00\x00\x00IEND\xaeB`\x82"
)
WAV = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00" + b"\x00" * 16


def _upload(store: VideoStudioStore, project_id: str, data: bytes, mime: str, name: str):
    upload = store.create_upload(
        project_id, name, mime, len(data), hashlib.sha256(data).hexdigest()
    )
    store.write_upload_part(upload["id"], 0, data)
    return store.complete_upload(upload["id"])


class _FakeTool:
    """Stands in for FFmpegTool: scripted probes plus a recording ffmpeg run."""

    def __init__(
        self,
        *,
        probes: dict[str, MediaProbe] | None = None,
        default_probe: MediaProbe | None = None,
        unavailable: bool = False,
        fail_run: bool = False,
        hang_run: bool = False,
        output: bytes | None = MP4,
    ) -> None:
        self.probes = probes or {}
        self.default_probe = default_probe or MediaProbe(5.0, 1280, 720, 30.0, False)
        self.unavailable = unavailable
        self.fail_run = fail_run
        self.hang_run = hang_run
        self.output = output
        self.runs: list[list[str]] = []
        self.extracts: list[tuple[str, str]] = []
        self.burned_srt = ""

    def ensure(self) -> Any:
        if self.unavailable:
            raise FFmpegUnavailableError("no ffmpeg")
        return object()

    async def probe_media(self, path: Path) -> MediaProbe:
        return self.probes.get(path.name, self.default_probe)

    async def extract_audio(self, media: Path, output: Path) -> Path:
        self.extracts.append((media.name, output.name))
        output.write_bytes(WAV)
        return output

    async def run(self, args, *, timeout=3600.0, on_progress=None, expected_total=None, cwd=None):
        self.runs.append(list(args))
        if cwd is not None:
            burned = Path(cwd) / "subtitles.srt"
            self.burned_srt = burned.read_text(encoding="utf-8") if burned.is_file() else ""
        if self.fail_run:
            raise FFmpegFailedError("boom")
        if self.hang_run:
            await asyncio.sleep(30)
            return b"", b""
        if on_progress is not None and expected_total:
            on_progress(0.5)
        output_path = Path(str(args[-1]))
        if self.output is not None:
            output_path.write_bytes(self.output)
        return b"progress=continue\n", b""


def _project_with_shots(tmp_path: Path, shots_spec: list[dict[str, Any]]):
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Compose")
    shots = []
    for index, spec in enumerate(shots_spec):
        shot = {
            "id": spec.get("id", f"shot-{index}"),
            "order": index,
            "title": spec.get("title", f"Shot {index}"),
            "prompt": spec.get("prompt", "a scene"),
            "notes": spec.get("notes", ""),
            "duration": spec.get("duration"),
        }
        if spec.get("video"):
            asset = _upload(store, project["id"], MP4, "video/mp4", f"clip{index}.mp4")
            shot["output_asset_id"] = asset["id"]
        if spec.get("keyframe"):
            asset = _upload(store, project["id"], PNG, "image/png", f"key{index}.png")
            shot["keyframe_asset_id"] = asset["id"]
        if spec.get("voiceover"):
            asset = _upload(store, project["id"], WAV, "audio/wav", f"vo{index}.wav")
            shot["voiceover_asset_id"] = asset["id"]
            shot["voiceover_text"] = spec["voiceover"]
        shots.append(shot)
    storyboard = store.save_storyboard(project["id"], {"shots": shots}, expected_revision=0)
    return store, project, storyboard


# ── subtitles ────────────────────────────────────────────────────────────────


def test_timestamp_formatting_round_trip() -> None:
    assert format_timestamp(0.0) == "00:00:00,000"
    assert format_timestamp(3661.5) == "01:01:01,500"
    cues = parse_srt(
        "1\n00:00:01,000 --> 00:00:03,500\nHello world\n\n"
        "2\n00:00:04,000 --> 00:00:06,000\n第二句\n"
    )
    assert [cue["text"] for cue in cues] == ["Hello world", "第二句"]
    assert cues[0]["start"] == 1.0 and cues[0]["end"] == 3.5
    assert parse_srt(serialize_srt(cues)) == cues


def test_split_caption_lines_respects_width_and_sentences() -> None:
    lines = split_caption_lines("第一句比较长。第二句短！Third sentence here.")
    assert all(len(line) <= 42 for line in lines)
    assert "".join(lines).replace(" ", "") == "第一句比较长。第二句短！Thirdsentencehere.".replace(
        " ", ""
    )
    assert split_caption_lines("") == []


def test_build_srt_from_shots_uses_priority_and_durations() -> None:
    document = build_srt_from_shots(
        [
            {"voiceover_text": "配音文案", "notes": "notes one", "title": "T1", "duration": 4.0},
            {"notes": "只有备注", "title": "T2", "duration": 2.0},
            {"title": "只有标题", "duration": 1.0},
        ]
    )
    cues = parse_srt(document)
    texts = [cue["text"] for cue in cues]
    assert "配音文案" in texts
    assert "只有备注" in texts
    assert "只有标题" in texts
    assert cues[0]["start"] == 0.0
    assert max(cue["end"] for cue in cues) <= 7.0 + 1e-6


def test_srt_from_segments_normalizes_and_serializes() -> None:
    """D2: raw ASR segments → defensive normalization → SRT round-trip."""
    document = srt_from_segments(
        [
            {"start": 1.0, "end": 2.5, "text": "  hello   world "},
            {"start": -5.0, "end": 0.8, "text": "clamped"},
            {"start": 2.0, "end": 1.0, "text": "inverted dropped"},
            {"start": 3.0, "end": 4.0, "text": "   "},
            {"start": 9.0, "end": 9.5, "text": "late"},
        ]
    )
    cues = parse_srt(document)
    assert [(cue["start"], cue["end"], cue["text"]) for cue in cues] == [
        (0.0, 0.8, "clamped"),
        (1.0, 2.5, "hello world"),
        (9.0, 9.5, "late"),
    ]
    assert [cue["index"] for cue in cues] == [1, 2, 3]
    assert srt_from_segments([]) == ""


def test_resolve_cue_overlaps_aligns_or_drops_shadowed_cues() -> None:
    merged = resolve_cue_overlaps(
        [
            {"start": 0.0, "end": 5.0, "text": "big"},
            {"start": 1.0, "end": 2.0, "text": "shadowed"},
            {"start": 4.5, "end": 6.5, "text": "aligned"},
            {"start": 6.0, "end": 6.4, "text": "no room"},
            {"start": 6.5, "end": 7.0, "text": "after"},
        ]
    )
    assert [(cue["text"], cue["start"]) for cue in merged] == [
        ("big", 0.0),
        ("aligned", 5.0),
        ("after", 6.5),
    ]
    assert [cue["index"] for cue in merged] == [1, 2, 3]
    assert all(merged[i]["end"] <= merged[i + 1]["start"] + 1e-9 for i in range(len(merged) - 1))


def test_merge_shifted_segments_places_shots_on_composition_timeline() -> None:
    """D2 from_asr merge: per-shot offsets shift segments, overlaps resolve."""
    merged = merge_shifted_segments(
        [
            (
                0.0,
                [
                    {"start": 0.0, "end": 2.0, "text": "one"},
                    {"start": 1.5, "end": 3.0, "text": "two"},  # intra-shot overlap
                ],
            ),
            (
                5.0,
                [
                    {"start": 0.0, "end": 2.0, "text": "three"},
                    {"start": 0.5, "end": 9.0, "text": "four"},  # survives alignment
                ],
            ),
            (12.0, []),
        ]
    )
    assert [(cue["text"], cue["start"], cue["end"]) for cue in merged] == [
        ("one", 0.0, 2.0),
        ("two", 2.0, 3.0),
        ("three", 5.0, 7.0),
        ("four", 7.0, 14.0),
    ]
    document = serialize_srt(merged)
    assert parse_srt(document) == merged


def test_subtitle_style_presets_cover_the_four_burn_in_looks() -> None:
    assert set(SUBTITLE_STYLE_PRESETS) == {
        "clean",
        "yellow_box",
        "outline_large",
        "high_contrast",
    }
    for key, value in SUBTITLE_STYLE_PRESETS.items():
        assert "FontName" in value and "FontSize" in value and value == resolve_subtitle_style(key)
    assert "PrimaryColour=&H0000FFFF" in resolve_subtitle_style("yellow_box")  # yellow text
    assert "Outline=3" in resolve_subtitle_style("outline_large")  # heavy outline
    assert resolve_subtitle_style("") == ""  # empty = ffmpeg defaults
    assert resolve_subtitle_style("FontSize=42,Bold=1") == "FontSize=42,Bold=1"  # raw passthrough


# ── request normalization / planning ────────────────────────────────────────


def test_normalize_defaults_to_full_order_and_rejects_unready_shots(tmp_path: Path) -> None:
    store, project, _ = _project_with_shots(
        tmp_path,
        [{"video": True}, {"keyframe": True, "duration": 3.0}],
    )
    normalized = composition.normalize_compose_request(store, project["id"], None)
    assert normalized["shot_order"] == ["shot-0", "shot-1"]
    assert normalized["subtitle"]["mode"] == "off"
    assert normalized["audio"]["voiceovers"] is True
    assert composition._normalize_output(normalized) == ("720p", 30, False)

    empty_store = VideoStudioStore(tmp_path / "empty")
    empty_project = empty_store.create_project("Empty")
    with pytest.raises(ValueError, match="no shots"):
        composition.normalize_compose_request(empty_store, empty_project["id"], None)


def test_normalize_rejects_shot_without_material_and_bad_requests(tmp_path: Path) -> None:
    store, project, _ = _project_with_shots(tmp_path, [{"video": True}, {}])
    with pytest.raises(ValueError, match="no generated video or keyframe"):
        composition.normalize_compose_request(
            store, project["id"], {"shot_order": ["shot-0", "shot-1"]}
        )
    with pytest.raises(ValueError, match="Unknown storyboard shot"):
        composition.normalize_compose_request(store, project["id"], {"shot_order": ["ghost"]})
    with pytest.raises(ValueError, match="duplicates"):
        composition.normalize_compose_request(
            store, project["id"], {"shot_order": ["shot-0", "shot-0"]}
        )
    with pytest.raises(ValueError, match="Unsupported subtitle"):
        composition.normalize_compose_request(
            store,
            project["id"],
            {"shot_order": ["shot-0"], "subtitle": {"mode": "burn_everything"}},
        )
    with pytest.raises(ValueError, match="background music"):
        composition.normalize_compose_request(
            store,
            project["id"],
            {
                "shot_order": ["shot-0"],
                "audio": {
                    "bgm_asset_id": _upload(store, project["id"], MP4, "video/mp4", "bgm.mp4")["id"]
                },
            },
        )


def test_normalize_accepts_asr_source_and_style_presets(tmp_path: Path) -> None:
    store, project, _ = _project_with_shots(tmp_path, [{"video": True}])
    normalized = composition.normalize_compose_request(
        store,
        project["id"],
        {"subtitle": {"mode": "from_asr", "style": "yellow_box"}},
    )
    assert normalized["subtitle"] == {
        "mode": "from_asr",
        "style": "yellow_box",
        "srt_asset_id": "",
        "font_size": None,
        "primary_colour": "",
    }
    # §Phase E2: custom size/colour overrides ride along for the burn-in.
    overridden = composition.normalize_compose_request(
        store,
        project["id"],
        {
            "subtitle": {
                "mode": "from_asr",
                "style": "clean",
                "font_size": 36,
                "primary_colour": "&H0000FFFF",
            }
        },
    )
    assert overridden["subtitle"]["font_size"] == 36
    assert overridden["subtitle"]["primary_colour"] == "&H0000FFFF"
    with pytest.raises(ValueError, match="font size"):
        composition.normalize_compose_request(
            store,
            project["id"],
            {"subtitle": {"mode": "from_notes", "font_size": 99}},
        )
    with pytest.raises(ValueError, match="ASS &H hex"):
        composition.normalize_compose_request(
            store,
            project["id"],
            {"subtitle": {"mode": "from_notes", "primary_colour": "red"}},
        )
    # Raw force_style values pass the charset guard (ASS colours use &H…).
    styled = composition.normalize_compose_request(
        store,
        project["id"],
        {"subtitle": {"mode": "from_asr", "style": "FontSize=42,PrimaryColour=&H0000FFFF"}},
    )
    assert styled["subtitle"]["style"].startswith("FontSize=42")
    with pytest.raises(ValueError, match="style preset is invalid"):
        composition.normalize_compose_request(
            store,
            project["id"],
            {"subtitle": {"mode": "from_asr", "style": "FontName='breakout'"}},
        )


def test_normalize_from_asset_requires_project_subtitle_asset(tmp_path: Path) -> None:
    store, project, _ = _project_with_shots(tmp_path, [{"video": True}])
    with pytest.raises(ValueError, match="requires a subtitle asset"):
        composition.normalize_compose_request(
            store, project["id"], {"subtitle": {"mode": "from_asset"}}
        )
    other_store = VideoStudioStore(tmp_path / "other")
    other_project = other_store.create_project("Other")
    foreign = other_store.save_subtitle_document(
        other_project["id"], "1\n00:00:00,000 --> 00:00:01,000\nhi\n"
    )
    with pytest.raises(ValueError, match="must belong to this project"):
        composition.normalize_compose_request(
            store,
            project["id"],
            {"subtitle": {"mode": "from_asset", "srt_asset_id": foreign["id"]}},
        )
    not_subtitle = _upload(store, project["id"], MP4, "video/mp4", "clip.mp4")
    with pytest.raises(ValueError, match="not a subtitle document"):
        composition.normalize_compose_request(
            store,
            project["id"],
            {"subtitle": {"mode": "from_asset", "srt_asset_id": not_subtitle["id"]}},
        )
    with pytest.raises(ValueError, match="from_asset source"):
        composition.normalize_compose_request(
            store,
            project["id"],
            {"subtitle": {"mode": "from_notes", "srt_asset_id": not_subtitle["id"]}},
        )
    subtitle = store.save_subtitle_document(project["id"], "1\n00:00:00,000 --> 00:00:01,000\nhi\n")
    normalized = composition.normalize_compose_request(
        store,
        project["id"],
        {"subtitle": {"mode": "from_asset", "srt_asset_id": subtitle["id"], "style": "clean"}},
    )
    assert normalized["subtitle"]["srt_asset_id"] == subtitle["id"]


def test_normalize_bgm_falls_back_to_project_slot_and_honours_overrides(
    tmp_path: Path,
) -> None:
    """§Phase D3: absent audio keys inherit the project slot; explicit keys win."""
    store, project, _ = _project_with_shots(tmp_path, [{"video": True}])
    # No project slot and no request audio → silent bed with neutral defaults.
    base = composition.normalize_compose_request(store, project["id"], None)
    assert base["audio"] == {
        "voiceovers": True,
        "bgm_asset_id": "",
        "bgm_volume": 0.6,
        "bgm_fade_in": 1.0,
        "bgm_fade_out": 1.0,
    }

    music = _upload(store, project["id"], WAV, "audio/wav", "bed.wav")
    store.update_project(
        project["id"],
        bgm_asset_id=music["id"],
        bgm_volume=0.25,
        bgm_fade_in=3.0,
        bgm_fade_out=4.0,
    )
    # Absent audio keys inherit the saved slot (asset + mix level + fades).
    inherited = composition.normalize_compose_request(store, project["id"], None)
    assert inherited["audio"] == {
        "voiceovers": True,
        "bgm_asset_id": music["id"],
        "bgm_volume": 0.25,
        "bgm_fade_in": 3.0,
        "bgm_fade_out": 4.0,
    }
    partial = composition.normalize_compose_request(
        store, project["id"], {"audio": {"bgm_volume": 0.8}}
    )
    assert partial["audio"]["bgm_asset_id"] == music["id"]
    assert partial["audio"]["bgm_volume"] == 0.8
    assert partial["audio"]["bgm_fade_in"] == 3.0

    # An explicit empty asset id means "no music this time"; other keys still
    # inherit (the volume stays usable for a future re-enable).
    silent = composition.normalize_compose_request(
        store, project["id"], {"audio": {"bgm_asset_id": ""}}
    )
    assert silent["audio"]["bgm_asset_id"] == ""
    assert silent["audio"]["bgm_volume"] == 0.25

    # Explicit per-request values win over the project slot.
    other_track = _upload(store, project["id"], WAV, "audio/wav", "other.wav")
    override = composition.normalize_compose_request(
        store,
        project["id"],
        {
            "audio": {
                "bgm_asset_id": other_track["id"],
                "bgm_volume": 1.1,
                "bgm_fade_in": 0.0,
                "bgm_fade_out": 2.0,
            }
        },
    )
    assert override["audio"] == {
        "voiceovers": True,
        "bgm_asset_id": other_track["id"],
        "bgm_volume": 1.1,
        "bgm_fade_in": 0.0,
        "bgm_fade_out": 2.0,
    }
    # Out-of-range request values clamp instead of failing the composition.
    clamped = composition.normalize_compose_request(
        store, project["id"], {"audio": {"bgm_volume": 9.0, "bgm_fade_out": 99.0}}
    )
    assert clamped["audio"]["bgm_volume"] == 2.0
    assert clamped["audio"]["bgm_fade_out"] == 10.0

    # Pre-D3 queued plans persisted one symmetric fade; it feeds both fades.
    legacy = composition.normalize_compose_request(
        store, project["id"], {"audio": {"bgm_fade": 2.5}}
    )
    assert legacy["audio"]["bgm_fade_in"] == 2.5
    assert legacy["audio"]["bgm_fade_out"] == 2.5

    # A foreign or stale BGM asset can never become the composition's bed.
    other_store = VideoStudioStore(tmp_path / "other")
    other_project = other_store.create_project("Other")
    foreign = _upload(other_store, other_project["id"], WAV, "audio/wav", "far.wav")
    with pytest.raises(ValueError, match="must belong to this project"):
        composition.normalize_compose_request(
            store, project["id"], {"audio": {"bgm_asset_id": foreign["id"]}}
        )
    with pytest.raises(ValueError, match="must be an audio asset"):
        composition.normalize_compose_request(
            store,
            project["id"],
            {
                "audio": {
                    "bgm_asset_id": _upload(store, project["id"], MP4, "video/mp4", "v.mp4")["id"]
                }
            },
        )


def test_ffmpeg_arguments_bgm_uses_independent_fades(tmp_path: Path) -> None:
    """§Phase D3: fade-in and fade-out are independent; 0 disables either."""
    _, _, plan = _argument_plan(tmp_path)  # fade_in=1.0, fade_out=1.5, total=10.0
    args = composition._build_ffmpeg_arguments(plan, srt_name="", output_path=tmp_path / "out.mp4")
    joined = " ".join(args)
    assert "afade=t=in:st=0:d=1.00" in joined
    assert "afade=t=out:st=8.50:d=1.50" in joined  # 10.0 − 1.5 fade-out start

    asymmetric = replace(plan, bgm_fade_in=0.0, bgm_fade_out=3.0)
    args = composition._build_ffmpeg_arguments(
        asymmetric, srt_name="", output_path=tmp_path / "out.mp4"
    )
    joined = " ".join(args)
    assert "afade=t=in" not in joined  # disabled fade-in
    assert "afade=t=out:st=7.00:d=3.00" in joined


def test_ffmpeg_arguments_preserve_native_audio_in_mixed_material(
    tmp_path: Path,
) -> None:
    """§Phase D5 acceptance: shots with native audio keep their track (amix
    mixes — never overwrites — beside the TTS voiceover and the BGM bed)."""
    store, project, _ = _project_with_shots(
        tmp_path,
        [
            {"id": "native", "video": True},  # §2.1 track two: model-native audio
            {"id": "silent", "video": True},  # no native audio (e.g. silent tier)
            {"keyframe": True, "duration": 2.0},  # image placeholder
        ],
    )
    bgm = _upload(store, project["id"], WAV, "audio/wav", "bgm.wav")
    storyboard = store.get_storyboard(project["id"])
    segments = []
    timeline = 0.0
    for shot in storyboard["shots"]:
        native = shot["id"] == "native"
        segments.append(
            composition.ShotSegment(
                shot_id=shot["id"],
                title=shot["title"],
                path=store.asset_path(shot["output_asset_id"] or shot["keyframe_asset_id"]),
                start=timeline,
                duration=5.0,
                is_placeholder=not shot.get("output_asset_id"),
                has_native_audio=native,
            )
        )
        timeline += 5.0
    plan = composition.ComposePlan(
        project_id=project["id"],
        segments=tuple(segments),
        subtitle_mode="off",
        voiceovers_enabled=True,
        bgm_path=store.asset_path(bgm["id"]),
        bgm_volume=0.6,
        bgm_fade_in=1.0,
        bgm_fade_out=1.0,
        width=1280,
        height=720,
        fps=30,
    )
    args = composition._build_ffmpeg_arguments(plan, srt_name="", output_path=tmp_path / "out.mp4")
    joined = " ".join(args)
    # The native-audio shot's track is normalised and kept...
    assert "[0:a]aresample=48000" in joined
    # ...while silent shots are padded with matching silence, so the audio
    # timeline stays aligned; nothing is dropped.
    assert "anullsrc=r=48000:cl=stereo:d=5.000[a1]" in joined
    assert "anullsrc=r=48000:cl=stereo:d=5.000[a2]" in joined
    assert "concat=n=3:v=0:a=1[abase]" in joined
    # abase (native + silence) mixes beside the BGM bed — amix, not overwrite.
    assert "amix=inputs=2:duration=longest:normalize=0[aout]" in joined
    assert "-c:a aac" in joined


@pytest.mark.asyncio
async def test_build_compose_plan_probes_and_clamps_placeholders(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, project, _ = _project_with_shots(
        tmp_path,
        [
            {"video": True, "voiceover": "旁白文本"},
            {"keyframe": True, "duration": 99.0},
        ],
    )
    bgm = _upload(store, project["id"], WAV, "audio/wav", "bgm.wav")
    tool = _FakeTool(default_probe=MediaProbe(6.0, 1920, 1080, 24.0, True))
    monkeypatch.setattr(composition, "get_ffmpeg_tool", lambda: tool)
    plan = await composition.build_compose_plan(
        store,
        project["id"],
        {
            "subtitle": {"mode": "from_notes"},
            "audio": {"bgm_asset_id": bgm["id"], "bgm_volume": 0.3, "bgm_fade": 2.0},
            "output": {"resolution": "1080p", "fps": 24},
        },
    )
    assert plan.width == 1920 and plan.height == 1080 and plan.fps == 24
    assert [segment.duration for segment in plan.segments] == [6.0, 30.0]
    assert plan.segments[0].has_native_audio is True
    assert plan.segments[1].is_placeholder is True
    assert plan.segments[0].voiceover_path is not None
    assert plan.bgm_path is not None
    assert plan.total_duration == pytest.approx(36.0)
    with pytest.raises(ValueError, match="duration limit"):
        monkeypatch.setattr(composition, "MAX_COMPOSE_TOTAL_SECONDS", 10.0)
        await composition.build_compose_plan(store, project["id"], None)


@pytest.mark.asyncio
async def test_build_compose_plan_requires_ffmpeg(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, project, _ = _project_with_shots(tmp_path, [{"video": True}])
    monkeypatch.setattr(composition, "get_ffmpeg_tool", lambda: _FakeTool(unavailable=True))
    with pytest.raises(FFmpegUnavailableError):
        await composition.build_compose_plan(store, project["id"], None)


# ── ffmpeg argument construction ────────────────────────────────────────────


def _argument_plan(tmp_path: Path) -> tuple[VideoStudioStore, str, composition.ComposePlan]:
    store, project, _ = _project_with_shots(
        tmp_path,
        [
            {"video": True, "voiceover": "第一镜旁白"},
            {"keyframe": True, "duration": 4.0},
        ],
    )
    bgm = _upload(store, project["id"], WAV, "audio/wav", "bgm.wav")
    plan = composition.ComposePlan(
        project_id=project["id"],
        segments=plan_segments(store, project["id"]),
        subtitle_mode="from_notes",
        voiceovers_enabled=True,
        bgm_path=store.asset_path(bgm["id"]),
        bgm_volume=0.6,
        bgm_fade_in=1.0,
        bgm_fade_out=1.5,
        width=1280,
        height=720,
        fps=30,
    )
    return store, project["id"], plan


def plan_segments(store: VideoStudioStore, project_id: str):
    storyboard = store.get_storyboard(project_id)
    segments = []
    timeline = 0.0
    for shot in storyboard["shots"]:
        duration = 5.0
        voiceover_path = None
        if shot.get("voiceover_asset_id"):
            voiceover_path = store.asset_path(shot["voiceover_asset_id"])
        segments.append(
            composition.ShotSegment(
                shot_id=shot["id"],
                title=shot["title"],
                path=store.asset_path(shot["output_asset_id"] or shot["keyframe_asset_id"]),
                start=timeline,
                duration=duration,
                is_placeholder=not shot.get("output_asset_id"),
                has_native_audio=bool(shot.get("output_asset_id")),
                voiceover_path=voiceover_path,
            )
        )
        timeline += duration
    return tuple(segments)


def test_ffmpeg_arguments_video_audio_and_subtitles(tmp_path: Path) -> None:
    _, _, plan = _argument_plan(tmp_path)
    args = composition._build_ffmpeg_arguments(
        plan, srt_name="subtitles.srt", output_path=tmp_path / "out.mp4"
    )
    joined = " ".join(args)
    assert "-loop" in args and "-t" in args  # placeholder image input
    assert "scale=1280:720" in joined
    assert "pad=1280:720" in joined
    assert "concat=n=2:v=1:a=0[vcat]" in joined
    assert "subtitles=subtitles.srt" in joined
    assert "adelay=0|0" in joined  # first shot voiceover at t=0
    assert "volume=0.60" in joined
    assert "afade=t=in:st=0:d=1.00" in joined
    assert "amix=inputs=3:duration=longest:normalize=0[aout]" in joined
    assert args[args.index("-map") + 1] == "[vsub]"
    assert "[aout]" in args
    assert args[-3] == "-progress" and args[-2] == "pipe:1" and args[-1].endswith("out.mp4")
    assert "libx264" in args and "veryfast" in args


def test_ffmpeg_arguments_apply_force_style_presets(tmp_path: Path) -> None:
    """D2 burn-in styles: preset keys and raw values reach force_style quoted."""
    _, _, plan = _argument_plan(tmp_path)
    styled = replace(plan, subtitle_style="yellow_box")
    args = composition._build_ffmpeg_arguments(
        styled, srt_name="subtitles.srt", output_path=tmp_path / "out.mp4"
    )
    joined = " ".join(args)
    expected = resolve_subtitle_style("yellow_box")
    assert f"subtitles=subtitles.srt:force_style='{expected}'" in joined
    assert args[args.index("-map") + 1] == "[vsub]"

    raw = replace(plan, subtitle_style="FontSize=42,Bold=1")
    raw_args = composition._build_ffmpeg_arguments(
        raw, srt_name="subtitles.srt", output_path=tmp_path / "out.mp4"
    )
    assert "subtitles=subtitles.srt:force_style='FontSize=42,Bold=1'" in " ".join(raw_args)

    # Empty style keeps the plain A3 burn (existing behaviour unchanged).
    plain_args = composition._build_ffmpeg_arguments(
        plan, srt_name="subtitles.srt", output_path=tmp_path / "out.mp4"
    )
    assert "force_style" not in " ".join(plain_args)


def test_ffmpeg_arguments_without_any_audio_skips_track(tmp_path: Path) -> None:
    _, _, plan = _argument_plan(tmp_path)
    plan = composition.ComposePlan(
        project_id=plan.project_id,
        segments=tuple(
            composition.ShotSegment(
                shot_id=segment.shot_id,
                title=segment.title,
                path=segment.path,
                start=segment.start,
                duration=segment.duration,
                is_placeholder=segment.is_placeholder,
                has_native_audio=False,
            )
            for segment in plan.segments
        ),
        subtitle_mode="off",
        voiceovers_enabled=False,
        bgm_path=None,
        bgm_volume=0.6,
        bgm_fade_in=1.0,
        bgm_fade_out=1.0,
        width=1280,
        height=720,
        fps=30,
    )
    args = composition._build_ffmpeg_arguments(plan, srt_name="", output_path=tmp_path / "out.mp4")
    assert "-an" in args
    assert "amix" not in " ".join(args)
    assert "subtitles" not in " ".join(args)


# ── job lifecycle ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_compose_project_creates_free_local_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.multi_user.models import LOCAL_ADMIN_ID

    store, project, _ = _project_with_shots(tmp_path, [{"video": True}])
    started: list[str] = []
    monkeypatch.setattr(
        composition, "start_video_job", lambda _store, job_id: started.append(job_id)
    )
    job = composition.compose_project(
        store,
        project_id=project["id"],
        request={"subtitle": {"mode": "from_notes"}},
        client_request_id="compose-1",
    )
    assert job["operation"] == "compose"
    assert job["status"] == "queued"
    assert store._internal_job(job["id"])["owner_user_id"] == LOCAL_ADMIN_ID
    assert started == [job["id"]]
    parameters = store.get_job(job["id"])["parameters"]["compose_plan"]
    assert parameters["subtitle"]["mode"] == "from_notes"

    same = composition.compose_project(
        store,
        project_id=project["id"],
        request={"subtitle": {"mode": "from_notes"}},
        client_request_id="compose-1",
    )
    assert same["id"] == job["id"]  # idempotent client_request_id


@pytest.mark.asyncio
async def test_run_compose_job_succeeds_and_adopts_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio import engine

    store, project, _ = _project_with_shots(
        tmp_path,
        [{"video": True, "voiceover": "配音一"}, {"keyframe": True, "duration": 2.0}],
    )
    tool = _FakeTool(default_probe=MediaProbe(4.0, 1280, 720, 30.0, True))
    monkeypatch.setattr(composition, "get_ffmpeg_tool", lambda: tool)
    monkeypatch.setattr(composition, "start_video_job", lambda *_: None)
    job = composition.compose_project(
        store,
        project_id=project["id"],
        request={"subtitle": {"mode": "from_notes"}},
        client_request_id="run-1",
    )
    await engine._run_in_owner_context(store, job["id"])
    finished = store.get_job(job["id"])
    assert finished["status"] == "succeeded"
    assert finished["stage"] == "succeeded"
    assert len(finished["output_asset_ids"]) == 1
    asset = store.get_asset(finished["output_asset_ids"][0])
    assert asset["kind"] == "video" and asset["origin"] == "generated"
    assert tool.runs, "ffmpeg must have been invoked"
    assert not list(store.uploads_root.glob("compose_*.mp4"))
    assert "-filter_complex" in tool.runs[0]
    compositions = composition.list_compositions(store, project["id"])
    assert [entry["id"] for entry in compositions] == [job["id"]]
    assert compositions[0]["output_assets"][0]["id"] == asset["id"]


@pytest.mark.asyncio
async def test_run_compose_job_maps_ffmpeg_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio import engine

    store, project, _ = _project_with_shots(tmp_path, [{"video": True}])
    monkeypatch.setattr(composition, "start_video_job", lambda *_: None)

    monkeypatch.setattr(composition, "get_ffmpeg_tool", lambda: _FakeTool(unavailable=True))
    job = composition.compose_project(
        store, project_id=project["id"], request=None, client_request_id="unavail"
    )
    await engine._run_in_owner_context(store, job["id"])
    failed = store.get_job(job["id"])
    assert failed["status"] == "failed"
    assert failed["error"]["code"] == "ffmpeg_unavailable"
    assert failed["error"]["message"]

    monkeypatch.setattr(composition, "get_ffmpeg_tool", lambda: _FakeTool(fail_run=True))
    job2 = composition.compose_project(
        store, project_id=project["id"], request=None, client_request_id="fail"
    )
    await engine._run_in_owner_context(store, job2["id"])
    failed2 = store.get_job(job2["id"])
    assert failed2["status"] == "failed"
    assert failed2["error"]["code"] == "ffmpeg_failed"

    # Storyboard changed between queueing and execution → compose_invalid.
    tool = _FakeTool()
    monkeypatch.setattr(composition, "get_ffmpeg_tool", lambda: tool)
    job3 = composition.compose_project(
        store, project_id=project["id"], request=None, client_request_id="stale"
    )
    store.save_storyboard(
        project["id"],
        {"shots": [{"id": "shot-0", "order": 0, "title": "Gone", "prompt": "x"}]},
        expected_revision=1,
    )
    await engine._run_in_owner_context(store, job3["id"])
    failed3 = store.get_job(job3["id"])
    assert failed3["status"] == "failed"
    assert failed3["error"]["code"] == "compose_invalid"
    assert not list(store.uploads_root.glob("compose_*.mp4"))


@pytest.mark.asyncio
async def test_run_compose_job_cancellation_cleans_temp_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, project, _ = _project_with_shots(tmp_path, [{"video": True}])
    tool = _FakeTool(hang_run=True)
    monkeypatch.setattr(composition, "get_ffmpeg_tool", lambda: tool)
    monkeypatch.setattr(composition, "start_video_job", lambda *_: None)
    job = composition.compose_project(
        store, project_id=project["id"], request=None, client_request_id="cancel"
    )
    task = asyncio.create_task(composition.run_compose_job(store, job["id"]))
    await asyncio.sleep(0.2)
    assert store.get_job(job["id"])["status"] == "running"
    assert store.cancel_active_job(job["id"]) == "running"
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert store.get_job(job["id"])["status"] == "cancelled"
    assert not list(store.uploads_root.glob("compose_*.mp4"))


# ── Phase E5: experimental 720p→1080p frame-by-frame upscale ────────────────


def test_normalize_output_upscale_forces_1080p(tmp_path: Path) -> None:
    """§Phase E5: the experimental switch forces 1080p and round-trips."""
    store, project, _ = _project_with_shots(tmp_path, [{"video": True}])
    normalized = composition.normalize_compose_request(
        store,
        project["id"],
        {"output": {"resolution": "480p", "upscale": True}},
    )
    assert composition._normalize_output(normalized) == ("1080p", 30, True)
    assert normalized["output"]["upscale"] is True

    plain = composition.normalize_compose_request(store, project["id"], None)
    assert composition._normalize_output(plain) == ("720p", 30, False)


@pytest.mark.asyncio
async def test_upscale_plan_segments_targets_only_sub_1080p_videos(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Placeholders and already-1080p shots are skipped; the rest are swapped."""
    store, project, _ = _project_with_shots(
        tmp_path,
        [
            {"id": "small", "video": True},
            {"id": "large", "video": True},
            {"id": "still", "keyframe": True, "duration": 2.0},
        ],
    )
    storyboard = store.get_storyboard(project["id"])
    by_id = {shot["id"]: shot for shot in storyboard["shots"]}
    plan = composition.ComposePlan(
        project_id=project["id"],
        segments=(
            composition.ShotSegment(
                shot_id="small",
                title="Small",
                path=store.asset_path(by_id["small"]["output_asset_id"]),
                start=0.0,
                duration=5.0,
                is_placeholder=False,
                has_native_audio=True,
                source_width=1280,
                source_height=720,
            ),
            composition.ShotSegment(
                shot_id="large",
                title="Large",
                path=store.asset_path(by_id["large"]["output_asset_id"]),
                start=5.0,
                duration=5.0,
                is_placeholder=False,
                has_native_audio=True,
                source_width=1920,
                source_height=1080,
            ),
            composition.ShotSegment(
                shot_id="still",
                title="Still",
                path=store.asset_path(by_id["still"]["keyframe_asset_id"]),
                start=10.0,
                duration=2.0,
                is_placeholder=True,
                has_native_audio=False,
            ),
        ),
        subtitle_mode="off",
        voiceovers_enabled=True,
        bgm_path=None,
        bgm_volume=0.6,
        bgm_fade_in=1.0,
        bgm_fade_out=1.0,
        width=1920,
        height=1080,
        fps=30,
        upscale=True,
    )

    calls: list[dict[str, Any]] = []

    async def fake_upscale(tool, source, dest, *, on_progress=None, fps=30.0):
        calls.append({"source": source, "dest": dest, "fps": fps})
        dest.write_bytes(MP4)
        if on_progress is not None:
            on_progress(0.5, "half-way")
            on_progress(1.0, "done")

    monkeypatch.setattr(composition, "upscale_clip_to_1080p", fake_upscale)
    upgraded = await composition._upscale_plan_segments(plan, tmp_path)

    assert len(calls) == 1  # only the 720p video shot
    assert calls[0]["source"] == plan.segments[0].path
    assert calls[0]["fps"] == 30.0
    assert upgraded.segments[0].path == calls[0]["dest"]
    assert upgraded.segments[0].source_width == 1920
    assert upgraded.segments[0].source_height == 1080
    # Untouched shots keep their original paths.
    assert upgraded.segments[1].path == plan.segments[1].path
    assert upgraded.segments[2].path == plan.segments[2].path


@pytest.mark.asyncio
async def test_run_compose_job_upscale_pre_step_and_error_mapping(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The switch wires the pre-step in front of the render and maps engine
    failures onto a dedicated ``upscale_unavailable`` error code."""
    from knorvia.services.video_studio import engine

    store, project, _ = _project_with_shots(
        tmp_path,
        [{"video": True, "voiceover": "旁白"}, {"keyframe": True, "duration": 2.0}],
    )
    tool = _FakeTool(default_probe=MediaProbe(4.0, 1280, 720, 30.0, True))
    monkeypatch.setattr(composition, "get_ffmpeg_tool", lambda: tool)
    monkeypatch.setattr(composition, "start_video_job", lambda *_: None)

    upscaled: list[Path] = []

    async def fake_upscale(_tool, source, dest, *, on_progress=None, fps=30.0):
        dest.write_bytes(MP4)
        upscaled.append(dest)
        if on_progress is not None:
            on_progress(1.0)

    monkeypatch.setattr(composition, "upscale_clip_to_1080p", fake_upscale)
    job = composition.compose_project(
        store,
        project_id=project["id"],
        request={"output": {"upscale": True}},
        client_request_id="up-1",
    )
    await engine._run_in_owner_context(store, job["id"])
    finished = store.get_job(job["id"])
    assert finished["status"] == "succeeded", finished.get("error")
    assert len(upscaled) == 1  # the video shot only; keyframe placeholder skipped
    # The render consumed the upscaled copy, not the original asset file,
    # and normalised every shot to the forced 1080p canvas.
    joined = " ".join(tool.runs[0])
    assert str(upscaled[0]) in joined
    assert "scale=1920:1080" in joined

    async def broken_upscale(*args: Any, **kwargs: Any):
        raise composition.UpscaleError("needs the local Real-ESRGAN engine")

    monkeypatch.setattr(composition, "upscale_clip_to_1080p", broken_upscale)
    job2 = composition.compose_project(
        store,
        project_id=project["id"],
        request={"output": {"upscale": True}},
        client_request_id="up-2",
    )
    await engine._run_in_owner_context(store, job2["id"])
    failed = store.get_job(job2["id"])
    assert failed["status"] == "failed"
    assert failed["error"]["code"] == "upscale_unavailable"
    assert not list(store.uploads_root.glob("compose_*.mp4"))


# ── Phase D2: from_asr automatic subtitles & subtitle assets ────────────────


@pytest.mark.asyncio
async def test_run_compose_job_from_asr_transcribes_merges_and_saves_srt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The full 自动字幕 chain: extract → STT → shift/merge → burn → save asset."""
    from knorvia.services.video_studio import engine

    store, project, _ = _project_with_shots(tmp_path, [{"video": True}, {"video": True}])
    tool = _FakeTool(default_probe=MediaProbe(4.0, 1280, 720, 30.0, True))
    monkeypatch.setattr(composition, "get_ffmpeg_tool", lambda: tool)
    transcriptions = [
        TranscriptionResult(
            "第一句 第二句",
            segments=[
                {"start": 0.0, "end": 2.0, "text": "第一句"},
                {"start": 2.0, "end": 4.0, "text": "第二句"},
            ],
            segments_supported=True,
        ),
        TranscriptionResult(
            "second shot",
            segments=[
                {"start": 0.0, "end": 2.5, "text": "second shot line"},
                {"start": 1.0, "end": 2.0, "text": "shadowed overlap"},
            ],
            segments_supported=True,
        ),
    ]

    async def fake_transcribe(audio: bytes, **kwargs: Any) -> TranscriptionResult:
        assert kwargs.get("want_segments") is True
        assert kwargs.get("filename") == "audio.wav"
        assert kwargs.get("content_type") == "audio/wav"
        assert audio == WAV  # the extracted 16 kHz mono PCM
        return transcriptions.pop(0)

    monkeypatch.setattr(composition, "transcribe_audio", fake_transcribe)
    monkeypatch.setattr(composition, "start_video_job", lambda *_: None)
    job = composition.compose_project(
        store,
        project_id=project["id"],
        request={"subtitle": {"mode": "from_asr", "style": "clean"}},
        client_request_id="asr-1",
    )
    await engine._run_in_owner_context(store, job["id"])
    finished = store.get_job(job["id"])
    assert finished["status"] == "succeeded", finished.get("error")

    # Both shots' video tracks were demuxed for STT, in composition order.
    assert len(tool.extracts) == 2
    assert all(media.endswith(".mp4") for media, _ in tool.extracts)
    # The burn carried the merged timeline + the style preset.
    filter_arg = tool.runs[0][tool.runs[0].index("-filter_complex") + 1]
    assert "force_style" in filter_arg
    assert resolve_subtitle_style("clean") in filter_arg
    # Shot 2's segments were shifted by shot 1's 4 s; the shadowed cue dropped.
    cues = parse_srt(tool.burned_srt)
    assert [(cue["text"], cue["start"], cue["end"]) for cue in cues] == [
        ("第一句", 0.0, 2.0),
        ("第二句", 2.0, 4.0),
        ("second shot line", 4.0, 6.5),
    ]
    # The generated SRT is kept as a subtitle asset for the editor to polish.
    subtitles = store.list_assets(project["id"], kind="subtitle")
    assert len(subtitles) == 1
    assert subtitles[0]["mime_type"] == "application/x-subrip"
    assert subtitles[0]["origin"] == "generated"
    saved = parse_srt(store.asset_path(subtitles[0]["id"]).read_text(encoding="utf-8"))
    assert [cue["text"] for cue in saved] == [cue["text"] for cue in cues]


@pytest.mark.asyncio
async def test_run_compose_job_from_asr_without_stt_fails_with_dedicated_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio import engine

    store, project, _ = _project_with_shots(tmp_path, [{"video": True}])
    tool = _FakeTool(default_probe=MediaProbe(4.0, 1280, 720, 30.0, True))
    monkeypatch.setattr(composition, "get_ffmpeg_tool", lambda: tool)

    async def no_gateway(audio: bytes, **kwargs: Any) -> TranscriptionResult:
        raise VoiceProviderError("No endpoint URL configured for STT.")

    monkeypatch.setattr(composition, "transcribe_audio", no_gateway)
    monkeypatch.setattr(composition, "start_video_job", lambda *_: None)
    job = composition.compose_project(
        store,
        project_id=project["id"],
        request={"subtitle": {"mode": "from_asr"}},
        client_request_id="asr-nogw",
    )
    await engine._run_in_owner_context(store, job["id"])
    failed = store.get_job(job["id"])
    assert failed["status"] == "failed"
    assert failed["error"]["code"] == "stt_unavailable"
    assert "speech-to-text" in failed["error"]["message"]
    assert not tool.runs  # ffmpeg never started


@pytest.mark.asyncio
async def test_run_compose_job_from_asr_timestampless_gateway_is_compose_invalid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SenseVoice-style degradation: text-only answers cannot make timed cues."""
    from knorvia.services.video_studio import engine

    store, project, _ = _project_with_shots(tmp_path, [{"video": True}])
    tool = _FakeTool(default_probe=MediaProbe(4.0, 1280, 720, 30.0, True))
    monkeypatch.setattr(composition, "get_ffmpeg_tool", lambda: tool)

    async def text_only(audio: bytes, **kwargs: Any) -> TranscriptionResult:
        return TranscriptionResult("no timestamps", segments=None, segments_supported=False)

    monkeypatch.setattr(composition, "transcribe_audio", text_only)
    monkeypatch.setattr(composition, "start_video_job", lambda *_: None)
    job = composition.compose_project(
        store,
        project_id=project["id"],
        request={"subtitle": {"mode": "from_asr"}},
        client_request_id="asr-degraded",
    )
    await engine._run_in_owner_context(store, job["id"])
    failed = store.get_job(job["id"])
    assert failed["status"] == "failed"
    assert failed["error"]["code"] == "compose_invalid"
    assert "no timestamps" in failed["error"]["message"]


@pytest.mark.asyncio
async def test_run_compose_job_from_asset_burns_edited_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """编辑→烧录: a saved/edited subtitle asset is burned verbatim."""
    from knorvia.services.video_studio import engine

    store, project, _ = _project_with_shots(tmp_path, [{"video": True}])
    document = (
        "1\n00:00:00,500 --> 00:00:02,000\n编辑过的字幕\n\n"
        "2\n00:00:02,500 --> 00:00:04,000\nEdited second line\n"
    )
    subtitle = store.save_subtitle_document(
        project["id"], document, filename="edited.srt", origin="edited"
    )
    tool = _FakeTool(default_probe=MediaProbe(4.0, 1280, 720, 30.0, True))
    monkeypatch.setattr(composition, "get_ffmpeg_tool", lambda: tool)
    monkeypatch.setattr(composition, "start_video_job", lambda *_: None)
    job = composition.compose_project(
        store,
        project_id=project["id"],
        request={
            "subtitle": {
                "mode": "from_asset",
                "srt_asset_id": subtitle["id"],
                "style": "high_contrast",
            }
        },
        client_request_id="asset-1",
    )
    await engine._run_in_owner_context(store, job["id"])
    finished = store.get_job(job["id"])
    assert finished["status"] == "succeeded", finished.get("error")
    assert "subtitles=subtitles.srt" in " ".join(tool.runs[0])
    assert resolve_subtitle_style("high_contrast") in " ".join(tool.runs[0])
    # No STT involved: nothing was extracted, no extra subtitle asset appeared.
    assert tool.extracts == []
    assert store.list_assets(project["id"], kind="subtitle") == [subtitle]


def test_subtitle_asset_save_and_replace_roundtrip(tmp_path: Path) -> None:
    """Editor saves: create a subtitle asset, then overwrite it in place."""
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Subs")
    document = "1\n00:00:00,000 --> 00:00:01,000\nfirst\n"
    asset = store.save_subtitle_document(
        project["id"], document, filename="captions.srt", origin="edited"
    )
    assert asset["kind"] == "subtitle"
    assert asset["mime_type"] == "application/x-subrip"
    assert asset["origin"] == "edited"
    assert asset["filename"] == "captions.srt"
    assert store.asset_path(asset["id"]).read_text(encoding="utf-8") == document

    edited = "1\n00:00:00,000 --> 00:00:01,500\nfirst (edited)\n\n2\n00:00:02,000 --> 00:00:03,000\nnew\n"
    updated = store.replace_subtitle_document(asset["id"], edited)
    assert updated["id"] == asset["id"]  # stable id → compose references survive
    assert updated["size_bytes"] == len(edited.encode("utf-8"))
    assert store.asset_path(asset["id"]).read_text(encoding="utf-8") == edited
    assert len(store.list_assets(project["id"], kind="subtitle")) == 1

    with pytest.raises(ValueError, match="valid SRT"):
        store.save_subtitle_document(project["id"], "this is not an srt file")
    with pytest.raises(ValueError, match="size limit"):
        store.save_subtitle_document(project["id"], "x" * (4 * 1024 * 1024 + 1))
    video_asset = _upload(store, project["id"], MP4, "video/mp4", "clip.mp4")
    with pytest.raises(ValueError, match="not a subtitle document"):
        store.replace_subtitle_document(video_asset["id"], document)
