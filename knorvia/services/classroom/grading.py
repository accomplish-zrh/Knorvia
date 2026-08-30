"""Two-tier quiz grading (OpenMAIC quiz-grade parity).

Objective questions (single/multiple) grade deterministically against the
stored answer; short answers go to the LLM with the question's analysis as
the reference. Results feed back into the discussion state so classroom
members can address the learner's actual mistakes.
"""

from __future__ import annotations

import logging
from typing import Any

from knorvia.services.classroom.models import Scene

logger = logging.getLogger(__name__)


def _objective_grade(question: dict[str, Any], answer: str) -> bool:
    expected = str(question.get("answer") or "").strip()
    given = str(answer or "").strip()
    if not expected or not given:
        return False
    expected_set = {part.strip() for part in expected.split(",") if part.strip()}
    given_set = {part.strip() for part in given.split(",") if part.strip()}
    return expected_set == given_set


async def grade_answers(scene: Scene, answers: dict[str, str]) -> list[dict[str, Any]]:
    """Grade every answered question of a quiz scene; returns result rows."""
    from knorvia.services.llm import complete

    results: list[dict[str, Any]] = []
    for question in scene.questions:
        data = question.to_dict()
        qid = str(data.get("id") or "")
        if qid not in answers:
            continue
        given = str(answers[qid])
        if data.get("type") == "short":
            correct = False
            comment = ""
            try:
                raw = await complete(
                    (
                        f"Question: {data.get('question')}\n"
                        f"Reference answer: {data.get('answer')}\n"
                        f"Learner answer: {given}\n\n"
                        "Is the learner's answer correct (same meaning, not "
                        "verbatim)? Reply with one line of JSON: "
                        '{"correct": true|false, "comment": "<one sentence>"}'
                    ),
                    system_prompt="You grade short answers fairly and briefly.",
                    temperature=0.1,
                )
                import json as _json
                import re as _re

                match = _re.search(r"\{.*\}", raw, _re.DOTALL)
                verdict = _json.loads(match.group(0)) if match else {}
                correct = bool(verdict.get("correct"))
                comment = str(verdict.get("comment") or "")
            except Exception as exc:  # noqa: BLE001 - grading never blocks
                logger.warning("Short-answer grading failed: %s", exc)
                comment = "Grading unavailable for this answer."
            results.append(
                {
                    "question_id": qid,
                    "correct": correct,
                    "given": given,
                    "answer": data.get("answer"),
                    "analysis": data.get("analysis"),
                    "comment": comment or data.get("analysis"),
                }
            )
            continue

        correct = _objective_grade(data, given)
        results.append(
            {
                "question_id": qid,
                "correct": correct,
                "given": given,
                "answer": data.get("answer"),
                "analysis": data.get("analysis"),
                "comment": "",
            }
        )
    return results


__all__ = ["grade_answers"]
