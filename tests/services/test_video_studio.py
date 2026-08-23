from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
import threading
import time
import zipfile

import httpx
import pytest
from starlette.requests import Request

from knorvia.multi_user.models import LOCAL_ADMIN_ID
from knorvia.services.video_studio import service
from knorvia.services.video_studio.provider import (
    FakeVideoStudioAdapter,
    GenericAsyncVideoAdapter,
    OpenAIVideosAdapter,
    VideoInput,
    VideoPollResult,
    VolcengineAsyncVideoAdapter,
    validate_download_url,
)
from knorvia.services.video_studio.store import (
    StoryboardConflictError,
    VideoStudioStore,
)
from knorvia.services.videogen.config import VideogenConfig

MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isomtest-video"
WAV = b"RIFF\x10\x00\x00\x00WAVEfmt " + b"\x00" * 16


def _payload(request_id: str = "request-1", **overrides):
    payload = {
        "operation": "text_to_video",
        "profile_id": "profile",
        "model_id": "model",
        "prompt": "a quiet lake",
        "input_asset_ids": [],
        "parameters": {},
        "client_request_id": request_id,
        "owner_user_id": LOCAL_ADMIN_ID,
        "config_revision": "revision",
    }
    payload.update(overrides)
    return payload


def _upload(store: VideoStudioStore, project_id: str, data: bytes, mime: str, name: str):
    upload = store.create_upload(
        project_id, name, mime, len(data), hashlib.sha256(data).hexdigest()
    )
    store.write_upload_part(upload["id"], 0, data)
    return store.complete_upload(upload["id"])


