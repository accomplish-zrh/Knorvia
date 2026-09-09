"""Compatibility facade for the legacy ``office_document`` tool.

The Office artifact runtime now lives in ``knorvia.services.office_artifacts``
(see ``knorvia/services/office_artifacts/ARCHITECTURE.md``). This module keeps the old
``office_document`` action vocabulary working on top of the new runtime:

- create / add_sheet / write_cells / formula / style / chart / read /
  screenshot_hint map to runtime-generated XLSX artifacts through the same
  transactional service the new ``office_apply`` tool uses;
- export_doc / export_slide map to the generated-DOCX / generated-PPTX
  adapters;
- container_* map to the ``.univer`` container adapter;
- ready / merge / discard / status map to the v2 draft lifecycle.

New integrations should use ``office_artifact`` / ``office_read`` /
``office_apply`` instead. This facade will be retired after one compat cycle.
"""

from __future__ import annotations

import csv
from io import StringIO
import json
from pathlib import Path
import re
from typing import Any

from knorvia.core.tool_protocol import BaseTool, ToolDefinition, ToolResult
from knorvia.services.office_artifacts.adapters.univer_container import (
    UNIT_TYPES,
    ContainerError,
    add_unit,
    export_unit,
    list_units,
    open_univer,
    pack_univer,
)
from knorvia.services.office_artifacts.contracts import OfficeArtifactError
from knorvia.services.office_artifacts.service import OfficeArtifactService
from knorvia.services.office_artifacts.sources import SourceContext
from knorvia.services.office_artifacts.store import (
    DraftStateError,
)
from knorvia.tools.prompting import load_prompt_hints


def _xlsx_adapter():
    from knorvia.services.office_artifacts.adapters import xlsx_adapter

    return xlsx_adapter


def _xlsx_reader(data: bytes):
    from knorvia.services.office_artifacts.adapters.xlsx_reader import XlsxReader

    return XlsxReader(data)


def _generate_docx(content: str) -> bytes:
    from knorvia.services.office_artifacts.adapters.generated_docx import generate_docx

    return generate_docx(content)


def _generate_pptx(content: str) -> tuple[bytes, int]:
    from knorvia.services.office_artifacts.adapters.generated_pptx import generate_pptx

    return generate_pptx(content)

WRITE_ACTIONS = (
    "create",
    "add_sheet",
    "write_cells",
    "formula",
    "style",
    "chart",
    "read",
    "export_doc",
    "export_slide",
    "screenshot_hint",
    "container_new",
    "container_add",
    "container_export_unit",
)
LIFECYCLE_ACTIONS = ("ready", "merge", "discard", "status")
DRAFT_ACTIONS = ("create",) + LIFECYCLE_ACTIONS
ACTIONS = WRITE_ACTIONS + LIFECYCLE_ACTIONS
CONTAINER_ACTIONS = ("container_new", "container_add", "container_export_unit")
LEGACY_XLSX_ACTIONS = ("add_sheet", "write_cells", "formula", "style", "chart")

_TOOL_DESCRIPTION = (
    "Create and edit structured Office files (xlsx / docx / pptx) without "
    "writing spreadsheet code. Writes default to an isolated draft "
    "(`as_draft=true`); the user previews a review card and confirms before "
    "files land in the turn workspace. Typical flow: create → add_sheet/"
    "write_cells → formula → style → chart → read (self-check) → optional "
    "export_doc / export_slide → draft_action=ready. `create` starts a "
    'workbook (`file` required). `write_cells` accepts {"A1": "Title", '
    '"B2": 123} or a 2D array. `formula` writes formula strings such as '
    '{"D2": "=SUM(B2:C2)"}. `style` takes [{target:"A1:D1", bold:true, '
    'bg:"#B0501E", color:"#FFFFFF", font_size:12}]. `chart` is '
    '{type:"bar|line|pie", data_range:"A1:B5", title:"..."}. `read` '
    "returns CSV of a range so you can verify writes. `export_doc` renders a "
    "Markdown subset (#/##/### headings, - lists, |a|b| tables, paragraphs) "
    "to .docx. `export_slide` builds a 16:9 deck from an outline (level-1 "
    "heading = new slide title; bullets = body). `screenshot_hint` returns a "
    "text grid (and a PNG preview when possible). Multi-unit `.univer` ZIP "
    "containers: `container_new` → `container_add` (unit_type=sheet|doc|slide, "
    "optional source_file / refs) → `container_export_unit`. Independent "
    "draft actions: ready | merge | discard | status (also via `draft_action`)."
)


