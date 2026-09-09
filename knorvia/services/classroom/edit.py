"""Course editing — minimal atomic op set (OpenMAIC patch/edit_deck parity).

Discipline (mirrors OpenMAIC's edit semantics, adapted to the classroom
document): ops are small and explicit; ``apply_ops`` clones the document,
applies every op to the clone, re-validates the model, and only then
hands the result back — any failure raises :class:`EditError` naming the
offending op, the caller's disk state stays untouched, and the input
document is never mutated. Scene/question ids are stable across edits
(``reorder`` only moves orders), so discussions and grading history stay
valid. The ``html`` field goes through the same deterministic safety gate
as generation.
"""

from __future__ import annotations

import copy
from typing import Any
import uuid

from knorvia.services.classroom.models import (
    QUESTION_TYPES,
    SCENE_TYPES,
    ClassroomDocument,
    QuizQuestion,
    Scene,
    SceneOutline,
)
from knorvia.services.classroom.sanitize import sanitize_widget_html

SET_FIELDS = ("title", "objective", "key_points", "minutes", "narration", "html")
STR_REPLACE_FIELDS = ("title", "objective", "key_points", "narration", "html")
LIST_FIELDS = {"key_points", "narration"}


class EditError(Exception):
    """One op failed validation; the whole transaction is discarded."""


def _op_error(index: int, reason: str) -> EditError:
    return EditError(f"op#{index}: {reason}")


def _scene_for(doc: ClassroomDocument, scene_id: str, index: int) -> Scene:
    scene = next((s for s in doc.scenes if s.id == scene_id), None)
    if scene is None:
        raise _op_error(index, f"scene '{scene_id}' not found")
    return scene


def _outline_for(doc: ClassroomDocument, scene_id: str) -> SceneOutline | None:
    return next((o for o in doc.outlines if o.id == scene_id), None)


def _renumber(doc: ClassroomDocument) -> None:
    for order, scene in enumerate(doc.scenes):
        scene.order = order
    for order, outline in enumerate(doc.outlines):
        outline.order = order


def _sync_outline_fields(scene: Scene, doc: ClassroomDocument) -> None:
    """Keep the reviewable outline entry aligned with renamed scene fields."""
    outline = _outline_for(doc, scene.id)
    if outline is None:
        return
    outline.title = scene.title
    outline.objective = scene.objective


def _apply_set(doc: ClassroomDocument, op: dict[str, Any], index: int) -> None:
    field = str(op.get("field") or "")
    if field not in SET_FIELDS:
        raise _op_error(index, f"field '{field}' is not editable (allowed: {SET_FIELDS})")
    scene = _scene_for(doc, str(op.get("scene_id") or ""), index)
    value = op.get("value")
    if field == "key_points":
        if not isinstance(value, list) or not all(isinstance(p, str) for p in value):
            raise _op_error(index, "key_points needs a list of strings")
        scene.key_points = [p.strip() for p in value if p.strip()][:6]
    elif field == "narration":
        if not isinstance(value, list) or not all(isinstance(p, str) for p in value):
            raise _op_error(index, "narration needs a list of strings")
        scene.narration = [p.strip() for p in value if p.strip()][:8]
    elif field == "minutes":
        try:
            minutes = max(1, min(30, int(value)))
        except (TypeError, ValueError):
            raise _op_error(index, "minutes needs an integer") from None
        outline = _outline_for(doc, scene.id)
        if outline is not None:
            outline.minutes = minutes
        else:
            raise _op_error(index, f"scene '{scene.id}' has no outline entry")
    elif field == "html":
        if scene.type != "interactive":
            raise _op_error(index, "html is only editable on interactive scenes")
        result = sanitize_widget_html(str(value or ""))
        if result.degrade:
            raise _op_error(
                index, f"html failed the safety scan: {', '.join(result.hits)}"
            )
        scene.html = result.html
    elif field == "title":
        scene.title = str(value or "").strip()[:80]
    else:  # objective
        scene.objective = str(value or "").strip()
    _sync_outline_fields(scene, doc)


