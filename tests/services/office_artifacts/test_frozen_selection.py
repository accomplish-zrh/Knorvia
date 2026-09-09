"""The frozen turn selection must constrain every operation, not just cell writes."""

from __future__ import annotations

from typing import Any

import pytest

from knorvia.services.office_artifacts.contracts import (
    InvalidOperationError,
    parse_operations,
)
from knorvia.tools.office_apply import _check_frozen_selection

SELECTION: dict[str, Any] = {
    "draft_id": "aaaa1111",
    "artifact_id": "bbbb2222",
    "revision": 0,
    "sheet": "Data",
    "range": "A1:B3",
}


def _check(operations: list[dict[str, Any]], selection: dict[str, Any] = SELECTION) -> None:
    _check_frozen_selection(
        selection,
        "aaaa1111",
        "bbbb2222",
        0,
        list(parse_operations(operations)),
    )


def _op(op: str, **fields: Any) -> dict[str, Any]:
    return {"op": op, "sheet": "Data", **fields}


def test_no_selection_means_no_constraint() -> None:
    _check([_op("set_cell", cell="Z99", text="x")], selection={})


def test_selection_pinning_another_draft_is_rejected() -> None:
    other = dict(SELECTION, draft_id="cccc3333")
    with pytest.raises(InvalidOperationError, match="different office draft|not 'aaaa1111'"):
        _check([_op("set_cell", cell="A1", text="x")], selection=other)


def test_stale_frozen_revision_is_rejected() -> None:
    with pytest.raises(InvalidOperationError, match="re-read with office_read"):
        _check([_op("set_cell", cell="A1", text="x")], selection=dict(SELECTION, revision=1))


def test_cell_write_outside_the_selection_is_rejected() -> None:
    with pytest.raises(InvalidOperationError, match="C1"):
        _check([_op("set_cell", cell="C1", text="x")])


def test_row_height_outside_the_selection_is_rejected() -> None:
    """The review's repro: select A1:B3, then restyle row 99."""
    with pytest.raises(InvalidOperationError, match="row 99"):
        _check([_op("set_row_height", row=99, height=30.0)])


def test_column_width_outside_the_selection_is_rejected() -> None:
    with pytest.raises(InvalidOperationError, match="column Z"):
        _check([_op("set_column_width", column="Z", width=14.0)])


def test_freeze_anchor_outside_the_selection_is_rejected() -> None:
    with pytest.raises(InvalidOperationError, match="freeze anchor"):
        _check([_op("freeze_panes", cell="C4")])


def test_clearing_a_freeze_needs_the_whole_sheet() -> None:
    with pytest.raises(InvalidOperationError, match="freeze reset"):
        _check([_op("freeze_panes", cell=None)])


def test_sheet_only_selection_still_bounds_the_sheet() -> None:
    selection = dict(SELECTION, range="")
    with pytest.raises(InvalidOperationError, match="'Other'"):
        _check(
            [{"op": "set_row_height", "sheet": "Other", "row": 2, "height": 30.0}],
            selection=selection,
        )


def test_structural_operations_inside_the_selection_are_allowed() -> None:
    _check(
        [
            _op("set_cell", cell="B2", text="ok"),
            _op("set_row_height", row=2, height=24.0),
            _op("set_column_width", column="B", width=18.0),
            _op("freeze_panes", cell="B2"),
        ]
    )


def test_operation_with_no_auditable_target_fails_closed() -> None:
    class _Unrecognized:
        sheet = "Data"
        op = "mystery"

    with pytest.raises(InvalidOperationError, match="no auditable target"):
        _check_frozen_selection(
            SELECTION, "aaaa1111", "bbbb2222", 0, [_Unrecognized()]  # type: ignore[list-item]
        )
