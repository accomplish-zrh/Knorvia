"""Narrow-range OOXML patcher for *imported* XLSX workbooks.

The original package is the source of truth. Only the target worksheet XML,
``xl/workbook.xml`` (when a recalc flag must be set) and — when formulas are
written — the stale ``xl/calcChain.xml`` (deleted so Excel rebuilds it) are
touched. Every other ZIP entry must remain byte-identical, which the
service verifies before advancing the revision.

Shared/array/spill formulas, protected sheets and external links fail
closed with machine-readable reasons instead of being rewritten blindly.

openpyxl never saves an imported workbook here.
"""

from __future__ import annotations

import io
from typing import Any
import zipfile

from lxml import etree

from knorvia.services.office_artifacts.adapters.base import AdapterOutcome
from knorvia.services.office_artifacts.contracts import (
    ClearCellsOp,
    CopyStyleOp,
    FreezePanesOp,
    InvalidOperationError,
    MergeCellsOp,
    SetCellOp,
    SetColumnWidthOp,
    SetFormulaOp,
    SetRangeOp,
    SetRowHeightOp,
    UnmergeCellsOp,
    UnsupportedOperationError,
    column_index,
    parse_cell,
    parse_range,
)
from knorvia.services.office_artifacts.verification import resolve_relationship_target

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

NS = {"m": MAIN_NS, "r": REL_NS}

WORKBOOK_PART = "xl/workbook.xml"
WORKBOOK_RELS = "xl/_rels/workbook.xml.rels"
CALC_CHAIN_PART = "xl/calcChain.xml"
CONTENT_TYPES_PART = "[Content_Types].xml"


def _q(name: str) -> str:
    return f"{{{MAIN_NS}}}{name}"


def _load_root(data: bytes) -> etree._Element:
    parser = etree.XMLParser(resolve_entities=False, no_network=True, remove_blank_text=False)
    try:
        return etree.fromstring(data, parser=parser)
    except etree.XMLSyntaxError as exc:
        raise InvalidOperationError(f"worksheet XML is not parseable: {exc}")


def resolve_sheet_part(entries: dict[str, bytes], sheet_name: str) -> str:
    """Map a workbook sheet name to its worksheet part path via rels."""
    if WORKBOOK_PART not in entries or WORKBOOK_RELS not in entries:
        raise InvalidOperationError("workbook is missing its workbook.xml or relationships")
    wb = _load_root(entries[WORKBOOK_PART])
    rels = _load_root(entries[WORKBOOK_RELS])
    rel_targets = {}
    for rel in rels:
        rel_targets[rel.get("Id") or ""] = rel.get("Target") or ""
    for sheet in wb.findall("m:sheets/m:sheet", NS):
        if sheet.get("name") == sheet_name:
            rel_id = sheet.get(f"{{{REL_NS}}}id")
            target = rel_targets.get(rel_id or "", "")
            if not target:
                raise InvalidOperationError(
                    f"sheet {sheet_name!r} has no worksheet relationship"
                )
            part = target.lstrip("/")
            if not part.startswith("xl/"):
                part = f"xl/{part}"
            if part not in entries:
                raise InvalidOperationError(f"worksheet part {part} is missing")
            return part
    raise InvalidOperationError(f"sheet {sheet_name!r} not found in workbook")


def _worksheet_roots(entries: dict[str, bytes], sheet_name: str) -> tuple[str, etree._Element]:
    part = resolve_sheet_part(entries, sheet_name)
    return part, _load_root(entries[part])


def _row_for(sheet: etree._Element, row_index: int, create: bool) -> etree._Element | None:
    sheet_data = sheet.find(_q("sheetData"))
    if sheet_data is None:
        if not create:
            return None
        sheet_data = etree.SubElement(sheet, _q("sheetData"))
        sheet.remove(sheet_data)
        sheet.insert(0, sheet_data)
    for row in sheet_data.findall(_q("row")):
        try:
            if int(row.get("r") or "0") == row_index:
                return row
        except ValueError:
            continue
    if not create:
        return None
    row = etree.Element(_q("row"), r=str(row_index))
    inserted = False
    for index, existing in enumerate(sheet_data.findall(_q("row"))):
        try:
            if int(existing.get("r") or "0") > row_index:
                sheet_data.insert(index, row)
                inserted = True
                break
        except ValueError:
            continue
    if not inserted:
        sheet_data.append(row)
    return row


