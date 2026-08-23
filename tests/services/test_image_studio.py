from __future__ import annotations

import asyncio
import hashlib
from io import BytesIO
import json
from pathlib import Path
import time
import zipfile

from fastapi import HTTPException
from PIL import Image
import pytest

from knorvia.services.image_studio.engine import (
    _model_config_revision,
    _native_resolution_rejected,
    _safe_error,
)
from knorvia.services.image_studio.ncnn_upscaler import NcnnUpscaler, ReleaseAsset
from knorvia.services.image_studio.store import (
    BoardConflictError,
    ImageStudioQueueFullError,
    ImageStudioStore,
)
from knorvia.services.image_studio.upscale import target_long_edge, upscale_to_target


def _png(size: tuple[int, int] = (2, 3)) -> bytes:
    buffer = BytesIO()
    Image.new("RGBA", size, (20, 80, 160, 255)).save(buffer, format="PNG")
    return buffer.getvalue()


PNG = _png()


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("unsupported image_size 4K", True),
        ("invalid resolution: 2K", True),
        ("invalid API key", False),
        ("request timed out", False),
    ],
)
def test_native_resolution_retry_only_handles_resolution_errors(message, expected):
    assert _native_resolution_rejected(ValueError(message)) is expected


def test_model_config_revision_tracks_routing_but_not_secrets():
    catalog = {
        "connections": [
            {
                "id": "conn",
                "provider": "openai",
                "base_url": "https://one.example/v1",
                "api_key": "secret-one",
            }
        ],
        "services": {
            "imagegen": {
                "profiles": [
                    {
                        "id": "profile",
                        "binding": "openai",
                        "connection_id": "conn",
                        "models": [
                            {
                                "id": "model",
                                "model": "image-1",
                                "capabilities": {"operations": ["generate"]},
                            }
                        ],
                    }
                ]
            }
        },
    }
    first = _model_config_revision(catalog, "profile", "model")
    catalog["connections"][0]["api_key"] = "rotated-secret"
    assert _model_config_revision(catalog, "profile", "model") == first
    catalog["connections"][0]["base_url"] = "https://two.example/v1"
    assert _model_config_revision(catalog, "profile", "model") != first