@pytest.mark.asyncio
async def test_user_contexts_resolve_isolated_video_stores_and_block_idor(tmp_path: Path) -> None:
    from fastapi import HTTPException

    from knorvia.api.routers import video_studio as router
    from knorvia.multi_user.models import CurrentUser, UserScope
    from knorvia.multi_user.paths import user_context
    from knorvia.services.video_studio.store import get_video_studio_store

    alice = CurrentUser(
        id="alice",
        username="alice",
        role="user",
        scope=UserScope(kind="user", user_id="alice", root=tmp_path / "alice"),
    )
    bob = CurrentUser(
        id="bob",
        username="bob",
        role="user",
        scope=UserScope(kind="user", user_id="bob", root=tmp_path / "bob"),
    )
    with user_context(alice):
        alice_store = get_video_studio_store()
        project = alice_store.create_project("Alice")
        asset = alice_store.save_output_bytes(project["id"], MP4, "video/mp4")
        job = alice_store.create_job(project["id"], _payload("alice-job", owner_user_id="alice"))
    with user_context(bob):
        bob_store = get_video_studio_store()
        assert bob_store.root != alice_store.root
        assert bob_store.list_projects() == []
        assert bob_store.get_project(project["id"]) is None
        assert bob_store.get_asset(asset["id"]) is None
        assert bob_store.get_job(job["id"]) is None
        for request_call in (
            lambda: router.asset_content(
                asset["id"], Request({"type": "http", "method": "GET", "path": "/", "headers": []})
            ),
            lambda: router.export_project(project["id"]),
            lambda: router.cancel_job(job["id"]),
            lambda: router.job_events(job["id"]),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await request_call()
            assert exc_info.value.status_code == 404
    from knorvia.services.video_studio.engine import shutdown_video_studio_runners

    await shutdown_video_studio_runners()


def test_active_project_and_session_bind(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    first = store.create_project("Desk")
    second = store.create_project("Other")
    assert store.get_active_project() is None
    assert store.set_active_project(first["id"])["id"] == first["id"]
    assert store.get_active_project()["id"] == first["id"]
    bound = store.bind_session_project("sess-desk", first["id"])
    assert bound["id"] == first["id"]
    assert store.get_session_project("sess-desk")["id"] == first["id"]
    store.set_active_project(second["id"])
    assert store.get_session_project("sess-desk")["id"] == first["id"]
    fresh = store.resolve_workspace_project("sess-new-create", title="Create · sess-new-create")
    assert fresh["id"] == second["id"]
    again = store.resolve_workspace_project("sess-desk", title="Chat · sess-desk")
    assert again["id"] == first["id"]
    with pytest.raises(KeyError):
        store.set_active_project("video_project_missing")


def test_upload_sniffs_media_and_generated_output_remains_video(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Video")
    uploaded = _upload(store, project["id"], MP4, "video/mp4", "clip.exe")
    assert uploaded["kind"] == "video"
    assert uploaded["origin"] == "uploaded"
    generated = store.save_output_bytes(project["id"], MP4, "video/mp4")
    assert generated["kind"] == "video"
    assert generated["origin"] == "generated"


def test_director_desk_snapshot_roundtrip_and_export(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Director")
    snapshot = {
        "protocolVersion": 1,
        "projectSchemaVersion": 1,
        "projectFingerprint": "fp-1",
        "project": {"cameras": [{"id": "cam-1", "name": "Push in"}], "assets": []},
        "portability": {"portable": True, "browserLocalAssetIds": [], "note": None},
    }
    assert store.get_director_desk(project["id"])["director_desk"] is None
    saved = store.save_director_desk(project["id"], snapshot)
    assert saved["director_desk"]["projectFingerprint"] == "fp-1"
    exported = store.export_project(project["id"])
    try:
        with zipfile.ZipFile(exported) as archive:
            manifest = json.loads(archive.read("manifest.json"))
        assert manifest["director_desk"]["projectFingerprint"] == "fp-1"
    finally:
        exported.unlink(missing_ok=True)
    assert store.clear_director_desk(project["id"])
    assert store.get_director_desk(project["id"])["director_desk"] is None


def test_upload_rejects_declared_type_disguise(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Video")
    upload = store.create_upload(
        project["id"], "fake.png", "image/png", len(MP4), hashlib.sha256(MP4).hexdigest()
    )
    store.write_upload_part(upload["id"], 0, MP4)
    with pytest.raises(ValueError, match="type does not match"):
        store.complete_upload(upload["id"])


@pytest.mark.asyncio
async def test_abort_upload_releases_reserved_quota_immediately(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.api.routers import video_studio as router
    from knorvia.services.video_studio import store as store_module

    monkeypatch.setattr(store_module, "MAX_ACTIVE_UPLOAD_BYTES", 10)
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Abort")
    first = store.create_upload(project["id"], "one.mp4", "video/mp4", 10, "a" * 64)
    first_path = Path(store.upload_record(first["id"])["temp_path"])
    with pytest.raises(ValueError, match="Too many active"):
        store.create_upload(project["id"], "blocked.mp4", "video/mp4", 1, "b" * 64)

    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)
    assert await router.abort_upload(first["id"]) == {"aborted": True}
    assert not first_path.exists()
    assert store.upload_record(first["id"]) is None
    assert await router.abort_upload(first["id"]) == {"aborted": False}
    replacement = store.create_upload(project["id"], "replacement.mp4", "video/mp4", 10, "c" * 64)
    assert replacement["id"] != first["id"]


def test_asset_and_project_deletion_physically_release_owned_files(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Cleanup")
    asset = store.save_output_bytes(project["id"], MP4, "video/mp4")
    path = store.asset_path(asset["id"])
    assert path.is_file()
    assert store.delete_asset(asset["id"])
    assert not path.exists()

    project_asset = store.save_output_bytes(project["id"], MP4 + b"project", "video/mp4")
    project_path = store.asset_path(project_asset["id"])
    assert store.delete_project(project["id"])
    assert not project_path.exists()
    assert not (store.projects_root / project["id"]).exists()


def test_project_cleanup_retries_after_a_windows_style_file_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio import store as store_module

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Locked")
    asset = store.save_output_bytes(project["id"], MP4, "video/mp4")
    project_dir = store.projects_root / project["id"]
    original = store_module.shutil.rmtree
    monkeypatch.setattr(
        store_module.shutil,
        "rmtree",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(PermissionError("in use")),
    )
    assert store.delete_project(project["id"])
    assert store.get_project(project["id"]) is None
    assert project_dir.exists()
    monkeypatch.setattr(store_module.shutil, "rmtree", original)
    assert store.cleanup_deleted_files() >= 1
    assert not project_dir.exists()
    assert store.get_asset(asset["id"]) is None


def test_asset_delete_fails_closed_for_job_and_storyboard_references(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("References")
    job_asset = store.save_output_bytes(project["id"], MP4, "video/mp4")
    job = store.create_job(project["id"], _payload("referenced-output"))
    store.add_job_output(job["id"], job_asset["id"])
    with pytest.raises(ValueError, match="video job"):
        store.delete_asset(job_asset["id"])

    board_asset = store.save_output_bytes(project["id"], MP4 + b"board", "video/mp4")
    store.save_storyboard(
        project["id"],
        {
            "shots": [
                {
                    "id": "shot-delete",
                    "order": 0,
                    "input_asset_ids": [board_asset["id"]],
                }
            ]
        },
        expected_revision=0,
    )
    with pytest.raises(ValueError, match="storyboard"):
        store.delete_asset(board_asset["id"])


def test_project_bgm_slot_persists_validates_and_guards_deletion(tmp_path: Path) -> None:
    """§Phase D3: project-level BGM slot — persistence, validation, delete guard."""
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Music")
    # Neutral defaults: no bed, the A3 mix level, 1 s symmetric fades.
    assert project["bgm_asset_id"] is None
    assert project["bgm_volume"] == 0.6
    assert project["bgm_fade_in"] == 1.0
    assert project["bgm_fade_out"] == 1.0

    music = _upload(store, project["id"], WAV, "audio/wav", "bgm.wav")
    updated = store.update_project(
        project["id"],
        bgm_asset_id=music["id"],
        bgm_volume=0.35,
        bgm_fade_in=2.5,
        bgm_fade_out=0.0,
    )
    assert updated["bgm_asset_id"] == music["id"]
    assert updated["bgm_volume"] == 0.35
    assert updated["bgm_fade_in"] == 2.5
    assert updated["bgm_fade_out"] == 0.0

    # Field isolation: a title-only rename keeps the slot; a BGM-only patch
    # keeps the title.
    renamed = store.update_project(project["id"], "Renamed")
    assert renamed["title"] == "Renamed"
    assert renamed["bgm_asset_id"] == music["id"]
    assert renamed["bgm_volume"] == 0.35
    reved = store.update_project(project["id"], bgm_volume=1.2)
    assert reved["title"] == "Renamed" and reved["bgm_volume"] == 1.2

    # The slot must be this project's audio asset.
    other = VideoStudioStore(tmp_path / "other")
    other_project = other.create_project("Other")
    foreign = _upload(other, other_project["id"], WAV, "audio/wav", "foreign.wav")
    with pytest.raises(ValueError, match="audio asset of this project"):
        store.update_project(project["id"], bgm_asset_id=foreign["id"])
    video_asset = store.save_output_bytes(project["id"], MP4, "video/mp4")
    with pytest.raises(ValueError, match="audio asset of this project"):
        store.update_project(project["id"], bgm_asset_id=video_asset["id"])

    # Mix level and both fades are range-bounded (0-2 / 0-10).
    for field, bad in (("bgm_volume", 2.5), ("bgm_fade_in", -1.0), ("bgm_fade_out", 11.0)):
        with pytest.raises(ValueError, match="out of range"):
            store.update_project(project["id"], **{field: bad})
    # NaN parses as a float but fails the bounds comparison → still rejected.
    with pytest.raises(ValueError, match="out of range"):
        store.update_project(project["id"], bgm_volume=float("nan"))

    # Deleting the slotted asset fails closed until the slot is cleared.
    with pytest.raises(ValueError, match="background music"):
        store.delete_asset(music["id"])
    cleared = store.update_project(project["id"], bgm_asset_id="")
    assert cleared["bgm_asset_id"] is None
    assert store.delete_asset(music["id"])


def test_project_bgm_columns_migrate_with_neutral_defaults(tmp_path: Path) -> None:
    """§Phase D3: a pre-D3 database gains the BGM columns on next open."""
    import sqlite3

    store = VideoStudioStore(tmp_path / "studio")
    legacy = store.create_project("Legacy")
    raw = sqlite3.connect(store.db_path)
    for column in ("bgm_asset_id", "bgm_volume", "bgm_fade_in", "bgm_fade_out"):
        raw.execute(f"ALTER TABLE projects DROP COLUMN {column}")
    raw.commit()
    raw.close()

    reopened = VideoStudioStore(tmp_path / "studio")
    migrated = reopened.get_project(legacy["id"])
    assert migrated["bgm_asset_id"] is None
    assert migrated["bgm_volume"] == 0.6
    assert migrated["bgm_fade_in"] == 1.0
    assert migrated["bgm_fade_out"] == 1.0


def test_storyboard_cas_and_worker_patch_preserve_user_fields(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Storyboard")
    first = store.save_storyboard(
        project["id"],
        {"shots": [{"id": "shot-1", "order": 4, "title": "Keep", "notes": "mine"}]},
        expected_revision=0,
    )
    with pytest.raises(StoryboardConflictError):
        store.save_storyboard(project["id"], {"shots": []}, expected_revision=0)
    job = store.create_job(
        project["id"],
        _payload(storyboard_shot_id="shot-1"),
    )
    store.patch_storyboard_shot_job(project["id"], "shot-1", job["id"])
    asset = store.save_output_bytes(project["id"], MP4, "video/mp4")
    assert store.patch_storyboard_job_output(project["id"], job["id"], asset["id"])
    board = store.get_storyboard(project["id"])
    assert board["revision"] == first["revision"] + 2
    assert board["shots"][0] == {
        "id": "shot-1",
        "order": 4,
        "title": "Keep",
        "prompt": "",
        "input_asset_ids": [],
        "job_id": job["id"],
        "output_asset_id": asset["id"],
        "duration": None,
        "notes": "mine",
        "transition": "",
        "keyframe_asset_id": None,
        "keyframe_prompt": "",
        "voiceover_text": "",
        "voiceover_asset_id": None,
        "voiceover_voice": "",
        "character_ids": [],
    }


def test_storyboard_shot_camera_field_roundtrip_and_normalize(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Storyboard camera")
    long_motion = "pan-" + "x" * 80
    saved = store.save_storyboard(
        project["id"],
        {
            "shots": [
                {
                    "id": "shot-push",
                    "title": "Push",
                    "prompt": "drone pushes in",
                    "camera": " push ",
                },
                {"id": "shot-long", "title": "Long", "prompt": "wide pan", "camera": long_motion},
                {"id": "shot-bare", "title": "Bare", "prompt": "static wide", "camera": "   "},
                {"id": "shot-junk", "title": "Junk", "prompt": "tilt down", "camera": 42},
            ]
        },
        expected_revision=0,
    )
    assert saved["revision"] == 1
    shots = store.get_storyboard(project["id"])["shots"]
    # Trimmed, capped at 64 chars, dropped when empty; non-strings coerce
    # through str() exactly like every other storyboard string field.
    assert shots[0]["camera"] == "push"
    assert shots[1]["camera"] == long_motion[:64]
    assert "camera" not in shots[2]
    assert shots[3]["camera"] == "42"
    # A read/validate round-trip keeps the stored value intact.
    assert store.get_storyboard(project["id"])["shots"][0]["camera"] == "push"


def test_storyboard_validation_and_write_exclude_concurrent_asset_delete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Storyboard lock")
    asset = store.save_output_bytes(project["id"], MP4, "video/mp4")
    validated = threading.Event()
    release = threading.Event()
    delete_done = threading.Event()
    failures: list[Exception] = []
    original = store._validate_storyboard

    def blocking_validate(project_id, payload):
        result = original(project_id, payload)
        validated.set()
        assert release.wait(2)
        return result

    monkeypatch.setattr(store, "_validate_storyboard", blocking_validate)

    def save():
        try:
            store.save_storyboard(
                project["id"],
                {"shots": [{"id": "shot-lock", "order": 0, "input_asset_ids": [asset["id"]]}]},
                expected_revision=0,
            )
        except Exception as exc:  # pragma: no cover - assertion below reports it
            failures.append(exc)

    def delete():
        try:
            store.delete_asset(asset["id"])
        except Exception as exc:
            failures.append(exc)
        finally:
            delete_done.set()

    save_thread = threading.Thread(target=save)
    save_thread.start()
    assert validated.wait(2)
    delete_thread = threading.Thread(target=delete)
    delete_thread.start()
    assert not delete_done.wait(0.05)
    release.set()
    save_thread.join(2)
    delete_thread.join(2)
    assert any("storyboard" in str(exc) for exc in failures)
    assert store.get_asset(asset["id"]) is not None


def test_job_creation_rechecks_input_after_prevalidation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Job lock")
    asset = store.save_output_bytes(project["id"], MP4, "video/mp4")
    original = store.get_asset
    deleted = False

    def race(asset_id):
        nonlocal deleted
        value = original(asset_id)
        if value and not deleted:
            deleted = True
            assert store.delete_asset(asset_id)
        return value

    monkeypatch.setattr(store, "get_asset", race)
    with pytest.raises(ValueError, match="Input assets"):
        store.create_job(project["id"], _payload("input-race", input_asset_ids=[asset["id"]]))
    assert store.list_jobs(project["id"]) == []


def test_job_idempotency_and_terminal_transitions_are_conditional(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Jobs")
    first = store.create_job(project["id"], _payload())
    assert store.create_job(project["id"], _payload())["id"] == first["id"]
    with pytest.raises(ValueError, match="different request"):
        store.create_job(project["id"], _payload(prompt="different"))
    assert store.transition_terminal(first["id"], "cancelled")
    assert not store.transition_terminal(first["id"], "succeeded")
    second = store.create_job(project["id"], _payload("request-2"))
    assert store.transition_terminal(second["id"], "succeeded")
    assert not store.transition_terminal(second["id"], "cancelled")
    failed = store.create_job(project["id"], _payload("request-failed"))
    assert store.transition_terminal(
        failed["id"], "failed", error_code="provider_error", error_message="rejected"
    )
    assert store.get_job(failed["id"])["error"] == {
        "code": "provider_error",
        "message": "rejected",
    }


def test_cancelled_jobs_are_compacted_from_the_bounded_runner_queue(tmp_path: Path) -> None:
    from knorvia.services.video_studio.engine import _StoreRunner
    from knorvia.services.video_studio.store import MAX_PENDING_JOBS

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Queue")
    runner = _StoreRunner(store)
    jobs = [
        store.create_job(project["id"], _payload(f"queued-{index}"))
        for index in range(MAX_PENDING_JOBS)
    ]
    assert all(runner.enqueue(job["id"]) for job in jobs)
    assert runner.queue.full()
    assert all(store.transition_terminal(job["id"], "cancelled") for job in jobs)
    replacement = store.create_job(project["id"], _payload("replacement"))
    assert runner.enqueue(replacement["id"])
    assert runner.queue.qsize() == 1


def test_completion_publishes_output_and_storyboard_atomically(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Atomic")
    store.save_storyboard(
        project["id"],
        {"shots": [{"id": "shot-atomic", "order": 0}]},
        expected_revision=0,
    )
    job = store.create_job(project["id"], _payload("atomic", storyboard_shot_id="shot-atomic"))
    store.patch_storyboard_shot_job(project["id"], "shot-atomic", job["id"])
    assert store.claim_submission(job["id"])
    assert store.record_provider_task(job["id"], "provider-atomic")
    asset = store.save_output_bytes(project["id"], MP4, "video/mp4")
    assert store.complete_job_with_output(job["id"], asset["id"])
    finished = store.get_job(job["id"])
    assert finished["status"] == "succeeded"
    assert finished["output_asset_ids"] == [asset["id"]]
    assert finished["error"] is None
    assert store.get_storyboard(project["id"])["shots"][0]["output_asset_id"] == asset["id"]

    cancelled = store.create_job(project["id"], _payload("cancel-race"))
    assert store.claim_submission(cancelled["id"])
    assert store.record_provider_task(cancelled["id"], "provider-cancelled")
    orphan = store.save_output_bytes(project["id"], MP4 + b"orphan", "video/mp4")
    assert store.transition_terminal(cancelled["id"], "cancelled")
    assert not store.complete_job_with_output(cancelled["id"], orphan["id"])
    assert store.get_job(cancelled["id"])["output_asset_ids"] == []
    assert store.delete_asset(orphan["id"])


def test_progress_events_are_not_duplicated_when_provider_state_is_unchanged(
    tmp_path: Path,
) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Progress")
    job = store.create_job(project["id"], _payload("progress"))
    assert store.claim_submission(job["id"])
    assert store.record_provider_task(job["id"], "provider-progress")
    before = len(store.events_after(job["id"]))
    assert store.update_progress(job["id"], 0.5, "rendering")
    assert not store.update_progress(job["id"], 0.5, "rendering")
    assert not store.update_progress(job["id"], 0.4, "rendering")
    assert store.update_progress(job["id"], 0.4, "encoding")
    events = store.events_after(job["id"])[before:]
    assert [event["type"] for event in events] == ["job.progress", "job.progress"]
    assert events[-1]["progress"] == 0.5
    assert events[-1]["stage"] == "encoding"


@pytest.mark.asyncio
async def test_cancel_during_submit_waits_for_task_id_then_cancels_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio import engine

    class DelayedSubmitAdapter(FakeVideoStudioAdapter):
        def __init__(self) -> None:
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def submit(self, *args, **kwargs) -> str:
            self.started.set()
            await self.release.wait()
            return "provider-after-cancel"

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Cancel submit")
    job = store.create_job(project["id"], _payload("cancel-submit"))
    adapter = DelayedSubmitAdapter()
    monkeypatch.setattr(engine, "_authorized_catalog", lambda _job: {})
    monkeypatch.setattr(
        engine,
        "resolve_videogen_runtime_config",
        lambda **_kwargs: VideogenConfig(
            model="m", adapter="fake", base_url="https://provider.test", request_timeout=2
        ),
    )
    monkeypatch.setattr(engine, "get_video_studio_adapter", lambda _name: adapter)
    task = asyncio.create_task(engine._run_in_owner_context(store, job["id"]))
    await asyncio.wait_for(adapter.started.wait(), timeout=1)
    assert store._internal_job(job["id"])["status"] == "submitting"
    engine._active[job["id"]] = task
    assert engine.cancel_video_job(store, job["id"])
    assert not task.cancelled()
    adapter.release.set()
    await asyncio.wait_for(task, timeout=1)
    engine._active.pop(job["id"], None)
    assert "provider-after-cancel" in adapter.cancelled
    assert store.get_job(job["id"])["status"] == "cancelled"


@pytest.mark.asyncio
async def test_provider_self_cancel_does_not_escape_cancellation_helper(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from knorvia.services.video_studio import engine

    class SelfCancellingAdapter(FakeVideoStudioAdapter):
        async def cancel(self, task_id: str, config: VideogenConfig) -> bool:
            raise asyncio.CancelledError

    monkeypatch.setattr(engine, "PROVIDER_CANCEL_GRACE_SECONDS", 0.05)
    await asyncio.wait_for(
        engine._cancel_provider_task(
            SelfCancellingAdapter(),
            "provider-task",
            VideogenConfig(model="m"),
            job_id="job",
        ),
        timeout=0.5,
    )


@pytest.mark.asyncio
async def test_restart_polls_completed_provider_before_expired_local_deadline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio import engine

    class CompletedAdapter(FakeVideoStudioAdapter):
        async def poll(self, task_id: str, config: VideogenConfig) -> VideoPollResult:
            return VideoPollResult("succeeded", 1.0, f"fake://{task_id}")

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Recovered")
    job = store.create_job(project["id"], _payload("recovered"))
    assert store.claim_submission(job["id"])
    assert store.record_provider_task(job["id"], "completed-while-offline")
    with store._connect() as db:
        db.execute("UPDATE jobs SET started_at=? WHERE id=?", (0.5, job["id"]))
    adapter = CompletedAdapter()
    monkeypatch.setattr(engine, "_authorized_catalog", lambda _job: {})
    monkeypatch.setattr(
        engine,
        "resolve_videogen_runtime_config",
        lambda **_kwargs: VideogenConfig(
            model="m", adapter="fake", base_url="https://provider.test", poll_timeout=1
        ),
    )
    monkeypatch.setattr(engine, "get_video_studio_adapter", lambda _name: adapter)
    await engine._run_in_owner_context(store, job["id"])
    finished = store.get_job(job["id"])
    assert finished["status"] == "succeeded"
    assert len(finished["output_asset_ids"]) == 1
    assert adapter.cancelled == set()


@pytest.mark.asyncio
async def test_accepted_provider_task_recovers_from_transient_poll_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio import engine

    class TransientPollAdapter(FakeVideoStudioAdapter):
        def __init__(self) -> None:
            super().__init__()
            self.poll_count = 0

        async def poll(self, task_id: str, config: VideogenConfig) -> VideoPollResult:
            self.poll_count += 1
            if self.poll_count == 1:
                raise httpx.ReadTimeout("temporary provider transport failure")
            return VideoPollResult("succeeded", 1.0, f"fake://{task_id}")

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Transient poll")
    job = store.create_job(project["id"], _payload("transient-poll"))
    adapter = TransientPollAdapter()
    monkeypatch.setattr(engine, "_authorized_catalog", lambda _job: {})
    monkeypatch.setattr(
        engine,
        "resolve_videogen_runtime_config",
        lambda **_kwargs: VideogenConfig(
            model="m",
            adapter="fake",
            base_url="https://provider.test",
            poll_interval=0.001,
            poll_timeout=5,
        ),
    )
    monkeypatch.setattr(engine, "get_video_studio_adapter", lambda _name: adapter)

    await engine._run_in_owner_context(store, job["id"])

    finished = store.get_job(job["id"])
    assert finished["status"] == "succeeded"
    assert adapter.poll_count == 2
    assert len(finished["output_asset_ids"]) == 1
    assert any(event.get("stage") == "retrying" for event in store.events_after(job["id"]))


@pytest.mark.asyncio
async def test_accepted_provider_task_recovers_from_transient_download_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio import engine

    class TransientDownloadAdapter(FakeVideoStudioAdapter):
        def __init__(self) -> None:
            super().__init__()
            self.download_count = 0

        async def poll(self, task_id: str, config: VideogenConfig) -> VideoPollResult:
            return VideoPollResult("succeeded", 1.0, f"fake://{task_id}")

        async def download(self, url: str, config: VideogenConfig, target: Path) -> str:
            self.download_count += 1
            if self.download_count == 1:
                raise OSError("temporary output storage transport failure")
            return await super().download(url, config, target)

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Transient download")
    job = store.create_job(project["id"], _payload("transient-download"))
    adapter = TransientDownloadAdapter()
    monkeypatch.setattr(engine, "_authorized_catalog", lambda _job: {})
    monkeypatch.setattr(
        engine,
        "resolve_videogen_runtime_config",
        lambda **_kwargs: VideogenConfig(
            model="m",
            adapter="fake",
            base_url="https://provider.test",
            poll_interval=0.001,
            poll_timeout=5,
        ),
    )
    monkeypatch.setattr(engine, "get_video_studio_adapter", lambda _name: adapter)

    await engine._run_in_owner_context(store, job["id"])

    finished = store.get_job(job["id"])
    assert finished["status"] == "succeeded"
    assert adapter.download_count == 2
    assert len(finished["output_asset_ids"]) == 1
    assert any(event.get("stage") == "retrying_download" for event in store.events_after(job["id"]))


def test_restart_resumes_provider_task_but_not_uncertain_submission(tmp_path: Path) -> None:
    root = tmp_path / "studio"
    store = VideoStudioStore(root)
    project = store.create_project("Restart")
    uncertain = store.create_job(project["id"], _payload("uncertain"))
    assert store.claim_submission(uncertain["id"])
    running = store.create_job(project["id"], _payload("running"))
    assert store.claim_submission(running["id"])
    assert store.record_provider_task(running["id"], "provider-42")
    reopened = VideoStudioStore(root)
    assert reopened.get_job(uncertain["id"])["status"] == "interrupted"
    assert reopened.get_job(running["id"])["status"] == "running"
    assert running["id"] in reopened.resumable_job_ids()


def test_export_includes_more_than_one_page_of_assets(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Export")
    for index in range(101):
        store.save_output_bytes(project["id"], MP4 + str(index).encode(), "video/mp4")
    exported = store.export_project(project["id"])
    with zipfile.ZipFile(exported) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert len(manifest["assets"]) == 101
        assert len([name for name in archive.namelist() if name.startswith("assets/")]) == 101
    second_export = store.export_project(project["id"])
    assert second_export != exported
    assert second_export.is_file()


def test_export_holds_snapshot_lock_until_archive_is_complete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Concurrent export")
    asset = store.save_output_bytes(project["id"], MP4, "video/mp4")
    entered = threading.Event()
    release = threading.Event()
    delete_done = threading.Event()
    original_asset_path = store.asset_path
    exported: list[Path] = []
    deleted: list[bool] = []

    def slow_asset_path(asset_id: str) -> Path:
        entered.set()
        assert release.wait(2)
        return original_asset_path(asset_id)

    monkeypatch.setattr(store, "asset_path", slow_asset_path)
    export_thread = threading.Thread(
        target=lambda: exported.append(store.export_project(project["id"]))
    )
    export_thread.start()
    assert entered.wait(2)

    def delete() -> None:
        deleted.append(store.delete_asset(asset["id"]))
        delete_done.set()

    delete_thread = threading.Thread(target=delete)
    delete_thread.start()
    assert not delete_done.wait(0.1)
    release.set()
    export_thread.join(2)
    delete_thread.join(2)
    assert not export_thread.is_alive()
    assert not delete_thread.is_alive()
    assert deleted == [True]
    with zipfile.ZipFile(exported[0]) as archive:
        assert len([name for name in archive.namelist() if name.startswith("assets/")]) == 1


@pytest.mark.asyncio
async def test_export_response_removes_unique_archive_after_send(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.api.routers import video_studio as router

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Response cleanup")
    store.save_output_bytes(project["id"], MP4, "video/mp4")
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)
    response = await router.export_project(project["id"])
    archive = Path(response.path)
    assert archive.is_file()
    assert response.background is not None
    await response.background()
    assert not archive.exists()


def test_schema_validation_enforces_custom_type_enum_and_bounds() -> None:
    capabilities = {
        "parameter_schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "guidance": {"type": "number", "minimum": 1, "maximum": 10},
                "motion": {"type": "string", "enum": ["low", "high"], "maxLength": 4},
            },
        }
    }
    service._validate_parameters({"guidance": 5, "motion": "high"}, capabilities)
    with pytest.raises(ValueError, match="Invalid type"):
        service._validate_parameters({"guidance": "5"}, capabilities)
    with pytest.raises(ValueError, match="above maximum"):
        service._validate_parameters({"guidance": 11}, capabilities)
    with pytest.raises(ValueError, match="Unsupported value"):
        service._validate_parameters({"motion": "fast"}, capabilities)
    for invalid in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ValueError, match="finite"):
            service._validate_parameters({"guidance": invalid}, capabilities)


def test_schema_validation_supports_bounded_unions_and_required_fields() -> None:
    capabilities = {
        "parameter_schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["preset"],
            "properties": {
                "preset": {
                    "anyOf": [
                        {"type": "string", "enum": ["cinematic"]},
                        {"type": "integer", "minimum": 1, "maximum": 3},
                    ]
                },
                "exclusive": {
                    "oneOf": [
                        {"type": "string", "enum": ["soft"]},
                        {"type": "integer", "enum": [2]},
                    ]
                },
            },
        }
    }
    service._validate_parameters({"preset": "cinematic", "exclusive": 2}, capabilities)
    service._validate_parameters({"preset": 3, "exclusive": "soft"}, capabilities)
    with pytest.raises(ValueError, match="Required video parameter"):
        service._validate_parameters({}, capabilities)
    with pytest.raises(ValueError, match="does not match anyOf"):
        service._validate_parameters({"preset": False}, capabilities)


def test_schema_validation_enforces_root_unions_without_rejecting_base_fields() -> None:
    any_of = {
        "parameter_schema": {
            "anyOf": [
                {
                    "type": "object",
                    "required": ["mode"],
                    "properties": {"mode": {"type": "string", "enum": ["prompt"]}},
                },
                {
                    "type": "object",
                    "required": ["frames"],
                    "properties": {"frames": {"type": "integer", "minimum": 1}},
                },
            ]
        }
    }
    service._validate_parameters({"mode": "prompt", "duration": "5"}, any_of)
    service._validate_parameters({"frames": 12, "resolution": "720p"}, any_of)
    with pytest.raises(ValueError, match="does not match anyOf"):
        service._validate_parameters({"mode": "invalid"}, any_of)

    one_of = {
        "parameter_schema": {
            "oneOf": [
                {
                    "type": "object",
                    "required": ["preset"],
                    "properties": {"preset": {"type": "string"}},
                },
                {
                    "type": "object",
                    "required": ["preset"],
                    "properties": {"preset": {"type": "integer"}},
                },
            ]
        }
    }
    service._validate_parameters({"preset": "cinematic", "fps": 24}, one_of)
    with pytest.raises(ValueError, match="does not match oneOf"):
        service._validate_parameters({"preset": False}, one_of)


def test_text_to_video_can_accept_capability_gated_input_audio(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Audio")
    audio = _upload(store, project["id"], WAV, "audio/wav", "sound.wav")
    option = {
        "capabilities": {
            "operations": ["text_to_video"],
            "audio_modes": ["none", "input"],
            "max_inputs": {"image": 0, "video": 0, "audio": 1, "total": 1},
            "parameter_schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {"audio_mode": {"type": "string", "enum": ["none", "input"]}},
            },
        },
        "defaults": {},
    }
    monkeypatch.setattr(service, "find_video_option", lambda *_: option)
    monkeypatch.setattr(
        service,
        "capture_video_authorization",
        lambda *_: {"owner_user_id": LOCAL_ADMIN_ID, "config_revision": "revision"},
    )
    monkeypatch.setattr(service, "start_video_job", lambda *_: None)
    job = service.create_video_job(
        store,
        project_id=project["id"],
        profile_id="profile",
        model_id="model",
        operation="text_to_video",
        prompt="dance",
        input_asset_ids=[audio["id"]],
        parameters={"audio_mode": "input"},
        client_request_id="audio-job",
        confirmed_cost=True,
    )
    assert job["input_asset_ids"] == [audio["id"]]


def test_explicit_cost_confirmation_is_required(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Cost")
    with pytest.raises(PermissionError, match="confirmation"):
        service.create_video_job(
            store,
            project_id=project["id"],
            profile_id="profile",
            model_id="model",
            operation="text_to_video",
            prompt="clip",
            input_asset_ids=[],
            parameters={},
            client_request_id="cost",
            confirmed_cost=False,
        )


@pytest.mark.asyncio
async def test_retry_inherits_storyboard_shot_id(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.api.routers import video_studio as router

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Retry")
    store.save_storyboard(
        project["id"],
        {"shots": [{"id": "shot-keep", "order": 0}]},
        expected_revision=0,
    )
    old = store.create_job(project["id"], _payload("old-shot", storyboard_shot_id="shot-keep"))
    captured: dict[str, object] = {}

    def create(_store, **kwargs):
        captured.update(kwargs)
        return {"id": "retry"}

    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)
    monkeypatch.setattr(router, "create_video_job", create)
    result = await router.retry_job(
        old["id"],
        router.RetryCreate(client_request_id="retry-shot", confirmed_cost=True),
    )
    assert result == {"id": "retry"}
    assert captured["storyboard_shot_id"] == "shot-keep"

    board = store.get_storyboard(project["id"])
    store.save_storyboard(project["id"], {"shots": []}, expected_revision=board["revision"])
    captured.clear()
    await router.retry_job(
        old["id"],
        router.RetryCreate(
            client_request_id="retry-without-deleted-shot",
            confirmed_cost=True,
            storyboard_shot_id=None,
        ),
    )
    assert captured["storyboard_shot_id"] is None

    captured.clear()
    await router.retry_job(
        old["id"],
        router.RetryCreate(client_request_id="retry-stale-shot", confirmed_cost=True),
    )
    assert captured["storyboard_shot_id"] is None


def test_retry_requires_a_retryable_terminal_job(tmp_path: Path) -> None:
    from knorvia.services.video_studio.store import VideoStudioRetryConflictError

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Retry state")
    original = store.create_job(project["id"], _payload("original"))
    retry_payload = _payload("retry", retry_of_job_id=original["id"])

    with pytest.raises(VideoStudioRetryConflictError, match="can be retried"):
        store.create_job(project["id"], retry_payload)

    assert store.transition_terminal(
        original["id"], "failed", error_code="provider_error", error_message="failed"
    )
    retried = store.create_job(project["id"], retry_payload)
    assert retried["retry_of_job_id"] == original["id"]


@pytest.mark.asyncio
async def test_retry_conflict_is_reported_as_http_409(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import HTTPException

    from knorvia.api.routers import video_studio as router
    from knorvia.services.video_studio.store import VideoStudioRetryConflictError

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Retry conflict")
    original = store.create_job(project["id"], _payload("active-original"))
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)
    monkeypatch.setattr(
        router,
        "create_video_job",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            VideoStudioRetryConflictError(
                "Only failed, cancelled, or interrupted video jobs can be retried"
            )
        ),
    )

    with pytest.raises(HTTPException) as raised:
        await router.retry_job(
            original["id"],
            router.RetryCreate(client_request_id="blocked-retry", confirmed_cost=True),
        )
    assert raised.value.status_code == 409


# ── §Phase C5 variants / reroll ─────────────────────────────────────


def _succeed(store: VideoStudioStore, project_id: str, job: dict, payload: bytes) -> dict:
    """Drive a store-created job to a succeeded state with one MP4 output."""
    assert store.claim_submission(job["id"])
    assert store.record_provider_task(job["id"], f"provider-{job['id']}")
    asset = store.save_output_bytes(project_id, payload, "video/mp4")
    assert store.complete_job_with_output(job["id"], asset["id"])
    return store.get_job(job["id"]) or {}


@pytest.mark.asyncio
async def test_shot_variant_list_is_read_only_newest_first_and_shot_scoped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import HTTPException

    from knorvia.api.routers import video_studio as router

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Variants")
    store.save_storyboard(
        project["id"],
        {"shots": [{"id": "shot-a", "order": 0}, {"id": "shot-b", "order": 1}]},
        expected_revision=0,
    )
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)
    first = store.create_job(project["id"], _payload("variant-1", storyboard_shot_id="shot-a"))
    time.sleep(0.02)
    other = store.create_job(project["id"], _payload("variant-other", storyboard_shot_id="shot-b"))
    time.sleep(0.02)
    second = store.create_job(project["id"], _payload("variant-2", storyboard_shot_id="shot-a"))
    revision_before = store.get_storyboard(project["id"])["revision"]

    result = await router.list_shot_jobs(project["id"], "shot-a")
    assert [job["id"] for job in result["jobs"]] == [second["id"], first["id"]]
    assert all(job["storyboard_shot_id"] == "shot-a" for job in result["jobs"])
    assert other["id"] not in {job["id"] for job in result["jobs"]}

    # Read-only: a repeated call neither mutates the storyboard nor the jobs.
    replay = await router.list_shot_jobs(project["id"], "shot-a")
    assert replay == result
    assert store.get_storyboard(project["id"])["revision"] == revision_before
    assert len(store.list_jobs(project["id"])) == 3

    with pytest.raises(HTTPException) as missing_shot:
        await router.list_shot_jobs(project["id"], "shot-missing")
    assert missing_shot.value.status_code == 404
    with pytest.raises(HTTPException) as missing_project:
        await router.list_shot_jobs("video_project_missing", "shot-a")
    assert missing_project.value.status_code == 404


def _reroll_option(supports_seed: bool) -> dict:
    return {
        "capabilities": {
            "operations": ["text_to_video"],
            "supports_seed": supports_seed,
            "durations": [4, 8],
            "parameter_schema": {
                "type": "object",
                "properties": {
                    "duration": {"type": "number"},
                    "camera_motion": {"type": "string", "enum": ["static", "dolly", "pan"]},
                    # Real presets declare the seed field when the model
                    # supports one; keep the fixture faithful to that.
                    **({"seed": {"type": "integer"}} if supports_seed else {}),
                },
            },
        },
        "defaults": {},
    }


async def _reroll_flow(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    supports_seed: bool,
    parameters: dict,
):
    """Shared §Phase C5 reroll plumbing; returns (store, project, old, new)."""
    from knorvia.api.routers import video_studio as router

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Reroll")
    store.save_storyboard(
        project["id"], {"shots": [{"id": "shot-r", "order": 0}]}, expected_revision=0
    )
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)
    old = store.create_job(
        project["id"],
        _payload("reroll-source", storyboard_shot_id="shot-r", parameters=parameters),
    )
    store.patch_storyboard_shot_job(project["id"], "shot-r", old["id"])
    old = _succeed(store, project["id"], old, MP4)

    option = _reroll_option(supports_seed)
    monkeypatch.setattr(service, "find_video_option", lambda *_: option)
    monkeypatch.setattr(router, "find_video_option", lambda *_: option)
    monkeypatch.setattr(
        service,
        "capture_video_authorization",
        lambda *_: {"owner_user_id": LOCAL_ADMIN_ID, "config_revision": "revision"},
    )
    monkeypatch.setattr(service, "start_video_job", lambda *_: None)
    rerolled = await router.reroll_job(
        old["id"],
        router.RerollCreate(client_request_id="reroll-1", confirmed_cost=True),
    )
    return store, project, old, rerolled


@pytest.mark.asyncio
async def test_reroll_copies_parameters_with_fresh_seed_and_verbatim_camera(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, project, old, rerolled = await _reroll_flow(
        tmp_path,
        monkeypatch,
        supports_seed=True,
        parameters={"seed": 123, "camera_motion": "dolly", "duration": 8},
    )
    assert rerolled["storyboard_shot_id"] == "shot-r"
    assert rerolled["prompt"] == old["prompt"]
    assert rerolled["operation"] == old["operation"]
    assert rerolled["retry_of_job_id"] is None  # reroll ≠ retry; lineage is the shot
    assert rerolled["parameters"]["camera_motion"] == "dolly"
    assert rerolled["parameters"]["duration"] == 8
    assert isinstance(rerolled["parameters"]["seed"], int)
    assert rerolled["parameters"]["seed"] != 123
    assert 0 <= rerolled["parameters"]["seed"] <= 2**32 - 1

    # The new take becomes the shot's current job and tops the variant list.
    shot = store.get_storyboard(project["id"])["shots"][0]
    assert shot["job_id"] == rerolled["id"]
    variants = store.list_shot_jobs(project["id"], "shot-r")
    assert [job["id"] for job in variants] == [rerolled["id"], old["id"]]


@pytest.mark.asyncio
async def test_reroll_without_seed_support_drops_seed_and_keeps_camera(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, _project_row, _old, rerolled = await _reroll_flow(
        tmp_path,
        monkeypatch,
        supports_seed=False,
        parameters={"camera_motion": "pan", "seed": 7},
    )
    assert rerolled["parameters"] == {"camera_motion": "pan"}
    assert "seed" not in rerolled["parameters"]
    assert len(store.list_jobs(_project_row["id"])) == 2


@pytest.mark.asyncio
async def test_reroll_requires_explicit_cost_confirmation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import HTTPException

    from knorvia.api.routers import video_studio as router

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Reroll cost")
    old = store.create_job(project["id"], _payload("reroll-cost"))
    old = _succeed(store, project["id"], old, MP4)
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)

    with pytest.raises(HTTPException) as raised:
        await router.reroll_job(
            old["id"],
            router.RerollCreate(client_request_id="reroll-unconfirmed", confirmed_cost=False),
        )
    assert raised.value.status_code == 409
    assert "confirmation" in str(raised.value.detail).lower()
    # No job was persisted by an unconfirmed reroll.
    assert len(store.list_jobs(project["id"])) == 1


@pytest.mark.asyncio
async def test_bind_shot_job_switches_current_variant_and_rejects_foreign_jobs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import HTTPException

    from knorvia.api.routers import video_studio as router

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Bind")
    store.save_storyboard(
        project["id"],
        {"shots": [{"id": "shot-a", "order": 0}, {"id": "shot-b", "order": 1}]},
        expected_revision=0,
    )
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)
    take_one = store.create_job(project["id"], _payload("bind-1", storyboard_shot_id="shot-a"))
    store.patch_storyboard_shot_job(project["id"], "shot-a", take_one["id"])
    take_one = _succeed(store, project["id"], take_one, MP4)
    take_two = store.create_job(project["id"], _payload("bind-2", storyboard_shot_id="shot-a"))
    take_two = _succeed(store, project["id"], take_two, MP4 + b"two")
    other_shot = store.create_job(project["id"], _payload("bind-b", storyboard_shot_id="shot-b"))
    other_shot = _succeed(store, project["id"], other_shot, MP4 + b"b")
    foreign_project = store.create_project("Foreign")
    foreign_job = store.create_job(foreign_project["id"], _payload("bind-foreign"))

    shot = store.get_storyboard(project["id"])["shots"][0]
    assert shot["job_id"] == take_one["id"]
    assert shot["output_asset_id"] == take_one["output_asset_ids"][0]

    result = await router.bind_shot_job(
        project["id"], "shot-a", router.ShotJobBind(job_id=take_two["id"])
    )
    assert result["shot"]["job_id"] == take_two["id"]
    assert result["shot"]["output_asset_id"] == take_two["output_asset_ids"][0]
    shot = store.get_storyboard(project["id"])["shots"][0]
    assert shot["job_id"] == take_two["id"]
    assert shot["output_asset_id"] == take_two["output_asset_ids"][0]

    for job_id, detail in (
        (other_shot["id"], "not generated for this shot"),
        (foreign_job["id"], "different project"),
    ):
        with pytest.raises(HTTPException) as rejected:
            await router.bind_shot_job(project["id"], "shot-a", router.ShotJobBind(job_id=job_id))
        assert rejected.value.status_code == 422
        assert detail in str(rejected.value.detail)

    with pytest.raises(HTTPException) as missing_job:
        await router.bind_shot_job(
            project["id"], "shot-a", router.ShotJobBind(job_id="video_job_missing")
        )
    assert missing_job.value.status_code == 404
    with pytest.raises(HTTPException) as missing_shot:
        await router.bind_shot_job(
            project["id"], "shot-missing", router.ShotJobBind(job_id=take_one["id"])
        )
    assert missing_shot.value.status_code == 404


@pytest.mark.asyncio
async def test_generic_adapter_streams_download_and_rejects_private_ssrf(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "video/mp4"}, content=MP4)

    adapter = GenericAsyncVideoAdapter(transport=httpx.MockTransport(handler))
    config = VideogenConfig(model="m", base_url="https://provider.test/v1")
    target = tmp_path / "out.mp4"
    assert await adapter.download("https://provider.test/out", config, target) == "video/mp4"
    assert target.read_bytes() == MP4
    monkeypatch.setattr(
        "knorvia.services.video_studio.provider.socket.getaddrinfo",
        lambda *_: [(None, None, None, None, ("127.0.0.1", 0))],
    )
    with pytest.raises(Exception, match="private address"):
        await validate_download_url("https://attacker.test/video", config.base_url)


@pytest.mark.asyncio
async def test_generic_adapter_fails_fast_for_rejected_and_unknown_states() -> None:
    statuses = iter(
        [
            {"status": "moderated", "error": {"message": "policy"}},
            {"status": "mystery"},
        ]
    )
    adapter = GenericAsyncVideoAdapter(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=next(statuses)))
    )
    config = VideogenConfig(model="m", base_url="https://provider.test/v1")
    rejected = await adapter.poll("one", config)
    assert rejected.state == "failed"
    assert rejected.error == "policy"
    with pytest.raises(Exception, match="unsupported status: mystery"):
        await adapter.poll("two", config)


@pytest.mark.asyncio
async def test_volcengine_adapter_uses_seedance_prompt_commands() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.read()))
        return httpx.Response(200, json={"id": "seedance-task"})

    adapter = VolcengineAsyncVideoAdapter(transport=httpx.MockTransport(handler))
    config = VideogenConfig(
        model="seedance",
        adapter="volcengine_async_task",
        base_url="https://ark.test/api/v3",
        aspect_ratio="16:9",
        resolution="720p",
        duration="5",
    )
    task_id = await adapter.submit(
        "a lake",
        config,
        inputs=[],
        parameters={"fps": 24, "audio_mode": "generate"},
        idempotency_key="seedance-probe",
    )
    assert task_id == "seedance-task"
    assert seen == {
        "model": "seedance",
        "content": [
            {
                "type": "text",
                "text": "a lake --ratio 16:9 --resolution 720p --duration 5",
            }
        ],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("parameters", "switch"),
    [
        # Moving vocabulary unlocks the camera; the motion itself stays in
        # the user's prompt, which this adapter never rewrites.
        ({"camera_motion": "orbit"}, "--camerafixed false"),
        ({"camera_motion": "push"}, "--camerafixed false"),
        # Locked-viewpoint vocabulary maps onto the fixed switch.
        ({"camera_motion": "static"}, "--camerafixed true"),
        ({"camera_control": "none"}, "--camerafixed true"),
        ({"camera_control": "simple"}, "--camerafixed false"),
        # An explicit boolean wins over the string parameters.
        ({"camera_fixed": True, "camera_motion": "orbit"}, "--camerafixed true"),
    ],
)
async def test_volcengine_adapter_maps_camera_params_onto_camerafixed(
    parameters: dict[str, object], switch: str
) -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.read()))
        return httpx.Response(200, json={"id": "seedance-task"})

    adapter = VolcengineAsyncVideoAdapter(transport=httpx.MockTransport(handler))
    config = VideogenConfig(
        model="seedance",
        adapter="volcengine_async_task",
        base_url="https://ark.test/api/v3",
        duration="5",
    )
    prompt = "a slow orbit around the lighthouse"
    task_id = await adapter.submit(
        prompt, config, inputs=[], parameters=parameters, idempotency_key="seedance-cam"
    )
    assert task_id == "seedance-task"
    # Camera intent rides the command tail appended to the text content; the
    # user prompt stays verbatim as the untouched prefix.
    text = seen["content"][0]["text"]
    assert text.startswith(prompt)
    assert text == f"{prompt} --duration 5 {switch}"
    # Camera parameters are consumed by the switch, never forwarded as keys.
    assert set(seen) == {"model", "content"}


