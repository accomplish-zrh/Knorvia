"""T1 — teaching-style skill packs, outline constraint checker, repair."""

from __future__ import annotations

import json
from typing import Any

import pytest

from knorvia.api.routers.classroom import list_teaching_styles
from knorvia.services.classroom.generator import generate_classroom
from knorvia.services.classroom.models import (
    ClassroomDocument,
    SceneOutline,
    new_classroom_id,
)
from knorvia.services.classroom.store import ClassroomStore
from knorvia.services.classroom.styles import (
    BRIEF_OVERVIEW,
    HANDS_ON,
    MASTER_LECTURE,
    get_style,
    list_styles,
)
from knorvia.services.classroom.styles.verify import (
    check_outline,
    describe_constraints,
    repair,
)


def _outline(stype: str, order: int, title: str = "场景") -> SceneOutline:
    return SceneOutline(
        id=f"s{order + 1}", type=stype, title=title, key_points=["a point"], order=order
    )


def _slides_and(count: int, tail_type: str) -> list[SceneOutline]:
    """``count`` slides followed by one scene of *tail_type*."""
    return [_outline("slide", i) for i in range(count)] + [
        _outline(tail_type, count)
    ]


def _scripted(responses: list[str], monkeypatch, captured: list[dict[str, Any]] | None = None):
    async def fake_complete(prompt, system_prompt="", **kwargs):
        if captured is not None:
            captured.append({"prompt": prompt, "system": system_prompt})
        if len(responses) == 1:
            return responses[0]
        return responses.pop(0)

    import knorvia.services.llm

    monkeypatch.setattr(knorvia.services.llm, "complete", fake_complete)


SCENE_JSON = json.dumps(
    {
        "title": "场景",
        "key_points": ["x"],
        "actions": [{"type": "speech", "agent_id": "teacher", "text": "讲解"}],
    },
    ensure_ascii=False,
)


def _outlines_payload(outlines: list[tuple[str, str]]) -> str:
    return json.dumps(
        {
            "title": "测试课",
            "outlines": [
                {"id": f"s{i + 1}", "type": stype, "title": name, "key_points": ["p"]}
                for i, (stype, name) in enumerate(outlines)
            ],
        },
        ensure_ascii=False,
    )


class TestCheckOutline:
    def test_master_lecture_accepts_slide_dominant_outline(self):
        outlines = _slides_and(4, "quiz")
        assert check_outline(outlines, MASTER_LECTURE.constraints) == []

    def test_master_lecture_flags_count_and_first_scene(self):
        outlines = [_outline("quiz", 0), _outline("slide", 1)]  # 2 scenes, quiz first
        diagnostics = check_outline(outlines, MASTER_LECTURE.constraints)
        text = "\n".join(diagnostics)
        assert "scene_count=2" in text
        assert "first scene must be 'slide'" in text

    def test_master_lecture_flags_quiz_budget_and_ratio(self):
        outlines = [_outline("quiz", 0), _outline("quiz", 1), _outline("slide", 2)]
        diagnostics = check_outline(outlines, MASTER_LECTURE.constraints)
        text = "\n".join(diagnostics)
        assert "quiz count 2 above maximum" not in text  # 2 is exactly the budget
        assert "slide ratio" in text  # 1/3 < 0.7

    def test_hands_on_bounds(self):
        assert check_outline(_slides_and(4, "quiz"), HANDS_ON.constraints) == []
        too_few = check_outline(_slides_and(2, "quiz"), HANDS_ON.constraints)
        assert any("scene_count=3" in d for d in too_few)
        four_quizzes = [_outline("slide", 0)] + [
            _outline("quiz", i + 1) for i in range(4)
        ]
        over = check_outline(four_quizzes, HANDS_ON.constraints)
        assert any("quiz count 4 above maximum 3" in d for d in over)
        no_quiz = check_outline([_outline("slide", i) for i in range(5)], HANDS_ON.constraints)
        assert any("quiz count 0 below minimum 1" in d for d in no_quiz)

    def test_brief_overview_bounds(self):
        assert check_outline(_slides_and(4, "quiz"), BRIEF_OVERVIEW.constraints) == []
        assert any(
            "scene_count=2" in d
            for d in check_outline(_slides_and(1, "quiz"), BRIEF_OVERVIEW.constraints)
        )
        too_many = check_outline(
            _slides_and(6, "quiz"), BRIEF_OVERVIEW.constraints
        )
        assert any("scene_count=7" in d for d in too_many)
        assert any(
            "quiz count 0 below minimum 1" in d
            for d in check_outline(
                [_outline("slide", i) for i in range(3)], BRIEF_OVERVIEW.constraints
            )
        )

    def test_consecutive_constraint(self):
        from knorvia.services.classroom.styles.base import OutlineConstraints

        constraints = OutlineConstraints(no_consecutive_types=("quiz",))
        outlines = [_outline("quiz", 0), _outline("quiz", 1), _outline("slide", 2)]
        diagnostics = check_outline(outlines, constraints)
        assert any("forbidden consecutive 'quiz'" in d for d in diagnostics)


