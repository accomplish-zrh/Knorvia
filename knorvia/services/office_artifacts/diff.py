"""Format-agnostic semantic diff envelope + XLSX cell snapshots.

A diff is built from before/after read-model snapshots of exactly the cells,
merges, dimensions and freeze settings a transaction touched — never from
file size or mtime.
"""

from __future__ import annotations

from typing import Any

from knorvia.services.office_artifacts.contracts import (
    MAX_DIFF_ENTRIES,
    DiffEntry,
    SemanticDiff,
)


def cell_snapshot(cell: Any) -> dict[str, Any]:
    """Normalize one openpyxl-style cell into the diff read model."""
    value = getattr(cell, "value", None)
    formula = ""
    if isinstance(value, str) and value.startswith("="):
        formula = value
    return {
        "value": None if formula else _jsonable(value),
        "formula": formula,
        "style_id": str(getattr(cell, "style_id", "") or "" if hasattr(cell, "style_id") else ""),
    }


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value
    return str(value)


def build_semantic_diff(entries: list[DiffEntry]) -> SemanticDiff:
    """Apply the diff size budget deterministically."""
    if len(entries) <= MAX_DIFF_ENTRIES:
        return SemanticDiff(entries=entries, omitted_count=0, truncated=False)
    kept = entries[:MAX_DIFF_ENTRIES]
    return SemanticDiff(
        entries=kept,
        omitted_count=len(entries) - MAX_DIFF_ENTRIES,
        truncated=True,
    )


def diff_entries_from_snapshots(
    sheet: str,
    before: dict[str, dict[str, Any]],
    after: dict[str, dict[str, Any]],
) -> list[DiffEntry]:
    """Cell-level entries from {a1: snapshot} maps of the touched targets."""
    entries: list[DiffEntry] = []
    for target in sorted(set(before) | set(after)):
        old = before.get(target) or {}
        new = after.get(target) or {}
        if old == new:
            continue
        entries.append(
            DiffEntry(
                sheet=sheet,
                kind="cell",
                target=target,
                before=old,
                after=new,
            )
        )
    return entries
