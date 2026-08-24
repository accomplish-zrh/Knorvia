"""
Unified session history API.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from knorvia.services.session import get_session_store, get_sqlite_session_store
from knorvia.services.storage.attachment_store import get_attachment_store

logger = logging.getLogger(__name__)

router = APIRouter()


class SessionRenameRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=100)


class SessionUpdateRequest(BaseModel):
    """Partial session update. Every field optional; at least one required."""

    title: str | None = Field(default=None, min_length=1, max_length=100)
    pinned: bool | None = None
    archived: bool | None = None


class BranchSelectionRequest(BaseModel):
    """Edit-branch picker state: `{parent_message_id: chosen_child_id}`.

    Stored inside the session preferences blob so it survives reloads
    without a dedicated column.
    """

    selected_branches: dict[str, int] = Field(default_factory=dict)


class QuizResultItem(BaseModel):
    question_id: str = ""
    question: str = Field(..., min_length=1)
    question_type: str = ""
    options: dict[str, str] | None = None
    user_answer: str = ""
    correct_answer: str = ""
    explanation: str | None = ""
    difficulty: str | None = ""
    is_correct: bool

    @field_validator("options", mode="before")
    @classmethod
    def _coerce_options(cls, v):
        return v if isinstance(v, dict) else {}

    @field_validator("explanation", "difficulty", mode="before")
    @classmethod
    def _coerce_str(cls, v):
        return v if isinstance(v, str) else ""


class QuizResultsRequest(BaseModel):
    answers: list[QuizResultItem] = Field(default_factory=list)
    turn_id: str = ""


def _format_quiz_results_message(answers: list[QuizResultItem]) -> str:
    total = len(answers)
    correct = sum(1 for item in answers if item.is_correct)
    score_pct = round((correct / total) * 100) if total else 0
    lines = ["[Quiz Performance]"]
    for idx, item in enumerate(answers, 1):
        question = item.question.strip().replace("\n", " ")
        user_answer = (item.user_answer or "").strip() or "(blank)"
        status = "Correct" if item.is_correct else "Incorrect"
        suffix = f" ({status})"
        if not item.is_correct and (item.correct_answer or "").strip():
            suffix = f" ({status}, correct: {(item.correct_answer or '').strip()})"
        qid = f"[{item.question_id}] " if item.question_id else ""
        lines.append(f"{idx}. {qid}Q: {question} -> Answered: {user_answer}{suffix}")
    lines.append(f"Score: {correct}/{total} ({score_pct}%)")
    return "\n".join(lines)


@router.get("")
async def list_sessions(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    include_archived: bool = Query(default=False),
):
    store = get_session_store()
    sessions = await store.list_sessions(
        limit=limit, offset=offset, include_archived=include_archived
    )
    return {"sessions": sessions}


@router.get("/search")
async def search_sessions(
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=30, ge=1, le=100),
):
    """Full-text history search across every message of every session.

    Returns compact hits (session id/title/time + a matched snippet), so the
    sidebar can offer "search all history" without loading transcripts.
    Archived sessions are included — search is how you find them again.
    """
    store = get_session_store()
    results = await store.search_sessions(q.strip(), limit=limit)
    return {"results": results}


# Cap (in characters) for a single event payload returned to the UI. RAG
# tools can attach whole KB documents to ``tool_result``/``observation``
# events; the frontend TraceSurface only needs a preview, and the LLM context
# is built from a separate content-only store, so capping here never affects
# model input.
MAX_EVENT_PAYLOAD = 1024 * 1024
_TRUNCATION_NOTICE = "\n\n[... content truncated]"
_TRUNCATABLE_EVENT_TYPES = ("tool_result", "observation")


def _truncate_oversized_events(
    messages: list[dict[str, Any]], limit: int = MAX_EVENT_PAYLOAD
) -> None:
    """Cap oversized ``tool_result``/``observation`` payloads in place.

    The session store already returns each message's events as a parsed
    ``events`` list (see ``SqliteSessionStore._serialize_message``), so we
    mutate that list directly. Only the UI rendering path is affected.
    """

    def _cap(container: dict[str, Any], field: str) -> bool:
        value = container.get(field)
        if isinstance(value, str) and len(value) > limit:
            container[field] = value[:limit] + _TRUNCATION_NOTICE
            return True
        return False

    for msg in messages:
        events = msg.get("events")
        if not isinstance(events, list):
            continue
        for event in events:
            if not isinstance(event, dict) or event.get("type") not in _TRUNCATABLE_EVENT_TYPES:
                continue
            truncated = _cap(event, "content")
            tool_metadata = (event.get("metadata") or {}).get("tool_metadata")
            if isinstance(tool_metadata, dict):
                for field in ("content", "answer"):
                    truncated = _cap(tool_metadata, field) or truncated
            if truncated:
                event["_truncated"] = True


@router.get("/{session_id}")
async def get_session(session_id: str):
    store = get_session_store()
    session = await store.get_session_with_messages(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    _truncate_oversized_events(session.get("messages", []))
    return session


@router.patch("/{session_id}")
async def update_session(session_id: str, payload: SessionUpdateRequest):
    """Rename and/or flip pinned/archived in one call.

    All fields are optional; omitted fields stay untouched. At least one
    must be present.
    """
    store = get_sqlite_session_store()
    session = await store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    touched = False
    if payload.pinned is not None:
        touched = await store.set_session_pinned(session_id, payload.pinned) or touched
    if payload.archived is not None:
        touched = await store.set_session_archived(session_id, payload.archived) or touched
    if payload.title is not None:
        touched = await store.update_session_title(session_id, payload.title) or touched
    if not touched:
        raise HTTPException(status_code=422, detail="No changes requested")
    return {"session": await store.get_session(session_id)}


@router.delete("/{session_id}")
async def delete_session(session_id: str):
    store = get_session_store()
    deleted = await store.delete_session(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        await get_attachment_store().delete_session(session_id)
    except Exception:
        logger.exception("failed to clean up attachments for session %s", session_id)
    return {"deleted": True, "session_id": session_id}


@router.put("/{session_id}/branch-selection")
async def update_branch_selection(session_id: str, payload: BranchSelectionRequest):
    store = get_sqlite_session_store()
    session = await store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    updated = await store.update_session_preferences(
        session_id, {"selected_branches": dict(payload.selected_branches)}
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"selected_branches": payload.selected_branches}


def _render_markdown(session: dict, messages: list[dict]) -> str:
    title = session.get("title") or "Untitled conversation"
    created = session.get("created_at") or 0
    stamp = datetime.fromtimestamp(float(created), tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [f"# {title}", "", f"_Exported from Knorvia · started {stamp} · {len(messages)} messages_", ""]
    for m in messages:
        role = m.get("role", "?")
        content = m.get("content") or ""
        if not content.strip():
            continue
        label = {"user": "🧑 User", "assistant": "🤖 Assistant", "system": "⚙️ System"}.get(role, role.title())
        lines.append(f"### {label}")
        lines.append("")
        lines.append(content)
        lines.append("")
    return "\n".join(lines)


@router.get("/{session_id}/export")
async def export_session(
    session_id: str,
    format: str = Query(default="json", pattern="^(json|md)$"),
):
    """Download a full transcript as JSON or Markdown.

    JSON preserves every stored field (roles, capabilities, metadata,
    branch parents); Markdown is a clean human-readable document.
    """
    store = get_sqlite_session_store()
    data = await store.export_session(session_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Session not found")

    safe_stem = "".join(c if c.isalnum() or c in "-_ " else "" for c in (data["session"].get("title") or "chat")).strip() or "chat"
    if format == "md":
        body = _render_markdown(data["session"], data["messages"])
        return {
            "format": "md",
            "filename": f"{safe_stem}.md",
            "mime_type": "text/markdown; charset=utf-8",
            "content": body,
        }
    return {
        "format": "json",
        "filename": f"{safe_stem}.json",
        "mime_type": "application/json",
        "content": json.dumps(data, ensure_ascii=False, indent=2),
    }


@router.delete("/{session_id}/messages/{message_id}")
async def delete_turn_by_message(session_id: str, message_id: int):
    store = get_sqlite_session_store()
    result = await store.delete_turn_by_message(session_id, message_id)
    if result["was_running"]:
        raise HTTPException(
            status_code=409, detail="Cannot delete a message while its turn is running"
        )
    if not result["deleted"]:
        raise HTTPException(status_code=404, detail="Message not found")
    attachment_store = get_attachment_store()
    for aid in result["attachment_ids"]:
        try:
            await attachment_store.delete_attachment(session_id, aid)
        except Exception:
            logger.exception("failed to delete attachment %s for session %s", aid, session_id)
    return result


@router.post("/{session_id}/messages/{message_id}/fork")
async def fork_session_from_message(session_id: str, message_id: int):
    """Branch a new session from any historical message.

    Copies the conversation path up to and including the target message
    into an independent "<title> (fork)" session; the original stays put.
    """
    store = get_sqlite_session_store()
    result = await store.fork_from_message(session_id, message_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Message not found")
    return {"session": result}


@router.post("/{session_id}/quiz-results")
async def record_quiz_results(session_id: str, payload: QuizResultsRequest):
    if not payload.answers:
        raise HTTPException(status_code=400, detail="Quiz results are required")
    store = get_sqlite_session_store()
    session = await store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    content = _format_quiz_results_message(payload.answers)
    await store.add_message(
        session_id=session_id,
        role="user",
        content=content,
        capability="deep_question",
    )
    notebook_count = 0
    try:
        notebook_count = await store.upsert_notebook_entries(
            session_id,
            [{**item.model_dump(), "turn_id": payload.turn_id} for item in payload.answers],
        )
    except Exception:
        logger.warning(
            "Failed to upsert notebook entries for session %s", session_id, exc_info=True
        )
    return {
        "recorded": True,
        "session_id": session_id,
        "answer_count": len(payload.answers),
        "notebook_count": notebook_count,
        "content": content,
    }
