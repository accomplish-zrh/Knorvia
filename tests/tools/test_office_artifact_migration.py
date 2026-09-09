"""v1 → v2 in-place migration coverage for the office artifact store."""

from __future__ import annotations

import json
from pathlib import Path

from knorvia.services.office_artifacts.adapters import xlsx_adapter
from knorvia.services.office_artifacts.store import OfficeArtifactStore
from knorvia.services.office_draft import OfficeDraftStore


def test_v1_draft_migrates_in_place_and_stays_operational(tmp_path: Path) -> None:
    legacy = OfficeDraftStore(tmp_path, workspace_dir=tmp_path / "exec")
    draft_id = legacy.create()
    data = xlsx_adapter.create_generated_xlsx("Data")
    (legacy.draft_dir(draft_id) / "report.xlsx").write_bytes(data)
    legacy.note_file(draft_id, "report.xlsx")

    store = OfficeArtifactStore(task_dir=tmp_path, workspace_dir=tmp_path / "exec")
    meta = store.status(draft_id)

    on_disk = json.loads(
        (store.draft_dir(draft_id) / "meta.json").read_text(encoding="utf-8")
    )
    assert on_disk["schema_version"] == 2
    assert len(meta["artifacts"]) == 1
    artifact = meta["artifacts"][0]
    assert artifact["origin_kind"] == "v1_migration"
    assert artifact["filename"] == "report.xlsx"
    assert store.current_bytes(draft_id, artifact["artifact_id"]) == data

    commit = store.commit_revision(
        draft_id,
        artifact["artifact_id"],
        new_bytes=xlsx_adapter.create_generated_xlsx("Edited"),
        base_revision=0,
        actor="user",
        operations_summary=["post-migration edit"],
        diff=None,
        verification={
            "reopened": True,
            "target_readback": True,
            "zip_structure_valid": True,
            "untouched_parts_verified": True,
        },
    )
    assert commit["revision_after"] == 1