@pytest.mark.asyncio
async def test_generic_adapter_forwards_schema_validated_custom_parameters() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.read()))
        return httpx.Response(200, json={"id": "custom-task"})

    adapter = GenericAsyncVideoAdapter(transport=httpx.MockTransport(handler))
    config = VideogenConfig(
        model="custom-video",
        adapter="async_task",
        base_url="https://custom.test/v1",
        aspect_ratio="16:9",
        resolution="1080p",
        duration="6",
    )
    assert (
        await adapter.submit(
            "a tracking shot",
            config,
            inputs=[],
            parameters={
                "camera_motion": "orbit",
                "guidance": 7.5,
                "negative_prompt": "flicker",
                # Protocol-owned and normalized fields cannot be replaced by
                # provider-specific schema properties with the same names.
                "model": "wrong-model",
                "content": [{"type": "text", "text": "wrong prompt"}],
                "aspect_ratio": "9:16",
                "resolution": "360p",
                "duration": "99",
            },
            idempotency_key="custom-wire",
        )
        == "custom-task"
    )
    assert seen == {
        "model": "custom-video",
        "content": [{"type": "text", "text": "a tracking shot"}],
        "camera_motion": "orbit",
        "guidance": 7.5,
        "negative_prompt": "flicker",
        "aspect_ratio": "16:9",
        "duration": "6",
        "resolution": "1080p",
    }


