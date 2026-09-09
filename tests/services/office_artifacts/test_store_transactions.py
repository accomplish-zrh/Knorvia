"""Revision journal + draft-lock invariants for the v2 office artifact store.

Every committed revision is an append-only audit record: ids are monotonic
and never reused, so committing after an undo may not overwrite the revision
it forked away from. Draft metadata is read-modify-written under the draft
lock, so two concurrent writers cannot lose each other's additions.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import threading

import pytest

from knorvia.services.office_artifacts import store as store_module
from knorvia.services.office_artifacts.adapters import xlsx_adapter
from knorvia.services.office_artifacts.store import OfficeArtifactStore


def _store(tmp_path: Path) -> OfficeArtifactStore:
    return OfficeArtifactStore(task_dir=tmp_path, workspace_dir=tmp_path / "exec")


def _draft_with_imported_xlsx(store: OfficeArtifactStore) -> tuple[str, str]:
    data = xlsx_adapter.create_generated_xlsx("Data")
    draft_id = store.create_draft()
    artifact_id = store.add_artifact(
        draft_id,
        filename="book.xlsx",
        mime="",
        kind="xlsx",
        origin_kind="attachment",
        origin_ref="attachment:book.xlsx",
        data=data,
        origin_base_hash=hashlib.sha256(data).hexdigest(),
    )
    return draft_id, artifact_id


def _commit(
    store: OfficeArtifactStore, draft_id: str, artifact_id: str, base: int, sheet: str
) -> dict:
    return store.commit_revision(
        draft_id,
        artifact_id,
        new_bytes=xlsx_adapter.create_generated_xlsx(sheet),
        base_revision=base,
        actor="agent",
        operations_summary=[f"set_cell A1 on {sheet}"],
        diff=None,
        verification={"reopened": True, "target_readback": True},
    )


def _revision_path(
    store: OfficeArtifactStore, draft_id: str, artifact_id: str, revision: int
) -> Path:
    return store.draft_dir(draft_id) / "artifacts" / artifact_id / "revisions" / f"{revision}.json"


def test_commit_after_undo_never_reuses_a_revision_id(tmp_path: Path) -> None:
    store = _store(tmp_path)
    draft_id, artifact_id = _draft_with_imported_xlsx(store)

    first = _commit(store, draft_id, artifact_id, 0, "One")
    second = _commit(store, draft_id, artifact_id, first["revision_after"], "Two")
    store.undo(draft_id, artifact_id)

    forked = _commit(store, draft_id, artifact_id, second["revision_before"], "Three")

    assert forked["revision_after"] != second["revision_after"]
    assert forked["revision_after"] > second["revision_after"]


def test_fork_leaves_the_abandoned_revision_record_untouched(tmp_path: Path) -> None:
    store = _store(tmp_path)
    draft_id, artifact_id = _draft_with_imported_xlsx(store)

    _commit(store, draft_id, artifact_id, 0, "One")
    second = _commit(store, draft_id, artifact_id, 1, "Two")
    abandoned = _revision_path(store, draft_id, artifact_id, second["revision_after"])
    before = abandoned.read_text(encoding="utf-8")

    store.undo(draft_id, artifact_id)
    _commit(store, draft_id, artifact_id, second["revision_before"], "Three")

    assert abandoned.read_text(encoding="utf-8") == before


def test_history_lists_the_active_branch_and_detached_revisions(tmp_path: Path) -> None:
    store = _store(tmp_path)
    draft_id, artifact_id = _draft_with_imported_xlsx(store)

    _commit(store, draft_id, artifact_id, 0, "One")
    second = _commit(store, draft_id, artifact_id, 1, "Two")
    store.undo(draft_id, artifact_id)
    forked = _commit(store, draft_id, artifact_id, second["revision_before"], "Three")

    manifest = store.manifest(draft_id, artifact_id)
    active = [int(rev) for rev in manifest.get("history") or []]
    detached = [int(rev) for rev in manifest.get("detached") or []]

    assert active == [0, 1, forked["revision_after"]]
    assert detached == [second["revision_after"]]


def test_forked_revisions_still_resolve_to_their_own_bytes(tmp_path: Path) -> None:
    store = _store(tmp_path)
    draft_id, artifact_id = _draft_with_imported_xlsx(store)

    _commit(store, draft_id, artifact_id, 0, "One")
    second = _commit(store, draft_id, artifact_id, 1, "Two")
    abandoned_bytes = store.revision_bytes(draft_id, artifact_id, second["revision_after"])

    store.undo(draft_id, artifact_id)
    _commit(store, draft_id, artifact_id, second["revision_before"], "Three")

    assert store.revision_bytes(draft_id, artifact_id, second["revision_after"]) == abandoned_bytes


def test_committed_revision_refreshes_the_legacy_mirror(tmp_path: Path) -> None:
    """``<draft>/<filename>`` remains a best-effort compatibility cache."""
    store = _store(tmp_path)
    draft_id, artifact_id = _draft_with_imported_xlsx(store)
    mirror = store.draft_dir(draft_id) / "book.xlsx"
    base_hash = hashlib.sha256(mirror.read_bytes()).hexdigest()

    edited = xlsx_adapter.create_generated_xlsx("Edited")
    store.commit_revision(
        draft_id,
        artifact_id,
        new_bytes=edited,
        base_revision=0,
        actor="agent",
        operations_summary=["set_cell A1"],
        diff=None,
        verification={"reopened": True},
    )

    edited_hash = hashlib.sha256(edited).hexdigest()
    assert hashlib.sha256(mirror.read_bytes()).hexdigest() == edited_hash

    store.undo(draft_id, artifact_id)
    assert hashlib.sha256(mirror.read_bytes()).hexdigest() == base_hash


def test_retry_after_a_lost_manifest_write_never_rewrites_a_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A revision that reached disk is permanent even if the manifest write failed."""
    store = _store(tmp_path)
    draft_id, artifact_id = _draft_with_imported_xlsx(store)
    mirror = store.draft_dir(draft_id) / "book.xlsx"
    mirror_before = mirror.read_bytes()
    real_write_json = store_module.write_json_atomic
    calls = {"meta": 0}

    def lose_the_manifest(path: Path, payload: dict, **kwargs: bool) -> None:
        if path.name == "meta.json":
            calls["meta"] += 1
            if calls["meta"] == 1:
                raise OSError("simulated os.replace failure")
        real_write_json(path, payload, **kwargs)

    monkeypatch.setattr(store_module, "write_json_atomic", lose_the_manifest)
    abandoned = xlsx_adapter.create_generated_xlsx("Abandoned")
    with pytest.raises(OSError):
        store.commit_revision(
            draft_id,
            artifact_id,
            new_bytes=abandoned,
            base_revision=0,
            actor="agent",
            operations_summary=["set_cell A1"],
            diff=None,
            verification={"reopened": True},
        )
    assert mirror.read_bytes() == mirror_before
    monkeypatch.undo()

    retried = _commit(store, draft_id, artifact_id, 0, "Retried")

    orphan = [
        path
        for path in (store.draft_dir(draft_id) / "artifacts" / artifact_id / "revisions").glob(
            "*.json"
        )
        if path.name != f"{retried['revision_after']}.json"
    ]
    assert orphan, "the revision that landed before the failure has no record"
    record = json.loads(orphan[0].read_text(encoding="utf-8"))
    assert record["after_hash"] == hashlib.sha256(abandoned).hexdigest()
    assert retried["revision_after"] != record["revision"]