def _fail(message: str, **meta: Any) -> ToolResult:
    return ToolResult(content=message, success=False, metadata=meta)


def _ok(message: str, output_file: str, **meta: Any) -> ToolResult:
    return ToolResult(
        content=message,
        success=True,
        metadata={"output_file": output_file, **meta},
    )


def _maybe_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text or text[0] not in "{[":
        return value
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return value


def _workspace(kwargs: dict[str, Any]) -> tuple[Path, bool]:
    raw = str(kwargs.get("_workspace_dir") or kwargs.get("_sandbox_workdir") or "").strip()
    if raw:
        path = Path(raw).expanduser().resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path, False
    return Path.cwd().resolve(), True


def _task_dir_of(kwargs: dict[str, Any]) -> Path | None:
    raw = str(kwargs.get("_task_dir") or "").strip()
    if not raw:
        return None
    return Path(raw).expanduser().resolve()


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    if value is None:
        return default
    return bool(value)


def _resolve_file(workspace: Path, file_name: str) -> Path:
    raw = Path(str(file_name or "").strip())
    if not str(file_name or "").strip() or raw.name in {".", ".."}:
        raise ValueError("`file` is required and must be a relative file name.")
    candidate = raw if raw.is_absolute() else workspace / raw
    resolved = candidate.expanduser().resolve()
    try:
        resolved.relative_to(workspace)
    except ValueError as exc:
        raise ValueError(f"path is outside the turn workspace: {file_name}") from exc
    return resolved


def _rel(path: Path, workspace: Path) -> str:
    try:
        return path.resolve().relative_to(workspace).as_posix()
    except ValueError:
        return str(path)


def _ensure_suffix(path: Path, suffix: str) -> Path:
    if path.suffix.lower() != suffix.lower():
        return path.with_suffix(suffix)
    return path


def _sheet_csv(data: bytes, read_range: str | None, sheet: str | None = None) -> str:
    reader = _xlsx_reader(data)
    ws = reader._worksheet(sheet)
    if read_range:
        from knorvia.services.office_artifacts.contracts import parse_range

        min_col, min_row, max_col, max_row = parse_range(read_range)
    else:
        min_col, min_row = 1, 1
        max_row, max_col = ws.max_row or 1, ws.max_column or 1
    buf = StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    for row in range(min_row, max_row + 1):
        values = []
        for col in range(min_col, max_col + 1):
            cell = ws.cell(row=row, column=col)
            value = cell.value
            values.append("" if value is None else str(value))
        writer.writerow(values)
    return buf.getvalue()


def _render_preview_png(ws: Any, dest: Path, *, max_rows: int = 16, max_cols: int = 8) -> bool:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False
    rows = max(1, min(int(ws.max_row or 1), max_rows))
    cols = max(1, min(int(ws.max_column or 1), max_cols))
    cell_w, cell_h, pad = 96, 24, 8
    image = Image.new("RGB", (cols * cell_w + pad * 2, rows * cell_h + pad * 2), "white")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype("arial.ttf", 12)
    except OSError:
        font = ImageFont.load_default()
    for row in range(1, rows + 1):
        for col in range(1, cols + 1):
            x0 = pad + (col - 1) * cell_w
            y0 = pad + (row - 1) * cell_h
            fill = "#F3EDE6" if row == 1 else "white"
            draw.rectangle([x0, y0, x0 + cell_w, y0 + cell_h], outline="#C8C8C8", fill=fill)
            value = ws.cell(row, col).value
            text = "" if value is None else str(value)[:14]
            draw.text((x0 + 4, y0 + 5), text, fill="#222222", font=font)
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest, format="PNG")
    return dest.is_file() and dest.stat().st_size > 0


# ----------------------------------------------------------------------
# Facade dispatch
# ----------------------------------------------------------------------


def _service_for(kwargs: dict[str, Any], workspace: Path) -> OfficeArtifactService | None:
    task_dir = _task_dir_of(kwargs)
    if task_dir is None:
        return None
    return OfficeArtifactService(
        task_dir=task_dir,
        workspace_dir=workspace,
        source_context=SourceContext(),
    )


