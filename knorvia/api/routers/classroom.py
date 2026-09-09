"""Classroom API — generation, playback documents, discussion, grading.

Generation streams OpenMAIC-style progress events over SSE; the discussion
endpoint is stateless (one director→speaker turn per call, the client loops
with the returned state); quiz grading is two-tier. All admin-gated like the
rest of the learning surfaces.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from knorvia.api.routers.auth import require_admin
from knorvia.services.classroom.director import build_agent_roster_json, pick_next_speaker, speak
from knorvia.services.classroom.generator import generate_classroom
from knorvia.services.classroom.grading import grade_answers
from knorvia.services.classroom.jobs import get_classroom_job_store
from knorvia.services.classroom.store import get_classroom_store

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(require_admin)])


class DiscussionRequest(BaseModel):
    """One stateless discussion turn (state round-trips from the client)."""

    scene_id: str = ""
    scene_title: str = ""
    scene_key_points: list[str] = Field(default_factory=list)
    seed_prompt: str = ""
    transcript: list[dict[str, Any]] = Field(default_factory=list)
    summaries: list[dict[str, Any]] = Field(default_factory=list)
    turn_count: int = 0
    pending_question: str = ""
    quiz_results: list[dict[str, Any]] = Field(default_factory=list)
    user_message: str = ""


class GradeRequest(BaseModel):
    scene_id: str
    answers: dict[str, str] = Field(default_factory=dict)


def _letter_for_index(index: int) -> str:
    return chr(ord("A") + index)


def _correct_answer_text(question: dict[str, Any]) -> str:
    """Human-readable correct answer (letters for choice questions)."""
    qtype = str(question.get("type") or "single")
    answer = str(question.get("answer") or "").strip()
    options = [str(o) for o in (question.get("options") or [])]
    if qtype in {"single", "multiple"} and options:
        letters = [
            _letter_for_index(int(part))
            for part in answer.split(",")
            if part.strip().isdigit() and int(part) < len(options)
        ]
        if letters:
            return ", ".join(letters)
    return answer


class SaveQuestionsRequest(BaseModel):
    """Wrong (or all) answers of one graded quiz scene → the question bank.

    Organic tie-in: entries land in the same SQLite notebook-entry store the
    题库 surface reads, under a synthetic ``classroom:{id}`` session, so
    classroom mistakes are reviewable next to every other quiz the learner
    has taken.
    """

    scene_id: str
    only_wrong: bool = True
    entries: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/{classroom_id}/save-questions")
async def save_questions_to_bank(classroom_id: str, payload: SaveQuestionsRequest):
    document = get_classroom_store().get(classroom_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Classroom not found")
    scene = next((s for s in document.scenes if s.id == payload.scene_id), None)
    if scene is None or scene.type != "quiz":
        raise HTTPException(status_code=404, detail="Quiz scene not found")

    from knorvia.services.session.sqlite_store import get_sqlite_session_store

    store = get_sqlite_session_store()
    session_id = f"classroom:{classroom_id}"
    await store.ensure_session_with_id(session_id, f"AI 课堂 · {document.title}")

    by_id = {f"{scene.id}:{q.id}": q.to_dict() for q in scene.questions}
    items: list[dict[str, Any]] = []
    for entry in payload.entries:
        question_key = str(entry.get("question_id") or "")
        full_key = f"{scene.id}:{question_key}"
        question = by_id.get(full_key)
        if question is None:
            continue
        if payload.only_wrong and bool(entry.get("is_correct")):
            continue
        qtype = str(question.get("type") or "single")
        options_list = [str(o) for o in (question.get("options") or [])]
        options_map = (
            {_letter_for_index(i): option for i, option in enumerate(options_list)}
            if qtype in {"single", "multiple"}
            else None
        )
        given = str(entry.get("user_answer") or "")
        if options_map:
            letters = [
                _letter_for_index(int(part))
                for part in given.split(",")
                if part.strip().isdigit() and int(part) < len(options_list)
            ]
            given = ", ".join(letters) if letters else given
        items.append(
            {
                "question_id": full_key,
                "turn_id": scene.id,
                "question": str(question.get("question") or ""),
                "question_type": qtype,
                "options": options_map,
                "correct_answer": _correct_answer_text(question),
                "explanation": str(question.get("analysis") or ""),
                "user_answer": given,
                "is_correct": bool(entry.get("is_correct")),
                "source": f"AI 课堂 · {document.title}",
            }
        )
    if not items:
        return {"saved": 0, "session_id": session_id}
    saved = await store.upsert_notebook_entries(session_id, items)
    return {"saved": saved, "session_id": session_id}


@router.post("/{classroom_id}/export-notebook")
async def export_to_notebook(classroom_id: str, notebook_id: str = ""):
    """Save the lesson's outline cards into a Notebook (organic tie-in)."""
    document = get_classroom_store().get(classroom_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Classroom not found")

    from knorvia.services.notebook import notebook_manager

    target_id = str(notebook_id or "").strip()
    if not target_id:
        wanted_name = "AI 课堂"
        existing = next(
            (
                nb
                for nb in notebook_manager.list_notebooks()
                if str(nb.get("name") or "") == wanted_name
            ),
            None,
        )
        target_id = (
            str(existing.get("id") or "")
            if existing
            else str(
                notebook_manager.create_notebook(
                    name=wanted_name,
                    description="AI Classroom lessons (OpenMAIC-inspired).",
                ).get("id")
                or ""
            )
        )
    if not target_id:
        raise HTTPException(status_code=500, detail="Notebook unavailable")

    lines = [f"# {document.title}", "", f"Topic: {document.topic}", ""]
    for scene in document.scenes:
        lines.append(f"## {scene.title}")
        if scene.objective:
            lines.append(f"*{scene.objective}*")
        if scene.widget is not None:
            widget = scene.widget.to_dict()
            lines.append(f"- 互动件: {widget.get('concept')}")
            if widget.get("key_variables"):
                lines.append(f"- 可操作变量: {', '.join(widget['key_variables'])}")
        for point in scene.key_points:
            lines.append(f"- {point}")
        for point in scene.narration:
            lines.append(f"- {point}")
        for question in scene.questions:
            data = question.to_dict()
            lines.append("")
            lines.append(f"**Q: {data.get('question')}**")
            if data.get("options"):
                for i, option in enumerate(data["options"]):
                    lines.append(f"- {_letter_for_index(i)}. {option}")
            lines.append(f"> 答案: {_correct_answer_text(data)} — {data.get('analysis')}")
        lines.append("")

    record = notebook_manager.add_record(
        [target_id],
        "solve",
        title=f"AI 课堂 · {document.title}",
        user_query=document.topic,
        output="\n".join(lines),
        summary=document.scenes[0].objective if document.scenes else "",
        metadata={"classroom_id": document.id, "source": "ai_classroom"},
    )
    return {"notebook_id": target_id, "record": record}


def _sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"


@router.get("")
async def list_classrooms():
    return {"classrooms": get_classroom_store().list()}


@router.get("/styles")
async def list_teaching_styles():
    """Teaching-style skill packs (title/description in Chinese, *_en for the
    English UI; the frontend picks by locale)."""
    from knorvia.services.classroom.styles import list_styles

    return {
        "styles": [
            {
                "id": style.id,
                "title": style.title,
                "description": style.description,
                "title_en": style.title_en,
                "description_en": style.description_en,
            }
            for style in list_styles()
        ]
    }


class GenerateRequest(BaseModel):
    topic: str = Field(..., min_length=1, max_length=400)
    minutes: int = 12
    language: str = "zh"
    # Organic tie-ins: ground the lesson in one of the learner's knowledge
    # bases, and seat saved Personas as the classmate agents.
    kb_name: str = ""
    persona_names: list[str] = Field(default_factory=list, max_length=3)
    # Teaching-style skill pack ("" = default behavior, checked server-side).
    style_id: str = Field(default="", max_length=64)


async def _resolve_kb_grounding(kb_name: str, topic: str) -> str:
    """Retrieve grounding text from *kb_name*; empty string on any problem.

    Uses the existing RAG service against the admin KB root — the same
    engines the chat pipeline searches, so a lesson teaches the learner's
    own material rather than the model's priors.
    """
    kb_name = str(kb_name or "").strip()
    if not kb_name:
        return ""
    try:
        from knorvia.multi_user.knowledge_access import admin_kb_base_dir
        from knorvia.services.rag.service import RAGService

        rag = RAGService(kb_base_dir=str(admin_kb_base_dir()), provider=None)
        result = await rag.search(topic, kb_name=kb_name)
        content = str(result.get("content") or result.get("answer") or "").strip()
        if content:
            logger.info("Classroom grounding from KB %s: %s chars", kb_name, len(content))
        return content
    except Exception:
        logger.warning(
            "Classroom KB grounding failed for %s; continuing ungrounded",
            kb_name,
            exc_info=True,
        )
        return ""


def _resolve_persona_specs(persona_names: list[str]) -> list[dict[str, str]]:
    """Saved Persona profiles (user + admin) as classmate identities."""
    if not persona_names:
        return []
    wanted = [str(name).strip() for name in persona_names if str(name).strip()]
    if not wanted:
        return []
    specs: list[dict[str, str]] = []
    try:
        from knorvia.api.routers.personas import _admin_persona_service
        from knorvia.services.persona import get_persona_service

        seen: dict[str, str] = {}
        for service in (get_persona_service(), _admin_persona_service()):
            try:
                for info in service.list_personas():
                    seen[info.name] = info.description
            except Exception:  # noqa: BLE001 - each root is best-effort
                continue
        for name in wanted:
            if name in seen and len(specs) < 3:
                specs.append({"name": name, "description": seen[name]})
    except Exception:
        logger.warning("Persona roster resolution failed", exc_info=True)
    return specs


@router.post("/generate")
async def generate(payload: GenerateRequest):
    """Create a durable generation job and return ``{job_id}`` immediately.

    The lesson keeps generating in a background task (request-independent):
    clients follow ``GET /jobs/{id}/events`` (replay + live SSE) and can
    reconnect after refresh/restart. The job's stored payload is a summary
    (names only) — KB text never lands in the job file.
    """
    job_store = get_classroom_job_store()
    job = job_store.create(
        topic=payload.topic,
        payload={
            "topic": payload.topic,
            "minutes": payload.minutes,
            "language": payload.language,
            "kb_name": payload.kb_name,
            "persona_names": payload.persona_names,
            "style_id": payload.style_id,
        },
    )
    task = asyncio.create_task(_run_generation_job(job.id, payload))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return {"job_id": job.id}


_background_tasks: set[asyncio.Task] = set()


async def _run_generation_job(job_id: str, payload: GenerateRequest) -> None:
    """Run one generation job to completion — never bound to a request."""
    job_store = get_classroom_job_store()
    job_store.mark_running(job_id)

    async def on_progress(step: str, info: dict[str, Any]) -> None:
        job_store.append_event(job_id, "progress", {"step": step, **info})

    try:
        kb_context = await _resolve_kb_grounding(payload.kb_name, payload.topic)
        persona_specs = _resolve_persona_specs(payload.persona_names)
        document = await generate_classroom(
            payload.topic,
            minutes=payload.minutes,
            language=payload.language,
            on_progress=on_progress,
            kb_context=kb_context,
            persona_specs=persona_specs,
            style_id=payload.style_id,
        )
        get_classroom_store().save(document)
        job_store.append_event(job_id, "done", {"id": document.id, "title": document.title})
        job_store.mark_done(job_id, document.id)
    except Exception as exc:  # noqa: BLE001 - job failure is recorded, not raised
        logger.exception("Classroom generation job %s failed", job_id)
        job_store.append_event(job_id, "error", {"message": str(exc)})
        job_store.mark_failed(job_id, str(exc))


@router.get("/jobs/{job_id}")
async def get_generation_job(job_id: str):
    """Job snapshot: status, payload summary, and every event so far."""
    job = get_classroom_job_store().get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.to_dict()


@router.get("/jobs/{job_id}/events")
async def stream_generation_job_events(job_id: str):
    """SSE: replay all stored events, then follow live until terminal."""
    job_store = get_classroom_job_store()
    if job_store.get(job_id) is None:
        raise HTTPException(status_code=404, detail="Job not found")

    async def stream():
        index = 0
        while True:
            job = job_store.get(job_id)
            if job is None:
                yield _sse("error", {"message": "job record vanished"})
                return
            events = job.events
            while index < len(events):
                event = events[index]
                index += 1
                yield _sse(
                    str(event.get("type") or "progress"), dict(event.get("data") or {})
                )
                if event.get("type") in {"done", "error"}:
                    return
            if job.status in {"done", "failed"}:
                return
            await job_store.wait_for_events(job_id)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/{classroom_id}")
async def get_classroom(classroom_id: str, revision: int | None = None):
    """Full document; with ``?revision=N`` a lite answer when unchanged."""
    document = get_classroom_store().get(classroom_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Classroom not found")
    if revision is not None and int(revision) == document.version:
        return {"id": document.id, "version": document.version, "unchanged": True}
    return document.to_dict()


class EditOpsRequest(BaseModel):
    """Atomic edit transaction: every op applies, or nothing does."""

    ops: list[dict[str, Any]] = Field(..., min_length=1, max_length=50)


@router.patch("/{classroom_id}")
async def edit_classroom(classroom_id: str, payload: EditOpsRequest):
    """Apply a list of edit ops atomically (OpenMAIC edit-deck discipline).

    409 names the offending op and the reason; on success the FULL updated
    document is returned so the client can refresh from the response body.
    """
    from knorvia.services.classroom.edit import EditError, apply_ops

    store = get_classroom_store()
    try:
        document = store.save_edit(classroom_id, lambda doc: apply_ops(doc, payload.ops))
    except EditError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if document is None:
        raise HTTPException(status_code=404, detail="Classroom not found")
    return document.to_dict()


@router.delete("/{classroom_id}")
async def delete_classroom(classroom_id: str):
    deleted = get_classroom_store().delete(classroom_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Classroom not found")
    return {"deleted": True}


@router.post("/{classroom_id}/discussion")
async def discussion_turn(classroom_id: str, payload: DiscussionRequest):
    """One stateless discussion turn: director picks, the member speaks."""
    document = get_classroom_store().get(classroom_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Classroom not found")

    scene_context = " · ".join(
        part for part in (payload.scene_title, *payload.scene_key_points[:3]) if part
    )
    decision = await pick_next_speaker(
        document,
        summaries=payload.summaries,
        turn_count=payload.turn_count,
        pending_question=payload.pending_question,
    )
    if decision in {"END", "USER"}:
        return StreamingResponse(
            iter(
                [
                    _sse(
                        "done",
                        {
                            "next": decision,
                            "state": {
                                "turn_count": payload.turn_count,
                                "summaries": payload.summaries,
                            },
                        },
                    )
                ]
            ),
            media_type="text/event-stream",
        )

    async def stream():
        yield _sse("agent_start", {"agent_id": decision})
        text = await speak(
            document,
            decision,
            scene_context=scene_context or payload.seed_prompt,
            transcript=payload.transcript,
            quiz_results=payload.quiz_results,
            user_message=payload.user_message,
        )
        if not text:
            yield _sse(
                "done",
                {
                    "next": "END",
                    "state": {"turn_count": payload.turn_count, "summaries": payload.summaries},
                },
            )
            return
        # Small chunks so the UI streams like the product chat.
        step = 24
        for index in range(0, len(text), step):
            yield _sse("text_delta", {"agent_id": decision, "text": text[index : index + step]})
        summaries = list(payload.summaries) + [
            {
                "agent_id": decision,
                "content": text[:120],
                "turn": payload.turn_count + 1,
            }
        ]
        yield _sse(
            "done",
            {
                "next": decision,
                "text": text,
                "state": {"turn_count": payload.turn_count + 1, "summaries": summaries},
            },
        )

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/{classroom_id}/grade")
async def grade_scene(classroom_id: str, payload: GradeRequest):
    document = get_classroom_store().get(classroom_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Classroom not found")
    scene = next((s for s in document.scenes if s.id == payload.scene_id), None)
    if scene is None or scene.type != "quiz":
        raise HTTPException(status_code=404, detail="Quiz scene not found")
    results = await grade_answers(scene, payload.answers)
    return {"scene_id": payload.scene_id, "results": results}


@router.get("/{classroom_id}/roster")
async def classroom_roster(classroom_id: str):
    document = get_classroom_store().get(classroom_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Classroom not found")
    return {"roster": build_agent_roster_json(document)}