def _cell_for(row: etree._Element, col: int, cell_ref: str, create: bool) -> etree._Element | None:
    for cell in row.findall(_q("c")):
        if (cell.get("r") or "").upper() == cell_ref:
            return cell
    if not create:
        return None
    cell = etree.Element(_q("c"), r=cell_ref)
    inserted = False
    for index, existing in enumerate(row.findall(_q("c"))):
        existing_ref = (existing.get("r") or "").upper()
        letters = "".join(ch for ch in existing_ref if ch.isalpha())
        try:
            if column_index(letters) > col:
                row.insert(index, cell)
                inserted = True
                break
        except Exception:
            continue
    if not inserted:
        row.append(cell)
    return cell


def _fail_closed_guards(sheet: etree._Element, cell_ref: str) -> None:
    if sheet.find(_q("sheetProtection")) is not None:
        raise UnsupportedOperationError(
            f"sheet is protected; refusing to patch {cell_ref}",
            reason="protected_sheet",
        )
    cell = _find_existing_cell(sheet, cell_ref)
    if cell is not None:
        formula = cell.find(_q("f"))
        if formula is not None and formula.get("t") in {"shared", "array", "dataTable"}:
            raise UnsupportedOperationError(
                f"cell {cell_ref} participates in a {formula.get('t')} formula; "
                "narrow patching refuses to break it",
                reason=f"{formula.get('t')}_formula",
            )


def _find_existing_cell(sheet: etree._Element, cell_ref: str) -> etree._Element | None:
    for row in sheet.findall("m:sheetData/m:row", NS):
        for cell in row.findall(_q("c")):
            if (cell.get("r") or "").upper() == cell_ref:
                return cell
    return None


def _set_cell_element(
    sheet: etree._Element,
    cell_ref: str,
    *,
    col: int,
    row_index: int,
    kind: str,
    payload: Any,
) -> bool:
    """Write one cell. Returns False when there was nothing there to change."""
    _fail_closed_guards(sheet, cell_ref)
    row = _row_for(sheet, row_index, create=kind != "clear")
    if row is None:
        return False
    cell = _cell_for(row, col, cell_ref, create=kind != "clear")
    if cell is None:
        return False
    if kind == "clear":
        # Clearing a cell removes its value, never its formatting: the <c>
        # element stays so its style id survives, and the row keeps whatever
        # row-level attributes it carried.
        had_value = len(cell) > 0
        for child in list(cell):
            cell.remove(child)
        cell.attrib.pop("t", None)
        return had_value
    if kind == "formula":
        formula_text = str(payload).lstrip("=")
        for child in list(cell):
            cell.remove(child)
        cell.attrib.pop("t", None)
        formula_element = etree.SubElement(cell, _q("f"))
        formula_element.text = formula_text
        return True
    for child in list(cell):
        cell.remove(child)
    cell.attrib.pop("t", None)
    if kind == "text":
        cell.set("t", "inlineStr")
        inline = etree.SubElement(cell, _q("is"))
        text = etree.SubElement(inline, _q("t"))
        text.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        text.text = str(payload)
    elif kind == "number":
        value = float(payload)
        if value.is_integer() and abs(value) < 1e15:
            text = str(int(value))
        else:
            text = repr(value)
        value_element = etree.SubElement(cell, _q("v"))
        value_element.text = text
    elif kind == "boolean":
        cell.set("t", "b")
        value_element = etree.SubElement(cell, _q("v"))
        value_element.text = "1" if payload else "0"
    return True


def _merge_ranges(sheet: etree._Element) -> list[tuple[int, int, int, int, etree._Element]]:
    ranges: list[tuple[int, int, int, int, etree._Element]] = []
    merge_cells = sheet.find(_q("mergeCells"))
    if merge_cells is None:
        return ranges
    for element in merge_cells.findall(_q("mergeCell")):
        ranges.append((*parse_range(element.get("ref") or ""), element))
    return ranges


def _ensure_merge_container(sheet: etree._Element) -> etree._Element:
    container = sheet.find(_q("mergeCells"))
    if container is not None:
        return container
    container = etree.Element(_q("mergeCells"), count="0")
    successors = [
        "phoneticPr",
        "conditionalFormatting",
        "dataValidations",
        "hyperlinks",
        "printOptions",
        "pageMargins",
        "pageSetup",
        "headerFooter",
        "rowBreaks",
        "colBreaks",
        "customProperties",
        "extLst",
    ]
    for tag in successors:
        anchor = sheet.find(_q(tag))
        if anchor is not None:
            anchor.addprevious(container)
            return container
    sheet.append(container)
    return container


