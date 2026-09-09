"""Diff and read contracts: what a reviewer is told must match what changed."""

from __future__ import annotations

import hashlib
import io
from pathlib import Path
from typing import Any

from openpyxl import Workbook
import pytest

from knorvia.services.office_artifacts.adapters import xlsx_adapter
from knorvia.services.office_artifacts.service import OfficeArtifactService


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _imported(tmp_path: Path, data: bytes) -> tuple[OfficeArtifactService, str, str]:
    service = OfficeArtifactService(task_dir=tmp_path, workspace_dir=tmp_path / "exec")
    draft_id = service.store.create_draft()
    artifact_id = service.store.add_artifact(
        draft_id,
        filename="book.xlsx",
        mime="",
        kind="xlsx",
        origin_kind="attachment",
        origin_ref="attachment:book.xlsx",
        data=data,
        origin_base_hash=_sha(data),
    )
    return service, draft_id, artifact_id


def _two_sheet_workbook() -> bytes:
    book = Workbook()
    first = book.active
    assert first is not None
    first.title = "Data"
    first["A1"] = "kept"
    extra = book.create_sheet("Added")
    extra["A1"] = "new sheet content"
    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def test_diff_covers_cells_outside_the_old_used_range(tmp_path: Path) -> None:
    """Writing into an empty corner must not diff as "nothing happened"."""
    empty = xlsx_adapter.create_generated_xlsx("Data")
    service, draft_id, artifact_id = _imported(tmp_path, empty)

    service.apply_operations(
        draft_id,
        artifact_id,
        0,
        [{"op": "set_cell", "sheet": "Data", "cell": "B2", "text": "added later"}],
        actor="tester",
    )

    diff = service.diff_between(draft_id, artifact_id, from_revision=0)
    targets = {(entry["kind"], entry["target"]) for entry in diff["entries"]}
    assert ("cell", "B2") in targets


def test_diff_reports_a_worksheet_that_only_exists_in_one_revision(
    tmp_path: Path,
) -> None:
    single = xlsx_adapter.create_generated_xlsx("Data")
    service, draft_id, artifact_id = _imported(tmp_path, single)

    service.store.commit_revision(
        draft_id,
        artifact_id,
        new_bytes=_two_sheet_workbook(),
        base_revision=0,
        actor="tester",
        operations_summary=["replace content"],
        diff=None,
        verification={"reopened": True},
    )

    kinds = {
        entry["kind"]: entry
        for entry in service.diff_between(draft_id, artifact_id, from_revision=0)["entries"]
    }
    assert "sheet" in kinds
    assert kinds["sheet"]["target"] == "Added"
    assert kinds["sheet"]["before"] == {"present": False}
    assert kinds["sheet"]["after"] == {"present": True}
    # The reverse direction reports it as removed.
    back = service.diff_between(
        draft_id, artifact_id, from_revision=1, to_revision=0
    )["entries"]
    assert any(
        entry["kind"] == "sheet" and entry["before"] == {"present": True} for entry in back
    )


def test_overview_reads_the_revision_it_was_asked_for(tmp_path: Path) -> None:
    data = xlsx_adapter.create_generated_xlsx("Data")
    service, draft_id, artifact_id = _imported(tmp_path, data)
    service.apply_operations(
        draft_id,
        artifact_id,
        0,
        [{"op": "set_cell", "sheet": "Data", "cell": "A1", "text": "second"}],
        actor="tester",
    )

    current = service.read_range(draft_id, artifact_id, "Data", "A1")
    old = service.read_range(draft_id, artifact_id, "Data", "A1", 0)

    assert current["cells"][0]["value"] == "second"
    assert current["revision"] == 1
    assert old["cells"][0]["value"] is None
    assert old["revision"] == 0


def test_office_read_tool_forwards_revision_to_the_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from knorvia.tools import office_read as office_read_module
    from knorvia.tools.office_read import OfficeReadTool

    calls: list[tuple[str, tuple[Any, ...]]] = []

    class _Recording:
        def overview(self, *args: Any) -> dict[str, Any]:
            calls.append(("overview", args))
            return {"ok": True}

        def read_range(self, *args: Any) -> dict[str, Any]:
            calls.append(("range", args))
            return {"ok": True}

    monkeypatch.setattr(
        office_read_module, "build_office_service", lambda kwargs: _Recording()
    )
    tool = OfficeReadTool()

    import asyncio

    asyncio.run(
        tool.execute(
            action="overview", draft_id="aaaa1111", artifact_id="bbbb2222", revision=3
        )
    )
    asyncio.run(
        tool.execute(
            action="range",
            draft_id="aaaa1111",
            artifact_id="bbbb2222",
            sheet="Data",
            range="A1",
            revision=2,
        )
    )

    assert calls == [
        ("overview", ("aaaa1111", "bbbb2222", 3)),
        ("range", ("aaaa1111", "bbbb2222", "Data", "A1", 2)),
    ]