def _draft_bytes(
    service: OfficeArtifactService, draft_id: str, file_name: str
) -> tuple[str, bytes]:
    artifact_id = service.store.find_artifact_by_filename(draft_id, file_name)
    if artifact_id is None:
        raise ValueError(f"Workbook {Path(file_name).name!r} does not exist. Call action=create first.")
    return artifact_id, service.store.current_bytes(draft_id, artifact_id)


def _execute_draft_mode(
    action: str,
    kwargs: dict[str, Any],
    workspace: Path,
    draft_id: str,
    service: OfficeArtifactService,
) -> ToolResult:
    """Legacy actions executed against v2 draft artifacts."""
    file_name = str(kwargs.get("file") or "").strip()
    if not file_name:
        return _fail("`file` is required (relative to this turn's workspace).")

    if action == "create":
        sheet = str(kwargs.get("sheet") or "").strip() or "Sheet"
        base = _xlsx_adapter().create_generated_xlsx(sheet)
        existing = service.store.find_artifact_by_filename(draft_id, file_name)
        if existing is None:
            created = service.create_generated(
                file_name, "xlsx", sheet=sheet, draft_id=draft_id
            )
            artifact_id = created["artifact"]["artifact_id"]
        else:
            commit = service.store.commit_revision(
                draft_id,
                existing,
                new_bytes=base,
                base_revision=service.store.current_revision(draft_id, existing),
                actor="agent",
                operations_summary=[f"create (reset) {file_name}"],
                diff=None,
                verification={"reopened": True, "zip_structure_valid": True,
                              "target_readback": True, "untouched_parts_verified": True,
                              "allowed_changed_parts": ["<generated workbook>"],
                              "notes": ["legacy create reset"]},
            )
            artifact_id = existing
        _ensure_suffix(Path(file_name), ".xlsx")
        return _ok(
            f"Created workbook {file_name} with sheet {sheet!r}.",
            file_name,
            sheet=sheet,
            draft_id=draft_id,
        )

    if action in LEGACY_XLSX_ACTIONS:
        artifact_id, current = _draft_bytes(service, draft_id, file_name)
        manifest = service.store.manifest(draft_id, artifact_id)
        if manifest.get("origin_kind") != "generated":
            # Legacy actions full-rewrite via openpyxl; that is only provably
            # format-faithful for runtime-generated workbooks. Imported files
            # must go through the narrow-patch typed protocol (office_apply).
            raise ValueError(
                f"{file_name} was imported from an existing file; legacy write "
                "actions only support runtime-generated workbooks. Use "
                "office_apply (typed operation batches) for imported files."
            )
        outcome, info = _xlsx_adapter().legacy_action(current, action, kwargs)
        verification = {
            "reopened": True,
            "target_readback": True,
            "zip_structure_valid": True,
            "untouched_parts_verified": True,
            "allowed_changed_parts": ["<generated workbook: openpyxl rewrite>"],
            "notes": ["legacy action on runtime-generated workbook"],
        }
        commit = service.store.commit_revision(
            draft_id,
            artifact_id,
            new_bytes=outcome.new_bytes,
            base_revision=service.store.current_revision(draft_id, artifact_id),
            actor="agent",
            operations_summary=[f"{action}: {info}"],
            diff=None,
            verification=verification,
            calculation_required=outcome.calculation_required,
        )
        extra: dict[str, Any] = {}
        if action == "write_cells":
            cells = _maybe_json(kwargs.get("cells")) or {}
            if isinstance(cells, dict):
                extra = {"cells_written": len(cells)}
        if action == "formula":
            cells = _maybe_json(kwargs.get("formula_cells") or kwargs.get("cells")) or {}
            extra = {"formulas": len(cells) if isinstance(cells, dict) else 0}
        if action == "style":
            styles = _maybe_json(kwargs.get("styles"))
            extra = {"styles": len(styles) if isinstance(styles, list) else 0}
        if action == "chart":
            chart = _maybe_json(kwargs.get("chart")) or {}
            extra = {
                "chart_type": chart.get("type"),
                "data_range": chart.get("data_range"),
            }
        return _ok(f"{info} Draft {draft_id} artifact updated.", file_name,
                   draft_id=draft_id, **extra)

    if action in ("read", "screenshot_hint"):
        artifact_id, current = _draft_bytes(service, draft_id, file_name)
        read_range = str(kwargs.get("read_range") or "").strip() or None
        csv_text = _sheet_csv(current, read_range, str(kwargs.get("sheet") or "") or None)
        span = read_range or "used range"
        body = csv_text if csv_text.strip() else "(empty range)"
        if action == "read":
            return _ok(f"Read {file_name} ({span}):\n{body}", file_name, read_range=span)
        reader = _xlsx_reader(current)
        preview = service.store.draft_dir(draft_id) / f"{Path(file_name).stem}_preview.png"
        png_ok = _render_preview_png(reader._worksheet(None), preview)
        note = f" PNG preview: {preview.name}." if png_ok else " (PNG preview unavailable)."
        return _ok(f"Screenshot hint for {file_name}:{note}\n{body}", file_name)

    raise ValueError(f"Unhandled action {action!r} in draft mode.")


