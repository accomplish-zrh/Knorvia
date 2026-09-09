"""``office_artifact`` — small, always-on artifact lifecycle tool.

Actions: ``open`` (resolve an opaque source ref), ``create`` (new generated
xlsx/docx/pptx), ``status``, ``ready``, ``undo``, ``redo``. Heavy reads and
batch mutations live in the deferred ``office_read`` / ``office_apply``
tools so the strict operation protocol is only loaded when needed.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from knorvia.core.tool_protocol import BaseTool, ToolDefinition, ToolParameter, ToolResult
from knorvia.services.office_artifacts.contracts import (
    ArtifactNotFoundError,
    DraftStateError,
    InvalidOperationError,
    OfficeArtifactError,
    RevisionConflictError,
    SourceResolutionError,
    SourceVerificationError,
    UnsupportedOperationError,
)
from knorvia.services.office_artifacts.service import OfficeArtifactService
from knorvia.services.office_artifacts.sources import SourceContext


def build_office_service(kwargs: dict[str, Any]) -> OfficeArtifactService | None:
    """Construct the service from server-injected kwargs (never model input)."""
    from knorvia.services.path_service import get_path_service

    task_dir = str(kwargs.get("_task_dir") or "").strip()
    if not task_dir:
        return None
    workspace_dir = str(kwargs.get("_workspace_dir") or "").strip() or None
    manifest = kwargs.get("_office_attachments")
    attachment_store = kwargs.get("_office_attachment_store")
    library_store = kwargs.get("_office_library_store")
    context = SourceContext(
        session_id=str(kwargs.get("_session_id") or ""),
        attachment_manifest=manifest if isinstance(manifest, list) else [],
        path_service=get_path_service() if not kwargs.get("_office_path_service") else kwargs["_office_path_service"],
        attachment_store=attachment_store,
        library_store=library_store,
    )
    return OfficeArtifactService(
        task_dir=Path(task_dir),
        workspace_dir=Path(workspace_dir) if workspace_dir else None,
        source_context=context,
    )


def _public_root() -> Path | None:
    try:
        from knorvia.services.path_service import get_path_service

        return get_path_service().get_public_outputs_root()
    except Exception:
        return None


def tool_error_result(exc: Exception) -> ToolResult:
    """Map runtime errors to a stable, model-readable failure result."""
    if isinstance(exc, RevisionConflictError):
        current = getattr(exc, "current_revision", None)
        return ToolResult(
            content=(
                f"REVISION CONFLICT: the artifact changed since you read it "
                f"(current revision: {current}). Re-read with office_read and "
                "retry on the current revision. Nothing was modified."
            ),
            success=False,
            metadata={"error": "revision_conflict", "current_revision": current},
        )
    if isinstance(exc, UnsupportedOperationError):
        return ToolResult(
            content=f"UNSUPPORTED: {exc} (reason: {getattr(exc, 'reason', '')})",
            success=False,
            metadata={"error": "unsupported", "reason": getattr(exc, "reason", "")},
        )
    if isinstance(exc, (SourceResolutionError, SourceVerificationError, ArtifactNotFoundError)):
        return ToolResult(
            content=f"NOT RESOLVED: {exc}",
            success=False,
            metadata={"error": getattr(exc, "code", "not_found")},
        )
    if isinstance(exc, DraftStateError):
        return ToolResult(
            content=f"DRAFT STATE: {exc}",
            success=False,
            metadata={"error": "draft_state"},
        )
    if isinstance(exc, InvalidOperationError):
        return ToolResult(
            content=f"INVALID OPERATION: {exc}",
            success=False,
            metadata={"error": "invalid_operation"},
        )
    if isinstance(exc, OfficeArtifactError):
        return ToolResult(content=f"OFFICE ERROR: {exc}", success=False,
                          metadata={"error": getattr(exc, "code", "office_error")})
    return ToolResult(content=f"office tool failed: {exc}", success=False, metadata={})


def result_from_payload(payload: dict[str, Any], summary: str) -> ToolResult:
    """Envelope every mutation with the mandated metadata keys."""
    metadata = {
        "mutated": payload.get("mutated", False),
        "artifact_revision": payload.get("revision_after", payload.get("current_revision")),
        "semantic_diff": payload.get("diff") or payload.get("last_diff"),
        "verification": payload.get("verification") or payload.get("last_verification"),
        "office_draft": payload.get("office_draft"),
        "draft_id": payload.get("draft_id"),
        "draft_status": payload.get("draft_status") or payload.get("status"),
        "artifact": payload.get("artifact"),
        "calculation_required": payload.get("calculation_required", False),
    }
    return ToolResult(content=summary, success=True, metadata=metadata)


class OfficeArtifactTool(BaseTool):
    """Open/create/undo/redo Office artifacts (always mounted)."""

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="office_artifact",
            description=(
                "Open an Office source (chat attachment, library entry, workspace "
                "file) or create a new xlsx/docx/pptx artifact in an isolated "
                "draft; undo/redo changes; mark a draft ready for the user to "
                "review and merge. Sources are opaque refs like "
                "`attachment:<id>`, `library:<entry-id>`, `workspace:<ref>` — "
                "never file paths. After opening, load `office_read` and "
                "`office_apply` via load_tools to inspect and edit."
            ),
            parameters=[
                ToolParameter(
                    name="action",
                    type="string",
                    enum=["open", "create", "status", "ready", "undo", "redo"],
                    description=(
                        "open=resolve a source into a draft artifact; create=new "
                        "generated artifact; ready=ask the user to confirm merge; "
                        "undo/redo=move the revision cursor; status=draft state."
                    ),
                ),
                ToolParameter(name="source", type="string",
                              description="open: opaque source ref (attachment:<id> | library:<id> | workspace:<ref>)."),
                ToolParameter(name="filename", type="string",
                              description="create: artifact file name, e.g. report.xlsx."),
                ToolParameter(name="kind", type="string", enum=["xlsx", "docx", "pptx"],
                              description="create: artifact kind."),
                ToolParameter(name="draft_id", type="string",
                              description="Existing draft id; omitted on open/create a new one is created."),
                ToolParameter(name="artifact_id", type="string",
                              description="undo/redo: artifact inside the draft."),
            ],
        )

    async def execute(self, **kwargs: Any) -> ToolResult:
        service = build_office_service(kwargs)
        if service is None:
            return ToolResult(
                content="office tools need a turn workspace (no task dir injected).",
                success=False,
            )
        action = str(kwargs.get("action") or "").strip().lower()
        draft_id = str(kwargs.get("draft_id") or kwargs.get("_office_draft_id") or "").strip()
        try:
            if action == "open":
                payload = service.open_source(
                    str(kwargs.get("source") or ""), draft_id=draft_id or None
                )
                artifact = payload["artifact"]
                return result_from_payload(
                    {**payload, "mutated": False},
                    f"Opened {artifact['origin_ref']} as artifact {artifact['artifact_id']} "
                    f"({artifact['filename']}) in draft {payload['draft_id']}. "
                    "Now load office_read/office_apply via load_tools, then start "
                    "with an office_read overview.",
                )
            if action == "create":
                filename = str(kwargs.get("filename") or "").strip()
                kind = str(kwargs.get("kind") or "xlsx").strip().lower()
                if not filename:
                    raise InvalidOperationError("create requires a filename")
                payload = service.create_generated(
                    filename, kind, draft_id=draft_id or None
                )
                artifact = payload["artifact"]
                return result_from_payload(
                    {**payload, "mutated": False},
                    f"Created generated {kind} artifact {artifact['artifact_id']} "
                    f"({artifact['filename']}) in draft {payload['draft_id']}. "
                    "Load office_read/office_apply via load_tools to edit it.",
                )
            if not draft_id:
                raise InvalidOperationError("draft_id is required for this action")
            if action == "status":
                payload = service.card_payload(draft_id)
                return result_from_payload(
                    {**payload, "mutated": False},
                    f"Draft {draft_id} is {payload.get('draft_status')} with "
                    f"{len(payload.get('artifacts') or [])} artifact(s).",
                )
            if action == "ready":
                meta = service.mark_ready(draft_id)
                payload = service.card_payload(draft_id)
                return result_from_payload(
                    {**payload, "mutated": False},
                    f"Draft {draft_id} is ready. The user can now review the "
                    "semantic diff and confirm the merge. Never merge yourself.",
                )
            if action in ("undo", "redo"):
                artifact_id = str(kwargs.get("artifact_id") or "").strip()
                if not artifact_id:
                    raise InvalidOperationError(f"{action} requires artifact_id")
                state = service.undo(draft_id, artifact_id) if action == "undo" \
                    else service.redo(draft_id, artifact_id)
                payload = service.card_payload(draft_id)
                return result_from_payload(
                    {**payload, "mutated": False},
                    f"{action.capitalize()} done: artifact {artifact_id} is now at "
                    f"revision {state['current_revision']}.",
                )
            return ToolResult(
                content=f"Invalid action {action!r}. Valid: open, create, status, ready, undo, redo.",
                success=False,
            )
        except Exception as exc:  # noqa: BLE001 - tool boundary
            return tool_error_result(exc)