@pytest.mark.asyncio
async def test_config_test_runner_uses_video_studio_adapter_registry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from knorvia.services.config.test_runner import ConfigTestRunner, TestRun
    from knorvia.services.video_studio import provider

    seen: dict[str, bytes] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        key = request.url.host
        seen[key] = request.read()
        return httpx.Response(200, json={"id": f"{key}-task"})

    transport = httpx.MockTransport(handler)
    monkeypatch.setitem(
        provider.VIDEO_STUDIO_ADAPTERS,
        "async_task",
        GenericAsyncVideoAdapter(transport=transport),
    )
    monkeypatch.setitem(
        provider.VIDEO_STUDIO_ADAPTERS,
        "volcengine_async_task",
        VolcengineAsyncVideoAdapter(transport=transport),
    )
    monkeypatch.setitem(
        provider.VIDEO_STUDIO_ADAPTERS,
        "openai_videos",
        OpenAIVideosAdapter(transport=transport),
    )

    def catalog(binding: str, host: str) -> dict[str, object]:
        return {
            "services": {
                "videogen": {
                    "active_profile_id": "profile",
                    "active_model_id": "model",
                    "profiles": [
                        {
                            "id": "profile",
                            "binding": binding,
                            "base_url": f"https://{host}/v1",
                            "api_key": "secret",
                            "models": [
                                {
                                    "id": "model",
                                    "model": "video-model",
                                    "aspect_ratio": "16:9",
                                    "resolution": "720p",
                                    "duration": "5",
                                }
                            ],
                        }
                    ],
                }
            }
        }

    runner = ConfigTestRunner()
    for binding, host in (
        ("custom", "custom.test"),
        ("volcengine", "volc.test"),
        ("openai", "openai.test"),
    ):
        run = TestRun(id=host, service="videogen")
        await runner._test_videogen(run, catalog(binding, host))
        assert run.events[-1]["task_id"] == f"{host}-task"

    custom = json.loads(seen["custom.test"])
    assert custom["aspect_ratio"] == "16:9"
    assert custom["resolution"] == "720p"
    assert custom["duration"] == "5"
    volc = json.loads(seen["volc.test"])
    assert volc["content"][0]["text"].endswith("--ratio 16:9 --resolution 720p --duration 5")
    assert b"multipart/form-data" not in seen["openai.test"]
    assert b"video-model" in seen["openai.test"]


