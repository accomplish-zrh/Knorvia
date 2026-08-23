from __future__ import annotations

import base64
import hashlib
from pathlib import Path
import sqlite3
from typing import Any

import pytest

from knorvia.multi_user.models import LOCAL_ADMIN_ID
from knorvia.services.video_studio import service
from knorvia.services.video_studio.capability_presets import (
    CAPABILITY_PRESETS,
    get_capability_preset,
    list_capability_presets,
)
from knorvia.services.video_studio.ffmpeg_tool import FFmpegUnavailableError
from knorvia.services.video_studio.provider import (
    FakeVideoStudioAdapter,
    GenericAsyncVideoAdapter,
    VideoInput,
    VolcengineAsyncVideoAdapter,
)
from knorvia.services.video_studio.store import VideoStudioStore
from knorvia.services.videogen.config import VideogenConfig

MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isomtest-video"
WAV = b"RIFF\x10\x00\x00\x00WAVEfmt " + b"\x00" * 16


def _png() -> bytes:
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (2, 2), "red").save(buffer, format="PNG")
    return buffer.getvalue()


def _upload(store: VideoStudioStore, project_id: str, data: bytes, mime: str, name: str):
    upload = store.create_upload(
        project_id, name, mime, len(data), hashlib.sha256(data).hexdigest()
    )
    store.write_upload_part(upload["id"], 0, data)
    return store.complete_upload(upload["id"])


def _option(preset_id: str = "seedance-fast-like", **overrides: Any) -> dict[str, Any]:
    option = {
        "capabilities": dict(get_capability_preset(preset_id)["capabilities"]),
        "defaults": {},
    }
    for key, value in overrides.items():
        if key == "capabilities":
            option["capabilities"].update(value)
        else:
            option[key] = value
    return option


def _patch_service(monkeypatch: pytest.MonkeyPatch, option: dict[str, Any]) -> None:
    monkeypatch.setattr(service, "find_video_option", lambda *_: option)
    monkeypatch.setattr(
        service,
        "capture_video_authorization",
        lambda *_: {"owner_user_id": LOCAL_ADMIN_ID, "config_revision": "revision"},
    )
    monkeypatch.setattr(service, "start_video_job", lambda *_: None)


