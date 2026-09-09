"""``office_apply`` — deferred, strictly-typed batch mutation tool.

One call = one atomic transaction on one artifact at one base revision:
parse (extra fields forbidden) → apply → verify (reopen / read-back /
ZIP structure / untouched OOXML parts) → commit. Any failure leaves the
current revision untouched. A frozen turn selection (injected server-side)
constrains where the batch may write.
"""

from __future__ import annotations

from typing import Any

from knorvia.core.tool_protocol import BaseTool, ToolDefinition, ToolParameter, ToolResult
from knorvia.services.office_artifacts.addresses import op_targets
from knorvia.services.office_artifacts.contracts import (
    FreezePanesOp,
    InvalidOperationError,
    SetColumnWidthOp,
    SetRowHeightOp,
    column_index,
    parse_cell,
    parse_range,
)
from knorvia.tools.office_artifact import (
    build_office_service,
    result_from_payload,
    tool_error_result,
)


def _check_frozen_selection(
    selection: dict[str, Any] | None,
    draft_id: str,
    artifact_id: str,
    current_revision: int,
    operations: list[Any],
) -> None:
    """Fail closed when the batch drifts outside the selection frozen at
    send time, or is based on a revision older than the frozen one."""
    if not isinstance(selection, dict) or not selection:
        return
    selected_draft = str(selection.get("draft_id") or "")
    if selected_draft and selected_draft != draft_id:
        raise InvalidOperationError(
            "the user's frozen selection belongs to office draft "
            f"{selected_draft!r}, not {draft_id!r}; work in that draft or ask "
            "the user to reselect before writing anywhere else"
        )
    selected_artifact = str(selection.get("artifact_id") or "")
    if selected_artifact and selected_artifact != artifact_id:
        raise InvalidOperationError(
            "the user's frozen selection targets a different artifact; "
            f"open {selected_artifact!r} or ask the user to reselect"
        )
    frozen_revision = selection.get("revision")
    if frozen_revision is not None and int(frozen_revision) != int(current_revision):
        raise InvalidOperationError(
            f"the frozen selection is at revision {frozen_revision} but the "
            f"artifact is at {current_revision}; re-read with office_read "
            "before applying",
        )
    sheet = str(selection.get("sheet") or "").strip()
    range_str = str(selection.get("range") or "").strip()
    if not sheet and not range_str:
        return
    bounds = parse_range(range_str) if range_str else None
    for op in operations:
        if str(getattr(op, "sheet", "") or "") != sheet:
            raise InvalidOperationError(
                f"operation targets sheet {getattr(op, 'sheet', '')!r} outside "
                f"the frozen selection sheet {sheet!r}"
            )
        violation = _selection_violation(op, bounds)
        if violation:
            raise InvalidOperationError(
                f"operation {getattr(op, 'op', type(op).__name__)} targets "
                f"{violation}, outside the frozen selection "
                f"{range_str or sheet + '!'}; ask the user to reselect"
            )


def _selection_violation(op: Any, bounds: tuple[int, int, int, int] | None) -> str | None:
    """Return where this operation writes when that is outside the selection.

    ``None`` bounds mean the user pinned a sheet without a range, so the sheet
    check is the whole constraint. Anything this function cannot audit has to
    be reported rather than waved through.
    """
    if bounds is None:
        return None
    min_col, min_row, max_col, max_row = bounds

    def outside(col: int, row: int) -> bool:
        return not (min_col <= col <= max_col and min_row <= row <= max_row)

    if isinstance(op, SetRowHeightOp):
        return None if min_row <= op.row <= max_row else f"row {op.row}"
    if isinstance(op, SetColumnWidthOp):
        col = column_index(op.column)
        return None if min_col <= col <= max_col else f"column {op.column}"
    if isinstance(op, FreezePanesOp):
        if op.cell is None:
            return "a sheet-wide freeze reset"
        col, row = parse_cell(op.cell)
        return None if not outside(col, row) else f"freeze anchor {op.cell.upper()}"

    targets = op_targets(op)
    if not targets:
        return f"{getattr(op, 'op', type(op).__name__)} has no auditable target"
    for target in targets:
        col, row = parse_cell(target)
        if outside(col, row):
            return target
    return None


class OfficeApplyTool(BaseTool):
    deferred = True  # progressive disclosure via load_tools

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="office_apply",
            description=(
                "Apply ONE atomic batch of strictly-typed operations to an "
                "XLSX artifact at a base revision. Ops: set_cell (exactly one "
                "of text/number/boolean/value_date/value_datetime/empty), "
                "set_formula (must start with '='), clear_cells, set_range "
                "(2D rows sized to the range), copy_style, merge_cells, "
                "unmerge_cells, set_row_height, set_column_width, "
                "freeze_panes. Unknown fields are rejected. The batch is "
                "verified (reopen, read-back, untouched OOXML parts) before "
                "the revision advances; failures change nothing. Formulas are "
                "written but not computed; say so in your answer."
            ),
            parameters=[
                ToolParameter(name="draft_id", type="string", description="Draft id."),
                ToolParameter(name="artifact_id", type="string", description="XLSX artifact id."),
                ToolParameter(name="base_revision", type="integer",
                              description="Revision the batch was based on (from your last read); mismatch = conflict."),
                ToolParameter(
                    name="operations",
                    type="array",
                    description=(
                        'e.g. [{"op":"set_cell","sheet":"Data","cell":"B2","number":42},'
                        '{"op":"set_formula","sheet":"Data","cell":"D2","formula":"=SUM(B2:C2)"}]'
                    ),
                ),
            ],
        )

    async def execute(self, **kwargs: Any) -> ToolResult:
        service = build_office_service(kwargs)
        if service is None:
            return ToolResult(content="office tools need a turn workspace.", success=False)
        draft_id = str(kwargs.get("draft_id") or kwargs.get("_office_draft_id") or "").strip()
        artifact_id = str(kwargs.get("artifact_id") or "").strip()
        base_revision = kwargs.get("base_revision")
        operations_raw = kwargs.get("operations")
        if not draft_id or not artifact_id or base_revision is None:
            return ToolResult(
                content="office_apply requires draft_id, artifact_id and base_revision.",
                success=False,
            )
        try:
            from knorvia.services.office_artifacts.contracts import parse_operations

            operations = parse_operations(operations_raw)
            _check_frozen_selection(
                kwargs.get("_office_selection"),
                draft_id,
                artifact_id,
                service.store.current_revision(draft_id, artifact_id),
                operations,
            )
            payload = service.apply_operations(
                draft_id,
                artifact_id,
                int(base_revision),
                operations_raw,
                actor="agent",
            )
            summary = (
                f"Batch applied: revision {payload['revision_before']} → "
                f"{payload['revision_after']}; {payload['touched_cells']} cell(s) "
                f"touched; verification passed "
                f"(reopen/read-back/untouched-parts)."
            )
            if payload.get("calculation_required"):
                summary += (
                    " Formulas were WRITTEN but NOT computed; they will "
                    "recalculate when the file opens in compatible spreadsheet "
                    "software — do not claim computed results."
                )
            return result_from_payload(payload, summary)
        except Exception as exc:  # noqa: BLE001
            return tool_error_result(exc)
