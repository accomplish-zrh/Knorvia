"""HTTP API for office-draft review cards in chat.

PATCH ``/api/v1/chat/office-drafts/{draft_id}`` is the user-facing confirm /
discard control. Auth matches ``/api/outputs``: the authenticated user's
workspace only; not admin-gated.

Drafts created by the Office artifact runtime v2 (``office_drafts/<id>/meta.json``
plus a revision journal) are served by the same endpoints and additionally get
typed artifact endpoints: reads (overview/range/find/diff/history), strict
operation batches (the same protocol the agent uses, ``actor="user"``), undo /
redo, and raw content download for the spreadsheet editor. Legacy v1 drafts
fall back to the original store.
"""

from __future__ import annotations

import mimetypes
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, ValidationError

from knorvia.api.routers.auth import require_auth
from knorvia.multi_user.context import get_current_user_or_none
from knorvia.multi_user.paths import get_path_service_for_scope
from knorvia.services.auth import TokenPayload
from knorvia.services.office_artifacts.contracts import (
    InvalidOperationError,
    OfficeArtifactError,
    parse_operations,
)
from knorvia.services.office_artifacts.service import OfficeArtifactService
from knorvia.services.office_artifacts.store import OfficeArtifactStore
from knorvia.services.office_draft import (
    DraftError,
    DraftNotFoundError,
    DraftTransitionError,
    OfficeDraftStore,
    validate_draft_id,
)
from knorvia.services.path_service import PathService

router = APIRouter()


class OfficeDraftPatch(BaseModel):
    """Body for confirm/discard. ``action`` is the only field the card sends."""

    action: Literal["merge", "discard"] = Field(..., description="merge | discard")


class ArtifactOperationBatch(BaseModel):
    """One atomic, strictly-typed batch against a known base revision."""

    base_revision: int = Field(..., description="Revision the batch was based on")
    operations: list[dict[str, Any]] = Field(..., description="Operation protocol batch")


class OfficeSourceOpen(BaseModel):
    """Open an opaque source ref (library entry, workspace file) as a draft."""

    source: str = Field(..., description="library:<id> | workspace:<ref> | attachment:<id>")
    expected_base_hash: str | None = Field(
        default=None,
        description="SHA-256 of the bytes the caller is editing; 409 if the "
        "source has changed since it was read",
    )


def _request_path_service() -> PathService:
    """Resolve the workspace installed by ``require_auth`` without fallback."""
    user = get_current_user_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Draft not found")
    return get_path_service_for_scope(user.scope)


def _validate(draft_id: str) -> str:
    try:
        return validate_draft_id(draft_id)
    except DraftError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Draft not found"
        ) from exc


def _roots() -> tuple[PathService, Any, Any]:
    path_service = _request_path_service()
    return (
        path_service,
        path_service.get_public_outputs_root(),
        path_service.get_chat_workspace_root(),
    )


def _load_v2_service(draft_id: str) -> OfficeArtifactService:
    draft_id = _validate(draft_id)
    path_service, public_root, chat_root = _roots()
    try:
        store = OfficeArtifactStore.locate(
            draft_id, public_root=public_root, chat_root=chat_root
        )
    except OfficeArtifactError as exc:
        raise _office_http_error(exc) from exc
    # Library-origin drafts merge back into the creative library, so the
    # reconstructed service must carry the same source context as ``open``.
    from knorvia.services.creative_library.store import get_creative_library_store
    from knorvia.services.office_artifacts.sources import SourceContext

    return OfficeArtifactService(
        task_dir=store.task_dir,
        workspace_dir=store.workspace_dir,
        public_root=public_root,
        source_context=SourceContext(
            path_service=path_service,
            library_store=get_creative_library_store(),
        ),
    )


def _load_v1_store(draft_id: str) -> OfficeDraftStore:
    try:
        token = _validate(draft_id)
    except HTTPException:
        raise
    path_service, public_root, chat_root = _roots()
    try:
        return OfficeDraftStore.locate(
            token,
            public_root=public_root,
            chat_root=chat_root,
        )
    except DraftNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Draft not found"
        ) from exc
    except DraftError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


def _office_http_error(exc: OfficeArtifactError) -> HTTPException:
    return HTTPException(
        status_code=getattr(exc, "http_status", status.HTTP_400_BAD_REQUEST),
        detail=str(exc),
    )


def _v2_card(service: OfficeArtifactService, draft_id: str) -> dict[str, object]:
    card = service.card_payload(draft_id)
    artifacts = card.get("artifacts") or []
    latest_diff = artifacts[0].get("last_diff") if artifacts else None
    return {
        "draft_id": card.get("draft_id"),
        "status": card.get("draft_status"),
        "files": card.get("files") or [],
        "artifacts": artifacts,
        "diff": latest_diff or [],
    }