@pytest.mark.asyncio
async def test_openai_videos_adapter_full_http_lifecycle(tmp_path: Path) -> None:
    seen: list[tuple[str, str, bytes]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        seen.append((request.method, request.url.path, body))
        if request.method == "POST":
            assert "multipart/form-data" in request.headers["content-type"]
            for value in (b"prompt", b"model", b"input_reference", b"seconds", b"size"):
                assert value in body
            for value in (b"a lighthouse", b"sora-2", b"8", b"1792x1024", b"image-data"):
                assert value in body
            assert request.headers["idempotency-key"] == "request-42"
            return httpx.Response(200, json={"id": "video_42", "status": "queued"})
        if request.method == "DELETE":
            return httpx.Response(200, json={"deleted": True})
        if request.url.path.endswith("/content"):
            return httpx.Response(200, headers={"content-type": "video/mp4"}, content=MP4)
        return httpx.Response(
            200,
            json={"id": "video_42", "status": "completed", "progress": 100},
        )

    image = tmp_path / "reference.png"
    image.write_bytes(b"image-data")
    adapter = OpenAIVideosAdapter(transport=httpx.MockTransport(handler))
    config = VideogenConfig(
        model="sora-2",
        adapter="openai_videos",
        base_url="https://api.openai.test/v1",
        api_key="secret",
        duration="8",
        resolution="1792x1024",
    )
    task_id = await adapter.submit(
        "a lighthouse",
        config,
        inputs=[VideoInput(image, "image/png", "image")],
        parameters={},
        idempotency_key="request-42",
    )
    assert task_id == "video_42"
    poll = await adapter.poll(task_id, config)
    assert poll.state == "succeeded"
    assert poll.output_url == "openai-video://video_42"
    target = tmp_path / "video.mp4"
    assert await adapter.download(poll.output_url, config, target) == "video/mp4"
    assert target.read_bytes() == MP4
    assert await adapter.cancel(task_id, config)
    assert [(method, path) for method, path, _ in seen] == [
        ("POST", "/v1/videos"),
        ("GET", "/v1/videos/video_42"),
        ("GET", "/v1/videos/video_42/content"),
        ("DELETE", "/v1/videos/video_42"),
    ]


@pytest.mark.asyncio
async def test_openai_videos_adapter_reports_failed_job() -> None:
    adapter = OpenAIVideosAdapter(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                json={
                    "id": "video_bad",
                    "status": "failed",
                    "progress": 30,
                    "error": {"message": "rejected"},
                },
            )
        )
    )
    result = await adapter.poll(
        "video_bad", VideogenConfig(model="sora-2", base_url="https://api.openai.test/v1")
    )
    assert result.state == "failed"
    assert result.error == "rejected"

    unknown = OpenAIVideosAdapter(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, json={"id": "video_new", "status": "mystery"})
        )
    )
    with pytest.raises(Exception, match="unsupported status: mystery"):
        await unknown.poll(
            "video_new", VideogenConfig(model="sora-2", base_url="https://api.openai.test/v1")
        )