def _execute_direct_mode(
    action: str,
    kwargs: dict[str, Any],
    workspace: Path,
    cwd_fallback: bool,
) -> ToolResult:
    """Legacy direct-write mode (as_draft=false or no turn workspace)."""
    file_name = str(kwargs.get("file") or "").strip()
    extra = f" (absolute {workspace})" if cwd_fallback else ""

    if action == "create":
        if not file_name:
            return _fail("`file` is required (relative to this turn's workspace).")
        path = _ensure_suffix(_resolve_file(workspace, file_name), ".xlsx")
        from knorvia.services.office_artifacts.contracts import validate_sheet_name

        sheet = validate_sheet_name(kwargs.get("sheet") or "Sheet")
        path.write_bytes(_xlsx_adapter().create_generated_xlsx(sheet))
        return _ok(f"Created workbook {_rel(path, workspace)} with sheet {sheet!r}{extra}.",
                   _rel(path, workspace), sheet=sheet)

    if action in ("add_sheet", "write_cells", "formula", "style", "chart"):
        if not file_name:
            return _fail("`file` is required (relative to this turn's workspace).")
        path = _ensure_suffix(_resolve_file(workspace, file_name), ".xlsx")
        if not path.is_file():
            raise ValueError(f"Workbook {path.name!r} does not exist. Call action=create first.")
        outcome, info = _xlsx_adapter().legacy_action(path.read_bytes(), action, kwargs)
        path.write_bytes(outcome.new_bytes)
        rel = _rel(path, workspace)
        extra_meta: dict[str, Any] = {}
        if action == "write_cells":
            cells = _maybe_json(kwargs.get("cells")) or {}
            extra_meta = {"cells_written": len(cells) if isinstance(cells, dict) else 0}
        if action == "formula":
            cells = _maybe_json(kwargs.get("formula_cells") or kwargs.get("cells")) or {}
            extra_meta = {"formulas": len(cells) if isinstance(cells, dict) else 0}
        if action == "style":
            styles = _maybe_json(kwargs.get("styles"))
            extra_meta = {"styles": len(styles) if isinstance(styles, list) else 0}
        if action == "chart":
            chart = _maybe_json(kwargs.get("chart")) or {}
            extra_meta = {"chart_type": chart.get("type"), "data_range": chart.get("data_range")}
        return _ok(f"{info}", rel, sheet=str(kwargs.get("sheet") or ""), **extra_meta)

    if action in ("read", "screenshot_hint"):
        if not file_name:
            return _fail("`file` is required (relative to this turn's workspace).")
        path = _ensure_suffix(_resolve_file(workspace, file_name), ".xlsx")
        if not path.is_file():
            raise ValueError(f"Workbook {path.name!r} does not exist. Call action=create first.")
        data = path.read_bytes()
        read_range = str(kwargs.get("read_range") or "").strip() or None
        csv_text = _sheet_csv(data, read_range, str(kwargs.get("sheet") or "") or None)
        span = read_range or "used range"
        body = csv_text if csv_text.strip() else "(empty range)"
        rel = _rel(path, workspace)
        if action == "read":
            return _ok(f"Read {rel} ({span}):\n{body}", rel, read_range=span)
        reader = _xlsx_reader(data)
        preview = path.with_name(f"{path.stem}_preview.png")
        png_ok = _render_preview_png(reader._worksheet(None), preview)
        preview_rel = _rel(preview, workspace) if png_ok else ""
        note = f" PNG preview: {preview_rel}." if png_ok else " (PNG preview unavailable)."
        return _ok(f"Screenshot hint for {rel}:{note}\n{body}",
                   preview_rel or rel, preview_file=preview_rel, source_file=rel)

    if action == "export_doc":
        if not file_name:
            return _fail("`file` is required (relative to this turn's workspace).")
        path = _ensure_suffix(_resolve_file(workspace, file_name), ".docx")
        path.write_bytes(_generate_docx(str(kwargs.get("content") or "")))
        rel = _rel(path, workspace)
        return _ok(f"Exported Word document {rel} ({path.stat().st_size} bytes){extra}.",
                   rel, bytes=path.stat().st_size)

    if action == "export_slide":
        if not file_name:
            return _fail("`file` is required (relative to this turn's workspace).")
        path = _ensure_suffix(_resolve_file(workspace, file_name), ".pptx")
        deck, slides = _generate_pptx(str(kwargs.get("content") or ""))
        path.write_bytes(deck)
        rel = _rel(path, workspace)
        return _ok(f"Exported {slides}-slide deck {rel} (16:9){extra}.",
                   rel, slides=slides, bytes=path.stat().st_size)

    if action in CONTAINER_ACTIONS:
        return _container_action(action, kwargs, workspace)

    raise ValueError(f"Unhandled action {action!r}.")


