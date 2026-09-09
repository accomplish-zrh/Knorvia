"""Merge coordinator invariants: nothing is published unless all of it can be."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

from knorvia.services.office_artifacts import merge_coordinator as coordinator_module
from knorvia.services.office_artifacts.adapters import xlsx_adapter
from knorvia.services.office_artifacts.contracts import (
    DraftStateError,
    MergeConflictError,
)
from knorvia.services.office_artifacts.service import OfficeArtifactService
from knorvia.services.office_artifacts.sources import SourceContext
from knorvia.services.office_artifacts.store import LOCK_NAME, OfficeArtifactStore


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _service(tmp_path: Path, *, library: object | None = None) -> OfficeArtifactService:
    return OfficeArtifactService(
        task_dir=tmp_path,
        workspace_dir=tmp_path / "exec",
        source_context=SourceContext(library_store=library),  # type: ignore[arg-type]
    )


def _add(
    service: OfficeArtifactService,
    draft_id: str,
    *,
    filename: str,
    origin_kind: str,
    data: bytes,
    origin_ref: str = "",
    base_hash: str | None = None,
) -> str:
    return service.store.add_artifact(
        draft_id,
        filename=filename,
        mime="",
        kind="xlsx",
        origin_kind=origin_kind,
        origin_ref=origin_ref or f"{origin_kind}:{filename}",
        data=data,
        origin_base_hash=_sha(data) if base_hash is None else base_hash,
    )


class _FakeLibrary:
    """Minimum surface the merge coordinator uses on the creative library."""

    def __init__(self) -> None:
        self.entries: dict[str, bytes] = {}

    def create(self, entry_id: str, data: bytes) -> None:
        self.entries[entry_id] = data

    def entry_bytes(self, entry_id: str) -> tuple[bytes, str] | None:
        data = self.entries.get(entry_id)
        return (data, "application/octet-stream") if data is not None else None

    def replace_entry_bytes(
        self, entry_id: str, data: bytes, *, expect_sha256: str | None = None
    ) -> dict[str, str] | None:
        current = self.entries.get(entry_id)
        if current is None:
            raise KeyError(entry_id)
        if expect_sha256 is not None and _sha(current) != expect_sha256:
            return None
        self.entries[entry_id] = data
        return {"id": entry_id, "sha256": _sha(data)}


def test_attachment_name_clash_publishes_once_without_clobbering(tmp_path: Path) -> None:
    service = _service(tmp_path)
    workspace: Path = service.store.workspace_dir
    workspace.mkdir(parents=True, exist_ok=True)
    unrelated = b"unrelated workbook that must survive the merge"
    (workspace / "same.xlsx").write_bytes(unrelated)

    draft_id = service.store.create_draft()
    _add(
        service,
        draft_id,
        filename="same.xlsx",
        origin_kind="attachment",
        data=xlsx_adapter.create_generated_xlsx("Edited"),
    )
    service.mark_ready(draft_id)
    outcome = service.merge(draft_id)

    assert (workspace / "same.xlsx").read_bytes() == unrelated
    published = sorted(p.name for p in workspace.glob("*.xlsx"))
    assert published == ["same.xlsx", outcome["files"][0]]
    assert outcome["files"][0] != "same.xlsx"


def test_merged_card_links_the_file_that_actually_exists(tmp_path: Path) -> None:
    service = OfficeArtifactService(
        task_dir=tmp_path,
        workspace_dir=tmp_path / "exec",
        public_root=tmp_path,
    )
    workspace = service.store.workspace_dir
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "same.xlsx").write_bytes(b"unrelated")

    draft_id = service.store.create_draft()
    _add(
        service,
        draft_id,
        filename="same.xlsx",
        origin_kind="attachment",
        data=xlsx_adapter.create_generated_xlsx("Edited"),
    )
    service.mark_ready(draft_id)
    outcome = service.merge(draft_id)
    card = service.card_payload(draft_id)

    entry = card["files"][0]
    assert entry["name"] == outcome["files"][0]
    assert entry["url"].endswith(entry["name"])


def test_illegal_status_merge_writes_nothing(tmp_path: Path) -> None:
    service = _service(tmp_path)
    draft_id = service.store.create_draft()
    _add(
        service,
        draft_id,
        filename="book.xlsx",
        origin_kind="attachment",
        data=xlsx_adapter.create_generated_xlsx("Data"),
    )
    service.discard(draft_id)

    with pytest.raises(DraftStateError):
        service.merge(draft_id)

    assert not list(service.store.workspace_dir.glob("*.xlsx"))


def test_conflict_on_second_artifact_publishes_nothing(tmp_path: Path) -> None:
    older = xlsx_adapter.create_generated_xlsx("Opened")
    newer = xlsx_adapter.create_generated_xlsx("Newer")
    library = _FakeLibrary()
    library.create("entry-1", newer)
    service = _service(tmp_path, library=library)
    workspace = service.store.workspace_dir
    workspace.mkdir(parents=True, exist_ok=True)

    draft_id = service.store.create_draft()
    _add(
        service,
        draft_id,
        filename="first.xlsx",
        origin_kind="attachment",
        data=xlsx_adapter.create_generated_xlsx("First"),
    )
    _add(
        service,
        draft_id,
        filename="stale.xlsx",
        origin_kind="library",
        data=older,
        origin_ref="library:entry-1",
    )
    service.mark_ready(draft_id)

    with pytest.raises(MergeConflictError):
        service.merge(draft_id)

    assert not list(workspace.glob("*.xlsx"))
    assert library.entries["entry-1"] == newer
    assert service.store.status(draft_id)["status"] == "ready"


def test_workspace_merge_conflicts_when_the_file_changed_underneath(
    tmp_path: Path,
) -> None:
    outputs = tmp_path / "public"
    outputs.mkdir(parents=True)
    original = xlsx_adapter.create_generated_xlsx("Original")
    (outputs / "plan.xlsx").write_bytes(original)
    service = OfficeArtifactService(
        task_dir=tmp_path / "task",
        workspace_dir=tmp_path / "task" / "exec",
        source_context=SourceContext(path_service=_FakePathService(outputs)),
    )
    opened = service.open_source("workspace:plan.xlsx")
    draft_id = str(opened["draft_id"])

    changed = xlsx_adapter.create_generated_xlsx("Someone else")
    (outputs / "plan.xlsx").write_bytes(changed)
    service.mark_ready(draft_id)

    with pytest.raises(MergeConflictError):
        service.merge(draft_id)

    assert (outputs / "plan.xlsx").read_bytes() == changed
    assert not list(service.store.workspace_dir.glob("*.xlsx"))


def test_failed_write_rolls_back_every_earlier_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    outputs = tmp_path / "public"
    outputs.mkdir(parents=True)
    original = xlsx_adapter.create_generated_xlsx("Original")
    (outputs / "plan.xlsx").write_bytes(original)
    service = OfficeArtifactService(
        task_dir=tmp_path,
        workspace_dir=tmp_path / "exec",
        source_context=SourceContext(path_service=_FakePathService(outputs)),
    )
    workspace = service.store.workspace_dir
    opened = service.open_source("workspace:plan.xlsx")
    draft_id = str(opened["draft_id"])
    artifact_id = str(opened["artifact"]["artifact_id"])
    service.store.commit_revision(
        draft_id,
        artifact_id,
        new_bytes=xlsx_adapter.create_generated_xlsx("Edited"),
        base_revision=0,
        actor="user",
        operations_summary=["set_cell A1"],
        diff=None,
        verification={"reopened": True},
    )
    _add(
        service,
        draft_id,
        filename="second.xlsx",
        origin_kind="attachment",
        data=xlsx_adapter.create_generated_xlsx("Second"),
    )
    service.mark_ready(draft_id)

    def fail_the_publish(path: Path, data: bytes) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(coordinator_module.publication, "atomic_write_exclusive", fail_the_publish)

    with pytest.raises(OSError):
        service.merge(draft_id)

    assert (outputs / "plan.xlsx").read_bytes() == original
    assert not list(workspace.glob("second*.xlsx"))
    assert service.store.status(draft_id)["status"] == "ready"


def test_two_artifacts_cannot_merge_onto_one_destination(tmp_path: Path) -> None:
    service = _service(tmp_path)
    draft_id = service.store.create_draft()
    data = xlsx_adapter.create_generated_xlsx("Data")
    _add(service, draft_id, filename="one.xlsx", origin_kind="v1_migration", data=data)
    _add(service, draft_id, filename="one.xlsx", origin_kind="v1_migration", data=data)
    service.mark_ready(draft_id)

    with pytest.raises(DraftStateError, match="merge them separately"):
        service.merge(draft_id)
    assert not list(service.store.workspace_dir.glob("*.xlsx"))


class _FakePathService:
    """Public-output resolution: one root, nested layout, no absolute escapes."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def resolve_public_output_path(self, path: object) -> Path | None:
        candidate = (self.root / str(path)).resolve()
        return candidate if candidate.is_file() else None


