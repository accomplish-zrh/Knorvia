"""Classroom discussion director — stateless, one turn per call.

OpenMAIC parity: every request answers exactly "who speaks next, and what
they say"; the client accumulates the DirectorState (turn count + per-turn
summaries) and sends it back, so the server keeps no session and aborts are
just cancelled requests. With the built-in roster the LLM director only runs
when classmates exist; single-agent lessons degrade to pure code routing.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from knorvia.services.classroom import prompts
from knorvia.services.classroom.models import (
    ClassroomDocument,
    classmates,
    teacher,
)

logger = logging.getLogger(__name__)

_END = "END"
_USER = "USER"


def _extract_next_agent(text: str) -> str:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return _END
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return _END
    return str(data.get("next_agent") or _END).strip() or _END


def build_agent_roster_json(doc: ClassroomDocument) -> str:
    return json.dumps(
        [
            {
                "id": profile.id,
                "role": profile.role,
                "name": profile.name,
                "persona": profile.persona,
            }
            for profile in doc.agent_profiles
        ],
        ensure_ascii=False,
    )


async def pick_next_speaker(
    doc: ClassroomDocument,
    *,
    summaries: list[dict[str, Any]],
    turn_count: int,
    pending_question: str = "",
) -> str:
    """The next speaker id, ``USER`` (hand back to the learner) or ``END``."""
    lead = teacher(doc)
    peers = classmates(doc)
    if lead is None:
        return _END
    last_speaker = str(summaries[-1].get("agent_id") or "") if summaries else ""

    # Code path when no classmate can enrich the debate: the teacher answers,
    # then the discussion ends — no LLM needed (OpenMAIC single-agent decay).
    if not peers:
        return _END if last_speaker == lead.id else lead.id

    from knorvia.services.llm import complete

    system, user = prompts.director_prompt(
        build_agent_roster_json(doc),
        json.dumps(summaries[-8:], ensure_ascii=False),
        turn_count,
        pending_question,
        doc.language,
    )
    try:
        raw = await complete(user, system_prompt=system, temperature=0.2)
    except Exception as exc:  # noqa: BLE001 - director failure ends the debate
        logger.warning("Classroom director failed: %s", exc)
        return _END
    decision = _extract_next_agent(raw)
    valid = {profile.id for profile in doc.agent_profiles} | {_USER, _END}
    if decision not in valid:
        return _END
    # Rule 2: never the same speaker twice in a row.
    if decision == last_speaker:
        peers_left = [p.id for p in peers if p.id != last_speaker]
        if decision == lead.id and peers_left:
            return peers_left[0]
        return lead.id if decision != lead.id and last_speaker != lead.id else _END
    return decision


async def speak(
    doc: ClassroomDocument,
    agent_id: str,
    *,
    scene_context: str,
    transcript: list[dict[str, Any]],
    quiz_results: list[dict[str, Any]] | None = None,
    user_message: str = "",
) -> str:
    """One in-character spoken turn for *agent_id*."""
    profile = next((p for p in doc.agent_profiles if p.id == agent_id), None)
    if profile is None:
        return ""
    from knorvia.services.llm import complete

    system, user = prompts.classmate_speech_prompt(
        profile.to_dict(),
        scene_context,
        json.dumps(transcript[-12:], ensure_ascii=False),
        json.dumps(quiz_results or [], ensure_ascii=False),
        user_message,
        doc.language,
    )
    try:
        raw = await complete(user, system_prompt=system, temperature=0.6)
    except Exception as exc:  # noqa: BLE001 - a lost voice ends its turn
        logger.warning("Classroom speaker %s failed: %s", agent_id, exc)
        return ""
    return raw.strip()[:600]


__all__ = ["build_agent_roster_json", "pick_next_speaker", "speak"]