def _payload(store: OfficeDraftStore, draft_id: str) -> dict[str, object]:
    card = store.card_payload(draft_id)
    nested = card.get("office_draft") if isinstance(card.get("office_draft"), dict) else {}
    return {
        "draft_id": card.get("draft_id"),
        "status": card.get("draft_status") or nested.get("status"),
        "files": card.get("files") or [],
        "diff": store.diff(draft_id),
    }


@router.get("/chat/office-drafts/{draft_id}")
async def read_office_draft(
    draft_id: str,
    _auth: TokenPayload | None = Depends(require_auth),
) -> dict[str, object]:
    """Return the current draft card payload for the authenticated user."""
    try:
        service = _load_v2_service(draft_id)
    except HTTPException as exc:
        if exc.status_code != status.HTTP_404_NOT_FOUND:
            raise
        store = _load_v1_store(draft_id)
        try:
            return _payload(store, draft_id)
        except DraftNotFoundError as exc_v1:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Draft not found"
            ) from exc_v1
    return _v2_card(service, draft_id)


@router.patch("/chat/office-drafts/{draft_id}")
async def patch_office_draft(
    draft_id: str,
    body: OfficeDraftPatch,
    _auth: TokenPayload | None = Depends(require_auth),
) -> dict[str, object]:
    """Merge a ready draft into the official workspace, or discard it."""
    try:
        service = _load_v2_service(draft_id)
        try:
            if body.action == "merge":
                # The review card can confirm from ``draft`` (agent never
                # called ready). User confirmation is the ready+merge. The
                # agent-side tool still cannot skip ``ready``.
                current = service.status(draft_id)["status"]
                if current == "draft":
                    service.mark_ready(draft_id)
                service.merge(draft_id)
            else:
                service.discard(draft_id)
            return _v2_card(service, draft_id)
        except OfficeArtifactError as exc:
            raise _office_http_error(exc) from exc
    except HTTPException as exc:
        if exc.status_code != status.HTTP_404_NOT_FOUND:
            raise
    store = _load_v1_store(draft_id)
    try:
        if body.action == "merge":
            current = store.status(draft_id)["status"]
            if current == "draft":
                store.mark_ready(draft_id)
            store.merge(draft_id)
        else:
            store.discard(draft_id)
        return _payload(store, draft_id)
    except DraftNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Draft not found"
        ) from exc
    except DraftTransitionError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except DraftError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


# ----------------------------------------------------------------------
# v2 typed artifact endpoints (Office artifact runtime only)
# ----------------------------------------------------------------------


@router.post("/chat/office-drafts/open")
async def open_office_draft(
    body: OfficeSourceOpen,
    _auth: TokenPayload | None = Depends(require_auth),
) -> dict[str, object]:
    """Open a source (e.g. a library entry) in a fresh draft for human editing.

    The human save path then POSTs operation batches and PATCHes merge — the
    same protocol the agent uses, so the CAS/verification rules are identical.
    """
    path_service = _request_path_service()
    from uuid import uuid4

    from knorvia.services.office_artifacts.sources import SourceContext

    task_dir = path_service.get_task_workspace("chat", f"office-editor-{uuid4().hex[:8]}")
    library_store = None
    if body.source.startswith("library:"):
        from knorvia.services.creative_library.store import get_creative_library_store

        library_store = get_creative_library_store()
    service = OfficeArtifactService(
        task_dir=task_dir,
        workspace_dir=task_dir / "exec",
        public_root=path_service.get_public_outputs_root(),
        source_context=SourceContext(
            path_service=path_service,
            library_store=library_store,
        ),
    )
    try:
        payload = service.open_source(
            body.source, expected_base_hash=body.expected_base_hash
        )
    except OfficeArtifactError as exc:
        raise _office_http_error(exc) from exc
    return {**payload, "card": _v2_card(service, str(payload["draft_id"]))}


@router.get("/chat/office-drafts/{draft_id}/artifacts/{artifact_id}/overview")
async def read_artifact_overview(
    draft_id: str,
    artifact_id: str,
    revision: int | None = None,
    _auth: TokenPayload | None = Depends(require_auth),
) -> dict[str, object]:
    service = _load_v2_service(draft_id)
    try:
        return service.overview(draft_id, artifact_id, revision)
    except OfficeArtifactError as exc:
        raise _office_http_error(exc) from exc