def _lock_held(store: OfficeArtifactStore, draft_id: str) -> bool:
    lock_path = store.draft_dir(draft_id) / LOCK_NAME
    try:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return True
    os.close(fd)
    lock_path.unlink(missing_ok=True)
    return False


def test_merge_holds_the_draft_lock_from_plan_through_stage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The plan is only a snapshot while nothing else can move the draft."""
    service = _service(tmp_path)
    store = service.store
    store.workspace_dir.mkdir(parents=True, exist_ok=True)
    draft_id = store.create_draft()
    _add(
        service,
        draft_id,
        filename="book.xlsx",
        origin_kind="attachment",
        data=xlsx_adapter.create_generated_xlsx("Data"),
    )
    service.mark_ready(draft_id)

    held: list[bool] = []
    real_plan = coordinator_module.MergeCoordinator._plan
    real_stage = coordinator_module.MergeCoordinator._stage

    def watch_plan(self: object, wanted: str) -> list[dict]:
        plan = real_plan(self, wanted)
        held.append(_lock_held(store, wanted))
        return plan

    def watch_stage(self: object, wanted: str, plan: list[dict]) -> dict:
        held.append(_lock_held(store, wanted))
        return real_stage(self, wanted, plan)

    monkeypatch.setattr(coordinator_module.MergeCoordinator, "_plan", watch_plan)
    monkeypatch.setattr(coordinator_module.MergeCoordinator, "_stage", watch_stage)
    service.merge(draft_id)

    assert held == [True, True], f"draft lock was free during the merge: {held}"


def test_workspace_artifact_merges_back_onto_its_resolved_source(tmp_path: Path) -> None:
    outputs = tmp_path / "public"
    nested = outputs / "reports"
    nested.mkdir(parents=True)
    original = xlsx_adapter.create_generated_xlsx("Original")
    (nested / "plan.xlsx").write_bytes(original)

    service = OfficeArtifactService(
        task_dir=tmp_path / "task",
        workspace_dir=tmp_path / "task" / "exec",
        public_root=outputs,
        source_context=SourceContext(path_service=_FakePathService(outputs)),
    )
    opened = service.open_source("workspace:reports/plan.xlsx")
    draft_id = str(opened["draft_id"])
    artifact_id = str(opened["artifact"]["artifact_id"])
    edited = xlsx_adapter.create_generated_xlsx("Edited")
    service.store.commit_revision(
        draft_id,
        artifact_id,
        new_bytes=edited,
        base_revision=0,
        actor="user",
        operations_summary=["set_cell A1"],
        diff=None,
        verification={"reopened": True},
    )
    service.mark_ready(draft_id)
    service.merge(draft_id)

    assert (nested / "plan.xlsx").read_bytes() == edited
    assert not list((tmp_path / "task" / "exec").glob("*.xlsx"))
    entry = service.card_payload(draft_id)["files"][0]
    assert entry["name"] == "plan.xlsx"
    assert entry["url"].endswith("/reports/plan.xlsx"), entry["url"]


def test_library_entry_changed_after_planning_is_refused_and_rolled_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = xlsx_adapter.create_generated_xlsx("Opened")
    intruder = xlsx_adapter.create_generated_xlsx("Someone saved this")
    library = _FakeLibrary()
    library.create("entry-1", base)
    service = _service(tmp_path, library=library)
    service.store.workspace_dir.mkdir(parents=True, exist_ok=True)

    draft_id = service.store.create_draft()
    _add(
        service,
        draft_id,
        filename="first.xlsx",
        origin_kind="attachment",
        data=xlsx_adapter.create_generated_xlsx("First"),
    )
    _add(
        service,
        draft_id,
        filename="entry.xlsx",
        origin_kind="library",
        data=base,
        origin_ref="library:entry-1",
    )
    service.mark_ready(draft_id)

    real_plan = coordinator_module.MergeCoordinator._plan

    def change_the_world_after_planning(self: object, wanted: str) -> list[dict]:
        plan = real_plan(self, wanted)
        library.entries["entry-1"] = intruder
        return plan

    monkeypatch.setattr(
        coordinator_module.MergeCoordinator, "_plan", change_the_world_after_planning
    )

    with pytest.raises(MergeConflictError):
        service.merge(draft_id)

    assert library.entries["entry-1"] == intruder
    assert not list(service.store.workspace_dir.glob("*.xlsx"))
    assert service.store.status(draft_id)["status"] == "ready"


def test_file_that_appeared_after_planning_is_never_clobbered(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = _service(tmp_path)
    draft_id = service.store.create_draft()
    _add(
        service,
        draft_id,
        filename="book.xlsx",
        origin_kind="attachment",
        data=xlsx_adapter.create_generated_xlsx("Data"),
    )
    service.mark_ready(draft_id)

    real_plan = coordinator_module.MergeCoordinator._plan
    workspace = service.store.workspace_dir

    def occupy_the_target_after_planning(self: object, wanted: str) -> list[dict]:
        plan = real_plan(self, wanted)
        workspace.mkdir(parents=True, exist_ok=True)
        for item in plan:
            if item.get("path") is not None:
                Path(item["path"]).write_bytes(b"an unrelated file that appeared")
        return plan

    monkeypatch.setattr(
        coordinator_module.MergeCoordinator, "_plan", occupy_the_target_after_planning
    )
    outcome = service.merge(draft_id)

    squatter = workspace / "book.xlsx"
    assert squatter.read_bytes() == b"an unrelated file that appeared"
    assert outcome["files"] != ["book.xlsx"]
    published = [p for p in workspace.glob("*.xlsx") if p != squatter]
    assert [p.name for p in published] == list(outcome["files"])


def test_lost_exclusive_publish_is_a_conflict_not_a_crash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The race is won by whoever created the file; the merge just refuses."""
    service = _service(tmp_path)
    draft_id = service.store.create_draft()
    _add(
        service,
        draft_id,
        filename="book.xlsx",
        origin_kind="attachment",
        data=xlsx_adapter.create_generated_xlsx("Data"),
    )
    service.mark_ready(draft_id)

    def lose_the_race(path: Path, data: bytes) -> None:
        raise FileExistsError(path)

    monkeypatch.setattr(coordinator_module.publication, "atomic_write_exclusive", lose_the_race)

    with pytest.raises(MergeConflictError):
        service.merge(draft_id)

    assert service.store.status(draft_id)["status"] == "ready"