class TestRepair:
    def test_downgrade_keeps_title_and_key_points(self):
        from knorvia.services.classroom.styles.base import OutlineConstraints

        constraints = OutlineConstraints(quiz_max=1)
        outlines = [
            _outline("quiz", 0, "小测一"),
            _outline("quiz", 1, "小测二"),
            _outline("slide", 2, "讲解"),
        ]
        repaired = repair(outlines, constraints)
        assert [o.type for o in repaired] == ["quiz", "slide", "slide"]
        assert repaired[1].title == "小测二"
        assert repaired[1].key_points == ["a point"]

    def test_truncates_surplus_tail_and_renumbers(self):
        from knorvia.services.classroom.styles.base import OutlineConstraints

        constraints = OutlineConstraints(scene_count_min=0, scene_count_max=4)
        outlines = [_outline("slide", i) for i in range(7)]
        repaired = repair(outlines, constraints)
        assert len(repaired) == 4
        assert [o.order for o in repaired] == [0, 1, 2, 3]

    def test_swaps_first_scene_into_required_type(self):
        outlines = [_outline("quiz", 0)] + [_outline("slide", i) for i in range(1, 5)]
        repaired = repair(outlines, MASTER_LECTURE.constraints)
        assert repaired[0].type == "slide"
        assert [o.order for o in repaired] == list(range(5))
        assert check_outline(repaired, MASTER_LECTURE.constraints) == []

    def test_repair_idempotent_and_check_clean(self):
        outlines = [_outline("quiz", 0)] + [_outline("slide", i) for i in range(1, 5)]
        once = repair(outlines, MASTER_LECTURE.constraints)
        assert check_outline(once, MASTER_LECTURE.constraints) == []
        twice = repair(once, MASTER_LECTURE.constraints)
        assert [o.to_dict() for o in twice] == [o.to_dict() for o in once]

    def test_repair_does_not_mutate_input(self):
        outlines = [_outline("quiz", 0), _outline("quiz", 1), _outline("slide", 2)]
        frozen = [o.to_dict() for o in outlines]
        repair(outlines, MASTER_LECTURE.constraints)
        assert [o.to_dict() for o in outlines] == frozen

    def test_unfixable_minimum_is_left_for_caller(self):
        # Too few scenes cannot be repaired by deletion — repair must neither
        # invent scenes nor crash; the diagnostics stay and the caller decides.
        outlines = [_outline("slide", 0), _outline("quiz", 1)]
        repaired = repair(outlines, HANDS_ON.constraints)
        assert len(repaired) == 2
        assert any(
            "scene_count=2" in d
            for d in check_outline(repaired, HANDS_ON.constraints)
        )


class TestStyleRegistry:
    def test_registry_exposes_three_styles(self):
        assert [s.id for s in list_styles()] == [
            "master-lecture",
            "hands-on",
            "brief-overview",
        ]
        assert get_style("hands-on") is HANDS_ON
        assert get_style("nope") is None
        assert get_style("") is None

    @pytest.mark.asyncio
    async def test_styles_endpoint_lists_id_title_description(self):
        result = await list_teaching_styles()
        styles = result["styles"]
        assert len(styles) == 3
        first = styles[0]
        assert first["id"] == "master-lecture"
        assert first["title"] and first["description"]
        assert first["title_en"] == "Master Lecture"

    def test_describe_constraints_summarizes_hard_rules(self):
        text = describe_constraints(MASTER_LECTURE.constraints)
        assert "4-10" in text and "slide" in text and "70%" in text

    def test_document_style_id_roundtrip(self, tmp_path):
        document = ClassroomDocument(
            id=new_classroom_id("风格"), title="t", topic="t", style_id="hands-on"
        )
        store = ClassroomStore(root=tmp_path / "classrooms")
        store.save(document)
        loaded = store.get(document.id)
        assert loaded is not None and loaded.style_id == "hands-on"
        legacy = ClassroomDocument.from_dict({"id": "old", "title": "t", "topic": "t"})
        assert legacy.style_id == ""


