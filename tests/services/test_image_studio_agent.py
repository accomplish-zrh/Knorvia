from __future__ import annotations

import base64
from io import BytesIO
from typing import Any

from PIL import Image
import pytest

from knorvia.services.image_studio.agent import (
    collect_input_asset_ids,
    decode_attachment,
    fallback_models,
    filter_studio_parameters,
    needs_confirmation,
    plan_studio_job,
    project_for_session,
    recent_session_outputs,
    resolve_studio_operation,
    run_studio_image_job,
    select_studio_model,
)
from knorvia.services.image_studio.store import ImageStudioStore


def _png(color: tuple[int, int, int] = (20, 80, 160)) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (8, 8), color).save(buffer, format="PNG")
    return buffer.getvalue()


def _model(
    profile_id: str = "p1",
    model_id: str = "m1",
    operations: list[str] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    row = {
        "profile_id": profile_id,
        "model_id": model_id,
        "profile_name": profile_id,
        "model_name": model_id,
        "capabilities": {
            "operations": operations or ["generate"],
            "parameters": ["n", "size", "target_resolution", "upscale_model"],
        },
        "is_active_default": extra.pop("is_active_default", False),
    }
    row.update(extra)
    return row


def test_resolve_generate_with_refs_becomes_edit() -> None:
    assert (
        resolve_studio_operation(
            "generate",
            has_inputs=True,
            has_mask=False,
            model_operations=["generate", "edit"],
        )
        == "edit"
    )


def test_resolve_inpaint_requires_mask() -> None:
    with pytest.raises(ValueError, match="mask"):
        resolve_studio_operation(
            "inpaint",
            has_inputs=True,
            has_mask=False,
            model_operations=["generate"],
        )


def test_resolve_enhance_uses_edit_when_inputs_exist() -> None:
    assert (
        resolve_studio_operation(
            "enhance",
            has_inputs=True,
            has_mask=False,
            model_operations=["generate", "edit"],
        )
        == "edit"
    )


def test_select_skips_named_model_that_cannot_edit() -> None:
    generate_only = _model("p1", "gen", ["generate"])
    editor = _model("p2", "edit", ["generate", "edit"])
    chosen = select_studio_model(
        [generate_only, editor],
        operation="edit",
        profile_id="p1",
        model_id="gen",
    )
    assert chosen["model_id"] == "edit"


def test_select_raises_when_no_model_matches() -> None:
    with pytest.raises(ValueError, match="inpaint"):
        select_studio_model([_model(operations=["generate"])], operation="inpaint")


def test_filter_drops_unknown_parameters() -> None:
    model = _model()
    cleaned = filter_studio_parameters(
        {"n": 2, "negative_prompt": "blur", "target_resolution": "2K", "size": ""},
        model,
    )
    assert cleaned == {"n": 2, "target_resolution": "2K"}


def test_needs_confirmation_for_costly_jobs() -> None:
    assert needs_confirmation("generate", {"n": 1}) is False
    assert needs_confirmation("generate", {"n": 2}) is True
    assert needs_confirmation("generate", {"n": 1, "target_resolution": "4K"}) is True
    assert needs_confirmation("inpaint", {"n": 1}) is True


def test_plan_routes_and_records_cost() -> None:
    plan = plan_studio_job(
        prompt="a lantern",
        operation="generate",
        n=2,
        target_resolution="2K",
        options=[_model("p1", "m1", ["generate", "edit"], is_active_default=True)],
        language="zh",
    )
    assert plan["operation"] == "generate"
    assert plan["needs_confirmation"] is True
    assert "2K" in plan["cost_hint"]
    assert plan["language"] == "zh"


def test_plan_rejects_empty_prompt() -> None:
    with pytest.raises(ValueError, match="prompt"):
        plan_studio_job(prompt="  ", options=[_model()])


def test_project_for_session_reuses_chat_title(tmp_path) -> None:
    store = ImageStudioStore(tmp_path / "image-studio")
    first = project_for_session(store, "session-abcdef1234567890")
    second = project_for_session(store, "session-abcdef1234567890")
    assert first["id"] == second["id"]
    assert first["title"].startswith("Chat · session-abcdef")


def test_project_for_session_does_not_collide_on_legacy_prefix(tmp_path) -> None:
    store = ImageStudioStore(tmp_path / "image-studio")
    first = project_for_session(store, "unified_1770000000000_aaaaaaaa")
    second = project_for_session(store, "unified_1770000000999_bbbbbbbb")
    assert first["id"] != second["id"]
    assert project_for_session(store, "unified_1770000000000_aaaaaaaa")["id"] == first["id"]


def test_project_for_session_adopts_legacy_project_and_survives_rename(tmp_path) -> None:
    store = ImageStudioStore(tmp_path / "image-studio")
    session_id = "session-legacy-abcdef1234567890"
    legacy = store.create_project(f"Chat · {session_id[:16]}")
    assigned = project_for_session(store, session_id)
    assert assigned["id"] == legacy["id"]
    store.update_project(assigned["id"], "Renamed by user")
    assert project_for_session(store, session_id)["id"] == legacy["id"]
    reopened = ImageStudioStore(store.root)
    assert project_for_session(reopened, session_id)["id"] == legacy["id"]


def test_project_for_session_replaces_a_deleted_mapping(tmp_path) -> None:
    store = ImageStudioStore(tmp_path / "image-studio")
    session_id = "session-deleted-project"
    first = project_for_session(store, session_id)
    assert store.delete_project(first["id"])
    replacement = project_for_session(store, session_id)
    assert replacement["id"] != first["id"]
    assert project_for_session(store, session_id)["id"] == replacement["id"]


def test_collect_prefers_studio_asset_then_recent(tmp_path) -> None:
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Chat · s1")
    older = store.save_asset(project["id"], _png((1, 2, 3)), "image/png", kind="output")
    newer = store.save_asset(project["id"], _png((4, 5, 6)), "image/png", kind="output")
    job = store.create_job(
        project["id"],
        {
            "operation": "generate",
            "profile_id": "p1",
            "model_id": "m1",
            "prompt": "keep",
            "parameters": {},
        },
    )
    store.add_job_output(job["id"], newer["id"], 0)
    store.update_job(job["id"], "succeeded")

    reused = collect_input_asset_ids(
        store, project["id"], attachments=[{"studio_asset_id": older["id"]}]
    )
    assert reused == [older["id"]]

    recent = collect_input_asset_ids(store, project["id"], reuse_recent=True)
    assert recent == [newer["id"]]
    assert recent_session_outputs(store, project["id"])[0]["job_id"] == job["id"]


def test_decode_attachment_reads_base64() -> None:
    png = _png()
    decoded = decode_attachment(
        {"base64": base64.b64encode(png).decode("ascii"), "mime_type": "image/png"}
    )
    assert decoded is not None
    assert decoded[0] == png


def test_decode_attachment_rejects_oversized_and_malformed_base64(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from knorvia.services.image_studio import agent

    monkeypatch.setattr(agent, "MAX_UPLOAD_IMAGE_BYTES", 2)
    assert decode_attachment({"base64": base64.b64encode(b"abc").decode("ascii")}) is None
    assert decode_attachment({"base64": "not valid base64!?"}) is None


def test_fallback_models_skips_incapable() -> None:
    current = _model("p1", "a", ["generate", "edit"])
    options = [
        current,
        _model("p2", "b", ["generate"]),
        _model("p3", "c", ["generate", "edit"]),
    ]
    remaining = fallback_models(options, current, "edit")
    assert [item["model_id"] for item in remaining] == ["c"]


@pytest.mark.asyncio
async def test_run_falls_back_to_next_capable_model(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = ImageStudioStore(tmp_path / "image-studio")
    models = [
        _model("p1", "primary", ["generate"]),
        _model("p2", "backup", ["generate"]),
    ]
    plan = plan_studio_job(prompt="a river", options=models)
    plan["allow_model_fallback"] = True
    calls: list[str] = []

    def fake_start(studio: ImageStudioStore, job_id: str) -> None:
        job = studio.get_job(job_id) or {}
        calls.append(str(job.get("model_id")))
        if job.get("model_id") == "primary":
            studio.update_job(job_id, "failed", error_message="503 overloaded")
            return
        output = studio.save_asset(job["project_id"], _png(), "image/png", kind="output")
        studio.add_job_output(job_id, output["id"], 0)
        studio.update_job(job_id, "succeeded", actual={"n": 1})

    monkeypatch.setattr("knorvia.services.image_studio.agent.start_job", fake_start)
    result = await run_studio_image_job(
        plan, session_id="sess-fallback", store=store, options=models
    )
    assert result["job"]["status"] == "succeeded"
    assert result["fallback_used"] is True
    assert calls == ["primary", "backup"]
    assert result["plan"]["model_id"] == "backup"


@pytest.mark.asyncio
async def test_run_does_not_fallback_without_explicit_opt_in(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = ImageStudioStore(tmp_path / "image-studio")
    models = [
        _model("p1", "primary", ["generate"]),
        _model("p2", "backup", ["generate"]),
    ]
    plan = plan_studio_job(prompt="a river", options=models)
    calls: list[str] = []

    def fake_start(studio: ImageStudioStore, job_id: str) -> None:
        job = studio.get_job(job_id) or {}
        calls.append(str(job.get("model_id")))
        studio.update_job(job_id, "failed", error_message="503 overloaded")

    monkeypatch.setattr("knorvia.services.image_studio.agent.start_job", fake_start)
    result = await run_studio_image_job(plan, store=store, options=models)
    assert result["job"]["status"] == "failed"
    assert result["fallback_used"] is False
    assert calls == ["primary"]


@pytest.mark.asyncio
async def test_run_does_not_fallback_on_policy_block(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = ImageStudioStore(tmp_path / "image-studio")
    models = [
        _model("p1", "primary", ["generate"]),
        _model("p2", "backup", ["generate"]),
    ]
    plan = plan_studio_job(prompt="blocked", options=models)

    def fake_start(studio: ImageStudioStore, job_id: str) -> None:
        studio.update_job(job_id, "failed", error_message="blocked by safety policy")

    monkeypatch.setattr("knorvia.services.image_studio.agent.start_job", fake_start)
    result = await run_studio_image_job(plan, store=store, options=models)
    assert result["job"]["status"] == "failed"
    assert result["fallback_used"] is False
    assert result["plan"]["model_id"] == "primary"


@pytest.mark.asyncio
async def test_wait_timeout_cancels_the_persisted_job(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    from knorvia.services.image_studio import agent

    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Timeout")
    job = store.create_job(
        project["id"],
        {
            "operation": "generate",
            "profile_id": "p1",
            "model_id": "m1",
            "prompt": "wait",
            "parameters": {},
        },
    )
    cancelled: list[str] = []

    async def no_sleep(_seconds: float) -> None:
        return None

    def fake_cancel(_store: ImageStudioStore, job_id: str) -> bool:
        cancelled.append(job_id)
        return True

    monkeypatch.setattr(agent, "MAX_JOB_WAIT_POLLS", 2)
    monkeypatch.setattr(agent.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(agent, "cancel_job", fake_cancel)
    with pytest.raises(TimeoutError, match="timed out"):
        await agent._wait_for_job(store, job["id"])
    assert cancelled == [job["id"]]


@pytest.mark.asyncio
async def test_run_never_calls_raw_generate_image(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    import knorvia.services.imagegen as imagegen_mod

    store = ImageStudioStore(tmp_path / "image-studio")
    models = [_model("p1", "m1", ["generate"])]
    plan = plan_studio_job(prompt="no bypass", options=models)
    called = {"n": 0}

    async def boom(*_args: Any, **_kwargs: Any) -> list[tuple[bytes, str]]:
        called["n"] += 1
        raise AssertionError("raw generate_image must not be used")

    monkeypatch.setattr(imagegen_mod, "generate_image", boom)

    def fake_start(studio: ImageStudioStore, job_id: str) -> None:
        job = studio.get_job(job_id) or {}
        output = studio.save_asset(job["project_id"], _png(), "image/png", kind="output")
        studio.add_job_output(job_id, output["id"], 0)
        studio.update_job(job_id, "succeeded", actual={"n": 1})

    monkeypatch.setattr("knorvia.services.image_studio.agent.start_job", fake_start)
    result = await run_studio_image_job(plan, store=store, options=models)
    assert result["job"]["status"] == "succeeded"
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_run_emits_studio_job_id_for_chat_cards(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = ImageStudioStore(tmp_path / "image-studio")
    models = [_model("p1", "m1", ["generate"])]
    plan = plan_studio_job(prompt="card", options=models)
    events: list[tuple[str, str, dict[str, Any]]] = []

    async def sink(kind: str, message: str = "", metadata: dict[str, Any] | None = None) -> None:
        events.append((kind, message, metadata or {}))

    def fake_start(studio: ImageStudioStore, job_id: str) -> None:
        job = studio.get_job(job_id) or {}
        output = studio.save_asset(job["project_id"], _png(), "image/png", kind="output")
        studio.add_job_output(job_id, output["id"], 0)
        studio.update_job(job_id, "succeeded", actual={"n": 1})

    monkeypatch.setattr("knorvia.services.image_studio.agent.start_job", fake_start)
    result = await run_studio_image_job(
        plan, session_id="sess-card", store=store, options=models, event_sink=sink
    )
    assert result["job"]["status"] == "succeeded"
    ids = [meta.get("studio_job_id") for _, _, meta in events if meta.get("studio_job_id")]
    assert result["job"]["id"] in ids
    assert any(meta.get("studio_project_id") for _, _, meta in events)


@pytest.mark.asyncio
async def test_target_is_reserved_before_an_immediate_job_finishes(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.ensure_default_project()
    store.save_board(
        project["id"],
        {
            "nodes": [
                {
                    "id": "slot",
                    "kind": "generate",
                    "x": 0,
                    "y": 0,
                    "width": 280,
                    "height": 280,
                }
            ]
        },
    )
    models = [_model("p1", "m1", ["generate"])]
    plan = plan_studio_job(prompt="instant", options=models)

    def fake_start(studio: ImageStudioStore, job_id: str) -> None:
        job = studio.get_job(job_id) or {}
        output = studio.save_asset(job["project_id"], _png(), "image/png", kind="output")
        studio.add_job_output(job_id, output["id"], 0)
        studio.update_job(job_id, "succeeded", actual={"n": 1})

    monkeypatch.setattr("knorvia.services.image_studio.agent.start_job", fake_start)
    result = await run_studio_image_job(plan, store=store, options=models, target_node_id="slot")
    board = store.get_board(project["id"])
    assert result["job"]["status"] == "succeeded"
    assert len(board["nodes"]) == 1
    assert board["nodes"][0]["kind"] == "image"
    assert board["nodes"][0]["status"] == "succeeded"


def test_prepare_board_applies_three_view_and_iterate(tmp_path) -> None:
    from knorvia.services.image_studio.board import prepare_board_for_job, summarize_board

    store = ImageStudioStore(tmp_path / "image-studio")
    project = store.create_project("Chat · board")
    asset = store.save_asset(project["id"], _png(), "image/png", kind="output")
    applied = prepare_board_for_job(
        store,
        project["id"],
        template="three-view",
        input_asset_ids=[asset["id"]],
        prompt="red coat explorer",
    )
    assert applied["template_id"] == "three-view"
    assert len(applied["generate_ids"]) == 3
    ref = next(
        node
        for node in applied["board"]["nodes"]
        if node.get("kind") == "image" and node.get("assetId") == asset["id"]
    )
    assert ref["assetId"] == asset["id"]
    again = prepare_board_for_job(store, project["id"], template="three-view")
    assert again["generate_ids"] == applied["generate_ids"]

    iterated = prepare_board_for_job(
        store,
        project["id"],
        iterate_from=asset["id"],
        prompt="turn to the left",
    )
    child = next(
        node for node in iterated["board"]["nodes"] if node["id"] == iterated["target_node_id"]
    )
    assert child["kind"] == "generate"
    assert child["parentNodeId"] == ref["id"]
    assert asset["id"] in iterated["input_asset_ids"]
    summary = summarize_board(iterated["board"])
    assert summary["node_count"] >= 6
