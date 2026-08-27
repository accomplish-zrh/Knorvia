"""HTTP API for office-draft review cards in chat.

PATCH ``/api/v1/chat/office-drafts/{draft_id}`` is the user-facing confirm /
discard control. Auth matches ``/api/outputs``: the authenticated user's
workspace only; not admin-gated.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from knorvia.api.routers.auth import require_auth
from knorvia.multi_user.context import get_current_user_or_none
from knorvia.multi_user.paths import get_path_service_for_scope
from knorvia.services.auth import TokenPayload
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


def _request_path_service() -> PathService:
    """Resolve the workspace installed by ``require_auth`` without fallback."""
    user = get_current_user_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Draft not found")
    return get_path_service_for_scope(user.scope)


def _load_store(draft_id: str) -> OfficeDraftStore:
    try:
        token = validate_draft_id(draft_id)
    except DraftError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Draft not found") from exc
    path_service = _request_path_service()
    try:
        return OfficeDraftStore.locate(
            token,
            public_root=path_service.get_public_outputs_root(),
            chat_root=path_service.get_chat_workspace_root(),
        )
    except DraftNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Draft not found") from exc
    except DraftError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


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
    store = _load_store(draft_id)
    try:
        return _payload(store, draft_id)
    except DraftNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Draft not found") from exc


@router.patch("/chat/office-drafts/{draft_id}")
async def patch_office_draft(
    draft_id: str,
    body: OfficeDraftPatch,
    _auth: TokenPayload | None = Depends(require_auth),
) -> dict[str, object]:
    """Merge a ready draft into the official workspace, or discard it."""
    store = _load_store(draft_id)
    try:
        if body.action == "merge":
            # The review card can confirm from ``draft`` (agent never called
            # ready). User confirmation is the ready+merge. The tool itself
            # still cannot skip ``ready``.
            current = store.status(draft_id)["status"]
            if current == "draft":
                store.mark_ready(draft_id)
            store.merge(draft_id)
        else:
            store.discard(draft_id)
        return _payload(store, draft_id)
    except DraftNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Draft not found") from exc
    except DraftTransitionError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except DraftError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