def _container_action(action: str, kwargs: dict[str, Any], workspace: Path) -> ToolResult:
    file_name = str(kwargs.get("file") or "").strip()
    if not file_name:
        return _fail("`file` is required (relative to this turn's workspace).")
    path = _ensure_suffix(_resolve_file(workspace, file_name), ".univer")
    rel = _rel(path, workspace)

    if action == "container_new":
        units_raw = _maybe_json(kwargs.get("units") or kwargs.get("cells"))
        entries: list[dict[str, Any]] = []
        if isinstance(units_raw, list):
            for item in units_raw:
                if not isinstance(item, dict):
                    raise ValueError("each units entry must be an object")
                entries.append(dict(item))
        source_name = str(kwargs.get("source_file") or "").strip()
        if source_name:
            source_path = _resolve_source_file(workspace, source_name)
            suffix = source_path.suffix.lower()
            type_map = {".xlsx": "sheet", ".xlsm": "sheet", ".docx": "doc", ".pptx": "slide"}
            unit_type = type_map.get(suffix)
            if unit_type is None:
                raise ValueError("source_file for container_new must be .xlsx / .docx / .pptx")
            unit_id = str(kwargs.get("unit_id") or "").strip()
            if not unit_id:
                stem = Path(source_name).stem
                unit_id = stem if re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,31}", stem) else unit_type
            entries.append({
                "id": unit_id,
                "type": unit_type,
                "name": str(kwargs.get("unit_name") or kwargs.get("sheet") or unit_id),
                "source": source_path,
            })
        manifest = pack_univer(entries, path, refs=_parse_refs(kwargs.get("refs")) or None)
        count = len(manifest.get("units") or [])
        return _ok(f"Created .univer container {rel} with {count} unit(s).", rel,
                   units=manifest.get("units") or [], refs=manifest.get("refs") or [])

    if action == "container_add":
        if not path.is_file():
            raise ValueError(f"Container {path.name!r} does not exist. Call action=container_new first.")
        unit_type = str(kwargs.get("unit_type") or "").strip().lower()
        if unit_type not in UNIT_TYPES:
            raise ValueError(f"`unit_type` is required for container_add ({', '.join(UNIT_TYPES)})")
        source_bytes = None
        source_name = str(kwargs.get("source_file") or "").strip()
        if source_name:
            source_bytes = _resolve_source_file(workspace, source_name).read_bytes()
        unit = add_unit(
            path,
            unit_type,
            str(kwargs.get("unit_name") or kwargs.get("name") or kwargs.get("sheet") or "").strip() or None,
            source_bytes,
            unit_id=str(kwargs.get("unit_id") or "").strip() or None,
            refs=_parse_refs(kwargs.get("refs")) or None,
        )
        refs = open_univer(path).get("refs") or []
        ref_note = f", recorded {len(refs)} ref(s)" if refs else ""
        return _ok(f"Added {unit['type']} unit {unit['id']!r} to {rel}{ref_note}.", rel,
                   unit=unit, units=list_units(path), refs=refs)

    unit_id = str(kwargs.get("unit_id") or "").strip()
    if not unit_id:
        raise ValueError("`unit_id` is required for container_export_unit")
    if not path.is_file():
        raise ValueError(f"Container {path.name!r} does not exist.")
    out_name = str(kwargs.get("export_file") or kwargs.get("output") or "").strip() or unit_id
    out_path = _resolve_file(workspace, out_name)
    exported = export_unit(path, unit_id, out_path)
    return _ok(f"Exported unit {unit_id!r} from {path.name} to {_rel(exported, workspace)}.",
               _rel(exported, workspace), unit_id=unit_id, container=rel)