def test_project_upload_job_and_event_lifecycle(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Concepts")
    upload = store.create_upload(
        project["id"], "reference.png", "image/png", len(PNG), hashlib.sha256(PNG).hexdigest()
    )
    store.write_upload_part(upload["upload_id"], 0, PNG)
    asset = store.complete_upload(upload["upload_id"])
    job = store.create_job(
        project["id"],
        {
            "operation": "edit",
            "profile_id": "profile",
            "model_id": "model",
            "prompt": "make it blue",
            "input_asset_ids": [asset["id"]],
            "parameters": {"n": 1},
        },
    )
    store.update_job(job["id"], "running")
    output = store.save_asset(project["id"], PNG, "image/png", kind="output")
    store.add_job_output(job["id"], output["id"], 0)
    store.update_job(job["id"], "succeeded", actual={"n": 1})

    saved = store.get_job(job["id"])
    assert saved is not None
    assert saved["status"] == "succeeded"
    assert saved["inputs"][0]["asset_id"] == asset["id"]
    assert saved["outputs"][0]["asset_id"] == output["id"]
    assert [event["type"] for event in store.events_after(job["id"])] == [
        "job.queued",
        "job.running",
        "job.output",
        "job.succeeded",
    ]


def test_upload_rejects_mime_spoof_and_bad_checksum(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Safety")
    upload = store.create_upload(
        project["id"], "fake.jpg", "image/jpeg", len(PNG), hashlib.sha256(PNG).hexdigest()
    )
    store.write_upload_part(upload["upload_id"], 0, PNG)
    with pytest.raises(ValueError, match="type does not match"):
        store.complete_upload(upload["upload_id"])

    upload = store.create_upload(project["id"], "bad.png", "image/png", len(PNG), "0" * 64)
    store.write_upload_part(upload["upload_id"], 0, PNG)
    with pytest.raises(ValueError, match="checksum"):
        store.complete_upload(upload["upload_id"])


def test_upload_rejects_out_of_range_parts_and_incomplete_upload(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Chunks")
    upload = store.create_upload(
        project["id"], "small.png", "image/png", len(PNG), hashlib.sha256(PNG).hexdigest()
    )
    with pytest.raises(ValueError, match="index"):
        store.write_upload_part(upload["upload_id"], 3, b"x")
    with pytest.raises(ValueError, match="incomplete"):
        store.complete_upload(upload["upload_id"])


def test_expired_uploads_are_removed_from_disk_and_database(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Expiry")
    upload = store.create_upload(
        project["id"], "old.png", "image/png", len(PNG), hashlib.sha256(PNG).hexdigest()
    )
    record = store.upload_record(upload["upload_id"])
    assert record is not None
    path = record["temp_path"]
    with store._connect() as db:
        db.execute("UPDATE uploads SET created_at=? WHERE id=?", (0, upload["upload_id"]))
    assert store.cleanup_expired_uploads(now=time.time()) == 1
    assert store.upload_record(upload["upload_id"]) is None
    assert not Path(path).exists()


def test_asset_store_rejects_non_image_provider_output(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Provider safety")
    with pytest.raises(ValueError, match="invalid"):
        store.save_asset(project["id"], b"not-an-image", "image/png", kind="output")
    with pytest.raises(ValueError, match="Unsupported"):
        store.save_asset(project["id"], PNG, "text/html", kind="output")


def test_asset_store_rejects_header_only_png_and_pixel_bomb(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    from knorvia.services.image_studio import store as store_module

    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Decode safety")
    header_only = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x02\x00\x00\x00\x03\x08\x06\x00\x00\x00"
    )
    with pytest.raises(ValueError, match="invalid|truncated"):
        store.save_asset(project["id"], header_only, "image/png", kind="input")
    monkeypatch.setattr(store_module, "MAX_IMAGE_PIXELS", 1)
    with pytest.raises(ValueError, match="safety limit"):
        store.save_asset(project["id"], PNG, "image/png", kind="input")


def test_project_board_persists_nodes_and_job_placement(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Board")
    empty = store.get_board(project["id"])
    assert empty["nodes"] == []
    saved = store.save_board(
        project["id"],
        {
            "viewport": {"x": 10, "y": 20, "scale": 1.5},
            "nodes": [
                {
                    "id": "n1",
                    "kind": "generate",
                    "x": 0,
                    "y": 0,
                    "width": 280,
                    "height": 220,
                    "jobId": "job_keep",
                    "prompt": "a hall",
                }
            ],
            "edges": [{"id": "e1", "from": "n1", "to": "missing", "role": "reference"}],
        },
    )
    assert saved["viewport"]["scale"] == 1.5
    assert saved["edges"] == []
    output = store.save_asset(project["id"], PNG, "image/png", kind="output")
    job = store.create_job(
        project["id"],
        {
            "operation": "generate",
            "profile_id": "p",
            "model_id": "m",
            "prompt": "a hall",
            "parameters": {},
        },
    )
    # Rewrite the stored job id onto the node through place_job_on_board's existing-job path.
    board = store.get_board(project["id"])
    board["nodes"][0]["jobId"] = job["id"]
    store.save_board(project["id"], board)
    store.add_job_output(job["id"], output["id"], 0)
    store.update_job(job["id"], "succeeded")
    placed = store.place_job_on_board(project["id"], store.get_job(job["id"]) or {})
    assert placed["nodes"][0]["assetId"] == output["id"]
    assert placed["nodes"][0]["kind"] == "image"


def test_board_revision_rejects_stale_writer_and_keeps_worker_patch(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("CAS")
    first = store.save_board(
        project["id"],
        {
            "nodes": [
                {
                    "id": "user-note",
                    "kind": "text",
                    "x": 0,
                    "y": 0,
                    "width": 240,
                    "height": 140,
                    "text": "draft",
                }
            ]
        },
    )
    stale = json.loads(json.dumps(first))

    def worker_patch(board):
        board["nodes"].append(
            {
                "id": "worker-output",
                "kind": "image",
                "x": 300,
                "y": 0,
                "width": 280,
                "height": 280,
                "assetId": "asset-result",
                "jobId": "job-result",
            }
        )

    patched = store.update_board(project["id"], worker_patch)
    assert patched["revision"] == first["revision"] + 1
    stale["nodes"][0]["text"] = "stale overwrite"
    with pytest.raises(BoardConflictError) as exc:
        store.save_board(project["id"], stale)
    assert exc.value.current_revision == patched["revision"]
    latest = store.get_board(project["id"])
    assert {node["id"] for node in latest["nodes"]} == {
        "user-note",
        "worker-output",
    }


def test_board_normalization_rejects_nonfinite_and_duplicate_geometry(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Geometry")
    saved = store.save_board(
        project["id"],
        {
            "viewport": {"x": float("nan"), "y": float("inf"), "scale": float("nan")},
            "nodes": [
                {
                    "id": "stable",
                    "kind": "image",
                    "x": 10,
                    "y": 20,
                    "width": 200,
                    "height": 200,
                },
                {
                    "id": "stable",
                    "kind": "image",
                    "x": 30,
                    "y": 40,
                    "width": 200,
                    "height": 200,
                },
                {
                    "id": "bad",
                    "kind": "image",
                    "x": float("nan"),
                    "y": 0,
                    "width": 200,
                    "height": 200,
                },
            ],
        },
    )
    assert saved["viewport"] == {"x": 0.0, "y": 0.0, "scale": 1.0}
    assert [node["id"] for node in saved["nodes"]] == ["stable"]
    assert "NaN" not in store.board_path(project["id"]).read_text(encoding="utf-8")


def test_provider_error_redaction_covers_headers_json_and_url_credentials():
    safe = _safe_error(
        ValueError(
            'x-api-key: abc123 {"access_token":"json-secret"} '
            "https://alice:hunter2@example.test/path?api_key=query-secret"
        )
    )
    for secret in ("abc123", "json-secret", "alice", "hunter2", "query-secret"):
        assert secret not in safe
    assert safe.count("[REDACTED]") >= 3


def test_board_recovers_previous_atomic_snapshot_instead_of_empty(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Recovery")
    first = store.save_board(project["id"], {"nodes": []})
    second = store.save_board(project["id"], {**first, "viewport": {"x": 9, "y": 0, "scale": 1}})
    assert second["viewport"]["x"] == 9
    store.board_path(project["id"]).write_text("{broken", encoding="utf-8")
    recovered = store.get_board(project["id"])
    assert recovered["revision"] == first["revision"]
    assert recovered["viewport"]["x"] == 0


def test_place_job_on_board_honors_target_node(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Target")
    store.save_board(
        project["id"],
        {
            "nodes": [
                {
                    "id": "slot",
                    "kind": "generate",
                    "x": 10,
                    "y": 20,
                    "width": 320,
                    "height": 292,
                    "prompt": "fill me",
                }
            ],
            "edges": [],
            "groups": [],
        },
    )
    output = store.save_asset(project["id"], PNG, "image/png", kind="output")
    job = store.create_job(
        project["id"],
        {
            "operation": "generate",
            "profile_id": "p",
            "model_id": "m",
            "prompt": "fill me",
            "parameters": {},
        },
    )
    store.add_job_output(job["id"], output["id"], 0)
    store.update_job(job["id"], "succeeded")
    placed = store.place_job_on_board(
        project["id"], store.get_job(job["id"]) or {}, target_node_id="slot"
    )
    slot = next(node for node in placed["nodes"] if node["id"] == "slot")
    assert slot["assetId"] == output["id"]
    assert slot["kind"] == "image"


def test_place_job_on_board_rejects_text_target(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Text target")
    store.save_board(
        project["id"],
        {
            "nodes": [
                {
                    "id": "note",
                    "kind": "text",
                    "x": 0,
                    "y": 0,
                    "width": 240,
                    "height": 140,
                    "text": "keep me",
                }
            ]
        },
    )
    output = store.save_asset(project["id"], PNG, "image/png", kind="output")
    job = store.create_job(
        project["id"],
        {
            "operation": "generate",
            "profile_id": "p",
            "model_id": "m",
            "prompt": "do not replace note",
            "parameters": {},
        },
    )
    store.add_job_output(job["id"], output["id"], 0)
    store.update_job(job["id"], "succeeded")
    with pytest.raises(ValueError, match="text note"):
        store.place_job_on_board(
            project["id"], store.get_job(job["id"]) or {}, target_node_id="note"
        )
    assert store.get_board(project["id"])["nodes"][0]["kind"] == "text"


def test_place_job_on_board_rejects_missing_explicit_target(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Missing target")
    job = store.create_job(
        project["id"],
        {
            "operation": "generate",
            "profile_id": "p",
            "model_id": "m",
            "prompt": "result",
            "parameters": {},
        },
    )

    with pytest.raises(ValueError, match="was not found"):
        store.place_job_on_board(project["id"], job, target_node_id="deleted-slot")
    assert store.get_board(project["id"])["nodes"] == []


def test_project_board_keeps_groups_and_output_settings(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Groups")
    saved = store.save_board(
        project["id"],
        {
            "nodes": [
                {
                    "id": "n1",
                    "kind": "generate",
                    "x": 0,
                    "y": 0,
                    "width": 320,
                    "height": 292,
                    "groupId": "g1",
                    "ratio": "21:9",
                    "quality": "2K",
                    "customWidth": 1536,
                    "customHeight": 640,
                }
            ],
            "edges": [],
            "groups": [{"id": "g1", "title": "Hero set"}],
        },
    )
    assert saved["groups"] == [{"id": "g1", "title": "Hero set"}]
    assert saved["nodes"][0]["ratio"] == "21:9"
    assert saved["nodes"][0]["customWidth"] == 1536


def test_deleted_asset_can_be_restored_only_for_an_active_project(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Undo")
    asset = store.save_asset(project["id"], PNG, "image/png", kind="output")
    assert store.delete_asset(asset["id"])
    assert store.get_asset(asset["id"]) is None
    restored = store.restore_asset(asset["id"])
    assert restored is not None
    assert restored["id"] == asset["id"]

    assert store.delete_asset(asset["id"])
    assert store.delete_project(project["id"])
    assert store.restore_asset(asset["id"]) is None


def test_upscale_fallback_reaches_target_and_preserves_aspect_ratio():
    source = BytesIO()
    Image.new("RGB", (320, 180), (20, 40, 60)).save(source, format="PNG")
    content, mime, metadata = upscale_to_target(source.getvalue(), "image/png", "1K")
    with Image.open(BytesIO(content)) as result:
        assert result.size == (1024, 576)
    assert mime == "image/png"
    assert metadata == {
        "method": "lanczos",
        "source_width": 320,
        "source_height": 180,
        "width": 1024,
        "height": 576,
        "target": "1K",
    }


def test_upscale_fallback_leaves_native_or_unknown_resolution_unchanged():
    source = BytesIO()
    Image.new("RGB", (1024, 512)).save(source, format="JPEG")
    original = source.getvalue()
    assert upscale_to_target(original, "image/jpeg", "1K") == (original, "image/jpeg", None)
    assert upscale_to_target(original, "image/jpeg", "8K") == (original, "image/jpeg", None)
    assert target_long_edge("4k") == 4096


def test_ncnn_installer_extracts_only_runtime_files(tmp_path, monkeypatch):
    archive = tmp_path / "fixture.zip"
    asset = ReleaseAsset("fixture.zip", "0" * 64, 0)
    upscaler = NcnnUpscaler(tmp_path / "engine", asset=asset)
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(upscaler.binary.name, b"binary")
        bundle.writestr("models/realesrgan-x4plus.bin", b"weights")
        bundle.writestr("models/realesrgan-x4plus.param", b"graph")
        bundle.writestr("../escape.txt", b"unsafe")
        bundle.writestr("input.jpg", b"unneeded")

    def copy_fixture(target):
        target.write_bytes(archive.read_bytes())

    monkeypatch.setattr(upscaler, "_download", copy_fixture)
    status = upscaler.install()
    assert status["installed"] is True
    assert upscaler.binary.read_bytes() == b"binary"
    assert not (tmp_path / "escape.txt").exists()
    assert not (upscaler.version_root / "input.jpg").exists()


def test_ncnn_status_reports_pinned_download_size(tmp_path):
    asset = ReleaseAsset("engine.zip", "a" * 64, 12345)
    status = NcnnUpscaler(tmp_path / "engine", asset=asset).status()
    assert status["supported"] is True
    assert status["installed"] is False
    assert status["download_bytes"] == 12345


def test_release_switch_disables_image_studio(monkeypatch):
    from knorvia.api.routers.image_studio import require_image_studio_enabled

    monkeypatch.setenv("KNORVIA_IMAGE_STUDIO_ENABLED", "false")
    with pytest.raises(HTTPException) as exc:
        require_image_studio_enabled()
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_upload_router_stops_stream_at_chunk_limit(monkeypatch):
    from knorvia.api.routers import image_studio as router

    class FakeRequest:
        headers: dict[str, str] = {}

        async def stream(self):
            yield b"123"
            yield b"456"

    monkeypatch.setattr(router, "UPLOAD_CHUNK_BYTES", 4)
    with pytest.raises(HTTPException) as exc:
        await router._read_upload_chunk(FakeRequest())
    assert exc.value.status_code == 413


@pytest.mark.asyncio
async def test_upload_router_rejects_negative_content_length():
    from knorvia.api.routers import image_studio as router

    class FakeRequest:
        headers = {"content-length": "-1"}

        async def stream(self):
            yield b""

    with pytest.raises(HTTPException) as exc:
        await router._read_upload_chunk(FakeRequest())
    assert exc.value.status_code == 400


def test_opening_store_marks_inflight_jobs_interrupted(tmp_path):
    root = tmp_path / "image-studio"
    store = ImageStudioStore(root)
    project = store.create_project("Recovery")
    job = store.create_job(
        project["id"],
        {
            "operation": "generate",
            "profile_id": "p",
            "model_id": "m",
            "prompt": "x",
            "parameters": {},
        },
    )
    store.update_job(job["id"], "running")
    reopened = ImageStudioStore(root)
    assert reopened.get_job(job["id"])["status"] == "interrupted"


def test_opening_store_keeps_queued_jobs_recoverable(tmp_path):
    root = tmp_path / "image-studio"
    store = ImageStudioStore(root)
    project = store.create_project("Recovery")
    job = store.create_job(
        project["id"],
        {
            "operation": "generate",
            "profile_id": "p",
            "model_id": "m",
            "prompt": "x",
            "parameters": {},
        },
    )
    reopened = ImageStudioStore(root)
    assert reopened.get_job(job["id"])["status"] == "queued"
    assert reopened.queued_job_ids() == [job["id"]]


@pytest.mark.asyncio
async def test_router_rejects_non_numeric_output_count_with_422(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    from knorvia.api.routers import image_studio as router

    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Bad count")
    monkeypatch.setattr(router, "get_image_studio_store", lambda: store)
    monkeypatch.setattr(
        router,
        "_allowed",
        lambda *_args: {
            "capabilities": {
                "operations": ["generate"],
                "parameters": ["n"],
                "max_outputs": 4,
            }
        },
    )
    payload = router.JobCreate(
        image_profile_id="p",
        model_id="m",
        prompt="bad count",
        parameters={"n": "not-a-number"},
    )
    with pytest.raises(HTTPException) as exc:
        await router.create_job(project["id"], payload)
    assert exc.value.status_code == 422
    assert "output count" in str(exc.value.detail).lower()


def test_store_rejects_cross_project_parent_context(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    first = store.create_project("First")
    second = store.create_project("Second")
    parent = store.create_job(
        first["id"],
        {
            "operation": "generate",
            "profile_id": "p",
            "model_id": "m",
            "prompt": "parent",
            "parameters": {},
        },
    )
    with pytest.raises(ValueError, match="image project"):
        store.create_job(
            second["id"],
            {
                "operation": "generate",
                "profile_id": "p",
                "model_id": "m",
                "prompt": "child",
                "parent_job_id": parent["id"],
                "parameters": {},
            },
        )


@pytest.mark.asyncio
async def test_dispatch_fails_closed_when_authorization_changes(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    from knorvia.services.image_studio import engine

    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Grant")
    job = store.create_job(
        project["id"],
        {
            "operation": "generate",
            "profile_id": "p",
            "model_id": "m",
            "prompt": "do not dispatch",
            "parameters": {},
            "owner_user_id": "local-admin",
            "config_revision": "old",
        },
    )

    def revoked(_job):
        raise PermissionError("grant revoked")

    monkeypatch.setattr(engine, "_authorized_catalog", revoked)
    await engine._run(store, job["id"])
    saved = store.get_job(job["id"])
    assert saved["status"] == "failed"
    assert saved["error_code"] == "authorization_error"
    assert "revoked" in saved["error_message"]


@pytest.mark.asyncio
async def test_dispatch_rejects_a_job_without_authorization_snapshot(tmp_path):
    from knorvia.services.image_studio import engine

    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("No snapshot")
    job = store.create_job(
        project["id"],
        {
            "operation": "generate",
            "profile_id": "p",
            "model_id": "m",
            "prompt": "must not reach provider",
            "parameters": {},
        },
    )
    await engine._run(store, job["id"])
    saved = store.get_job(job["id"])
    assert saved["status"] == "failed"
    assert saved["error_code"] == "authorization_error"
    assert "authorization snapshots" in saved["error_message"]


def test_live_owner_resolution_applies_demotion_and_disable(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    from knorvia.services import auth
    from knorvia.services.image_studio import engine

    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    record = {
        "id": "user-a",
        "username": "alice",
        "role": "user",
        "disabled": False,
    }
    monkeypatch.setattr(auth, "list_users", lambda: [dict(record)])
    resolved = engine._resolve_job_owner("user-a")
    assert resolved.id == "user-a"
    assert resolved.role == "user"
    assert resolved.scope.kind == "user"

    record["disabled"] = True
    monkeypatch.setattr(auth, "list_users", lambda: [dict(record)])
    with pytest.raises(PermissionError, match="disabled"):
        engine._resolve_job_owner("user-a")


def test_owner_resolution_is_fail_closed_without_auth_and_for_deleted_partner(
    monkeypatch: pytest.MonkeyPatch,
):
    from types import SimpleNamespace

    from knorvia.services import auth, partners
    from knorvia.services.image_studio import engine

    monkeypatch.setattr(auth, "AUTH_ENABLED", False)
    assert engine._resolve_job_owner("local-admin").id == "local-admin"
    with pytest.raises(PermissionError, match="unavailable"):
        engine._resolve_job_owner("user-a")

    manager = SimpleNamespace(load_config=lambda _partner_id: None)
    monkeypatch.setattr(partners, "get_partner_manager", lambda: manager)
    with pytest.raises(PermissionError, match="partner no longer exists"):
        engine._resolve_job_owner("partner_artist")

    manager.load_config = lambda _partner_id: SimpleNamespace(name="Artist")
    partner = engine._resolve_job_owner("partner_artist")
    assert partner.id == "partner_artist"
    assert partner.username == "Artist"


@pytest.mark.asyncio
async def test_resumed_runner_rehydrates_each_persisted_job_owner(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    from knorvia.multi_user.context import get_current_user
    from knorvia.multi_user.models import CurrentUser, UserScope
    from knorvia.multi_user.paths import user_context
    from knorvia.services.image_studio import engine

    monkeypatch.setattr(engine, "WORKERS_PER_STORE", 1)
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Shared admin store")

    def make_user(user_id: str) -> CurrentUser:
        return CurrentUser(
            id=user_id,
            username=user_id,
            role="admin",
            scope=UserScope(kind="admin", user_id=user_id, root=tmp_path / "shared"),
        )

    users = {name: make_user(name) for name in ("admin-a", "admin-b")}
    monkeypatch.setattr(engine, "_resolve_job_owner", lambda owner_id: users[owner_id])
    seen: list[str] = []

    async def fake_run_in_owner_context(studio: ImageStudioStore, job_id: str) -> None:
        assert studio.claim_job(job_id)
        seen.append(get_current_user().id)
        studio.update_job(job_id, "succeeded", from_statuses=("running",))

    monkeypatch.setattr(engine, "_run_in_owner_context", fake_run_in_owner_context)
    for owner_id in ("admin-a", "admin-b"):
        store.create_job(
            project["id"],
            {
                "operation": "generate",
                "profile_id": "p",
                "model_id": "m",
                "prompt": owner_id,
                "parameters": {},
                "owner_user_id": owner_id,
                "config_revision": "revision",
            },
        )
    try:
        # The long-lived worker inherits admin-a, but the second persisted job
        # must still execute inside admin-b's reconstructed live context.
        with user_context(users["admin-a"]):
            engine.resume_queued_jobs(store)
        runner = engine._runners[str(store.db_path)]
        await asyncio.wait_for(runner.queue.join(), timeout=2)
        assert seen == ["admin-a", "admin-b"]
    finally:
        await engine.shutdown_image_studio_runners()


def test_terminal_transitions_do_not_overwrite_each_other(tmp_path):
    import threading

    from knorvia.services.image_studio.engine import cancel_job

    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Terminal race")

    def running_job(prompt: str) -> dict:
        job = store.create_job(
            project["id"],
            {
                "operation": "generate",
                "profile_id": "p",
                "model_id": "m",
                "prompt": prompt,
                "parameters": {},
            },
        )
        assert store.claim_job(job["id"])
        return job

    finished_first = running_job("finish first")
    finish_committed = threading.Event()
    cancel_result: list[bool] = []

    def finish_then_signal() -> None:
        assert store.update_job(finished_first["id"], "succeeded", from_statuses=("running",))
        finish_committed.set()

    def cancel_after_finish() -> None:
        assert finish_committed.wait(2)
        cancel_result.append(cancel_job(store, finished_first["id"]))

    threads = [
        threading.Thread(target=finish_then_signal),
        threading.Thread(target=cancel_after_finish),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=2)
        assert not thread.is_alive()
    assert cancel_result == [False]
    assert store.get_job(finished_first["id"])["status"] == "succeeded"

    cancelled_first = running_job("cancel first")
    cancel_committed = threading.Event()
    finish_result: list[bool] = []

    def cancel_then_signal() -> None:
        assert cancel_job(store, cancelled_first["id"])
        cancel_committed.set()

    def finish_after_cancel() -> None:
        assert cancel_committed.wait(2)
        finish_result.append(
            store.update_job(cancelled_first["id"], "succeeded", from_statuses=("running",))
        )

    threads = [
        threading.Thread(target=cancel_then_signal),
        threading.Thread(target=finish_after_cancel),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=2)
        assert not thread.is_alive()
    assert finish_result == [False]
    assert store.get_job(cancelled_first["id"])["status"] == "cancelled"


def test_store_enforces_pending_job_budget(tmp_path, monkeypatch: pytest.MonkeyPatch):
    from knorvia.services.image_studio import store as store_module

    monkeypatch.setattr(store_module, "MAX_PENDING_JOBS", 2)
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Budget")
    payload = {
        "operation": "generate",
        "profile_id": "p",
        "model_id": "m",
        "prompt": "x",
        "parameters": {},
    }
    store.create_job(project["id"], payload)
    store.create_job(project["id"], payload)
    with pytest.raises(ImageStudioQueueFullError):
        store.create_job(project["id"], payload)


@pytest.mark.asyncio
async def test_runner_limits_each_user_store_to_two_active_jobs(tmp_path, monkeypatch):
    from knorvia.services.image_studio import engine

    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Queue")
    jobs = [
        store.create_job(
            project["id"],
            {
                "operation": "generate",
                "profile_id": "p",
                "model_id": "m",
                "prompt": str(index),
                "parameters": {},
            },
        )
        for index in range(3)
    ]
    current = 0
    maximum = 0
    two_started = asyncio.Event()
    release = asyncio.Event()

    async def fake_run(_store, _job_id):
        nonlocal current, maximum
        current += 1
        maximum = max(maximum, current)
        if current == 2:
            two_started.set()
        try:
            await release.wait()
        finally:
            current -= 1

    monkeypatch.setattr(engine, "_run", fake_run)
    try:
        for job in jobs:
            engine.start_job(store, job["id"])
        await asyncio.wait_for(two_started.wait(), timeout=2)
        await asyncio.sleep(0.05)
        assert maximum == 2
        release.set()
        runner = engine._runners[str(store.db_path)]
        await asyncio.wait_for(runner.queue.join(), timeout=2)
    finally:
        release.set()
        await engine.shutdown_image_studio_runners()


@pytest.mark.asyncio
async def test_cancelling_one_job_keeps_the_worker_alive(tmp_path, monkeypatch):
    from knorvia.services.image_studio import engine

    monkeypatch.setattr(engine, "WORKERS_PER_STORE", 1)
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Cancel")
    jobs = [
        store.create_job(
            project["id"],
            {
                "operation": "generate",
                "profile_id": "p",
                "model_id": "m",
                "prompt": str(index),
                "parameters": {},
            },
        )
        for index in range(2)
    ]
    first_started = asyncio.Event()
    second_started = asyncio.Event()

    async def fake_run(studio: ImageStudioStore, job_id: str):
        if job_id == jobs[0]["id"]:
            studio.update_job(job_id, "running")
            first_started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                studio.update_job(job_id, "cancelled")
                raise
        studio.update_job(job_id, "succeeded")
        second_started.set()

    monkeypatch.setattr(engine, "_run", fake_run)
    try:
        engine.start_job(store, jobs[0]["id"])
        engine.start_job(store, jobs[1]["id"])
        await asyncio.wait_for(first_started.wait(), timeout=2)
        assert engine.cancel_job(store, jobs[0]["id"])
        await asyncio.wait_for(second_started.wait(), timeout=2)
        runner = engine._runners[str(store.db_path)]
        assert any(not worker.done() for worker in runner.workers)
        assert store.get_job(jobs[1]["id"])["status"] == "succeeded"
    finally:
        await engine.shutdown_image_studio_runners()


@pytest.mark.asyncio
async def test_runner_replaces_done_worker_and_resumes_persisted_queue(tmp_path, monkeypatch):
    from knorvia.services.image_studio import engine

    monkeypatch.setattr(engine, "WORKERS_PER_STORE", 1)
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Resume")

    async def fake_run(studio: ImageStudioStore, job_id: str):
        studio.update_job(job_id, "succeeded")

    monkeypatch.setattr(engine, "_run", fake_run)
    try:
        runner = engine._runner_for(store)
        runner.ensure_started()
        old_worker = runner.workers[0]
        old_worker.cancel()
        await asyncio.gather(old_worker, return_exceptions=True)
        runner.ensure_started()
        assert runner.workers[0] is not old_worker
        assert not runner.workers[0].done()

        job = store.create_job(
            project["id"],
            {
                "operation": "generate",
                "profile_id": "p",
                "model_id": "m",
                "prompt": "resume",
                "parameters": {},
            },
        )
        engine.resume_queued_jobs(store)
        await asyncio.wait_for(runner.queue.join(), timeout=2)
        assert store.get_job(job["id"])["status"] == "succeeded"
    finally:
        await engine.shutdown_image_studio_runners()


def test_project_export_contains_assets_and_redacted_manifest(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Export")
    asset = store.save_asset(project["id"], PNG, "image/png", kind="output")
    archive_path = store.export_project(project["id"])
    with zipfile.ZipFile(archive_path) as archive:
        names = set(archive.namelist())
        manifest = json.loads(archive.read("manifest.json"))
    assert f"assets/{asset['id']}.png" in names
    assert manifest["project"]["id"] == project["id"]
    assert "relative_path" not in manifest["assets"][0]


def test_project_export_does_not_silently_truncate_after_200_assets(tmp_path):
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Large export")
    for _ in range(201):
        store.save_asset(project["id"], PNG, "image/png", kind="output")
    with zipfile.ZipFile(store.export_project(project["id"])) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        asset_names = [name for name in archive.namelist() if name.startswith("assets/")]
    assert len(manifest["assets"]) == 201
    assert len(asset_names) == 201