def _apply_merge(sheet: etree._Element, range_str: str) -> None:
    min_col, min_row, max_col, max_row = parse_range(range_str)
    for e_min_col, e_min_row, e_max_col, e_max_row, _ in _merge_ranges(sheet):
        overlaps = not (
            max_col < e_min_col or min_col > e_max_col
            or max_row < e_min_row or min_row > e_max_row
        )
        if overlaps:
            raise InvalidOperationError(
                f"merge {range_str} overlaps an existing merged range"
            )
    container = _ensure_merge_container(sheet)
    element = etree.SubElement(container, _q("mergeCell"))
    element.set("ref", range_str)
    container.set("count", str(len(container.findall(_q("mergeCell")))))


def _apply_unmerge(sheet: etree._Element, range_str: str) -> None:
    normalized = ":".join(part.strip().upper() for part in range_str.split(":"))
    container = sheet.find(_q("mergeCells"))
    if container is None:
        raise InvalidOperationError(f"no merged range {range_str} to unmerge")
    for element in container.findall(_q("mergeCell")):
        ref = ":".join(part.strip().upper() for part in (element.get("ref") or "").split(":"))
        if ref == normalized:
            container.remove(element)
            remaining = container.findall(_q("mergeCell"))
            if not remaining:
                sheet.remove(container)
            else:
                container.set("count", str(len(remaining)))
            return
    raise InvalidOperationError(f"no merged range {range_str} to unmerge")


def _apply_row_height(sheet: etree._Element, row_index: int, height: float) -> None:
    row = _row_for(sheet, row_index, create=True)
    row.set("ht", repr(float(height)))
    row.set("customHeight", "1")


def _apply_column_width(sheet: etree._Element, column: str, width: float) -> None:
    index = column_index(column)
    cols = sheet.find(_q("cols"))
    if cols is None:
        cols = etree.Element(_q("cols"))
        anchor = sheet.find(_q("sheetData"))
        if anchor is not None:
            anchor.addprevious(cols)
        else:
            sheet.append(cols)

    new_value = repr(float(width))
    pieces: list[tuple[int, dict[str, str]]] = []
    kept: list[etree._Element] = []
    matched = False
    for element in cols.findall(_q("col")):
        span = _col_span(element)
        if matched or span is None or not (span[0] <= index <= span[1]):
            kept.append(element)
            continue
        matched = True
        low, high = span
        attrs = dict(element.attrib)
        if low < index:
            pieces.append((low, {**attrs, "min": str(low), "max": str(index - 1)}))
        pieces.append(
            (index, {**attrs, "min": str(index), "max": str(index),
                     "width": new_value, "customWidth": "1"})
        )
        if high > index:
            pieces.append((index + 1, {**attrs, "min": str(index + 1), "max": str(high)}))
    if not matched:
        # No existing definition covers this column; add a standalone one.
        pieces.append((index, {"min": str(index), "max": str(index),
                               "width": new_value, "customWidth": "1"}))

    for element in cols.findall(_q("col")):
        cols.remove(element)
    # Excel expects ascending column order; unparseable entries stay at the end.
    for _, attrs in sorted(pieces, key=lambda piece: piece[0]):
        etree.SubElement(cols, _q("col"), attrs)
    for element in kept:
        cols.append(element)


def _col_span(element: etree._Element) -> tuple[int, int] | None:
    try:
        low = int(element.get("min") or "")
        high = int(element.get("max") or "")
    except (TypeError, ValueError):
        return None
    if low < 1 or high < low:
        return None
    return low, high


def _apply_freeze(sheet: etree._Element, cell_ref: str | None) -> None:
    sheet_views = sheet.find(_q("sheetViews"))
    if sheet_views is None:
        sheet_views = etree.Element(_q("sheetViews"))
        sheet.insert(1, sheet_views)
    view = sheet_views.find(_q("sheetView"))
    if view is None:
        view = etree.SubElement(sheet_views, _q("sheetView"))
    pane = view.find(_q("pane"))
    if cell_ref is None:
        if pane is not None:
            view.remove(pane)
        return
    col, row = parse_cell(cell_ref)
    if pane is None:
        pane = etree.Element(_q("pane"))
        view.insert(0, pane)
    if col > 1:
        pane.set("xSplit", str(col - 1))
    if row > 1:
        pane.set("ySplit", str(row - 1))
    pane.set("topLeftCell", cell_ref.upper())
    pane.set(
        "activePane",
        "bottomRight" if col > 1 and row > 1 else ("topRight" if col > 1 else "bottomLeft"),
    )
    pane.set("state", "frozen")


