"""Server-side injection and frozen-selection coverage for OAR v2 tools."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from knorvia.agents.chat.agentic_pipeline import AgenticChatPipeline
from knorvia.core.context import UnifiedContext
from knorvia.services.office_artifacts.contracts import (
    InvalidOperationError,
    parse_operations,
)
from knorvia.services.path_service import PathService
from knorvia.tools.office_apply import _check_frozen_selection
from knorvia.tools.office_artifact import build_office_service


class _Attachment:
    def __init__(self, id: str, filename: str, mime_type: str) -> None:
        self.id = id
        self.filename = filename
        self.mime_type = mime_type
        self.type = "file"


def _pipeline(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> AgenticChatPipeline:
    service = PathService(workspace_root=tmp_path)
    monkeypatch.setattr("knorvia.services.path_service.get_path_service", lambda: service)
    pipeline = AgenticChatPipeline.__new__(AgenticChatPipeline)
    monkeypatch.setattr(
        AgenticChatPipeline, "_current_user_id", lambda self: "u_ada", raising=False
    )
    return pipeline


def _context(**metadata: Any) -> UnifiedContext:
    return UnifiedContext(
        session_id="s1",
        user_message="edit the sheet",
        attachments=[
            _Attachment(
                "a1",
                "data.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
            _Attachment("a2", "pic.png", "image/png"),
        ],
        metadata={"turn_id": "t-1", **metadata},
    )


def test_augment_strips_forged_fields_and_injects_context(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pipeline = _pipeline(monkeypatch, tmp_path)
    context = _context(
        office_selection={
            "draft_id": "d1",
            "artifact_id": "art1",
            "sheet": "Data",
            "range": "A1:B4",
            "revision": 3,
            "evil": "x",
        }
    )
    kwargs = pipeline._augment_tool_kwargs(
        "office_artifact",
        {
            "action": "open",
            "source": "attachment:a1",
            "_task_dir": "C:/evil",
            "_office_draft_id": "forged",
            "_session_id": "forged",
        },
        context,
    )
    assert kwargs["_task_dir"] != "C:/evil"
    assert "_office_draft_id" not in kwargs
    assert kwargs["_session_id"] == "s1"
    assert kwargs["_office_attachments"] == [
        {
            "id": "a1",
            "filename": "data.xlsx",
            "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }
    ]
    assert kwargs["_office_selection"] == {
        "draft_id": "d1",
        "artifact_id": "art1",
        "sheet": "Data",
        "range": "A1:B4",
        "revision": 3,
    }
    assert Path(kwargs["_workspace_dir"]).name == "exec"


def test_augment_office_document_keeps_draft_metadata(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pipeline = _pipeline(monkeypatch, tmp_path)
    context = _context(office_draft={"draft_id": "abcd1234", "files": [], "status": "draft"})
    kwargs = pipeline._augment_tool_kwargs("office_document", {"action": "create"}, context)
    assert kwargs["_office_draft_id"] == "abcd1234"
    assert kwargs["_task_dir"]
    assert Path(kwargs["_workspace_dir"]).name == "exec"


def test_frozen_selection_allows_in_scope_batch() -> None:
    ops = parse_operations(
        [{"op": "set_cell", "sheet": "Data", "cell": "A1", "number": 1}]
    )
    _check_frozen_selection(
        {"sheet": "Data", "range": "A1:B4", "revision": 3}, "d1", "art1", 3, ops
    )


def test_frozen_selection_rejects_out_of_scope() -> None:
    ops = parse_operations(
        [{"op": "set_cell", "sheet": "Data", "cell": "C9", "number": 1}]
    )
    with pytest.raises(InvalidOperationError):
        _check_frozen_selection(
            {"sheet": "Data", "range": "A1:B4", "revision": 3}, "d1", "art1", 3, ops
        )
    other_sheet = parse_operations(
        [{"op": "set_cell", "sheet": "Other", "cell": "A1", "number": 1}]
    )
    with pytest.raises(InvalidOperationError):
        _check_frozen_selection({"sheet": "Data"}, "d1", "art1", 3, other_sheet)


def test_frozen_selection_rejects_stale_revision() -> None:
    ops = parse_operations(
        [{"op": "set_cell", "sheet": "Data", "cell": "A1", "number": 1}]
    )
    with pytest.raises(InvalidOperationError):
        _check_frozen_selection(
            {"sheet": "Data", "range": "A1:B4", "revision": 3}, "d1", "art1", 4, ops
        )


def test_build_office_service_from_injected_kwargs(tmp_path: Path) -> None:
    task_dir = tmp_path / "task"
    service = build_office_service(
        {"_task_dir": str(task_dir), "_workspace_dir": str(task_dir / "exec"), "_session_id": "s1"}
    )
    assert service is not None
    assert service.store.root == task_dir / "office_drafts"
    assert build_office_service({}) is None