def test_job_input_roles_persisted_and_returned(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Roles")
    first = _upload(store, project["id"], _png(), "image/png", "first.png")
    last = _upload(store, project["id"], _png(), "image/png", "last.png")
    audio = _upload(store, project["id"], WAV, "audio/wav", "voice.wav")
    job = store.create_job(
        project["id"],
        {
            "operation": "image_to_video",
            "profile_id": "profile",
            "model_id": "model",
            "prompt": "bridge the two frames",
            "input_asset_ids": [],
            "inputs": [
                {"asset_id": first["id"], "role": "first-frame"},
                {"asset_id": last["id"], "role": "last-frame"},
                {"asset_id": audio["id"], "role": "audio"},
            ],
            "parameters": {"reference_mode": "first-last", "audio_mode": "input"},
            "client_request_id": "roles-1",
            "owner_user_id": LOCAL_ADMIN_ID,
            "config_revision": "revision",
        },
    )
    assert job["input_asset_ids"] == [first["id"], last["id"], audio["id"]]
    assert job["inputs"] == [
        {"asset_id": first["id"], "role": "first-frame"},
        {"asset_id": last["id"], "role": "last-frame"},
        {"asset_id": audio["id"], "role": "audio"},
    ]
    internal = store._internal_job(job["id"])
    assert internal["inputs"][0]["role"] == "first-frame"

    with pytest.raises(ValueError, match="not both"):
        store.create_job(
            project["id"],
            {
                "operation": "image_to_video",
                "profile_id": "profile",
                "model_id": "model",
                "prompt": "mixing forms",
                "input_asset_ids": [first["id"]],
                "inputs": [{"asset_id": first["id"], "role": "reference"}],
                "parameters": {},
                "client_request_id": "roles-2",
                "owner_user_id": LOCAL_ADMIN_ID,
                "config_revision": "revision",
            },
        )


def test_job_inputs_role_column_migrates_and_backfills(tmp_path: Path) -> None:
    root = tmp_path / "studio"
    root.mkdir(parents=True)
    db = sqlite3.connect(root / "studio.db")
    db.executescript(
        """
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, retry_of_job_id TEXT,
          storyboard_shot_id TEXT,
          client_request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
          operation TEXT NOT NULL, status TEXT NOT NULL, profile_id TEXT NOT NULL,
          model_id TEXT NOT NULL, prompt TEXT NOT NULL, parameters_json TEXT NOT NULL,
          owner_user_id TEXT NOT NULL, config_revision TEXT NOT NULL,
          provider_task_id TEXT, progress REAL NOT NULL DEFAULT 0,
          stage TEXT NOT NULL DEFAULT 'queued', error_code TEXT, error_message TEXT,
          created_at REAL NOT NULL, started_at REAL, finished_at REAL
        );
        CREATE TABLE job_inputs (
          job_id TEXT NOT NULL, asset_id TEXT NOT NULL, position INTEGER NOT NULL,
          PRIMARY KEY(job_id, position)
        );
        INSERT INTO jobs (id, project_id, client_request_id, request_hash, operation,
          status, profile_id, model_id, prompt, parameters_json, owner_user_id,
          config_revision, created_at)
          VALUES ('job_legacy', 'p1', 'legacy', 'hash', 'text_to_video', 'succeeded',
          'profile', 'model', 'old', '{}', 'owner', 'rev', 1);
        INSERT INTO job_inputs (job_id, asset_id, position) VALUES ('job_legacy', 'asset_old', 0);
        """
    )
    db.commit()
    db.close()

    store = VideoStudioStore(root)
    with store._connect() as fresh:
        columns = {row[1] for row in fresh.execute("PRAGMA table_info(job_inputs)")}
        assert "role" in columns
        roles = [row[0] for row in fresh.execute("SELECT role FROM job_inputs")]
    assert roles == ["reference"]


def test_validate_first_last_requires_two_images(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Frames")
    only = _upload(store, project["id"], _png(), "image/png", "only.png")
    _patch_service(monkeypatch, _option())

    with pytest.raises(ValueError, match="require two images"):
        service.validate_video_job_plan(
            store,
            project_id=project["id"],
            profile_id="profile",
            model_id="model",
            operation="image_to_video",
            prompt="crossfade",
            input_asset_ids=[only["id"]],
            parameters={"reference_mode": "first-last"},
        )


def test_validate_first_last_and_auto_derive_frame_roles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Derive")
    first = _upload(store, project["id"], _png(), "image/png", "first.png")
    second = _upload(store, project["id"], _png(), "image/png", "second.png")
    third = _upload(store, project["id"], _png(), "image/png", "third.png")
    _patch_service(monkeypatch, _option())

    plan = service.validate_video_job_plan(
        store,
        project_id=project["id"],
        profile_id="profile",
        model_id="model",
        operation="image_to_video",
        prompt="two frames",
        input_asset_ids=[first["id"], second["id"]],
        parameters={"reference_mode": "first-last"},
    )
    assert plan["inputs"] == [
        {"asset_id": first["id"], "role": "first-frame"},
        {"asset_id": second["id"], "role": "last-frame"},
    ]

    plan = service.validate_video_job_plan(
        store,
        project_id=project["id"],
        profile_id="profile",
        model_id="model",
        operation="image_to_video",
        prompt="one frame",
        input_asset_ids=[first["id"]],
        parameters={},
    )
    assert plan["inputs"] == [{"asset_id": first["id"], "role": "first-frame"}]

    plan = service.validate_video_job_plan(
        store,
        project_id=project["id"],
        profile_id="profile",
        model_id="model",
        operation="image_to_video",
        prompt="many refs",
        input_asset_ids=[first["id"], second["id"], third["id"]],
        parameters={"reference_mode": "multi"},
    )
    assert all(spec["role"] == "reference" for spec in plan["inputs"])

    explicit = service.validate_video_job_plan(
        store,
        project_id=project["id"],
        profile_id="profile",
        model_id="model",
        operation="image_to_video",
        prompt="explicit wins",
        input_asset_ids=[],
        inputs=[
            {"asset_id": third["id"], "role": "first-frame"},
            {"asset_id": second["id"], "role": "reference"},
        ],
        parameters={"reference_mode": "first-last"},
    )
    assert explicit["inputs"][0]["role"] == "first-frame"
    assert explicit["inputs"][1]["role"] == "last-frame"


def test_validate_rejects_video_ref_when_capability_is_zero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Mini")
    image = _upload(store, project["id"], _png(), "image/png", "frame.png")
    clip = _upload(store, project["id"], MP4, "video/mp4", "clip.mp4")
    _patch_service(monkeypatch, _option("seedance-mini-like"))

    with pytest.raises(ValueError, match="Too many video inputs"):
        service.validate_video_job_plan(
            store,
            project_id=project["id"],
            profile_id="profile",
            model_id="model",
            operation="image_to_video",
            prompt="remove the logo",
            input_asset_ids=[image["id"], clip["id"]],
            parameters={},
        )


def test_validate_rejects_role_kind_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Mismatch")
    image = _upload(store, project["id"], _png(), "image/png", "frame.png")
    clip = _upload(store, project["id"], MP4, "video/mp4", "clip.mp4")
    _patch_service(monkeypatch, _option())

    with pytest.raises(ValueError, match="must be an image"):
        service.validate_video_job_plan(
            store,
            project_id=project["id"],
            profile_id="profile",
            model_id="model",
            operation="video_to_video",
            prompt="wrong role",
            input_asset_ids=[],
            inputs=[{"asset_id": clip["id"], "role": "first-frame"}],
            parameters={},
        )
    with pytest.raises(ValueError, match="must be an audio"):
        service.validate_video_job_plan(
            store,
            project_id=project["id"],
            profile_id="profile",
            model_id="model",
            operation="image_to_video",
            prompt="wrong audio role",
            input_asset_ids=[],
            inputs=[{"asset_id": image["id"], "role": "audio"}],
            parameters={"reference_mode": "multi"},
        )


def test_create_video_job_persists_derived_roles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Persist")
    image = _upload(store, project["id"], _png(), "image/png", "frame.png")
    _patch_service(monkeypatch, _option())

    job = service.create_video_job(
        store,
        project_id=project["id"],
        profile_id="profile",
        model_id="model",
        operation="image_to_video",
        prompt="animate the still",
        input_asset_ids=[image["id"]],
        parameters={},
        client_request_id="derived-roles",
        confirmed_cost=True,
    )
    assert job["inputs"] == [{"asset_id": image["id"], "role": "first-frame"}]


def test_adapter_payload_sends_roles_and_multimodal_parts(tmp_path: Path) -> None:
    image = tmp_path / "first.png"
    image.write_bytes(_png())
    other = tmp_path / "ref.png"
    other.write_bytes(_png())
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(MP4)

    inputs = [
        VideoInput(image, "image/png", "image", role="first-frame"),
        VideoInput(clip, "video/mp4", "video", role="continue-from"),
        VideoInput(other, "image/png", "image", role="reference"),
    ]
    config = VideogenConfig(
        model="seedance",
        api_key="key",
        base_url="https://gateway.example.test",
        aspect_ratio="16:9",
        duration="5",
        resolution="720p",
    )
    payload = GenericAsyncVideoAdapter._payload(
        "a lake", config, inputs, {"reference_mode": "multi"}
    )
    content = payload["content"]
    assert content[0] == {"type": "text", "text": "a lake"}
    assert content[1]["type"] == "image_url"
    assert content[1]["role"] == "first_frame"
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert content[2]["type"] == "video_url"
    assert content[2]["video_url"]["url"].startswith("data:video/mp4;base64,")
    assert "role" not in content[2]
    assert content[3]["type"] == "image_url"
    assert "role" not in content[3]
    assert payload["reference_mode"] == "multi"

    volc = VolcengineAsyncVideoAdapter._payload("a lake", config, inputs, {})
    assert volc["content"][0]["text"] == "a lake --ratio 16:9 --resolution 720p --duration 5"
    frame_role = volc["content"][1]
    assert frame_role["role"] == "first_frame"
    decoded = base64.b64decode(frame_role["image_url"]["url"].split(",", 1)[1])
    assert decoded == _png()


def test_capability_presets_mirror_public_tiers() -> None:
    # §Phase D5 adds "kling-3.x-like": this test enumerates the registry, so
    # it grows with the new Kling 3.0 native-audio tier.
    assert set(CAPABILITY_PRESETS) == {
        "seedance-fast-like",
        "seedance-standard-like",
        "seedance-mini-like",
        "seedance-2.5-like",
        "minimax-h3-like",
        "happyhorse-like",
        "kling-2.x-like",
        "kling-3.x-like",
        "wan-2.x-like",
        "hailuo-h3-like",
    }
    mini = get_capability_preset("seedance-mini-like")["capabilities"]
    assert mini["max_inputs"] == {"image": 9, "video": 0, "audio": 0, "total": 9}
    assert "universal" not in mini["reference_modes"]

    flagship = get_capability_preset("seedance-2.5-like")["capabilities"]
    assert flagship["max_inputs"] == {"image": 30, "video": 10, "audio": 10, "total": 50}
    assert flagship["durations"][-1] == 30

    horse = get_capability_preset("happyhorse-like")["capabilities"]
    assert horse["aspect_ratios"] == ["16:9", "9:16", "1:1", "4:3", "3:4"]
    assert horse["max_inputs"]["video"] == 0

    minimax = get_capability_preset("minimax-h3-like")["capabilities"]
    assert minimax["resolutions"] == ["768p", "1440p"]
    assert minimax["max_inputs"]["total"] == 19

    kling = get_capability_preset("kling-2.x-like")["capabilities"]
    assert kling["operations"] == ["text_to_video", "image_to_video", "extend"]
    assert kling["durations"] == [5, 10]
    assert "extend" in kling["operations"] and kling["supports_cancel"] is True

    wan = get_capability_preset("wan-2.x-like")["capabilities"]
    assert wan["audio_modes"] == ["none", "generate"]
    assert wan["durations"] == [5, 10]

    hailuo = get_capability_preset("hailuo-h3-like")["capabilities"]
    assert hailuo["max_inputs"] == {"image": 9, "video": 3, "audio": 3, "total": 15}
    assert hailuo["reference_modes"] == ["multi"]

    presets = list_capability_presets()
    assert [item["id"] for item in presets] == list(CAPABILITY_PRESETS)
    assert get_capability_preset("unknown") is None


def test_d5_native_audio_presets_declare_generate_mode() -> None:
    """§Phase D5 (§2.1 track two): tiers with native audio open
    audio_modes=["none","generate"] so the Composer can explicitly offer
    "generate (native)" vs "reference audio"; silent tiers stay honest."""
    for preset_id in (
        "seedance-fast-like",
        "seedance-standard-like",
        "seedance-2.5-like",
        "kling-3.x-like",
        "wan-2.x-like",
        "minimax-h3-like",
        "hailuo-h3-like",
    ):
        capabilities = get_capability_preset(preset_id)["capabilities"]
        assert capabilities["audio_modes"] == ["none", "generate"], preset_id

    kling3 = get_capability_preset("kling-3.x-like")["capabilities"]
    assert kling3["operations"] == ["text_to_video", "image_to_video", "extend"]
    assert kling3["durations"] == [5, 10]
    schema = kling3["parameter_schema"]["properties"]
    assert schema["camera_control"]["enum"] == ["none", "simple", "custom"]
    assert schema["camera_motion"]["enum"] == ["push", "pull", "pan", "tilt", "follow", "orbit"]

    # Tiers without native audio must not advertise it.
    for preset_id in ("seedance-mini-like", "happyhorse-like", "kling-2.x-like"):
        assert get_capability_preset(preset_id)["capabilities"]["audio_modes"] == ["none"]


@pytest.mark.asyncio
async def test_capability_presets_endpoint() -> None:
    from knorvia.api.routers import video_studio as router

    result = await router.capability_presets()
    ids = [item["id"] for item in result["presets"]]
    assert "seedance-2.5-like" in ids
    preset = next(item for item in result["presets"] if item["id"] == "seedance-2.5-like")
    assert preset["capabilities"]["max_inputs"]["image"] == 30


@pytest.mark.asyncio
async def test_router_rejects_inputs_and_asset_ids_together(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import HTTPException

    from knorvia.api.routers import video_studio as router

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Both")
    image = _upload(store, project["id"], _png(), "image/png", "frame.png")
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)
    payload = router.JobCreate(
        profile_id="profile",
        model_id="model",
        operation="image_to_video",
        prompt="both forms",
        input_asset_ids=[image["id"]],
        inputs=[router.JobInput(asset_id=image["id"], role="first-frame")],
        client_request_id="both-1",
        confirmed_cost=True,
    )
    with pytest.raises(HTTPException) as exc:
        await router.create_job(project["id"], payload)
    assert exc.value.status_code == 422


# ── extend: local last-frame derivation (parity roadmap §C1, path one) ──────


class _RecordingVideoAdapter(FakeVideoStudioAdapter):
    """FakeVideoStudioAdapter that records each provider submit call."""

    def __init__(self) -> None:
        super().__init__()
        self.submits: list[dict[str, Any]] = []

    async def submit(
        self,
        prompt: str,
        config: VideogenConfig,
        *,
        inputs: list[VideoInput],
        parameters: dict[str, Any],
        idempotency_key: str,
    ) -> str:
        self.submits.append(
            {
                "prompt": prompt,
                "inputs": list(inputs),
                "parameters": dict(parameters),
                "idempotency_key": idempotency_key,
            }
        )
        return await super().submit(
            prompt,
            config,
            inputs=inputs,
            parameters=parameters,
            idempotency_key=idempotency_key,
        )


class _NativeExtendVideoAdapter(_RecordingVideoAdapter):
    """Adapter wired to a provider-side extend endpoint (§C1 path two)."""

    native_extend = True


class _FakeExtendFFmpeg:
    """Test double for the local last-frame extraction."""

    def __init__(self, *, unavailable: bool = False) -> None:
        self.unavailable = unavailable
        self.calls: list[Path] = []

    async def extract_last_frame(self, video: Path, output: Path) -> Path:
        if self.unavailable:
            raise FFmpegUnavailableError("no local engine")
        self.calls.append(video)
        output.write_bytes(_png())
        return output


def _patch_engine(monkeypatch: pytest.MonkeyPatch, adapter: Any, ffmpeg: _FakeExtendFFmpeg) -> None:
    from knorvia.services.video_studio import engine

    monkeypatch.setattr(engine, "_authorized_catalog", lambda _job: {})
    monkeypatch.setattr(
        engine,
        "resolve_videogen_runtime_config",
        lambda **_: VideogenConfig(
            model="fake", adapter="fake", base_url="https://fake.test", poll_interval=0.001
        ),
    )
    monkeypatch.setattr(engine, "get_video_studio_adapter", lambda _name: adapter)
    monkeypatch.setattr(engine, "get_ffmpeg_tool", lambda: ffmpeg)


def _extend_job(
    store: VideoStudioStore,
    project_id: str,
    clip_id: str,
    audio_id: str | None = None,
    *,
    request_id: str = "extend-run",
) -> dict[str, Any]:
    inputs: list[dict[str, str]] = [{"asset_id": clip_id, "role": "continue-from"}]
    if audio_id:
        inputs.append({"asset_id": audio_id, "role": "audio"})
    return store.create_job(
        project_id,
        {
            "operation": "extend",
            "profile_id": "profile",
            "model_id": "model",
            "prompt": "keep chasing the convoy",
            "input_asset_ids": [],
            "inputs": inputs,
            "parameters": {},
            "client_request_id": request_id,
            "owner_user_id": LOCAL_ADMIN_ID,
            "config_revision": "revision",
        },
    )


@pytest.mark.asyncio
async def test_extend_job_derives_local_last_frame_for_i2v(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio import engine

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Extend")
    clip = _upload(store, project["id"], MP4, "video/mp4", "convoy.mp4")
    adapter = _RecordingVideoAdapter()
    ffmpeg = _FakeExtendFFmpeg()
    _patch_engine(monkeypatch, adapter, ffmpeg)
    job = _extend_job(store, project["id"], clip["id"], request_id="extend-local")
    await engine._run_in_owner_context(store, job["id"])

    finished = store.get_job(job["id"])
    assert finished["status"] == "succeeded"
    assert finished["operation"] == "extend"  # the user-facing operation is unchanged
    assert ffmpeg.calls == [store.asset_path(clip["id"])]

    submitted = adapter.submits[0]
    assert submitted["prompt"] == "keep chasing the convoy"  # verbatim, no rewrite
    assert submitted["parameters"] == {}
    assert len(submitted["inputs"]) == 1
    derived = submitted["inputs"][0]
    assert (derived.kind, derived.role) == ("image", "first-frame")
    assert derived.mime_type == "image/png"

    events = store.events_after(job["id"])
    derived_event = next(item for item in events if item["type"] == "job.extend_derived")
    assert derived_event["extend_mode"] == "local_last_frame"
    asset = store.get_asset(derived_event["derived_first_frame_asset_id"])
    assert asset["kind"] == "image"
    assert asset["filename"] == "convoy-last-frame.png"
    assert derived.path == store.asset_path(asset["id"])
    extending = next(item for item in events if item.get("stage") == "extending")
    assert "last frame" in extending["message"]


@pytest.mark.asyncio
async def test_native_extend_adapter_passes_inputs_through(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio import engine

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("NativeExtend")
    clip = _upload(store, project["id"], MP4, "video/mp4", "convoy.mp4")
    adapter = _NativeExtendVideoAdapter()
    ffmpeg = _FakeExtendFFmpeg()
    _patch_engine(monkeypatch, adapter, ffmpeg)
    job = _extend_job(store, project["id"], clip["id"], request_id="extend-native")
    await engine._run_in_owner_context(store, job["id"])

    assert store.get_job(job["id"])["status"] == "succeeded"
    assert ffmpeg.calls == []  # the provider extends natively: no local extraction
    submitted = adapter.submits[0]
    assert submitted["inputs"] == [
        VideoInput(store.asset_path(clip["id"]), "video/mp4", "video", role="continue-from")
    ]
    assert not [
        item for item in store.events_after(job["id"]) if item["type"] == "job.extend_derived"
    ]


@pytest.mark.asyncio
async def test_extend_without_local_engine_fails_with_two_path_hint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio import engine

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("NoEngine")
    clip = _upload(store, project["id"], MP4, "video/mp4", "convoy.mp4")
    adapter = _RecordingVideoAdapter()
    _patch_engine(monkeypatch, adapter, _FakeExtendFFmpeg(unavailable=True))
    job = _extend_job(store, project["id"], clip["id"], request_id="extend-missing")
    await engine._run_in_owner_context(store, job["id"])

    failed = store.get_job(job["id"])
    assert failed["status"] == "failed"
    assert failed["error"]["code"] == "ffmpeg_unavailable"
    message = failed["error"]["message"]
    assert "FFmpeg" in message and "本地合成引擎" in message
    assert "native extend" in message and "原生延长" in message
    assert adapter.submits == []  # nothing was ever billed


@pytest.mark.asyncio
async def test_extend_forwards_audio_alongside_derived_last_frame(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio import engine

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("ExtendAudio")
    clip = _upload(store, project["id"], MP4, "video/mp4", "convoy.mp4")
    audio = _upload(store, project["id"], WAV, "audio/wav", "sirens.wav")
    adapter = _RecordingVideoAdapter()
    _patch_engine(monkeypatch, adapter, _FakeExtendFFmpeg())
    job = _extend_job(
        store, project["id"], clip["id"], audio_id=audio["id"], request_id="extend-audio"
    )
    await engine._run_in_owner_context(store, job["id"])

    assert store.get_job(job["id"])["status"] == "succeeded"
    submitted = adapter.submits[0]
    assert [(item.kind, item.role) for item in submitted["inputs"]] == [
        ("image", "first-frame"),
        ("audio", "audio"),
    ]
    assert submitted["inputs"][1].path == store.asset_path(audio["id"])