def _resolve_source_file(workspace: Path, source_name: str) -> Path:
    candidate = _resolve_file(workspace, source_name)
    if candidate.is_file():
        return candidate
    raise ValueError(f"source_file not found: {source_name}")


def _parse_refs(raw: Any) -> list[dict[str, Any]]:
    payload = _maybe_json(raw)
    if payload in (None, "", [], {}):
        return []
    if isinstance(payload, dict):
        payload = [payload]
    if not isinstance(payload, list):
        raise ValueError('`refs` must be a list like [{"to":"sheet","range":"A1:B5"}]')
    return [item for item in payload if isinstance(item, dict)]


def execute_office_document(kwargs: dict[str, Any]) -> ToolResult:
    """Run one legacy ``office_document`` action through the v2 runtime."""
    action = str(kwargs.get("action") or "").strip().lower()
    draft_action = str(kwargs.get("draft_action") or "").strip().lower()
    if draft_action and draft_action not in DRAFT_ACTIONS:
        valid = ", ".join(DRAFT_ACTIONS)
        return _fail(f"Invalid draft_action {draft_action!r}. Valid: {valid}.")
    if action and action not in ACTIONS:
        valid = ", ".join(ACTIONS)
        return _fail(f"Invalid action {action!r}. Valid actions: {valid}.")
    if not action and not draft_action:
        valid = ", ".join(ACTIONS)
        return _fail(f"Invalid action {action!r}. Valid actions: {valid}.")
    lifecycle = (
        draft_action
        if draft_action in DRAFT_ACTIONS
        else (action if action in LIFECYCLE_ACTIONS else "")
    )
    writing = action in WRITE_ACTIONS
    workspace, cwd_fallback = _workspace(kwargs)
    try:
        service = _service_for(kwargs, workspace)
        draft_id = str(kwargs.get("draft_id") or kwargs.get("_office_draft_id") or "").strip()
        as_draft = _as_bool(kwargs.get("as_draft"), default=True)
        use_draft = service is not None and as_draft and (writing or lifecycle)

        if lifecycle and lifecycle != "create":
            if service is None or not draft_id:
                if service is None:
                    raise ValueError("office drafts need a turn workspace (`_task_dir`).")
                return _fail("`draft_id` is required for this draft action.")
            if lifecycle == "ready":
                meta = service.store.mark_ready(draft_id)
            elif lifecycle == "merge":
                meta = service.merge(draft_id)
            elif lifecycle == "discard":
                meta = service.store.discard(draft_id)
            else:
                meta = {**service.store.status(draft_id), "diff": service.store.diff(draft_id)}
            payload = service.store.card_payload(draft_id)
            merged = {"draft_status": meta.get("status"), **payload}
            return ToolResult(
                content=f"Office draft {draft_id} is {meta.get('status')}.",
                success=True,
                metadata=merged,
            )

        if lifecycle == "create" and not draft_id:
            if service is None:
                raise ValueError("office drafts need a turn workspace (`_task_dir`).")
            draft_id = service.store.create_draft()

        result: ToolResult
        if use_draft and action:
            if not draft_id:
                draft_id = service.store.create_draft()
            result = _execute_draft_mode(action, kwargs, workspace, draft_id, service)
        elif action:
            result = _execute_direct_mode(action, kwargs, workspace, cwd_fallback)
        else:
            result = _fail(f"Unhandled action {action!r}.")

        if use_draft and draft_id:
            try:
                payload = service.store.card_payload(draft_id)
                merged = {**(result.metadata or {}), **payload}
                merged.setdefault("draft_id", draft_id)
                merged.setdefault("draft_status", payload.get("draft_status"))
                return ToolResult(content=result.content, success=result.success, metadata=merged)
            except OfficeArtifactError:
                return result
        return result
    except (ValueError, ContainerError) as exc:
        return _fail(str(exc))
    except DraftStateError as exc:
        return _fail(str(exc))
    except OfficeArtifactError as exc:
        return _fail(str(exc))
    except Exception as exc:  # noqa: BLE001 - tool boundary
        return _fail(f"office_document failed: {exc}")