def _apply_copy_style(
    sheet: etree._Element,
    source_cell: str,
    target_range: str,
) -> int:
    """Copy one cell's style over a range. Returns the cells actually written."""
    source = _find_existing_cell(sheet, source_cell.upper())
    if source is None:
        raise UnsupportedOperationError(
            f"style source {source_cell} does not exist on this sheet; refusing to "
            "copy a style that is not there",
            reason="missing_style_source",
        )
    source_style = source.get("s")
    written = 0
    min_col, min_row, max_col, max_row = parse_range(target_range)
    for row_index in range(min_row, max_row + 1):
        row = _row_for(sheet, row_index, create=True)
        for col in range(min_col, max_col + 1):
            ref = f"{_col_letter(col)}{row_index}"
            target = _cell_for(row, col, ref, create=True)
            if source_style is None:
                target.attrib.pop("s", None)
            else:
                target.set("s", source_style)
            written += 1
    return written


def _col_letter(index: int) -> str:
    letters = ""
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(ord("A") + rem) + letters
    return letters


def _set_full_calc_on_load(entries: dict[str, bytes]) -> None:
    root = _load_root(entries[WORKBOOK_PART])
    calc = root.find(_q("calcPr"))
    if calc is None:
        calc = etree.Element(_q("calcPr"))
        anchor = root.find(_q("definedNames"))
        if anchor is None:
            anchor = root.find(_q("sheets"))
        if anchor is not None:
            anchor.addnext(calc)
        else:
            root.append(calc)
    calc.set("fullCalcOnLoad", "1")
    entries[WORKBOOK_PART] = etree.tostring(
        root, xml_declaration=True, encoding="UTF-8", standalone=True
    )


def _purge_references(entries: dict[str, bytes], part: str) -> set[str]:
    """Drop every package reference that addresses ``part``.

    Returns the manifest parts that were rewritten, so the caller can declare
    them as intentionally changed.
    """
    edited: set[str] = set()
    for name in [candidate for candidate in entries if candidate.endswith(".rels")]:
        root = _load_root(entries[name])
        removed = False
        for rel in list(root):
            if (rel.get("TargetMode") or "").lower() == "external":
                continue
            target = str(rel.get("Target") or "")
            if not target or target.startswith("#"):
                continue
            if resolve_relationship_target(name, target) == part:
                root.remove(rel)
                removed = True
        if removed:
            entries[name] = _serialize(root)
            edited.add(name)
    if CONTENT_TYPES_PART in entries:
        root = _load_root(entries[CONTENT_TYPES_PART])
        removed = False
        for override in list(root):
            if str(override.get("PartName") or "").lstrip("/") == part:
                root.remove(override)
                removed = True
        if removed:
            entries[CONTENT_TYPES_PART] = _serialize(root)
            edited.add(CONTENT_TYPES_PART)
    return edited