def test_unknown_explicit_video_adapter_fails_closed() -> None:
    from knorvia.services.config.provider_runtime import resolve_videogen_runtime_config

    catalog = {
        "services": {
            "videogen": {
                "active_profile_id": "p",
                "active_model_id": "m",
                "profiles": [
                    {
                        "id": "p",
                        "binding": "custom",
                        "base_url": "https://video.test/v1",
                        "adapter": "gemini_veo",
                        "models": [{"id": "m", "model": "veo"}],
                    }
                ],
            }
        }
    }
    with pytest.raises(ValueError, match="Unsupported video-generation adapter"):
        resolve_videogen_runtime_config(catalog=catalog)


def test_shared_connection_change_invalidates_queued_authorization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from copy import deepcopy

    from knorvia.services.video_studio import engine

    catalog = {
        "connections": [
            {
                "id": "shared",
                "provider": "custom",
                "base_url": "https://old.test/v1",
                "api_key": "old-secret",
                "extra_headers": {"X-Tenant": "old"},
            }
        ],
        "services": {
            "videogen": {
                "active_profile_id": "p",
                "active_model_id": "m",
                "profiles": [
                    {
                        "id": "p",
                        "binding": "custom",
                        "connection_id": "shared",
                        "models": [{"id": "m", "model": "video-model"}],
                    }
                ],
            }
        },
    }
    revision = engine._config_revision(catalog, "p", "m")
    changed = deepcopy(catalog)
    changed["connections"][0].update(
        {
            "base_url": "https://new.test/v1",
            "api_key": "new-secret",
            "extra_headers": {"X-Tenant": "new"},
        }
    )
    assert engine._config_revision(changed, "p", "m") != revision
    monkeypatch.setattr(
        engine,
        "allowed_videogen_options",
        lambda: {"options": [{"profile_id": "p", "model_id": "m"}]},
    )
    monkeypatch.setattr(
        engine,
        "get_model_catalog_service",
        lambda: type("Catalog", (), {"load": lambda self: changed})(),
    )
    with pytest.raises(PermissionError, match="configuration changed"):
        engine._authorized_catalog(
            {
                "owner_user_id": LOCAL_ADMIN_ID,
                "profile_id": "p",
                "model_id": "m",
                "config_revision": revision,
            }
        )