def _apply_str_replace(doc: ClassroomDocument, op: dict[str, Any], index: int) -> None:
    field = str(op.get("field") or "")
    if field not in STR_REPLACE_FIELDS:
        raise _op_error(
            index, f"str_replace cannot target '{field}' (allowed: {STR_REPLACE_FIELDS})"
        )
    scene = _scene_for(doc, str(op.get("scene_id") or ""), index)
    old = str(op.get("old") or "")
    new = str(op.get("new") or "")
    if not old:
        raise _op_error(index, "str_replace needs a non-empty 'old'")
    if field in LIST_FIELDS:
        items = scene.key_points if field == "key_points" else scene.narration
        try:
            item_index = int(op.get("index"))
        except (TypeError, ValueError):
            raise _op_error(
                index, f"str_replace on '{field}' needs an item 'index'"
            ) from None
        if not 0 <= item_index < len(items):
            raise _op_error(index, f"index {item_index} out of range for '{field}'")
        if items[item_index].count(old) != 1:
            raise _op_error(
                index,
                f"old text matches {items[item_index].count(old)} times in "
                f"{field}[{item_index}] (exactly 1 required)",
            )
        items[item_index] = items[item_index].replace(old, new)
        return
    text = getattr(scene, field)
    if text.count(old) != 1:
        raise _op_error(
            index,
            f"old text matches {text.count(old)} times in '{field}' (exactly 1 required)",
        )
    setattr(scene, field, text.replace(old, new))


def _apply_retitle(doc: ClassroomDocument, op: dict[str, Any], index: int) -> None:
    scene = _scene_for(doc, str(op.get("scene_id") or ""), index)
    title = str(op.get("title") or "").strip()
    if not title:
        raise _op_error(index, "retitle needs a non-empty title")
    scene.title = title[:80]
    _sync_outline_fields(scene, doc)


def _apply_insert_blank(doc: ClassroomDocument, op: dict[str, Any], index: int) -> None:
    try:
        at = int(op.get("at"))
    except (TypeError, ValueError):
        raise _op_error(index, "insert_blank needs an integer 'at'") from None
    if not 0 <= at <= len(doc.scenes):
        raise _op_error(index, f"insert position {at} out of range 0..{len(doc.scenes)}")
    new_id = f"scene-{uuid.uuid4().hex[:8]}"
    scene = Scene(id=new_id, order=at, type="slide")
    doc.scenes.insert(at, scene)
    doc.outlines.insert(
        at, SceneOutline(id=new_id, type="slide", title="", key_points=[], order=at)
    )
    _renumber(doc)


def _apply_delete_scene(doc: ClassroomDocument, op: dict[str, Any], index: int) -> None:
    scene_id = str(op.get("scene_id") or "")
    _scene_for(doc, scene_id, index)
    doc.scenes = [s for s in doc.scenes if s.id != scene_id]
    doc.outlines = [o for o in doc.outlines if o.id != scene_id]
    if not doc.scenes:
        raise _op_error(index, "cannot delete the last scene")
    _renumber(doc)


def _apply_reorder(doc: ClassroomDocument, op: dict[str, Any], index: int) -> None:
    ordered_ids = op.get("ordered_ids")
    if not isinstance(ordered_ids, list):
        raise _op_error(index, "reorder needs 'ordered_ids'")
    current = [s.id for s in doc.scenes]
    if sorted(ordered_ids) != sorted(current) or len(ordered_ids) != len(current):
        raise _op_error(
            index,
            "ordered_ids must be a permutation of ALL scene ids "
            f"(got {len(ordered_ids)} for {len(current)} scenes)",
        )
    by_id = {s.id: s for s in doc.scenes}
    doc.scenes = [by_id[sid] for sid in ordered_ids]
    outline_by_id = {o.id: o for o in doc.outlines if o.id in by_id}
    doc.outlines = [outline_by_id[sid] for sid in ordered_ids if sid in outline_by_id]
    _renumber(doc)


