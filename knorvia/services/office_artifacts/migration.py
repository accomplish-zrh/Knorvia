"""v1 → v2 draft migration.

A v1 draft was a flat list of file names in ``meta.json`` plus whatever files
happened to sit in the draft directory. Converting one lives here rather than
in ``store.py`` because it is the only place the runtime reads that legacy
layout, and its file-list rule is subtle: v1 recorded files lazily (the
directory scan was its read-time source of truth), so ``meta["files"]`` alone
silently misses files. The migration must union the recorded list with a scan.

Each migrated file becomes an artifact at revision 0 whose blob is the file
itself, tagged ``origin_kind="v1_migration"`` — which is also what tells the
merge coordinator it may publish by name, the way the v1 store did.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable
import uuid

from knorvia.services.office_artifacts import revisions
from knorvia.services.office_artifacts.store_io import (
    LOCK_NAME,
    META_NAME,
    SCHEMA_VERSION,
    coerce_status,
    dir_lock,
    kind_of,
    safe_component,
    safe_under_root,
    sha256_of,
    utcnow,
    validate_draft_id,
    write_json_atomic,
)

WriteBlob = Callable[[Path, str, str, bytes], None]


def migrate_v1_draft(
    draft_root: Path,
    draft_id: str,
    legacy: dict[str, Any],
    write_blob: WriteBlob,
) -> None:
    """Rewrite ``<draft>/meta.json`` in v2 shape, in place and under the lock."""
    with dir_lock(draft_root / LOCK_NAME):
        meta_path = draft_root / META_NAME
        try:
            current = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            current = legacy
        if isinstance(current, dict) and int(current.get("schema_version") or 1) >= SCHEMA_VERSION:
            return
        source_meta = current if isinstance(current, dict) else legacy
        artifacts: list[dict[str, Any]] = []
        names = [name for name in (source_meta.get("files") or []) if isinstance(name, str)]
        if draft_root.is_dir():
            for entry in sorted(draft_root.iterdir()):
                if not entry.is_file() or entry.name in (META_NAME, LOCK_NAME):
                    continue
                rel = entry.relative_to(draft_root).as_posix()
                if rel not in names:
                    names.append(rel)
        for name in names:
            source = safe_under_root(draft_root, name)
            if not source.is_file():
                continue
            data = source.read_bytes()
            digest = sha256_of(data)
            artifact_id = uuid.uuid4().hex[:8]
            write_blob(draft_root / "artifacts" / artifact_id / "blobs", digest, name, data)
            artifacts.append(
                {
                    "artifact_id": artifact_id,
                    "filename": safe_component(name),
                    "mime": "",
                    "kind": kind_of(name),
                    "origin_kind": "v1_migration",
                    "origin_ref": f"v1:{name}",
                    "origin_base_hash": digest,
                    "current_revision": revisions.BASE_REVISION,
                    "history": [revisions.BASE_REVISION],
                    "cursor": 0,
                    "revision_seq": revisions.BASE_REVISION,
                    "detached": [],
                    "created_at": utcnow(),
                    "updated_at": utcnow(),
                }
            )
        migrated = {
            "schema_version": SCHEMA_VERSION,
            "draft_id": validate_draft_id(draft_id),
            "status": coerce_status(source_meta.get("status")),
            "artifacts": artifacts,
            "created_at": str(source_meta.get("created_at") or utcnow()),
            "updated_at": utcnow(),
        }
        write_json_atomic(draft_root / META_NAME, migrated)
