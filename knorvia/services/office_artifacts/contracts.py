"""Type-safe contracts for the Office artifact runtime (v2).

Everything the model (or a human via the API) submits is parsed through the
Pydantic v2 discriminated unions in this module. Every model uses
``extra="forbid"`` so an unexpected field is a hard validation error instead
of silent acceptance, and every limit lives here — no magic numbers in the
adapters or the service.
"""

from __future__ import annotations

from datetime import date, datetime
import math
import re
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

# --------------------------------------------------------------------------
# Limits — the single source of truth for every budget in the runtime.
# --------------------------------------------------------------------------

MAX_BATCH_OPERATIONS = 200
MAX_TOUCHED_CELLS = 20_000
MAX_READ_CELLS = 2_000
MAX_CELL_CHARS = 32_767
MAX_SHEETNAME_CHARS = 31
MAX_SHEET_ROWS = 1_048_576
MAX_SHEET_COLS = 16_384
MAX_DIFF_ENTRIES = 500
MAX_RANGE_HITS = 200
MAX_ROW_HEIGHT = 409.0
MAX_COLUMN_WIDTH = 255.0

_A1_CELL = re.compile(r"^([A-Za-z]{1,3})([0-9]{1,7})$")
_A1_RANGE = re.compile(r"^([A-Za-z]{1,3})([0-9]{1,7})(?::([A-Za-z]{1,3})([0-9]{1,7}))?$")
_COLUMN_LETTERS = re.compile(r"^[A-Za-z]{1,3}$")

SOURCE_KINDS = ("generated", "attachment", "library", "workspace")
OFFICE_SUFFIXES = (".xlsx", ".xlsm", ".docx", ".pptx")


def normalize_client_selection(value: Any) -> dict[str, Any]:
    """Whitelist a client-supplied spreadsheet selection.

    Used where a selection is frozen (turn start) and where it is enforced
    (``office_apply``), so every entry point accepts exactly the same keys and
    a hostile payload cannot smuggle extra fields into tool kwargs.
    """
    if not isinstance(value, dict):
        return {}
    selection: dict[str, Any] = {}
    for key in ("draft_id", "artifact_id", "sheet", "range"):
        text = str(value.get(key) or "").strip()
        if text:
            selection[key] = text
    revision = value.get("revision")
    if isinstance(revision, int) and not isinstance(revision, bool):
        selection["revision"] = revision
    return selection


class OfficeArtifactError(Exception):
    """Base error; ``code`` is machine-readable, ``reason`` a stable slug."""

    code = "office_error"
    http_status = 500

    def __init__(self, message: str, *, reason: str = "") -> None:
        super().__init__(message)
        self.reason = reason or self.__class__.__name__


class ArtifactNotFoundError(OfficeArtifactError):
    code = "artifact_not_found"
    http_status = 404


class DraftStateError(OfficeArtifactError):
    """Terminal drafts refuse writes; illegal lifecycle transitions."""

    code = "draft_state"
    http_status = 409


class RevisionConflictError(OfficeArtifactError):
    """CAS failure: caller's base_revision is not the current revision."""

    code = "revision_conflict"
    http_status = 409

    def __init__(self, message: str, *, current_revision: int | None = None) -> None:
        super().__init__(message, reason="stale_revision")
        self.current_revision = current_revision


class InvalidOperationError(OfficeArtifactError):
    code = "invalid_operation"
    http_status = 422


class UnsupportedOperationError(OfficeArtifactError):
    """Fail-closed: the runtime refuses what it cannot prove faithful."""

    code = "unsupported_operation"
    http_status = 422


class SourceResolutionError(OfficeArtifactError):
    code = "source_unresolvable"
    http_status = 404


class SourceVerificationError(OfficeArtifactError):
    """A source file failed ZIP/OOXML safety screening."""

    code = "source_unsafe"
    http_status = 422


class VerificationError(OfficeArtifactError):
    """Post-mutation verification failed; the revision is not advanced."""

    code = "verification_failed"
    http_status = 422


class MergeConflictError(OfficeArtifactError):
    """Merge CAS failure: the origin content changed since open."""

    code = "merge_conflict"
    http_status = 409


