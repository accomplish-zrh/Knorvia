"""Draft-mode coverage for the ``office_document`` tool."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from knorvia.agents.chat.agentic_pipeline import AgenticChatPipeline
from knorvia.core.agentic.tool_dispatch import DispatchOutcome
from knorvia.core.context import UnifiedContext
from knorvia.core.stream_bus import StreamBus
from knorvia.core.tool_protocol import ToolResult
from knorvia.tools.office_document import DRAFT_ACTIONS, execute_office_document


def _run(task_dir: Path, **kwargs: Any) -> ToolResult:
    official = task_dir / "exec"
    official.mkdir(parents=True, exist_ok=True)
    payload = {
        "_workspace_dir": str(official),
        "_task_dir": str(task_dir),
        **kwargs,
    }
    return execute_office_document(payload)


def test_as_draft_default_writes_to_draft_not_workspace(tmp_path: Path) -> None:
    result = _run(tmp_path, action="create", file="report.xlsx", sheet="Data")
    assert result.success is True
    draft_id = str(result.metadata["draft_id"])
    assert len(draft_id) == 8
    assert result.metadata["draft_status"] == "draft"
    assert not (tmp_path / "exec" / "report.xlsx").exists()
    assert (tmp_path / "office_drafts" / draft_id / "report.xlsx").is_file()
    assert result.metadata["office_draft"]["files"][0]["name"] == "report.xlsx"


def test_as_draft_false_writes_official(tmp_path: Path) -> None:
    result = _run(tmp_path, action="create", file="report.xlsx", as_draft=False)
    assert result.success is True
    assert (tmp_path / "exec" / "report.xlsx").is_file()
    assert "draft_id" not in result.metadata


def test_without_task_dir_still_writes_directly(tmp_path: Path) -> None:
    result = execute_office_document(
        {
            "_workspace_dir": str(tmp_path),
            "action": "create",
            "file": "plain.xlsx",
        }
    )
    assert result.success is True
    assert (tmp_path / "plain.xlsx").is_file()
    assert "draft_id" not in result.metadata


def test_draft_action_ready_merge_status(tmp_path: Path) -> None:
    created = _run(tmp_path, action="create", file="report.xlsx")
    draft_id = created.metadata["draft_id"]
    ready = _run(tmp_path, action="ready", draft_id=draft_id)
    assert ready.success is True
    assert ready.metadata["draft_status"] == "ready"
    status = _run(tmp_path, draft_action="status", draft_id=draft_id, action="status")
    assert status.success is True
    merged = _run(tmp_path, draft_action="merge", draft_id=draft_id, action="merge")
    assert merged.success is True
    assert merged.metadata["draft_status"] == "merged"
    assert (tmp_path / "exec" / "report.xlsx").is_file()


def test_merged_draft_refuses_further_writes(tmp_path: Path) -> None:
    created = _run(tmp_path, action="create", file="report.xlsx")
    draft_id = created.metadata["draft_id"]
    _run(tmp_path, action="ready", draft_id=draft_id)
    _run(tmp_path, action="merge", draft_id=draft_id)
    written = _run(
        tmp_path,
        action="write_cells",
        file="report.xlsx",
        cells={"A1": 1},
        draft_id=draft_id,
    )
    assert written.success is False
    assert "refused" in written.content.lower() or "merged" in written.content.lower()


def test_discard_from_draft(tmp_path: Path) -> None:
    created = _run(tmp_path, action="create", file="report.xlsx")
    draft_id = created.metadata["draft_id"]
    discarded = _run(tmp_path, action="discard", draft_id=draft_id)
    assert discarded.success is True
    assert discarded.metadata["draft_status"] == "discarded"


def test_invalid_draft_action(tmp_path: Path) -> None:
    result = _run(tmp_path, action="create", file="x.xlsx", draft_action="explode")
    assert result.success is False
    assert "draft_action" in result.content
    for name in DRAFT_ACTIONS:
        assert name in result.content


def test_lifecycle_without_draft_id_fails(tmp_path: Path) -> None:
    result = _run(tmp_path, action="ready")
    assert result.success is False
    assert "draft_id" in result.content.lower()


def test_draft_xlsx_is_public_output(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from knorvia.services.path_service import PathService

    service = PathService(workspace_root=tmp_path)
    monkeypatch.setattr("knorvia.services.path_service.get_path_service", lambda: service)
    task_dir = service.get_task_workspace("chat", "t-1")
    result = _run(task_dir, action="create", file="report.xlsx")
    assert result.success is True
    draft_id = result.metadata["draft_id"]
    draft_file = task_dir / "office_drafts" / draft_id / "report.xlsx"
    assert service.is_public_output_path(draft_file)
    url = str(result.metadata["office_draft"]["files"][0]["url"])
    assert url.startswith("/api/outputs/")
    assert draft_id in url


def test_pipeline_injects_task_dir_and_draft_id(monkeypatch, tmp_path: Path) -> None:
    from knorvia.services.path_service import PathService

    service = PathService(workspace_root=tmp_path)
    monkeypatch.setattr("knorvia.services.path_service.get_path_service", lambda: service)
    pipeline = AgenticChatPipeline.__new__(AgenticChatPipeline)
    monkeypatch.setattr(
        AgenticChatPipeline, "_current_user_id", lambda self: "u_ada", raising=False
    )
    context = UnifiedContext(
        session_id="s1",
        user_message="make a sheet",
        metadata={
            "turn_id": "t-1",
            "office_draft": {"draft_id": "abcd1234", "files": [], "status": "draft"},
        },
    )
    kwargs = pipeline._augment_tool_kwargs("office_document", {"action": "create"}, context)
    assert kwargs["_task_dir"]
    assert kwargs["_office_draft_id"] == "abcd1234"
    assert Path(kwargs["_workspace_dir"]).name == "exec"


@pytest.mark.asyncio
async def test_pipeline_publishes_office_draft_metadata() -> None:
    pipeline = AgenticChatPipeline.__new__(AgenticChatPipeline)
    context = UnifiedContext(session_id="s1", user_message="sheet", metadata={})
    bus = StreamBus()
    outcome = DispatchOutcome(
        tool_metadata_by_id={
            "call-1": {
                "office_draft": {
                    "draft_id": "abcd1234",
                    "status": "draft",
                    "files": [{"name": "a.xlsx", "url": "/api/outputs/a.xlsx"}],
                }
            }
        }
    )
    await pipeline._publish_office_draft_metadata(context, outcome, bus)
    assert context.metadata["office_draft"]["draft_id"] == "abcd1234"
    assert any((event.metadata or {}).get("trace_kind") == "office_draft" for event in bus._history)
