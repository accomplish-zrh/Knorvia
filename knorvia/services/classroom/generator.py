"""Classroom generation — topic → outlines → scenes (OpenMAIC parity).

Two LLM stages with a per-stage retry, deterministic assembly in between,
and step callbacks mirroring OpenMAIC's generation progress protocol
(`outlines → scenes(n/total) → completed`). Media/TTS stages are
deliberately dropped: the playback timeline derives speech duration from
text length, so a slow/broken TTS can never block a lesson.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
import json
import logging
import re
import time
from typing import Any

from knorvia.services.classroom import prompts
from knorvia.services.classroom.models import (
    ACTION_QUIZ,
    AgentProfile,
    ClassroomDocument,
    QuizQuestion,
    Scene,
    SceneOutline,
    classmates,
    make_action,
    new_classroom_id,
    teacher,
)

logger = logging.getLogger(__name__)

ProgressCb = Callable[[str, dict[str, Any]], Awaitable[None]]

_MAX_RETRIES = 2
_JSON_OBJECT_RE = re.compile(r"\{.*\}|\[.*\]", re.DOTALL)


def _extract_json(text: str) -> Any:
    """Parse the first JSON value in *text*, tolerating markdown fences."""
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else text
    match = _JSON_OBJECT_RE.search(candidate)
    if not match:
        raise ValueError("model returned no JSON object")
    return json.loads(match.group(0))


async def _complete_json(system: str, user: str) -> Any:
    from knorvia.services.llm import complete

    last_error: Exception | None = None
    for _ in range(_MAX_RETRIES):
        try:
            raw = await complete(user, system_prompt=system, temperature=0.4)
            return _extract_json(raw)
        except Exception as exc:  # noqa: BLE001 - retry, then surface
            last_error = exc
            logger.warning("Classroom stage call failed: %s", exc)
    raise RuntimeError(f"Classroom generation stage failed: {last_error}")


def _agent_profiles(doc_language: str) -> list[AgentProfile]:
    return [AgentProfile.from_dict(spec) for spec in prompts.default_agent_profiles(doc_language)]


async def generate_classroom(
    topic: str,
    *,
    minutes: int = 12,
    language: str = "zh",
    on_progress: ProgressCb | None = None,
) -> ClassroomDocument:
    """Run the full pipeline and return the assembled document."""
    minutes = max(4, min(45, int(minutes or 12)))
    doc_language = "zh" if str(language).startswith("zh") else "en"
    doc = ClassroomDocument(
        id=new_classroom_id(topic),
        title="",
        topic=topic.strip(),
        language=doc_language,
        created_at=time.time(),
        agent_profiles=_agent_profiles(doc_language),
    )

    async def progress(step: str, **payload: Any) -> None:
        if on_progress is not None:
            await on_progress(step, payload)

    await progress("initializing", message=topic)

    # Stage 1 — outlines (the reviewable intermediate product).
    await progress("generating_outlines", message="")
    system, user = prompts.outlines_prompt(topic, minutes, doc_language)
    payload = await _complete_json(system, user)
    doc.title = str(payload.get("title") or topic)[:80]
    raw_outlines = payload.get("outlines") or []
    if not isinstance(raw_outlines, list) or not raw_outlines:
        raise RuntimeError("Model produced no scene outlines")
    doc.outlines = [
        SceneOutline.from_dict({**item, "order": index})
        for index, item in enumerate(raw_outlines[:9])
        if isinstance(item, dict)
    ]
    _enforce_outline_budget(doc.outlines)
    if not doc.outlines:
        raise RuntimeError("Model produced no valid scene outlines")

    # Stage 2 — one call per scene (content + actions together), sequential so
    # each scene's speech can stay coherent with the roster; per-scene failure
    # retries once inside _complete_json, then that scene degrades to a bare
    # card instead of failing the lesson (OpenMAIC's media-fallback spirit).
    roster_json = json.dumps([a.to_dict() for a in doc.agent_profiles], ensure_ascii=False)
    total = len(doc.outlines)
    for outline in doc.outlines:
        await progress(
            "generating_scenes",
            scenes_generated=outline.order,
            total_scenes=total,
            message=outline.title,
        )
        system, user = prompts.scene_prompt(outline.to_dict(), roster_json, doc.title, doc_language)
        try:
            payload = await _complete_json(system, user)
        except Exception as exc:  # noqa: BLE001 - degrade, don't fail the lesson
            logger.warning(
                "Scene %s (%s) degraded to a bare card: %s",
                outline.id,
                outline.title,
                exc,
            )
            payload = {}
        doc.scenes.append(_assemble_scene(outline, payload, doc))

    await progress("completed", scenes_generated=len(doc.scenes), total_scenes=total)
    return doc


def _enforce_outline_budget(outlines: list[SceneOutline]) -> None:
    """Clamp quiz/discussion counts to the OpenMAIC resource discipline."""
    quiz_seen = 0
    discussion_seen = 0
    from knorvia.services.classroom.models import MAX_DISCUSSION_SCENES, MAX_QUIZ_SCENES

    for outline in outlines:
        if outline.type == "quiz":
            quiz_seen += 1
            if quiz_seen > MAX_QUIZ_SCENES:
                outline.type = "slide"
        elif outline.type == "discussion":
            discussion_seen += 1
            if discussion_seen > MAX_DISCUSSION_SCENES:
                outline.type = "slide"


def _assemble_scene(
    outline: SceneOutline, payload: dict[str, Any], doc: ClassroomDocument
) -> Scene:
    """Deterministic assembly: validated content + a rebuilt action timeline."""
    scene = Scene(
        id=outline.id,
        order=outline.order,
        type=outline.type,
        title=str(payload.get("title") or outline.title),
        key_points=[str(k) for k in (payload.get("key_points") or outline.key_points)][:6],
        objective=str(payload.get("objective") or outline.objective),
    )
    speaker_ids = {profile.id for profile in doc.agent_profiles}
    lead = teacher(doc)
    actions: list[dict[str, Any]] = []
    for raw in payload.get("actions") or []:
        if not isinstance(raw, dict):
            continue
        kind = str(raw.get("type") or "")
        if kind == "speech":
            speaker = str(raw.get("agent_id") or "")
            text = str(raw.get("text") or "").strip()
            if not text:
                continue
            if speaker not in speaker_ids:
                speaker = lead.id if lead else speaker
            if speaker != (lead.id if lead else "") and speaker in {
                profile.id for profile in classmates(doc)
            }:
                profile = next(p for p in classmates(doc) if p.id == speaker)
                if len(text) > 220:
                    # Classmates are students: cap their interjections.
                    text = text[:217] + "…"
                _ = profile
            actions.append(make_action("speech", agent_id=speaker, text=text))
        elif kind == ACTION_QUIZ and outline.type == "quiz":
            actions.append(make_action(ACTION_QUIZ))
        elif kind == "discussion" and outline.type == "discussion":
            actions.append(
                make_action("discussion", prompt=str(raw.get("prompt") or outline.objective))
            )

    if outline.type == "quiz":
        questions = [
            QuizQuestion.from_dict(q)
            for q in (payload.get("questions") or [])
            if isinstance(q, dict) and str(q.get("question") or "").strip()
        ]
        if not questions:
            # A quiz scene without questions is a slide; honest degradation.
            scene.type = "slide"
        else:
            scene.questions = questions[:4]
            if not any(a.get("type") == ACTION_QUIZ for a in actions):
                actions.append(make_action(ACTION_QUIZ))
    if outline.type == "discussion" and not any(a.get("type") == "discussion" for a in actions):
        actions.append(make_action("discussion", prompt=outline.objective or outline.title))
    if not actions or actions[0].get("type") != "speech":
        # The lesson must always open with the teacher speaking the card.
        lead = teacher(doc)
        opening = "; ".join(scene.key_points[:3]) or scene.objective
        actions.insert(
            0,
            make_action(
                "speech",
                agent_id=lead.id if lead else "teacher",
                text=f"{scene.title}。{opening}",
            ),
        )
    scene.actions = actions
    return scene


__all__ = ["generate_classroom"]