@router.get("/chat/office-drafts/{draft_id}/artifacts/{artifact_id}/range")
async def read_artifact_range(
    draft_id: str,
    artifact_id: str,
    sheet: str | None = None,
    range: str | None = None,  # noqa: A002 - query param name is the protocol
    revision: int | None = None,
    _auth: TokenPayload | None = Depends(require_auth),
) -> dict[str, object]:
    service = _load_v2_service(draft_id)
    try:
        return service.read_range(draft_id, artifact_id, sheet, range, revision)
    except OfficeArtifactError as exc:
        raise _office_http_error(exc) from exc


@router.get("/chat/office-drafts/{draft_id}/artifacts/{artifact_id}/find")
async def read_artifact_find(
    draft_id: str,
    artifact_id: str,
    q: str,
    sheet: str | None = None,
    scope: str | None = None,
    max_hits: int = 50,
    _auth: TokenPayload | None = Depends(require_auth),
) -> dict[str, object]:
    service = _load_v2_service(draft_id)
    try:
        return service.find(draft_id, artifact_id, q, sheet=sheet, scope=scope, max_hits=max_hits)
    except OfficeArtifactError as exc:
        raise _office_http_error(exc) from exc


@router.get("/chat/office-drafts/{draft_id}/artifacts/{artifact_id}/diff")
async def read_artifact_diff(
    draft_id: str,
    artifact_id: str,
    from_revision: int,
    to_revision: int | None = None,
    _auth: TokenPayload | None = Depends(require_auth),
) -> dict[str, object]:
    service = _load_v2_service(draft_id)
    try:
        diff = service.diff_between(
            draft_id, artifact_id, from_revision=from_revision, to_revision=to_revision
        )
        entries = diff.get("entries") or []
        return {
            "diff": diff,
            "entry_count": len(entries),
            "omitted_count": int(diff.get("omitted_count") or 0),
        }
    except OfficeArtifactError as exc:
        raise _office_http_error(exc) from exc


@router.get("/chat/office-drafts/{draft_id}/artifacts/{artifact_id}/history")
async def read_artifact_history(
    draft_id: str,
    artifact_id: str,
    _auth: TokenPayload | None = Depends(require_auth),
) -> dict[str, object]:
    service = _load_v2_service(draft_id)
    try:
        return service.history(draft_id, artifact_id)
    except OfficeArtifactError as exc:
        raise _office_http_error(exc) from exc


@router.get("/chat/office-drafts/{draft_id}/artifacts/{artifact_id}/content")
async def read_artifact_content(
    draft_id: str,
    artifact_id: str,
    revision: int | None = None,
    _auth: TokenPayload | None = Depends(require_auth),
) -> Response:
    """Raw artifact bytes (current or requested revision) for the editor."""
    service = _load_v2_service(draft_id)
    try:
        manifest = service.store.manifest(draft_id, artifact_id)
        target = (
            service.store.current_revision(draft_id, artifact_id)
            if revision is None
            else revision
        )
        data = service.store.revision_bytes(draft_id, artifact_id, target)
    except OfficeArtifactError as exc:
        raise _office_http_error(exc) from exc
    filename = str(manifest.get("filename") or "artifact.bin")
    media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return Response(
        content=data,
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@router.post("/chat/office-drafts/{draft_id}/artifacts/{artifact_id}/operations")
async def apply_artifact_operations(
    draft_id: str,
    artifact_id: str,
    body: ArtifactOperationBatch,
    _auth: TokenPayload | None = Depends(require_auth),
) -> dict[str, object]:
    """Human-side strict operation batch — the same protocol as the agent."""
    service = _load_v2_service(draft_id)
    try:
        operations = parse_operations(body.operations)
        if not operations:
            raise InvalidOperationError("operations must be a non-empty list")
    except InvalidOperationError as exc:
        raise _office_http_error(exc) from exc
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    try:
        payload = service.apply_operations(
            draft_id, artifact_id, body.base_revision, body.operations, actor="user"
        )
    except OfficeArtifactError as exc:
        raise _office_http_error(exc) from exc
    return payload


@router.post("/chat/office-drafts/{draft_id}/artifacts/{artifact_id}/undo")
async def undo_artifact(
    draft_id: str,
    artifact_id: str,
    _auth: TokenPayload | None = Depends(require_auth),
) -> dict[str, object]:
    service = _load_v2_service(draft_id)
    try:
        return service.undo(draft_id, artifact_id)
    except OfficeArtifactError as exc:
        raise _office_http_error(exc) from exc


@router.post("/chat/office-drafts/{draft_id}/artifacts/{artifact_id}/redo")
async def redo_artifact(
    draft_id: str,
    artifact_id: str,
    _auth: TokenPayload | None = Depends(require_auth),
) -> dict[str, object]:
    service = _load_v2_service(draft_id)
    try:
        return service.redo(draft_id, artifact_id)
    except OfficeArtifactError as exc:
        raise _office_http_error(exc) from exc