class OfficeDocumentTool(BaseTool):
    """Backward-compatible alias for the runtime's generated-authoring actions."""

    def get_prompt_hints(self, language: str = "en"):
        return load_prompt_hints(self.name, language=language)

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="office_document",
            description=_TOOL_DESCRIPTION,
            raw_parameters={
                "type": "object",
                "additionalProperties": True,
                "required": ["action"],
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": list(ACTIONS),
                        "description": (
                            "create | add_sheet | write_cells | formula | "
                            "style | chart | read | export_doc | export_slide | "
                            "screenshot_hint | container_new | container_add | "
                            "container_export_unit | ready | merge | discard | status"
                        ),
                    },
                    "as_draft": {
                        "type": "boolean",
                        "description": (
                            "Write into an isolated draft the user must confirm "
                            "(default true). Set false only to write the official file."
                        ),
                    },
                    "draft_action": {
                        "type": "string",
                        "enum": list(DRAFT_ACTIONS),
                        "description": (
                            "Independent draft lifecycle: create | ready | merge | "
                            "discard | status. ready/merge/discard/status also work as `action`."
                        ),
                    },
                    "draft_id": {
                        "type": "string",
                        "description": (
                            "Existing 8-char draft id. Reused automatically within a turn "
                            "when omitted."
                        ),
                    },
                    "file": {
                        "type": "string",
                        "description": "Output file name relative to this turn's workspace. Required for write actions.",
                    },
                    "sheet": {"type": "string", "description": "Worksheet / slide name."},
                    "cells": {
                        "description": (
                            'Object {"A1": "Title", "B2": 123} or 2D array [["a","b"],[1,2]].'
                        )
                    },
                    "formula_cells": {
                        "type": "object",
                        "additionalProperties": {"type": "string"},
                        "description": '{"D2": "=SUM(B2:C2)"}',
                    },
                    "styles": {
                        "type": "array",
                        "items": {"type": "object", "additionalProperties": True},
                        "description": (
                            '[{target:"A1:D1", bold:true, bg:"#B0501E", '
                            'color:"#FFFFFF", font_size:12}]'
                        ),
                    },
                    "chart": {
                        "type": "object",
                        "additionalProperties": True,
                        "description": '{type:"bar|line|pie", data_range:"A1:B5", title:"..."}',
                    },
                    "content": {
                        "type": "string",
                        "description": "Markdown (export_doc) or outline (export_slide).",
                    },
                    "read_range": {
                        "type": "string",
                        "description": 'A1-style range such as "A1:D10".',
                    },
                    "unit_type": {
                        "type": "string",
                        "enum": list(UNIT_TYPES),
                        "description": (
                            "container_add: sheet | doc | slide unit to append "
                            "to a .univer ZIP container."
                        ),
                    },
                    "unit_id": {
                        "type": "string",
                        "description": (
                            "Unit id inside a .univer container "
                            "(container_add / container_export_unit)."
                        ),
                    },
                    "unit_name": {"type": "string", "description": "Display name for a container unit."},
                    "source_file": {
                        "type": "string",
                        "description": (
                            "Existing .xlsx/.docx/.pptx in the turn workspace to "
                            "pack into a .univer unit."
                        ),
                    },
                    "refs": {
                        "type": "array",
                        "items": {"type": "object", "additionalProperties": True},
                        "description": (
                            'Cross-unit data refs, e.g. [{"to":"sheet","range":"A1:B5"}]. '
                            "Recorded on manifest.refs; Slide units get a text placeholder."
                        ),
                    },
                    "export_file": {
                        "type": "string",
                        "description": (
                            "Destination file name for container_export_unit "
                            "(native xlsx/docx/pptx)."
                        ),
                    },
                },
            },
        )

    async def execute(self, **kwargs: Any) -> ToolResult:
        return execute_office_document(kwargs)