def test_mirror_failure_cannot_uncommit_a_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = _store(tmp_path)
    draft_id, artifact_id = _draft_with_imported_xlsx(store)
    mirror = store.draft_dir(draft_id) / "book.xlsx"
    mirror_before = mirror.read_bytes()
    edited = xlsx_adapter.create_generated_xlsx("Edited")
    real_atomic_write = store_module.atomic_write

    def fail_only_the_mirror(path: Path, data: bytes) -> None:
        if path == mirror:
            raise OSError("mirror disk full")
        real_atomic_write(path, data)

    monkeypatch.setattr(store_module, "atomic_write", fail_only_the_mirror)
    committed = store.commit_revision(
        draft_id,
        artifact_id,
        new_bytes=edited,
        base_revision=0,
        actor="agent",
        operations_summary=["set_cell A1"],
        diff=None,
        verification={"reopened": True},
    )

    assert committed["revision_after"] == 1
    assert store.current_bytes(draft_id, artifact_id) == edited
    assert mirror.read_bytes() == mirror_before


def test_two_first_reads_migrate_one_v1_artifact_without_an_orphan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = _store(tmp_path)
    draft_id = "c0ffee00"
    draft_root = store.draft_dir(draft_id)
    draft_root.mkdir(parents=True)
    (draft_root / "book.xlsx").write_bytes(xlsx_adapter.create_generated_xlsx("Legacy"))
    (draft_root / "meta.json").write_text(
        json.dumps(
            {
                "draft_id": draft_id,
                "status": "ready",
                "files": ["book.xlsx"],
                "created_at": "2026-01-01T00:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )

    both_saw_v1 = threading.Barrier(2, timeout=5)
    real_migrate = OfficeArtifactStore._migrate_v1

    def migrate_together(self, wanted: str, legacy: dict) -> None:
        both_saw_v1.wait()
        real_migrate(self, wanted, legacy)

    monkeypatch.setattr(OfficeArtifactStore, "_migrate_v1", migrate_together)
    results: list[dict] = []
    errors: list[Exception] = []

    def load() -> None:
        try:
            results.append(store.status(draft_id))
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=load), threading.Thread(target=load)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)

    assert not errors
    assert len(results) == 2
    assert results[0]["artifacts"][0]["artifact_id"] == results[1]["artifacts"][0]["artifact_id"]
    artifact_dirs = list((draft_root / "artifacts").iterdir())
    assert len(artifact_dirs) == 1


def test_concurrent_add_artifact_keeps_both_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The metadata read must be inside the lock that guards the write."""
    store = _store(tmp_path)
    draft_id = store.create_draft()

    # Both threads park here after reading meta.json but before writing it,
    # which is exactly the window a stale read escapes through.
    both_have_read = threading.Barrier(2, timeout=2)
    real_write_blob = OfficeArtifactStore._write_blob

    def parked_write_blob(self, blob_dir, blob_hash, filename, data):
        try:
            both_have_read.wait()
        except threading.BrokenBarrierError:
            pass
        return real_write_blob(self, blob_dir, blob_hash, filename, data)

    monkeypatch.setattr(OfficeArtifactStore, "_write_blob", parked_write_blob)

    added: list[str] = []
    lock = threading.Lock()

    def add(name: str) -> None:
        artifact_id = store.add_artifact(
            draft_id,
            filename=name,
            mime="",
            kind="xlsx",
            origin_kind="attachment",
            origin_ref=f"attachment:{name}",
            data=xlsx_adapter.create_generated_xlsx(name.partition(".")[0]),
        )
        with lock:
            added.append(artifact_id)

    threads = [
        threading.Thread(target=add, args=("first.xlsx",)),
        threading.Thread(target=add, args=("second.xlsx",)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)

    assert len(added) == 2
    names = sorted(a["filename"] for a in store.status(draft_id)["artifacts"])
    assert names == ["first.xlsx", "second.xlsx"]