# --------------------------------------------------------------------------
# A1 helpers — shared by contracts, adapters, readers and the service.
# --------------------------------------------------------------------------


def column_letter(index: int) -> str:
    """1-based column index to Excel letters (1 -> A, 27 -> AA)."""
    if not 1 <= index <= MAX_SHEET_COLS:
        raise InvalidOperationError(f"column index {index} out of range 1-{MAX_SHEET_COLS}")
    letters = ""
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(ord("A") + rem) + letters
    return letters


def column_index(letters: str) -> int:
    value = 0
    for ch in letters.upper():
        value = value * 26 + (ord(ch) - ord("A") + 1)
    return value


def parse_cell(cell: str) -> tuple[int, int]:
    """``B3`` -> (column 2, row 3), bounds-checked, uppercase normalised."""
    match = _A1_CELL.fullmatch(str(cell or "").strip().upper())
    if not match:
        raise InvalidOperationError(f"invalid cell address {cell!r}; use A1-style addresses")
    col = column_index(match.group(1))
    row = int(match.group(2))
    if not 1 <= row <= MAX_SHEET_ROWS:
        raise InvalidOperationError(f"row {row} out of range 1-{MAX_SHEET_ROWS}")
    if not 1 <= col <= MAX_SHEET_COLS:
        raise InvalidOperationError(f"column {match.group(1)} out of range")
    return col, row


def cell_name(col: int, row: int) -> str:
    return f"{column_letter(col)}{row}"


def parse_range(range_str: str) -> tuple[int, int, int, int]:
    """``A1`` or ``A1:C4`` -> (min_col, min_row, max_col, max_row), normalised."""
    raw = str(range_str or "").strip().upper()
    match = _A1_RANGE.fullmatch(raw)
    if not match:
        raise InvalidOperationError(
            f"invalid range {range_str!r}; use A1 or A1:C4 (no $ anchors)"
        )
    c1, r1 = column_index(match.group(1)), int(match.group(2))
    c2, r2 = (
        column_index(match.group(3)),
        int(match.group(4)),
    ) if match.group(3) else (c1, r1)
    if not (1 <= r1 <= MAX_SHEET_ROWS and 1 <= r2 <= MAX_SHEET_ROWS):
        raise InvalidOperationError(f"range {range_str!r} exceeds row bounds")
    if not (1 <= c1 <= MAX_SHEET_COLS and 1 <= c2 <= MAX_SHEET_COLS):
        raise InvalidOperationError(f"range {range_str!r} exceeds column bounds")
    return min(c1, c2), min(r1, r2), max(c1, c2), max(r1, r2)


def range_cell_count(range_str: str) -> int:
    min_col, min_row, max_col, max_row = parse_range(range_str)
    return (max_col - min_col + 1) * (max_row - min_row + 1)


def validate_sheet_name(name: str) -> str:
    value = str(name or "").strip()
    if not value:
        raise InvalidOperationError("sheet name is required")
    if re.search(r"[:\\/?*\[\]]", value) or value.startswith("'"):
        raise InvalidOperationError(f"invalid sheet name {name!r}")
    if len(value) > MAX_SHEETNAME_CHARS:
        raise InvalidOperationError("sheet name must be 31 characters or fewer")
    return value


def validate_formula(formula: str) -> str:
    text = str(formula or "").strip()
    if not text.startswith("="):
        raise InvalidOperationError(
            "formula must start with '='; write plain text with set_cell"
        )
    if len(text) > MAX_CELL_CHARS:
        raise InvalidOperationError("formula exceeds 32767 characters")
    return text


# --------------------------------------------------------------------------
# Results envelope — what every mutation returns to tools, API and UI.
# --------------------------------------------------------------------------


class DiffEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sheet: str
    kind: Literal["cell", "merge", "dimension", "freeze", "sheet"]
    target: str
    before: dict[str, Any] = Field(default_factory=dict)
    after: dict[str, Any] = Field(default_factory=dict)


