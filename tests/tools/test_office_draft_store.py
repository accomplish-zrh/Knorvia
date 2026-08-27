"""State-machine coverage for ``OfficeDraftStore``."""

from __future__ import annotations

from pathlib import Path

import pytest

from knorvia.services.office_draft import (
    DraftNotFoundError,
    DraftTransitionError,
    OfficeDraftStore,
    validate_draft_id,
)


def _store(tmp_path: Path) -> OfficeDraftStore:
    workspace = tmp_path / "exec"
    workspace.mkdir(parents=True, exist_ok=True)
    return OfficeDraftStore(tmp_path, workspace_dir=workspace, public_root=tmp_path)


def test_validate_draft_id_rejects_garbage() -> None:
    with pytest.raises(Exception):
        validate_draft_id("../ab")
    with pytest.raises(Exception):
        validate_draft_id("short")
    assert len(validate_draft_id("abcd1234")) == 8


def test_create_status_ready_merge_round_trip(tmp_path: Path) -> None:
    store = _store(tmp_path)
    (store.workspace_dir / "seed.xlsx").write_bytes(b"old")
    draft_id = store.create(["seed.xlsx"])
    assert store.status(draft_id)["status"] == "draft"
    draft_file = store.draft_dir(draft_id) / "seed.xlsx"
    assert draft_file.read_bytes() == b"old"
    draft_file.write_bytes(b"new")
    store.note_file(draft_id, "seed.xlsx")
    store.mark_ready(draft_id)
    assert store.status(draft_id)["status"] == "ready"
    store.merge(draft_id)
    assert store.status(draft_id)["status"] == "merged"
    assert (store.workspace_dir / "seed.xlsx").read_bytes() == b"new"


def test_merge_overwrites_official_file(tmp_path: Path) -> None:
    store = _store(tmp_path)
    (store.workspace_dir / "report.xlsx").write_bytes(b"official-old")
    draft_id = store.create()
    (store.draft_dir(draft_id) / "report.xlsx").write_bytes(b"draft-new")
    store.note_file(draft_id, "report.xlsx")
    store.mark_ready(draft_id)
    store.merge(draft_id)
    assert (store.workspace_dir / "report.xlsx").read_bytes() == b"draft-new"


def test_illegal_draft_to_merged_then_direct_discard(tmp_path: Path) -> None:
    store = _store(tmp_path)
    draft_id = store.create()
    (store.draft_dir(draft_id) / "a.xlsx").write_bytes(b"x")
    store.note_file(draft_id, "a.xlsx")
    with pytest.raises(DraftTransitionError, match="merged"):
        store.merge(draft_id)
    store.discard(draft_id)
    assert store.status(draft_id)["status"] == "discarded"
    with pytest.raises(DraftTransitionError):
        store.mark_ready(draft_id)
    with pytest.raises(DraftTransitionError):
        store.merge(draft_id)


def test_ready_can_be_discarded(tmp_path: Path) -> None:
    store = _store(tmp_path)
    draft_id = store.create()
    store.mark_ready(draft_id)
    store.discard(draft_id)
    assert store.status(draft_id)["status"] == "discarded"


def test_merged_refuses_further_writes(tmp_path: Path) -> None:
    store = _store(tmp_path)
    draft_id = store.create()
    (store.draft_dir(draft_id) / "a.xlsx").write_bytes(b"x")
    store.note_file(draft_id, "a.xlsx")
    store.mark_ready(draft_id)
    store.merge(draft_id)
    with pytest.raises(DraftTransitionError, match="refused"):
        store.assert_writable(draft_id)
    with pytest.raises(DraftTransitionError):
        store.note_file(draft_id, "b.xlsx")


def test_status_unknown_id(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with pytest.raises(DraftNotFoundError):
        store.status("deadbeef")


def test_diff_lists_size_and_mtime(tmp_path: Path) -> None:
    store = _store(tmp_path)
    draft_id = store.create()
    (store.draft_dir(draft_id) / "a.xlsx").write_bytes(b"abc")
    store.note_file(draft_id, "a.xlsx")
    rows = store.diff(draft_id)
    assert len(rows) == 1
    assert rows[0]["name"] == "a.xlsx"
    assert rows[0]["draft_size"] == 3
    assert rows[0]["exists_in_workspace"] is False


def test_locate_finds_registered_draft(tmp_path: Path) -> None:
    chat = tmp_path / "workspace" / "chat" / "chat" / "turn-1"
    chat.mkdir(parents=True)
    store = OfficeDraftStore(
        chat,
        workspace_dir=chat / "exec",
        public_root=tmp_path,
    )
    draft_id = store.create()
    found = OfficeDraftStore.locate(
        draft_id, public_root=tmp_path, chat_root=tmp_path / "workspace" / "chat"
    )
    assert found.status(draft_id)["draft_id"] == draft_id


def test_card_payload_includes_files(tmp_path: Path) -> None:
    store = _store(tmp_path)
    draft_id = store.create()
    (store.draft_dir(draft_id) / "grid.xlsx").write_bytes(b"PK")
    store.note_file(draft_id, "grid.xlsx")
    payload = store.card_payload(draft_id)
    assert payload["draft_id"] == draft_id
    assert payload["draft_status"] == "draft"
    assert payload["office_draft"]["files"][0]["name"] == "grid.xlsx"
