"""
Import chat histories from external coding CLIs (Claude Code, Codex) into the
user's learning space as normal, re-openable sessions.

Two import paths: the desktop/server can list and parse the usual
``~/.claude`` / ``~/.codex`` homes after the user clicks Detect, or the
client can still pick a folder (File System Access) and POST normalized
sessions. Imported sessions share the session tables with native chats
but carry an ``imported_`` id prefix. Re-importing the same folder is
idempotent (dedup by id).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from knorvia.services.session import (
    get_sqlite_session_store,
    make_imported_session_id,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Browser adapters only emit these; reject anything else so a malformed payload
# can never seed an unsupported provider category.
_ALLOWED_SOURCES = {"claude_code", "codex"}

# Defensive ceilings — a single import request should never grow unbounded.
_MAX_SESSIONS_PER_REQUEST = 1000
_MAX_MESSAGES_PER_SESSION = 10000


class ImportedMessage(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    content: str = ""
    created_at: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ImportedSession(BaseModel):
    external_id: str = Field(..., min_length=1, max_length=256)
    title: str = ""
    source_cwd: str = ""
    created_at: float
    updated_at: float
    messages: list[ImportedMessage] = Field(default_factory=list)


class ChatHistoryImportRequest(BaseModel):
    source: str = Field(..., min_length=1)
    # All sessions in one request belong to one agent (a named, scoped slice of
    # a source folder). Empty when the client hasn't adopted the agent model yet
    # — the backend stays backwards-compatible by simply omitting attribution.
    agent_id: str = Field(default="", max_length=256)
    agent_name: str = Field(default="", max_length=256)
    sessions: list[ImportedSession] = Field(default_factory=list)

    @field_validator("source")
    @classmethod
    def _normalize_source(cls, value: str) -> str:
        normalized = (value or "").strip().lower()
        if normalized not in _ALLOWED_SOURCES:
            raise ValueError(f"Unsupported import source: {value!r}")
        return normalized


@router.get("/homes")
async def list_import_homes() -> dict[str, Any]:
    """Default Claude Code / Codex folders on this machine (user-triggered detect)."""
    from knorvia.services.session.import_homes import discover_import_homes

    return {"homes": discover_import_homes()}


class ImportHomeRequest(BaseModel):
    source: str = Field(..., min_length=1)
    agent_id: str = Field(default="", max_length=256)
    agent_name: str = Field(default="", max_length=256)

    @field_validator("source")
    @classmethod
    def _normalize_home_source(cls, value: str) -> str:
        normalized = (value or "").strip().lower()
        if normalized not in _ALLOWED_SOURCES:
            raise ValueError(f"Unsupported import source: {value!r}")
        return normalized


@router.post("/homes")
async def import_detected_home(payload: ImportHomeRequest) -> dict[str, Any]:
    from knorvia.services.session.import_homes import import_home_async

    try:
        return await import_home_async(
            payload.source, agent_id=payload.agent_id, agent_name=payload.agent_name
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/chat-history")
async def import_chat_history(payload: ChatHistoryImportRequest) -> dict[str, Any]:
    if not payload.sessions:
        raise HTTPException(status_code=400, detail="No sessions to import")
    if len(payload.sessions) > _MAX_SESSIONS_PER_REQUEST:
        raise HTTPException(
            status_code=413,
            detail=f"Too many sessions in one request (max {_MAX_SESSIONS_PER_REQUEST})",
        )

    store = get_sqlite_session_store()
    imported = 0
    skipped = 0
    results: list[dict[str, Any]] = []

    for incoming in payload.sessions:
        # Drop content-less rows (e.g. tool-only turns the adapter could not
        # reduce to text) so the transcript stays a clean human conversation.
        messages = [m for m in incoming.messages if (m.content or "").strip()]
        if not messages:
            skipped += 1
            results.append(
                {"external_id": incoming.external_id, "imported": False, "reason": "empty"}
            )
            continue
        if len(messages) > _MAX_MESSAGES_PER_SESSION:
            messages = messages[:_MAX_MESSAGES_PER_SESSION]

        session_id = make_imported_session_id(payload.source, incoming.external_id)
        import_meta: dict[str, Any] = {
            "source": payload.source,
            "source_cwd": incoming.source_cwd,
            "external_id": incoming.external_id,
        }
        if payload.agent_id:
            import_meta["agent_id"] = payload.agent_id
        if payload.agent_name:
            import_meta["agent_name"] = payload.agent_name
        preferences = {"import": import_meta}
        try:
            result = await store.import_session(
                session_id,
                incoming.title,
                incoming.created_at,
                incoming.updated_at,
                preferences,
                [m.model_dump() for m in messages],
            )
        except Exception:
            logger.exception("failed to import session %s", incoming.external_id)
            skipped += 1
            results.append(
                {"external_id": incoming.external_id, "imported": False, "reason": "error"}
            )
            continue

        if result.get("imported"):
            imported += 1
        else:
            skipped += 1
        results.append({"external_id": incoming.external_id, **result})

    return {"imported": imported, "skipped": skipped, "sessions": results}


@router.get("/chat-history")
async def list_imported_chat_history(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    store = get_sqlite_session_store()
    sessions = await store.list_imported_sessions(limit=limit, offset=offset)
    return {"sessions": sessions}