class SemanticDiff(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entries: list[DiffEntry] = Field(default_factory=list)
    omitted_count: int = 0
    truncated: bool = False


class VerificationSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reopened: bool = False
    target_readback: bool = False
    zip_structure_valid: bool = False
    untouched_parts_verified: bool = False
    allowed_changed_parts: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class ApplyBatchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mutated: bool
    artifact_id: str
    filename: str
    revision_before: int
    revision_after: int
    touched_cells: int
    diff: SemanticDiff
    verification: VerificationSummary
    calculation_required: bool = False


class ArtifactSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifact_id: str
    filename: str
    mime: str
    kind: Literal["xlsx", "docx", "pptx", "univer"]
    origin_kind: str
    origin_ref: str
    origin_base_hash: str
    current_revision: int | None
    current_hash: str
    created: bool = False


# --------------------------------------------------------------------------
# Source references — opaque ids only; never local paths or user ids.
# --------------------------------------------------------------------------


class SourceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["generated", "attachment", "library", "workspace"]
    opaque_id: str = ""

    @property
    def as_string(self) -> str:
        return f"{self.kind}:{self.opaque_id}" if self.opaque_id else f"{self.kind}:new"


def parse_source_ref(raw: str) -> SourceRef:
    text = str(raw or "").strip()
    kind, sep, opaque = text.partition(":")
    if sep and kind in ("attachment", "library", "workspace") and opaque.strip():
        return SourceRef(kind=kind, opaque_id=opaque.strip())
    if text in ("generated:new", "generated", "new", ""):
        return SourceRef(kind="generated", opaque_id="")
    raise InvalidOperationError(
        f"invalid source {raw!r}; use generated:new | attachment:<id> | "
        "library:<entry-id> | workspace:<opaque-ref>"
    )


# --------------------------------------------------------------------------
# Operations — the strict discriminated union (op tag, extra="forbid").
# --------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SetCellOp(_Strict):
    op: Literal["set_cell"]
    sheet: str
    cell: str
    text: str | None = None
    number: float | None = None
    boolean: bool | None = None
    value_date: date | None = None
    value_datetime: datetime | None = None
    empty: bool | None = None

    @model_validator(mode="after")
    def _exactly_one_value(self) -> SetCellOp:
        provided = [
            name
            for name in ("text", "number", "boolean", "value_date", "value_datetime", "empty")
            if getattr(self, name) is not None
        ]
        if len(provided) != 1:
            raise InvalidOperationError(
                f"set_cell {self.cell}: exactly one of text/number/boolean/date/"
                "datetime/empty is required"
            )
        if self.text is not None:
            if self.text.startswith("="):
                raise InvalidOperationError(
                    f"set_cell {self.cell}: text starting with '=' is a formula; "
                    "use the set_formula operation"
                )
            if len(self.text) > MAX_CELL_CHARS:
                raise InvalidOperationError(f"set_cell {self.cell}: text exceeds 32767 chars")
        if self.number is not None and not math.isfinite(self.number):
            raise InvalidOperationError(
                f"set_cell {self.cell}: number must be finite (no NaN/Infinity)"
            )
        return self


class SetFormulaOp(_Strict):
    op: Literal["set_formula"]
    sheet: str
    cell: str
    formula: str

    @model_validator(mode="after")
    def _formula_shape(self) -> SetFormulaOp:
        validate_formula(self.formula)
        return self


class ClearCellsOp(_Strict):
    op: Literal["clear_cells"]
    sheet: str
    range: str


class SetRangeOp(_Strict):
    op: Literal["set_range"]
    sheet: str
    range: str
    rows: list[list[Union[str, int, float, bool, None]]]

    @model_validator(mode="after")
    def _shape_and_values(self) -> SetRangeOp:
        if not self.rows:
            raise InvalidOperationError("set_range rows must not be empty")
        min_col, min_row, max_col, max_row = parse_range(self.range)
        height, width = max_row - min_row + 1, max_col - min_col + 1
        if len(self.rows) != height:
            raise InvalidOperationError(
                f"set_range {self.range}: expected {height} row(s), got {len(self.rows)}"
            )
        for r_idx, row in enumerate(self.rows):
            if len(row) != width:
                raise InvalidOperationError(
                    f"set_range {self.range}: row {r_idx + 1} has {len(row)} value(s), "
                    f"expected {width}"
                )
            for value in row:
                if isinstance(value, float) and not math.isfinite(value):
                    raise InvalidOperationError(
                        f"set_range {self.range}: numbers must be finite"
                    )
                if isinstance(value, str):
                    if value.startswith("="):
                        raise InvalidOperationError(
                            f"set_range {self.range}: '=' strings are formulas; "
                            "use set_formula per cell"
                        )
                    if len(value) > MAX_CELL_CHARS:
                        raise InvalidOperationError(
                            f"set_range {self.range}: text exceeds 32767 chars"
                        )
        return self


class CopyStyleOp(_Strict):
    op: Literal["copy_style"]
    sheet: str
    source_cell: str
    target_range: str


class MergeCellsOp(_Strict):
    op: Literal["merge_cells"]
    sheet: str
    range: str


class UnmergeCellsOp(_Strict):
    op: Literal["unmerge_cells"]
    sheet: str
    range: str


class SetRowHeightOp(_Strict):
    op: Literal["set_row_height"]
    sheet: str
    row: int = Field(ge=1, le=MAX_SHEET_ROWS)
    height: float = Field(ge=0, le=MAX_ROW_HEIGHT)


class SetColumnWidthOp(_Strict):
    op: Literal["set_column_width"]
    sheet: str
    column: str
    width: float = Field(ge=0, le=MAX_COLUMN_WIDTH)

    @model_validator(mode="after")
    def _column_shape(self) -> SetColumnWidthOp:
        if not _COLUMN_LETTERS.fullmatch(str(self.column or "").strip().upper()):
            raise InvalidOperationError(
                f"set_column_width: column must be Excel letters, got {self.column!r}"
            )
        self.column = self.column.strip().upper()
        if column_index(self.column) > MAX_SHEET_COLS:
            raise InvalidOperationError(f"column {self.column} out of range")
        return self


class FreezePanesOp(_Strict):
    op: Literal["freeze_panes"]
    sheet: str
    cell: str | None = None  # None = unfreeze

    @model_validator(mode="after")
    def _cell_shape(self) -> FreezePanesOp:
        if self.cell is not None:
            parse_cell(self.cell)
        return self


Operation = Annotated[
    Union[
        SetCellOp,
        SetFormulaOp,
        ClearCellsOp,
        SetRangeOp,
        CopyStyleOp,
        MergeCellsOp,
        UnmergeCellsOp,
        SetRowHeightOp,
        SetColumnWidthOp,
        FreezePanesOp,
    ],
    Field(discriminator="op"),
]


def touched_cell_count(op: Any) -> int:
    """Cells one operation touches, for the batch budget."""
    if isinstance(op, (SetCellOp, SetFormulaOp)):
        return 1
    if isinstance(op, (ClearCellsOp, SetRangeOp, MergeCellsOp, UnmergeCellsOp)):
        return range_cell_count(op.range)
    if isinstance(op, CopyStyleOp):
        return range_cell_count(op.target_range)
    return 1


def parse_operations(raw: Any) -> list[Any]:
    """Parse and budget-check a batch of raw operation dicts."""
    from pydantic import TypeAdapter

    if not isinstance(raw, list) or not raw:
        raise InvalidOperationError("operations must be a non-empty list")
    if len(raw) > MAX_BATCH_OPERATIONS:
        raise InvalidOperationError(
            f"batch has {len(raw)} operations; the limit is {MAX_BATCH_OPERATIONS}"
        )
    adapter = TypeAdapter(list[Operation])
    try:
        operations = adapter.validate_python(raw)
    except Exception as exc:
        raise InvalidOperationError(f"operation validation failed: {exc}") from exc
    total = sum(touched_cell_count(op) for op in operations)
    if total > MAX_TOUCHED_CELLS:
        raise InvalidOperationError(
            f"batch touches {total} cells; the limit is {MAX_TOUCHED_CELLS}"
        )
    return operations


class ApplyBatchRequest(_Strict):
    """One atomic transaction: all operations or none."""

    artifact_id: str
    base_revision: int = Field(ge=0)
    operations: list[Operation]
    actor: Literal["agent", "human"] = "agent"


class OpenSourceRequest(_Strict):
    source: str
    filename: str | None = None
