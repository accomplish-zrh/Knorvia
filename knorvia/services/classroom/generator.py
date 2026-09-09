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
    MAX_INTERACTIVE_SCENES,
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
from knorvia.services.classroom.sanitize import sanitize_widget_html
from knorvia.services.classroom.styles import get_style
from knorvia.services.classroom.styles.verify import (
    check_outline,
    describe_constraints,
    repair,
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


def _parse_outlines(payload: dict[str, Any], cap: int = 9) -> list[SceneOutline]:
    """Validate + clamp the model's outline list (global resource discipline)."""
    raw_outlines = payload.get("outlines") or []
    if not isinstance(raw_outlines, list) or not raw_outlines:
        raise RuntimeError("Model produced no scene outlines")
    outlines = [
        SceneOutline.from_dict({**item, "order": index})
        for index, item in enumerate(raw_outlines[:cap])
        if isinstance(item, dict)
    ]
    _enforce_outline_budget(outlines)
    if not outlines:
        raise RuntimeError("Model produced no valid scene outlines")
    return outlines


async def _enforce_style_constraints(
    doc: ClassroomDocument,
    system: str,
    user: str,
    style: Any,
    progress: ProgressCb,
) -> None:
    """One diagnostic re-plan, then a deterministic repair — never a failure.

    The re-plan feeds the violated diagnostics back into the outline prompt;
    if the outline still violates the style contract, ``repair`` fixes what
    is deterministically fixable and the leftover diagnostics ride along in
    an ``outline_repaired`` event (informational, not an error).
    """
    diagnostics = check_outline(doc.outlines, style.constraints)
    if not diagnostics:
        return
    replan_user = (
        user
        + "\nYour previous outline violated these hard constraints:\n"
        + "\n".join(f"- {item}" for item in diagnostics)
        + "\nRegenerate the COMPLETE outline obeying every constraint above. "
        "Return ONLY the JSON object."
    )
    try:
        payload = await _complete_json(system, replan_user)
        replanned = _parse_outlines(payload, cap=style.constraints.scene_count_max)
        doc.title = str(payload.get("title") or doc.title)[:80]
        doc.outlines = replanned
    except Exception as exc:  # noqa: BLE001 - keep attempt 1, repair below
        logger.warning("Classroom style re-plan failed: %s", exc)
    diagnostics = check_outline(doc.outlines, style.constraints)
    if diagnostics:
        doc.outlines = repair(doc.outlines, style.constraints)
        remaining = check_outline(doc.outlines, style.constraints)
        await progress(
            "outline_repaired", diagnostics=diagnostics, remaining=remaining
        )


def _agent_profiles(
    doc_language: str, persona_specs: list[dict[str, str]] | None = None
) -> list[AgentProfile]:
    """Teacher is builtin; classmates come from the user's saved Personas
    (organic tie-in) with builtin archetypes filling the remaining seats."""
    builtin = [
        AgentProfile.from_dict(spec) for spec in prompts.default_agent_profiles(doc_language)
    ]
    teacher_profile = next(p for p in builtin if p.role == "teacher")
    archetype = [p for p in builtin if p.role == "classmate"]

    seats: list[AgentProfile] = []
    for spec in (persona_specs or [])[:3]:
        name = str(spec.get("name") or "").strip()
        if not name:
            continue
        fallback = archetype[len(seats) % len(archetype)]
        seats.append(
            AgentProfile(
                id=f"persona-{len(seats) + 1}",
                name=name,
                role="classmate",
                persona=str(spec.get("description") or "").strip() or fallback.persona,
                color=fallback.color,
            )
        )
    while len(seats) < 3:
        seats.append(archetype[len(seats) % len(archetype)])
    return [teacher_profile, *seats]


async def generate_classroom(
    topic: str,
    *,
    minutes: int = 12,
    language: str = "zh",
    on_progress: ProgressCb | None = None,
    kb_context: str = "",
    persona_specs: list[dict[str, str]] | None = None,
    style_id: str = "",
) -> ClassroomDocument:
    """Run the full pipeline and return the assembled document.

    *kb_context* — retrieved knowledge-base text that grounds the outline
    (organic tie-in: lessons teach the learner's own KBs). *persona_specs*
    — saved Persona profiles reused as classmate identities (organic
    tie-in: the classroom wears the user's own personas); the teacher stays
    the built-in one and unfilled seats fall back to the builtin archetypes.
    *style_id* — teaching-style skill pack; when set, its pedagogy text is
    injected into the outline prompt and the produced outline is checked
    against the style's hard constraints (one re-plan, then a deterministic
    repair — never a hard failure). Empty keeps the default behavior.
    """
    minutes = max(4, min(45, int(minutes or 12)))
    doc_language = "zh" if str(language).startswith("zh") else "en"
    style = get_style(style_id)
    doc = ClassroomDocument(
        id=new_classroom_id(topic),
        title="",
        topic=topic.strip(),
        language=doc_language,
        created_at=time.time(),
        agent_profiles=_agent_profiles(doc_language, persona_specs=persona_specs),
        style_id=style.id if style else "",
    )

    async def progress(step: str, **payload: Any) -> None:
        if on_progress is not None:
            await on_progress(step, payload)

    await progress("initializing", message=topic)

    # Stage 1 — outlines (the reviewable intermediate product).
    await progress("generating_outlines", message="")
    style_directive = ""
    if style is not None:
        style_directive = (
            f"{style.prompt_text}\n"
            "硬约束（生成结果会被确定性校验器逐条核对，违例会被退回重写）：\n"
            f"- {describe_constraints(style.constraints)}"
        )
    system, user = prompts.outlines_prompt(
        topic, minutes, doc_language, grounding=kb_context, style_directive=style_directive
    )
    outline_cap = style.constraints.scene_count_max if style else 9
    payload = await _complete_json(system, user)
    doc.title = str(payload.get("title") or topic)[:80]
    doc.outlines = _parse_outlines(payload, cap=outline_cap)

    if style is not None:
        await _enforce_style_constraints(doc, system, user, style, progress)

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
        scene, degraded_reason = _assemble_scene(outline, payload, doc)
        doc.scenes.append(scene)
        if degraded_reason:
            # Safety gate hit a document-tier risk — the widget is dropped,
            # the lesson continues as a plain card (never a hard failure).
            await progress(
                "scene_degraded",
                scene_id=scene.id,
                scene_title=scene.title,
                reason=degraded_reason,
            )

    await progress("completed", scenes_generated=len(doc.scenes), total_scenes=total)
    return doc


def _enforce_outline_budget(outlines: list[SceneOutline]) -> None:
    """Clamp quiz/discussion/interactive counts to the resource discipline."""
    quiz_seen = 0
    discussion_seen = 0
    interactive_seen = 0
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
        elif outline.type == "interactive":
            interactive_seen += 1
            if interactive_seen > MAX_INTERACTIVE_SCENES:
                outline.type = "slide"


def _assemble_scene(
    outline: SceneOutline, payload: dict[str, Any], doc: ClassroomDocument
) -> tuple[Scene, str]:
    """Deterministic assembly: validated content + a rebuilt action timeline.

    Returns ``(scene, degraded_reason)`` — *degraded_reason* is non-empty
    when the safety gate downgraded an interactive scene to a slide.
    """
    scene = Scene(
        id=outline.id,
        order=outline.order,
        type=outline.type,
        title=str(payload.get("title") or outline.title),
        key_points=[str(k) for k in (payload.get("key_points") or outline.key_points)][:6],
        objective=str(payload.get("objective") or outline.objective),
    )
    degraded_reason = ""
    if outline.type == "interactive":
        scene.widget = outline.widget
        scene.narration = [
            str(n).strip()
            for n in (payload.get("narration") or [])
            if str(n).strip()
        ][:6]
        result = sanitize_widget_html(str(payload.get("html") or ""))
        if (
            result.degrade
            or scene.widget is None
            or scene.widget.validate()
        ):
            # Safety hard line: a document-tier risk (or a missing/invalid
            # widget) drops the whole widget; the card survives as a slide.
            scene.type = "slide"
            scene.widget = None
            scene.html = ""
            scene.narration = []
            degraded_reason = "; ".join(result.hits) or "widget missing or invalid"
        else:
            scene.html = result.html

    speaker_ids = {profile.id for profile in doc.agent_profiles}
    lead = teacher(doc)
    actions: list[dict[str, Any]] = []
    if scene.type == "interactive" and scene.narration:
        # Narration lines are the teacher's spoken timeline for the widget.
        for line in scene.narration:
            actions.append(
                make_action("speech", agent_id=lead.id if lead else "teacher", text=line)
            )
    else:
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
    return scene, degraded_reason


__all__ = ["generate_classroom"]