def test_library_merge_reports_the_real_name_not_a_dead_file_link(tmp_path: Path) -> None:
    base = xlsx_adapter.create_generated_xlsx("Opened")
    library = _FakeLibrary()
    library.create("entry-1", base)
    service = OfficeArtifactService(
        task_dir=tmp_path,
        workspace_dir=tmp_path / "exec",
        public_root=tmp_path,
        source_context=SourceContext(library_store=library),
    )
    service.store.workspace_dir.mkdir(parents=True, exist_ok=True)
    draft_id = service.store.create_draft()
    artifact_id = _add(
        service,
        draft_id,
        filename="entry.xlsx",
        origin_kind="library",
        data=base,
        origin_ref="library:entry-1",
    )
    edited = xlsx_adapter.create_generated_xlsx("Edited")
    service.store.commit_revision(
        draft_id,
        artifact_id,
        new_bytes=edited,
        base_revision=0,
        actor="user",
        operations_summary=["set_cell A1"],
        diff=None,
        verification={"reopened": True},
    )
    service.mark_ready(draft_id)
    outcome = service.merge(draft_id)

    entry = service.card_payload(draft_id)["files"][0]
    assert outcome["files"] == ["entry.xlsx"]
    assert entry["name"] == "entry.xlsx"
    assert entry["url"] == "", "a library write-back has no workspace file to link"
    assert entry["kind"] == "library"
    assert not list(service.store.workspace_dir.glob("library*"))
    assert library.entries["entry-1"] == edited


