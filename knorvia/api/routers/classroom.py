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
from knorvia.services.classroom.store import get_classroom_store

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(require_admin)])


class GenerateRequest(BaseModel):
    topic: str = Field(..., min_length=1, max_length=400)
    minutes: int = 12
    language: str = "zh"


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


def _sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"


@router.get("")
async def list_classrooms():
    return {"classrooms": get_classroom_store().list()}


@router.post("/generate")
async def generate(payload: GenerateRequest):
    """Generate a lesson, streaming progress events; final event = document."""

    async def stream():
        def progress_payload(step: str, info: dict[str, Any]) -> str:
            return _sse("progress", {"step": step, **info})

        queue: "asyncio.Queue[tuple[str, dict[str, Any]] | None]" = asyncio.Queue()

        async def on_progress(step: str, info: dict[str, Any]) -> None:
            await queue.put((step, info))

        async def run() -> None:
            try:
                document = await generate_classroom(
                    payload.topic,
                    minutes=payload.minutes,
                    language=payload.language,
                    on_progress=on_progress,
                )
                get_classroom_store().save(document)
                await queue.put(("done", {"id": document.id, "title": document.title}))
            except Exception as exc:  # noqa: BLE001 - reported as an SSE error
                logger.exception("Classroom generation failed")
                await queue.put(("error", {"message": str(exc)}))
            finally:
                await queue.put(None)

        task = asyncio.create_task(run())
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                step, info = item
                if step == "done":
                    yield _sse("done", info)
                elif step == "error":
                    yield _sse("error", info)
                else:
                    yield progress_payload(step, info)
        finally:
            task.cancel()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/{classroom_id}")
async def get_classroom(classroom_id: str):
    document = get_classroom_store().get(classroom_id)
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