def _serialize(root: etree._Element) -> bytes:
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def _rebuild_zip(entries: dict[str, bytes], order: list[str], dropped: set[str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in order:
            if name in dropped:
                continue
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            bundle.writestr(info, entries[name])
    return buffer.getvalue()


def apply_narrow_patch(data: bytes, operations: list[Any]) -> AdapterOutcome:
    """Apply one validated batch to an imported workbook, fail-closed."""
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        order = [info.filename for info in bundle.infolist()]
        entries = {info.filename: bundle.read(info.filename) for info in bundle.infolist()}

    formula_ops = [op for op in operations if isinstance(op, SetFormulaOp)]
    if formula_ops:
        rels = _load_root(entries[WORKBOOK_RELS])
        for rel in rels:
            if "externalLink" in (rel.get("Type") or ""):
                raise UnsupportedOperationError(
                    "workbook references external links; formula patching is refused",
                    reason="external_links",
                )

    patched_parts: set[str] = set()
    touched = 0
    targets: list[str] = []
    calculation_required = False

    grouped: dict[str, list[Any]] = {}
    for op in operations:
        sheet_name = str(op.sheet or "").strip()
        if not sheet_name:
            raise InvalidOperationError("every operation needs a sheet name")
        grouped.setdefault(sheet_name, []).append(op)

    for sheet_name, ops in grouped.items():
        part, sheet = _worksheet_roots(entries, sheet_name)
        if sheet.find(_q("sheetProtection")) is not None:
            raise UnsupportedOperationError(
                f"sheet {sheet_name!r} is protected; refusing to patch",
                reason="protected_sheet",
            )
        for op in ops:
            if isinstance(op, SetCellOp):
                col, row_index = parse_cell(op.cell)
                _fail_closed_guards(sheet, op.cell.upper())
                if op.text is not None:
                    kind, payload = "text", op.text
                elif op.number is not None:
                    kind, payload = "number", op.number
                elif op.boolean is not None:
                    kind, payload = "boolean", op.boolean
                elif op.empty:
                    kind, payload = "clear", None
                else:
                    raise UnsupportedOperationError(
                        "date values on imported workbooks require a matching number "
                        "format; refusing to write a value that would display as a "
                        "serial number",
                        reason="date_value_unsupported_on_import",
                    )
                if _set_cell_element(
                    sheet, op.cell.upper(), col=col, row_index=row_index,
                    kind=kind, payload=payload,
                ):
                    touched += 1
                    targets.append(op.cell.upper())
            elif isinstance(op, SetFormulaOp):
                col, row_index = parse_cell(op.cell)
                _fail_closed_guards(sheet, op.cell.upper())
                if _set_cell_element(
                    sheet, op.cell.upper(), col=col, row_index=row_index,
                    kind="formula", payload=op.formula,
                ):
                    touched += 1
                    targets.append(op.cell.upper())
                calculation_required = True
            elif isinstance(op, ClearCellsOp):
                min_col, min_row, max_col, max_row = parse_range(op.range)
                for row_index in range(min_row, max_row + 1):
                    for col in range(min_col, max_col + 1):
                        ref = f"{_col_letter(col)}{row_index}"
                        if _set_cell_element(
                            sheet, ref, col=col, row_index=row_index,
                            kind="clear", payload=None,
                        ):
                            touched += 1
                            targets.append(ref)
            elif isinstance(op, SetRangeOp):
                min_col, min_row, max_col, max_row = parse_range(op.range)
                for r_offset, row_values in enumerate(op.rows):
                    for c_offset, value in enumerate(row_values):
                        col = min_col + c_offset
                        row_index = min_row + r_offset
                        ref = f"{_col_letter(col)}{row_index}"
                        _fail_closed_guards(sheet, ref)
                        if value is None:
                            kind, payload = "clear", None
                        elif isinstance(value, str):
                            kind, payload = "text", value
                        elif isinstance(value, bool):
                            kind, payload = "boolean", value
                        else:
                            kind, payload = "number", float(value)
                        if _set_cell_element(sheet, ref, col=col, row_index=row_index,
                                            kind=kind, payload=payload):
                            touched += 1
                            targets.append(ref)
            elif isinstance(op, CopyStyleOp):
                written = _apply_copy_style(sheet, op.source_cell, op.target_range)
                touched += written
                if written:
                    targets.append(op.target_range)
            elif isinstance(op, MergeCellsOp):
                _apply_merge(sheet, op.range)
                targets.append(op.range)
            elif isinstance(op, UnmergeCellsOp):
                _apply_unmerge(sheet, op.range)
                targets.append(op.range)
            elif isinstance(op, SetRowHeightOp):
                _apply_row_height(sheet, op.row, op.height)
                targets.append(f"row:{op.row}")
            elif isinstance(op, SetColumnWidthOp):
                _apply_column_width(sheet, op.column, op.width)
                targets.append(f"col:{op.column}")
            elif isinstance(op, FreezePanesOp):
                _apply_freeze(sheet, op.cell)
                targets.append(f"freeze:{op.cell or 'none'}")
            else:  # pragma: no cover - contracts guarantee the union
                raise UnsupportedOperationError(
                    f"operation {type(op).__name__} is not supported on imported workbooks",
                    reason="unsupported_on_import",
                )
        entries[part] = etree.tostring(
            sheet, xml_declaration=True, encoding="UTF-8", standalone=True
        )
        patched_parts.add(part)

    if formula_ops:
        _set_full_calc_on_load(entries)
        patched_parts.add(WORKBOOK_PART)

    dropped: set[str] = set()
    if formula_ops and CALC_CHAIN_PART in entries:
        dropped.add(CALC_CHAIN_PART)
        patched_parts |= _purge_references(entries, CALC_CHAIN_PART)

    new_bytes = _rebuild_zip(entries, order, dropped)
    return AdapterOutcome(
        new_bytes=new_bytes,
        calculation_required=calculation_required,
        allowed_parts_hint=sorted(patched_parts | dropped),
        touched_cells=touched,
        target_addresses=sorted(set(targets)),
    )
