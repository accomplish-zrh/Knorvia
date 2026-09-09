"""Append-only revision journal for office artifacts.

Two rules make the journal trustworthy as an audit trail:

- **Revision ids are monotonic and never reused.** They come from the
  artifact's ``revision_seq`` counter, not from ``current_revision + 1``, so
  committing on a branch that forked after an undo writes a brand-new record
  instead of overwriting the branch it abandoned.
- **Record files are written once and never modified.** Which revisions fell
  off the active branch is manifest state (``detached``), not something that
  has to be stamped into an existing record.

``<n>.json`` for ``n == 0`` never exists: revision 0 is the immutable source
bytes recorded in ``origin_base_hash``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from knorvia.services.office_artifacts.contracts import MAX_DIFF_ENTRIES

BASE_REVISION = 0


def ensure_journal(artifact: dict[str, Any]) -> None:
    """Backfill journal fields for manifests written before ids were monotonic."""
    history = _ids(artifact.get("history")) or [BASE_REVISION]
    if artifact.get("revision_seq") is None:
        artifact["revision_seq"] = max(
            [*history, *_ids(artifact.get("detached")), BASE_REVISION]
        )
    if not isinstance(artifact.get("detached"), list):
        artifact["detached"] = []


def record_ids(artifact_dir: Path) -> list[int]:
    """Revision ids already on disk, including orphans from a lost manifest write."""
    ids: list[int] = []
    for path in (artifact_dir / "revisions").glob("*.json"):
        try:
            ids.append(int(path.stem))
        except ValueError:
            continue
    return ids


def allocate_id(artifact: dict[str, Any], artifact_dir: Path | None = None) -> int:
    """Next revision id for this artifact; strictly greater than any used before.

    The manifest is not the only witness: a transaction whose record landed but
    whose manifest write was lost leaves an orphan ``<n>.json`` behind, and the
    next commit must allocate past it rather than overwrite it.
    """
    ensure_journal(artifact)
    on_disk = record_ids(artifact_dir) if artifact_dir is not None else []
    highest = max(
        [
            int(artifact.get("revision_seq") or 0),
            *_ids(artifact.get("history")),
            *_ids(artifact.get("detached")),
            *on_disk,
            BASE_REVISION,
        ]
    )
    artifact["revision_seq"] = highest + 1
    return int(artifact["revision_seq"])


def branch(artifact: dict[str, Any]) -> list[int]:
    return _ids(artifact.get("history")) or [BASE_REVISION]


def detached(artifact: dict[str, Any]) -> list[int]:
    return _ids(artifact.get("detached"))


def advance(artifact: dict[str, Any], new_revision: int) -> None:
    """Append ``new_revision`` to the active branch and park the abandoned tail."""
    history = branch(artifact)
    cursor = int(artifact.get("cursor") or 0)
    dropped = history[cursor + 1 :]
    existing = detached(artifact)
    artifact["detached"] = sorted({*existing, *[int(rev) for rev in dropped]})
    artifact["history"] = [*history[: cursor + 1], int(new_revision)]
    artifact["cursor"] = len(artifact["history"]) - 1
    artifact["current_revision"] = int(new_revision)


def record_path(artifact_dir: Path, revision: int) -> Path:
    return artifact_dir / "revisions" / f"{int(revision)}.json"


def build_record(
    *,
    revision: int,
    parent: int,
    before_hash: str,
    after_hash: str,
    created_at: str,
    actor: str,
    operations_summary: list[str],
    diff: dict[str, Any] | None,
    verification: dict[str, Any] | None,
    calculation_required: bool,
) -> dict[str, Any]:
    return {
        "revision": int(revision),
        "parent": int(parent),
        "before_hash": before_hash,
        "after_hash": after_hash,
        "created_at": created_at,
        "actor": actor,
        "operations_summary": list(operations_summary)[:200],
        "diff": clamp_diff(diff),
        "verification": verification or {},
        "calculation_required": calculation_required,
    }


def clamp_diff(diff: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(diff, dict):
        return None
    clamped = dict(diff)
    entries = clamped.get("entries")
    if isinstance(entries, list) and len(entries) > MAX_DIFF_ENTRIES:
        clamped["entries"] = entries[:MAX_DIFF_ENTRIES]
        clamped["omitted_count"] = int(clamped.get("omitted_count") or 0) + (
            len(entries) - MAX_DIFF_ENTRIES
        )
        clamped["truncated"] = True
    return clamped


def _ids(raw: Any) -> list[int]:
    if not isinstance(raw, list):
        return []
    values: list[int] = []
    for item in raw:
        try:
            values.append(int(item))
        except (TypeError, ValueError):
            continue
    return values