def test_openai_video_options_expose_deprecation_without_marking_image_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from knorvia.multi_user import model_access

    profile = {
        "id": "p",
        "name": "OpenAI",
        "binding": "openai",
        "models": [{"id": "m", "name": "Sora", "model": "sora-2"}],
    }
    monkeypatch.setattr(
        model_access,
        "admin_catalog",
        lambda: {
            "services": {
                "videogen": {
                    "active_profile_id": "p",
                    "active_model_id": "m",
                    "profiles": [profile],
                },
                "imagegen": {
                    "active_profile_id": "p",
                    "active_model_id": "m",
                    "profiles": [profile],
                },
            }
        },
    )
    video = model_access.allowed_videogen_options()["options"][0]
    assert model_access.allowed_videogen_options()["selected"] == "p:m"
    assert video["lifecycle"]["shutdown_date"] == "2026-09-24"
    assert video["capabilities"]["supports_cancel"] is False
    assert "lifecycle" not in model_access.allowed_imagegen_options()["options"][0]


@pytest.mark.asyncio
async def test_engine_fake_adapter_completes_and_persists_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.video_studio import engine

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Fake")
    job = store.create_job(project["id"], _payload("fake-run"))
    fake = FakeVideoStudioAdapter()
    monkeypatch.setattr(engine, "_authorized_catalog", lambda _job: {})
    monkeypatch.setattr(
        engine,
        "resolve_videogen_runtime_config",
        lambda **_: VideogenConfig(
            model="fake", adapter="fake", base_url="https://fake.test", poll_interval=0.001
        ),
    )
    monkeypatch.setattr(engine, "get_video_studio_adapter", lambda _name: fake)
    await engine._run_in_owner_context(store, job["id"])
    finished = store.get_job(job["id"])
    assert finished["status"] == "succeeded"
    assert len(finished["output_asset_ids"]) == 1
    assert store.get_asset(finished["output_asset_ids"][0])["kind"] == "video"


@pytest.mark.asyncio
async def test_range_endpoint_get_head_and_416(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.api.routers import video_studio as router

    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Range")
    asset = store.save_output_bytes(project["id"], MP4, "video/mp4")
    monkeypatch.setattr(router, "get_video_studio_store", lambda: store)

    def request(method: str, range_value: str | None = None) -> Request:
        headers = [] if range_value is None else [(b"range", range_value.encode())]
        return Request({"type": "http", "method": method, "path": "/", "headers": headers})

    partial = await router.asset_content(asset["id"], request("GET", "bytes=4-11"))
    assert partial.status_code == 206
    assert partial.headers["content-range"] == f"bytes 4-11/{len(MP4)}"
    assert b"".join([chunk async for chunk in partial.body_iterator]) == MP4[4:12]
    head = await router.asset_content(asset["id"], request("HEAD"))
    assert head.status_code == 200
    assert head.headers["accept-ranges"] == "bytes"
    assert head.headers["content-length"] == str(len(MP4))
    invalid = await router.asset_content(asset["id"], request("GET", "bytes=9999-"))
    assert invalid.status_code == 416
    assert invalid.headers["content-range"] == f"bytes */{len(MP4)}"
