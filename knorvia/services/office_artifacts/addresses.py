"""Cell-address helpers shared by the service, the diff and the agent tools.

Everything here answers one question: *which addresses does this operation
touch?* The apply path uses it to snapshot before/after values, the semantic
diff uses it to bound its scan, and ``office_apply`` uses it to check a batch
against the frozen turn selection.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from knorvia.services.office_artifacts.contracts import (
    MAX_READ_CELLS,
    InvalidOperationError,
    SetCellOp,
    SetFormulaOp,
    SetRangeOp,
    cell_name,
    column_letter,
    parse_range,
)

if TYPE_CHECKING:
    from knorvia.services.office_artifacts.adapters.xlsx_reader import XlsxReader


def merged_state(reader: XlsxReader, sheet: str, range_str: str) -> bool:
    try:
        model = reader.overview()["sheets"]
        target = next((s for s in model if s["name"] == sheet), None)
        if target is None:
            return False
        normalized = range_str.upper()
        return any(str(rng).upper() == normalized for rng in target.get("merged_ranges") or [])
    except InvalidOperationError:
        return False


def row_height(reader: XlsxReader, sheet: str, row: int) -> float | None:
    worksheet = reader._worksheet(sheet)
    dimension = worksheet.row_dimensions.get(row)
    return float(dimension.height) if dimension is not None and dimension.height else None


def col_width(reader: XlsxReader, sheet: str, column: str) -> float | None:
    worksheet = reader._worksheet(sheet)
    dimension = worksheet.column_dimensions.get(column.upper())
    return float(dimension.width) if dimension is not None and dimension.width else None


def freeze_state(reader: XlsxReader, sheet: str) -> str | None:
    worksheet = reader._worksheet(sheet)
    return str(worksheet.freeze_panes) if worksheet.freeze_panes else None


def used_bounds(reader: XlsxReader, sheet: str) -> tuple[int, int, int, int]:
    info = reader.read_range(sheet, None)
    return parse_range(str(info.get("range") or "A1:A1"))


def union_cells(before: XlsxReader, after: XlsxReader, sheet: str) -> list[str]:
    """Every address inside either revision's used range."""
    from_bounds, to_bounds = used_bounds(before, sheet), used_bounds(after, sheet)
    min_col = min(from_bounds[0], to_bounds[0])
    min_row = min(from_bounds[1], to_bounds[1])
    max_col = max(from_bounds[2], to_bounds[2])
    max_row = max(from_bounds[3], to_bounds[3])
    total = (max_col - min_col + 1) * (max_row - min_row + 1)
    if total > MAX_READ_CELLS:
        raise InvalidOperationError(
            f"{sheet} spans {total} cells across the two revisions; diffs are "
            f"limited to {MAX_READ_CELLS} cells",
        )
    return [
        cell_name(col, row)
        for row in range(min_row, max_row + 1)
        for col in range(min_col, max_col + 1)
    ]


def range_value_for(op: SetRangeOp, cell_ref: str) -> Any:
    min_col, min_row, _max_col, _max_row = parse_range(op.range)
    for r_offset, row_values in enumerate(op.rows):
        for c_offset, value in enumerate(row_values):
            if cell_name(min_col + c_offset, min_row + r_offset) == cell_ref:
                return value
    return None


def op_targets(op: Any) -> list[str]:
    """Addresses an operation writes. Empty means "not auditable by address"."""
    if isinstance(op, (SetCellOp, SetFormulaOp)):
        return [op.cell.upper()]
    range_str = getattr(op, "range", None) or getattr(op, "target_range", None)
    if range_str:
        min_col, min_row, max_col, max_row = parse_range(range_str)
        return [
            f"{column_letter(col)}{row}"
            for row in range(min_row, max_row + 1)
            for col in range(min_col, max_col + 1)
        ]
    return []


def non_conflicting(directory: Path, filename: str) -> Path:
    """A path in ``directory`` that does not shadow an existing file."""
    stem, suffix = Path(filename).stem, Path(filename).suffix
    candidate = directory / filename
    if not candidate.exists() or Path(filename).suffix.lower() == "":
        return candidate
    candidate = directory / f"{stem}_edited{suffix}"
    counter = 2
    while candidate.exists():
        candidate = directory / f"{stem}_edited-{counter}{suffix}"
        counter += 1
    return candidate