class TestStyledGeneration:
    @pytest.mark.asyncio
    async def test_style_directive_reaches_outline_prompt(self, monkeypatch):
        captured: list[dict[str, Any]] = []
        valid = _outlines_payload(
            [("slide", "开场"), ("slide", "机制"), ("quiz", "小测"), ("slide", "收尾")]
        )
        _scripted([valid, SCENE_JSON, SCENE_JSON, SCENE_JSON, SCENE_JSON], monkeypatch, captured)
        document = await generate_classroom("T", style_id="master-lecture")
        assert document.style_id == "master-lecture"
        assert "命题句" in captured[0]["prompt"]
        assert "硬约束" in captured[0]["prompt"]
        assert check_outline(document.outlines, MASTER_LECTURE.constraints) == []

    @pytest.mark.asyncio
    async def test_violation_replans_once_and_recovers(self, monkeypatch):
        captured: list[dict[str, Any]] = []
        violating = _outlines_payload(
            [("quiz", "开局即测"), ("slide", "A"), ("slide", "B"), ("slide", "C"), ("slide", "D")]
        )
        valid = _outlines_payload(
            [("slide", "开场"), ("slide", "A"), ("quiz", "小测"), ("slide", "C"), ("slide", "D")]
        )
        steps: list[tuple[str, dict[str, Any]]] = []

        async def on_progress(step, info):
            steps.append((step, info))

        _scripted(
            [violating, valid, SCENE_JSON, SCENE_JSON, SCENE_JSON, SCENE_JSON, SCENE_JSON],
            monkeypatch,
            captured,
        )
        document = await generate_classroom(
            "T", style_id="master-lecture", on_progress=on_progress
        )
        outline_calls = [c for c in captured if "outlines" in c["prompt"]]
        assert len(outline_calls) == 2
        # The diagnostics of attempt 1 are fed back into the re-plan prompt.
        assert "violated these hard constraints" in captured[1]["prompt"]
        assert "first scene must be 'slide'" in captured[1]["prompt"]
        assert not any(step == "outline_repaired" for step, _ in steps)
        assert check_outline(document.outlines, MASTER_LECTURE.constraints) == []
        assert len(document.scenes) == 5

    @pytest.mark.asyncio
    async def test_still_violating_falls_back_to_repair(self, monkeypatch):
        violating = _outlines_payload(
            [("quiz", "开局即测"), ("slide", "A"), ("slide", "B"), ("slide", "C"), ("slide", "D")]
        )
        steps: list[tuple[str, dict[str, Any]]] = []

        async def on_progress(step, info):
            steps.append((step, info))

        _scripted(
            [violating, violating, SCENE_JSON, SCENE_JSON, SCENE_JSON, SCENE_JSON, SCENE_JSON],
            monkeypatch,
        )
        document = await generate_classroom(
            "T", style_id="master-lecture", on_progress=on_progress
        )
        repaired_events = [info for step, info in steps if step == "outline_repaired"]
        assert len(repaired_events) == 1
        assert repaired_events[0]["diagnostics"]
        # Repair fixed what is fixable: outline now obeys the contract.
        assert check_outline(document.outlines, MASTER_LECTURE.constraints) == []
        assert document.outlines[0].type == "slide"
        # The lesson still generates fully — repair is not a failure.
        assert len(document.scenes) == 5
        assert document.style_id == "master-lecture"

    @pytest.mark.asyncio
    async def test_default_path_stays_unstyled(self, monkeypatch):
        captured: list[dict[str, Any]] = []
        valid = _outlines_payload([("slide", "A"), ("quiz", "Q")])
        _scripted([valid, SCENE_JSON, SCENE_JSON], monkeypatch, captured)
        document = await generate_classroom("T", style_id="")
        assert document.style_id == ""
        assert "命题句" not in captured[0]["prompt"]
        assert len(captured) == 3  # one outline call + two scene calls

    @pytest.mark.asyncio
    async def test_unknown_style_id_falls_back_to_default(self, monkeypatch):
        captured: list[dict[str, Any]] = []
        valid = _outlines_payload([("slide", "A")])
        _scripted([valid, SCENE_JSON], monkeypatch, captured)
        document = await generate_classroom("T", style_id="ghost-style")
        assert document.style_id == ""
        assert len(captured) == 2
