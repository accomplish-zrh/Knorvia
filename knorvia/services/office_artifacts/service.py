"""OfficeArtifactService — the single orchestration entry.

Agent tools and human-editing API endpoints both land here. Every mutation:

1. is based on a concrete revision (``base_revision`` CAS — stale base →
   conflict, never last-writer-wins),
2. applies to an isolated draft artifact as one atomic transaction,
3. produces a semantic diff built from before/after read models,
4. is verified (re-open, target read-back, ZIP structure, untouched OOXML
   parts) *before* the revision advances, and
5. only reaches the outside world (workspace / library / output file) when
   the user confirms the merge — with a CAS check for library origins.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from knorvia.services.office_artifacts.addresses import (
    col_width,
    freeze_state,
    merged_state,
    op_targets,
    range_value_for,
    row_height,
    union_cells,
)
from knorvia.services.office_artifacts.contracts import (
    MAX_RANGE_HITS,
    ApplyBatchResult,
    ClearCellsOp,
    FreezePanesOp,
    InvalidOperationError,
    MergeCellsOp,
    MergeConflictError,
    RevisionConflictError,
    SetCellOp,
    SetColumnWidthOp,
    SetFormulaOp,
    SetRangeOp,
    SetRowHeightOp,
    UnmergeCellsOp,
    UnsupportedOperationError,
    VerificationError,
    VerificationSummary,
    parse_operations,
    parse_source_ref,
)
from knorvia.services.office_artifacts.diff import (
    DiffEntry,
    build_semantic_diff,
    diff_entries_from_snapshots,
)
from knorvia.services.office_artifacts.merge_coordinator import MergeCoordinator
from knorvia.services.office_artifacts.sources import (
    ResolvedSource,
    SourceContext,
    resolve_source,
)
from knorvia.services.office_artifacts.store import (
    OfficeArtifactStore,
)
from knorvia.services.office_artifacts.store_io import (
    safe_component,
    sha256_of,
)
from knorvia.services.office_artifacts.verification import (
    REQUIRED_XLSX_PARTS,
    allowed_changed_parts,
    compute_untouched_violations,
    verify_package_relations,
    verify_zip_structure,
)

if TYPE_CHECKING:
    from knorvia.services.office_artifacts.adapters.xlsx_reader import XlsxReader

XLSX_KINDS = {"xlsx"}
GENERATED_KINDS = {"xlsx", "docx", "pptx"}


def _kind_of_filename(filename: str) -> str:
    from pathlib import PurePath

    suffix = PurePath(filename).suffix.lower()
    return {".xlsx": "xlsx", ".xlsm": "xlsx", ".docx": "docx", ".pptx": "pptx"}.get(
        suffix, "binary"
    )


class OfficeArtifactService:
    """All agent and human Office mutations flow through this class."""

    def __init__(
        self,
        *,
        task_dir: Path,
        workspace_dir: Path | None = None,
        public_root: Path | None = None,
        source_context: SourceContext | None = None,
    ) -> None:
        self.store = OfficeArtifactStore(
            task_dir, workspace_dir=workspace_dir, public_root=public_root
        )
        self.source_context = source_context or SourceContext()

    # ------------------------------------------------------------------
    # Open / create
    # ------------------------------------------------------------------

    def open_source(
        self,
        source: str,
        *,
        draft_id: str | None = None,
        filename_override: str | None = None,
        expected_base_hash: str | None = None,
    ) -> dict[str, Any]:
        """Resolve an opaque source ref into a draft artifact."""
        parsed = parse_source_ref(source)
        if parsed.kind == "generated":
            raise InvalidOperationError("use create_generated for generated:new sources")
        resolved = resolve_source(parsed, self.source_context)
        if expected_base_hash and resolved.data is not None:
            # Checked before anything is created, so a refused open leaves no
            # draft directory behind.
            if sha256_of(resolved.data) != expected_base_hash.strip().lower():
                raise MergeConflictError(
                    "this file changed since it was opened; close and reopen the "
                    "editor to get the latest version before saving"
                )
        return self._register_resolved(resolved, draft_id=draft_id)

    def _register_resolved(
        self, resolved: ResolvedSource, *, draft_id: str | None, filename_override: str | None = None
    ) -> dict[str, Any]:
        draft_id = draft_id or self.store.create_draft()
        artifact_id = self.store.add_artifact(
            draft_id,
            filename=filename_override or resolved.filename,
            mime=resolved.mime,
            kind=_kind_of_filename(resolved.filename),
            origin_kind=resolved.kind,
            origin_ref=resolved.origin_ref,
            origin_base_hash=resolved.base_hash,
            data=resolved.data,
        )
        manifest = self.store.manifest(draft_id, artifact_id)
        return {
            "draft_id": draft_id,
            "artifact": manifest,
            "card": self.store.card_payload(draft_id),
        }

    def create_generated(
        self,
        filename: str,
        kind: str,
        *,
        sheet: str | None = None,
        draft_id: str | None = None,
    ) -> dict[str, Any]:
        safe_name = safe_component(filename)
        if not safe_name.lower().endswith(f".{kind}"):
            safe_name = safe_component(f"{safe_name}.{kind}")
        # Lazy heavy imports: importing this module must stay cheap for the
        # API import-memory boundary (openpyxl/pptx/docx stay cold).
        if kind == "xlsx":
            from knorvia.services.office_artifacts.adapters import xlsx_adapter

            base = xlsx_adapter.create_generated_xlsx(sheet or "Sheet")
        elif kind == "docx":
            from knorvia.services.office_artifacts.adapters.generated_docx import (
                generate_docx,
            )

            base = generate_docx("# Document\n")
        elif kind == "pptx":
            from knorvia.services.office_artifacts.adapters.generated_pptx import (
                generate_pptx,
            )

            base, _slides = generate_pptx("# Deck\n")
        else:
            raise UnsupportedOperationError(
                f"generated kind {kind!r} is not supported", reason="unsupported_kind"
            )
        draft_id = draft_id or self.store.create_draft()
        artifact_id = self.store.add_artifact(
            draft_id,
            filename=safe_name,
            mime="",
            kind=kind,
            origin_kind="generated",
            origin_ref="generated:new",
            origin_base_hash=sha256_of(base),
            data=base,
        )
        manifest = self.store.manifest(draft_id, artifact_id)
        return {
            "draft_id": draft_id,
            "artifact": manifest,
            "card": self.store.card_payload(draft_id),
        }

    # ------------------------------------------------------------------
    # Reads (never mutate)
    # ------------------------------------------------------------------

    def _reader(self, draft_id: str, artifact_id: str, revision: int | None) -> XlsxReader:
        manifest = self.store.manifest(draft_id, artifact_id)
        if manifest.get("kind") not in ("xlsx", "xlsm"):
            raise UnsupportedOperationError(
                f"artifact {artifact_id} is {manifest.get('kind')!r}; XLSX reads only",
                reason="not_a_spreadsheet",
            )
        data = (
            self.store.current_bytes(draft_id, artifact_id)
            if revision is None
            else self.store.revision_bytes(draft_id, artifact_id, revision)
        )
        from knorvia.services.office_artifacts.adapters.xlsx_reader import XlsxReader

        return XlsxReader(data)

    def overview(
        self, draft_id: str, artifact_id: str, revision: int | None = None
    ) -> dict[str, Any]:
        manifest = self.store.manifest(draft_id, artifact_id)
        imported = manifest.get("origin_kind") != "generated"
        model = self._reader(draft_id, artifact_id, revision)
        allowed = [
            "set_cell", "set_formula", "clear_cells", "set_range", "copy_style",
            "merge_cells", "unmerge_cells", "set_row_height", "set_column_width",
            "freeze_panes",
        ]
        return {
            "artifact_id": artifact_id,
            "filename": manifest["filename"],
            "origin_kind": manifest.get("origin_kind"),
            "origin_ref": manifest.get("origin_ref"),
            "current_revision": self.store.current_revision(draft_id, artifact_id),
            "reading_revision": manifest.get("current_revision") if revision is None else revision,
            "sheets": model.overview()["sheets"],
            "features": model.features(),
            "external_links": model.external_link_count(),
            "allowed_operations": allowed,
            "edit_policy": (
                "generated workbook: full rewrite allowed"
                if not imported
                else "imported workbook: narrow OOXML patch only; unsupported "
                "operations fail closed"
            ),
        }

    def read_range(
        self,
        draft_id: str,
        artifact_id: str,
        sheet: str | None,
        range_str: str | None,
        revision: int | None = None,
    ) -> dict[str, Any]:
        model = self._reader(draft_id, artifact_id, revision)
        result = model.read_range(sheet, range_str)
        result["revision"] = (
            self.store.current_revision(draft_id, artifact_id)
            if revision is None
            else revision
        )
        return result

    def find(
        self,
        draft_id: str,
        artifact_id: str,
        query: str,
        *,
        sheet: str | None = None,
        scope: str | None = None,
        max_hits: int = 50,
    ) -> dict[str, Any]:
        model = self._reader(draft_id, artifact_id, None)
        hits = model.find(query, sheet=sheet, scope=scope, max_hits=min(max_hits, MAX_RANGE_HITS))
        return {"query": query, "hits": hits, "hit_count": len(hits)}

    def features(
        self, draft_id: str, artifact_id: str, sheet: str | None = None
    ) -> dict[str, Any]:
        model = self._reader(draft_id, artifact_id, None)
        return model.features(sheet)

    def diff_between(
        self,
        draft_id: str,
        artifact_id: str,
        *,
        from_revision: int,
        to_revision: int | None = None,
    ) -> dict[str, Any]:
        """Semantic diff between two revisions of one artifact."""
        manifest = self.store.manifest(draft_id, artifact_id)
        current = int(manifest.get("current_revision") or 0)
        to_revision = current if to_revision is None else int(to_revision)
        if manifest.get("kind") not in ("xlsx", "xlsm"):
            raise UnsupportedOperationError(
                "semantic diff is XLSX-only in this phase", reason="not_a_spreadsheet"
            )
        before_data = self.store.revision_bytes(draft_id, artifact_id, from_revision)
        after_data = self.store.revision_bytes(draft_id, artifact_id, to_revision)
        from knorvia.services.office_artifacts.adapters.xlsx_reader import XlsxReader

        before_reader, after_reader = XlsxReader(before_data), XlsxReader(after_data)
        before_sheets = set(before_reader.sheet_names())
        after_sheets = set(after_reader.sheet_names())
        entries: list[DiffEntry] = []
        for sheet in sorted(before_sheets | after_sheets):
            if sheet not in after_sheets:
                entries.append(
                    DiffEntry(sheet=sheet, kind="sheet", target=sheet,
                              before={"present": True}, after={"present": False})
                )
                continue
            if sheet not in before_sheets:
                entries.append(
                    DiffEntry(sheet=sheet, kind="sheet", target=sheet,
                              before={"present": False}, after={"present": True})
                )
                continue
            # Compare the union of both used ranges: a cell outside the old
            # bounds is still a change the reviewer has to see.
            targets = union_cells(before_reader, after_reader, sheet)
            before_map = before_reader.snapshot_cells(sheet, targets)
            after_map = after_reader.snapshot_cells(sheet, targets)
            entries.extend(diff_entries_from_snapshots(sheet, before_map, after_map))
        diff = build_semantic_diff(entries)
        result = diff.model_dump()
        result.update(
            {
                "artifact_id": artifact_id,
                "from_revision": from_revision,
                "to_revision": to_revision,
            }
        )
        return result

    def history(self, draft_id: str, artifact_id: str) -> dict[str, Any]:
        manifest = self.store.manifest(draft_id, artifact_id)
        records = []
        for revision in manifest.get("history") or [0]:
            record = self.store.revision_record(draft_id, artifact_id, int(revision))
            records.append(
                {
                    "revision": int(revision),
                    "detached": bool(record.get("detached")),
                    "actor": record.get("actor"),
                    "created_at": record.get("created_at"),
                    "operations_summary": record.get("operations_summary") or [],
                    "calculation_required": bool(record.get("calculation_required")),
                }
            )
        return {
            "artifact_id": artifact_id,
            "current_revision": int(manifest.get("current_revision") or 0),
            "cursor": int(manifest.get("cursor") or 0),
            "history": records,
        }

    # ------------------------------------------------------------------
    # Apply — the one mutation entry for agents and humans alike
    # ------------------------------------------------------------------

    def apply_operations(
        self,
        draft_id: str,
        artifact_id: str,
        base_revision: int,
        operations_raw: Any,
        *,
        actor: str = "agent",
    ) -> dict[str, Any]:
        self.store.assert_writable(draft_id)
        manifest = self.store.manifest(draft_id, artifact_id)
        kind = manifest.get("kind")
        imported = manifest.get("origin_kind") != "generated"
        if kind not in ("xlsx", "xlsm"):
            raise UnsupportedOperationError(
                f"batch operations are XLSX-only in this phase; this artifact is "
                f"{kind!r} (created via {'narrow patch' if imported else 'generation'})",
                reason="not_a_spreadsheet",
            )
        operations = parse_operations(operations_raw)

        current_revision = self.store.current_revision(draft_id, artifact_id)
        if int(base_revision) != current_revision:
            raise RevisionConflictError(
                f"artifact {artifact_id} is at revision {current_revision}, "
                f"caller based the batch on {int(base_revision)}",
                current_revision=current_revision,
            )

        original = self.store.current_bytes(draft_id, artifact_id)
        before_snapshots = self._snapshots_for(original, operations)

        from knorvia.services.office_artifacts.adapters import xlsx_adapter
        from knorvia.services.office_artifacts.adapters.xlsx_reader import XlsxReader

        if imported:
            outcome = xlsx_adapter.apply_to_imported(original, operations)
        else:
            outcome = xlsx_adapter.apply_to_generated(original, operations)

        # Verification BEFORE the revision can advance.
        verification = self._verify(
            original_bytes=original,
            candidate_bytes=outcome.new_bytes,
            imported=imported,
            operations=operations,
            allowed_parts=outcome.allowed_parts_hint,
        )

        after_snapshots = self._snapshots_for(outcome.new_bytes, operations)
        entries: list[DiffEntry] = []
        before_reader = XlsxReader(original)
        after_reader = XlsxReader(outcome.new_bytes)
        for op in operations:
            sheet = op.sheet
            if isinstance(op, MergeCellsOp):
                before_state = merged_state(before_reader, sheet, op.range)
                after_state = merged_state(after_reader, sheet, op.range)
                if before_state != after_state:
                    entries.append(
                        DiffEntry(sheet=sheet, kind="merge", target=op.range,
                                  before={"merged": before_state}, after={"merged": after_state})
                    )
            elif isinstance(op, UnmergeCellsOp):
                before_state = merged_state(before_reader, sheet, op.range)
                after_state = merged_state(after_reader, sheet, op.range)
                if before_state != after_state:
                    entries.append(
                        DiffEntry(sheet=sheet, kind="merge", target=op.range,
                                  before={"merged": before_state}, after={"merged": after_state})
                    )
            elif isinstance(op, SetRowHeightOp):
                before_h = row_height(before_reader, sheet, op.row)
                after_h = row_height(after_reader, sheet, op.row)
                if before_h != after_h:
                    entries.append(
                        DiffEntry(sheet=sheet, kind="dimension", target=f"row:{op.row}",
                                  before={"height": before_h}, after={"height": after_h})
                    )
            elif isinstance(op, SetColumnWidthOp):
                before_w = col_width(before_reader, sheet, op.column)
                after_w = col_width(after_reader, sheet, op.column)
                if before_w != after_w:
                    entries.append(
                        DiffEntry(sheet=sheet, kind="dimension", target=f"col:{op.column}",
                                  before={"width": before_w}, after={"width": after_w})
                    )
            elif isinstance(op, FreezePanesOp):
                before_f = freeze_state(before_reader, sheet)
                after_f = freeze_state(after_reader, sheet)
                if before_f != after_f:
                    entries.append(
                        DiffEntry(sheet=sheet, kind="freeze",
                                  target=f"freeze:{op.cell or 'none'}",
                                  before={"freeze_panes": before_f},
                                  after={"freeze_panes": after_f})
                    )
        for sheet, before_map in before_snapshots.items():
            entries.extend(
                diff_entries_from_snapshots(sheet, before_map, after_snapshots.get(sheet, {}))
            )
        diff = build_semantic_diff(entries)

        summary = [
            f"{idx + 1}. {op.op} {op.sheet}!"
            + (
                op.cell
                if isinstance(op, (SetCellOp, SetFormulaOp))
                else (op.range if hasattr(op, "range") else getattr(op, "target_range", ""))
            )
            for idx, op in enumerate(operations)
        ]
        commit = self.store.commit_revision(
            draft_id,
            artifact_id,
            new_bytes=outcome.new_bytes,
            base_revision=int(base_revision),
            actor=actor,
            operations_summary=summary,
            diff=diff.model_dump(),
            verification=verification.model_dump(),
            calculation_required=outcome.calculation_required,
        )
        if commit.get("unchanged"):
            return {
                "mutated": False,
                "unchanged": True,
                "artifact_id": artifact_id,
                "filename": manifest["filename"],
                "revision_before": commit["revision_before"],
                "revision_after": commit["revision_after"],
                "note": "the batch produced byte-identical content; no new revision",
            }

        result = ApplyBatchResult(
            mutated=True,
            artifact_id=artifact_id,
            filename=manifest["filename"],
            revision_before=int(commit["revision_before"]),
            revision_after=int(commit["revision_after"]),
            touched_cells=outcome.touched_cells,
            diff=diff,
            verification=verification,
            calculation_required=outcome.calculation_required,
        )
        payload = result.model_dump()
        payload["card"] = self.store.card_payload(draft_id)
        return payload

    def _snapshots_for(
        self, data: bytes, operations: list[Any]
    ) -> dict[str, dict[str, dict[str, Any]]]:
        from knorvia.services.office_artifacts.adapters.xlsx_reader import XlsxReader

        reader = XlsxReader(data)
        per_sheet: dict[str, set[str]] = {}
        for op in operations:
            targets = op_targets(op)
            per_sheet.setdefault(op.sheet, set()).update(targets)
        snapshots: dict[str, dict[str, dict[str, Any]]] = {}
        for sheet, targets in per_sheet.items():
            if sheet in reader.sheet_names():
                snapshots[sheet] = reader.snapshot_cells(sheet, sorted(targets))
        return snapshots

    def _verify(
        self,
        *,
        original_bytes: bytes,
        candidate_bytes: bytes,
        imported: bool,
        operations: list[Any],
        allowed_parts: list[str] | None = None,
    ) -> VerificationSummary:
        notes: list[str] = []
        verify_zip_structure(candidate_bytes, required_parts=REQUIRED_XLSX_PARTS)
        verify_package_relations(candidate_bytes)
        zip_valid = True
        from knorvia.services.office_artifacts.adapters.xlsx_reader import XlsxReader

        reader = XlsxReader(candidate_bytes)  # reopen guard
        reopened = True

        if imported:
            violations = compute_untouched_violations(
                original_bytes, candidate_bytes, allowed_parts or []
            )
            allowed = allowed_changed_parts(original_bytes, candidate_bytes)
            if violations:
                raise VerificationError(
                    "untouched OOXML parts changed: " + ", ".join(violations[:10])
                )
            untouched_ok = True
        else:
            allowed = ["<generated workbook: openpyxl rewrite>"]
            untouched_ok = True
            notes.append("generated artifact: full rewrite is allowed by policy")

        # Target read-back: every write op must be observable in the reopened file.
        expectations: dict[str, dict[str, tuple[str, Any]]] = {}
        for op in operations:
            targets = op_targets(op)
            for target in targets:
                if isinstance(op, SetCellOp):
                    if op.text is not None:
                        expectations.setdefault(op.sheet, {})[target] = ("value", op.text)
                    elif op.number is not None:
                        expectations.setdefault(op.sheet, {})[target] = ("number", op.number)
                    elif op.boolean is not None:
                        expectations.setdefault(op.sheet, {})[target] = ("value", op.boolean)
                    elif op.empty:
                        expectations.setdefault(op.sheet, {})[target] = ("empty", None)
                elif isinstance(op, SetFormulaOp):
                    expectations.setdefault(op.sheet, {})[target] = ("formula", op.formula)
                elif isinstance(op, ClearCellsOp) or (
                    isinstance(op, SetRangeOp)
                ):
                    if isinstance(op, ClearCellsOp):
                        expectations.setdefault(op.sheet, {})[target] = ("empty", None)
                    else:
                        offset_targets = op_targets(op)
                        for cell_ref in offset_targets:
                            value = range_value_for(op, cell_ref)
                            if value is None:
                                expectations.setdefault(op.sheet, {})[cell_ref] = ("empty", None)
                            elif isinstance(value, str):
                                expectations.setdefault(op.sheet, {})[cell_ref] = ("value", value)
                            elif isinstance(value, bool):
                                expectations.setdefault(op.sheet, {})[cell_ref] = ("value", value)
                            else:
                                expectations.setdefault(op.sheet, {})[cell_ref] = (
                                    "number",
                                    float(value),
                                )

        readback_ok = True
        for sheet, cell_map in expectations.items():
            if sheet not in reader.sheet_names():
                continue
            snapshots = reader.snapshot_cells(sheet, sorted(cell_map))
            for cell_ref, (mode, expected) in cell_map.items():
                snap = snapshots.get(cell_ref) or {}
                if mode == "empty":
                    if snap.get("value") is not None or snap.get("formula"):
                        readback_ok = False
                elif mode == "formula":
                    if str(snap.get("formula") or "").lstrip("=") != str(expected).lstrip("="):
                        readback_ok = False
                elif mode == "number":
                    try:
                        if float(snap.get("value")) != float(expected):  # type: ignore[arg-type]
                            readback_ok = False
                    except (TypeError, ValueError):
                        readback_ok = False
                else:
                    if snap.get("value") != expected:
                        readback_ok = False
        if not readback_ok:
            raise VerificationError(
                "target read-back failed: mutated cells do not read back as expected"
            )

        return VerificationSummary(
            reopened=reopened,
            target_readback=readback_ok,
            zip_structure_valid=zip_valid,
            untouched_parts_verified=untouched_ok,
            allowed_changed_parts=allowed,
            notes=notes,
        )

    # ------------------------------------------------------------------
    # Undo / redo
    # ------------------------------------------------------------------

    def undo(self, draft_id: str, artifact_id: str) -> dict[str, Any]:
        self.store.assert_writable(draft_id)
        state = self.store.undo(draft_id, artifact_id)
        state["card"] = self.store.card_payload(draft_id)
        return state

    def redo(self, draft_id: str, artifact_id: str) -> dict[str, Any]:
        self.store.assert_writable(draft_id)
        state = self.store.redo(draft_id, artifact_id)
        state["card"] = self.store.card_payload(draft_id)
        return state

    # ------------------------------------------------------------------
    # Lifecycle + merge
    # ------------------------------------------------------------------

    def mark_ready(self, draft_id: str) -> dict[str, Any]:
        return self.store.mark_ready(draft_id)

    def discard(self, draft_id: str) -> dict[str, Any]:
        return self.store.discard(draft_id)

    def merge(self, draft_id: str) -> dict[str, Any]:
        """User-confirmed merge: staged by the merge coordinator."""
        return MergeCoordinator(self.store, self.source_context).merge(draft_id)

    def status(self, draft_id: str) -> dict[str, Any]:
        return self.store.status(draft_id)

    def card_payload(self, draft_id: str) -> dict[str, Any]:
        return self.store.card_payload(draft_id)