def test_rollback_never_deletes_a_file_a_later_writer_took_over(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = _service(tmp_path)
    draft_id = service.store.create_draft()
    _add(
        service,
        draft_id,
        filename="first.xlsx",
        origin_kind="attachment",
        data=xlsx_adapter.create_generated_xlsx("First"),
    )
    _add(
        service,
        draft_id,
        filename="second.xlsx",
        origin_kind="attachment",
        data=xlsx_adapter.create_generated_xlsx("Second"),
    )
    service.mark_ready(draft_id)

    intruder = b"a later writer now owns this path"
    real_publish = coordinator_module.publication.publish_exclusive
    calls = 0

    def take_over_then_fail(path: Path, data: bytes):
        nonlocal calls
        calls += 1
        if calls == 1:
            receipt = real_publish(path, data)
            path.write_bytes(intruder)
            return receipt
        raise OSError("disk full")

    monkeypatch.setattr(coordinator_module.publication, "publish_exclusive", take_over_then_fail)
    with pytest.raises(OSError, match="disk full"):
        service.merge(draft_id)

    assert (service.store.workspace_dir / "first.xlsx").read_bytes() == intruder
    assert not (service.store.workspace_dir / "second.xlsx").exists()
    assert service.store.status(draft_id)["status"] == "ready"


def test_library_rollback_never_overwrites_a_later_save(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = xlsx_adapter.create_generated_xlsx("Opened")
    edited = xlsx_adapter.create_generated_xlsx("Edited")
    intruder = xlsx_adapter.create_generated_xlsx("Later save")
    library = _FakeLibrary()
    library.create("entry-1", base)
    service = _service(tmp_path, library=library)
    draft_id = service.store.create_draft()
    artifact_id = _add(
        service,
        draft_id,
        filename="entry.xlsx",
        origin_kind="library",
        origin_ref="library:entry-1",
        data=base,
    )
    service.store.commit_revision(
        draft_id,
        artifact_id,
        new_bytes=edited,
        base_revision=0,
        actor="user",
        operations_summary=["set_cell A1"],
        diff=None,
        verification={"reopened": True},
    )
    _add(
        service,
        draft_id,
        filename="later.xlsx",
        origin_kind="attachment",
        data=xlsx_adapter.create_generated_xlsx("Later"),
    )
    service.mark_ready(draft_id)

    def take_over_then_fail(path: Path, data: bytes):
        library.entries["entry-1"] = intruder
        raise OSError("disk full")

    monkeypatch.setattr(coordinator_module.publication, "publish_exclusive", take_over_then_fail)
    with pytest.raises(OSError, match="disk full"):
        service.merge(draft_id)

    assert library.entries["entry-1"] == intruder
    assert service.store.status(draft_id)["status"] == "ready"


def test_finalize_merge_does_not_reread_status_after_the_commit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = _service(tmp_path)
    draft_id = service.store.create_draft()
    _add(
        service,
        draft_id,
        filename="book.xlsx",
        origin_kind="attachment",
        data=xlsx_adapter.create_generated_xlsx("Data"),
    )
    service.mark_ready(draft_id)

    def forbidden_status_read(wanted: str) -> dict:
        raise AssertionError(f"post-commit status read for {wanted}")

    monkeypatch.setattr(service.store, "status", forbidden_status_read)
    outcome = service.merge(draft_id)
    monkeypatch.undo()

    assert outcome["status"] == "merged"
    assert service.store.status(draft_id)["status"] == "merged"
    assert (service.store.workspace_dir / "book.xlsx").is_file()