def _validate_questions(questions: list[dict[str, Any]], index: int) -> list[QuizQuestion]:
    if not questions:
        raise _op_error(index, "quiz_edit needs at least one question")
    if len(questions) > 4:
        raise _op_error(index, "a quiz scene holds at most 4 questions")
    validated: list[QuizQuestion] = []
    seen_ids: set[str] = set()
    for position, raw in enumerate(questions):
        if not isinstance(raw, dict):
            raise _op_error(index, f"question {position + 1} is not an object")
        qtype = str(raw.get("type") or "")
        if qtype not in QUESTION_TYPES:
            raise _op_error(
                index,
                f"question {position + 1}: type '{qtype}' not in {list(QUESTION_TYPES)}",
            )
        question_text = str(raw.get("question") or "").strip()
        if not question_text:
            raise _op_error(index, f"question {position + 1}: empty question text")
        options = [str(o) for o in (raw.get("options") or [])]
        answer = str(raw.get("answer") or "").strip()
        analysis = str(raw.get("analysis") or "").strip()
        if qtype in {"single", "multiple"}:
            if len(options) < 2:
                raise _op_error(
                    index, f"question {position + 1}: choice questions need >= 2 options"
                )
            parts = [p.strip() for p in answer.split(",") if p.strip()] if answer else []
            if not parts:
                raise _op_error(index, f"question {position + 1}: missing answer")
            for part in parts:
                if not part.isdigit() or int(part) >= len(options):
                    raise _op_error(
                        index,
                        f"question {position + 1}: answer '{part}' outside options",
                    )
        else:  # short
            if not analysis:
                raise _op_error(
                    index,
                    f"question {position + 1}: short answers need an analysis (rubric)",
                )
        qid = str(raw.get("id") or "").strip() or f"q-{uuid.uuid4().hex[:6]}"
        if qid in seen_ids:
            raise _op_error(index, f"duplicate question id '{qid}'")
        seen_ids.add(qid)
        try:
            points = max(1, min(10, int(raw.get("points") or 1)))
        except (TypeError, ValueError):
            points = 1
        validated.append(
            QuizQuestion(
                id=qid,
                type=qtype,
                question=question_text,
                options=options[:6],
                answer=answer,
                analysis=analysis,
                points=points,
            )
        )
    return validated


def _apply_quiz_edit(doc: ClassroomDocument, op: dict[str, Any], index: int) -> None:
    scene = _scene_for(doc, str(op.get("scene_id") or ""), index)
    if scene.type != "quiz":
        raise _op_error(index, f"scene '{scene.id}' is not a quiz scene")
    questions = op.get("questions")
    if not isinstance(questions, list):
        raise _op_error(index, "quiz_edit needs a 'questions' array")
    scene.questions = _validate_questions(questions, index)
    if not any(a.get("type") == "quiz_trigger" for a in scene.actions):
        scene.actions.append({"type": "quiz_trigger"})


_OP_HANDLERS = {
    "set": _apply_set,
    "str_replace": _apply_str_replace,
    "retitle": _apply_retitle,
    "insert_blank": _apply_insert_blank,
    "delete_scene": _apply_delete_scene,
    "reorder": _apply_reorder,
    "quiz_edit": _apply_quiz_edit,
}


def _validate_document(doc: ClassroomDocument, index: int) -> None:
    """Final model validation before the caller persists the clone."""
    scene_ids = [s.id for s in doc.scenes]
    if len(scene_ids) != len(set(scene_ids)):
        raise _op_error(index, "scene ids are not unique after the edit")
    if not doc.scenes:
        raise _op_error(index, "a lesson needs at least one scene")
    for order, scene in enumerate(doc.scenes):
        if scene.type not in SCENE_TYPES:
            raise _op_error(index, f"scene '{scene.id}' has illegal type '{scene.type}'")
        if scene.order != order:
            raise _op_error(index, f"scene '{scene.id}' order is not sequential")


def apply_ops(doc: ClassroomDocument, ops: list[dict[str, Any]]) -> ClassroomDocument:
    """Apply a list of ops atomically; returns a NEW document.

    Raises :class:`EditError` (naming the offending op index) on any
    failure — the input document object is left untouched in that case.
    On success ``version`` is incremented and scene/question ids are
    stable except for freshly inserted pages.
    """
    if not isinstance(ops, list) or not ops:
        raise EditError("ops must be a non-empty list")
    clone = ClassroomDocument.from_dict(copy.deepcopy(doc.to_dict()))
    for index, op in enumerate(ops):
        if not isinstance(op, dict):
            raise _op_error(index, "op must be an object")
        kind = str(op.get("type") or "")
        handler = _OP_HANDLERS.get(kind)
        if handler is None:
            raise _op_error(
                index, f"unknown op type '{kind}' (allowed: {sorted(_OP_HANDLERS)})"
            )
        handler(clone, op, index)
        _validate_document(clone, index)
    clone.version = max(1, clone.version) + 1
    return clone


__all__ = ["EditError", "apply_ops"]
