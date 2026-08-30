"""Classroom service: schemas, store, generation, director, grading."""

from __future__ import annotations

import json
from typing import Any

import pytest

from knorvia.services.classroom import director as director_mod
from knorvia.services.classroom.generator import generate_classroom
from knorvia.services.classroom.grading import grade_answers
from knorvia.services.classroom.models import (
    ACTION_SPEECH,
    AgentProfile,
    ClassroomDocument,
    QuizQuestion,
    Scene,
    classmates,
    new_classroom_id,
    teacher,
)
from knorvia.services.classroom.store import ClassroomStore


def _doc() -> ClassroomDocument:
    return ClassroomDocument(
        id=new_classroom_id("测试主题"),
        title="A tiny lesson",
        topic="testing",
        language="zh",
        agent_profiles=[
            AgentProfile(id="teacher", name="老师", role="teacher", persona="主讲"),
            AgentProfile(id="curious", name="小问", role="classmate", persona="好奇"),
        ],
        outlines=[],
        scenes=[
            Scene(
                id="s1",
                order=0,
                type="slide",
                title="开场",
                key_points=["a", "b"],
                actions=[
                    {"type": ACTION_SPEECH, "agent_id": "teacher", "text": "你好"},
                ],
            ),
            Scene(
                id="s2",
                order=1,
                type="quiz",
                title="小测",
                questions=[
                    QuizQuestion(
                        id="q1",
                        type="single",
                        question="1+1=?",
                        options=["1", "2", "3", "4"],
                        answer="1",
                        analysis="显然",
                    )
                ],
                actions=[{"type": "quiz_trigger"}],
            ),
        ],
    )


def _scripted_complete(responses: list[str], monkeypatch):
    calls: list[dict[str, Any]] = []

    async def fake_complete(prompt, system_prompt="", **kwargs):
        calls.append({"prompt": prompt, "system": system_prompt})
        if len(responses) == 1:
            return responses[0]
        return responses.pop(0)

    import knorvia.services.llm

    monkeypatch.setattr(knorvia.services.llm, "complete", fake_complete)
    return calls


class TestModels:
    def test_document_roundtrip(self):
        document = _doc()
        restored = ClassroomDocument.from_dict(document.to_dict())
        assert restored.title == document.title
        assert restored.scenes[1].questions[0].answer == "1"
        assert teacher(restored).id == "teacher"
        assert [p.id for p in classmates(restored)] == ["curious"]

    def test_from_dict_drops_malformed(self):
        restored = ClassroomDocument.from_dict(
            {
                "id": "x",
                "scenes": [
                    {"id": "s1", "type": "alien"},
                    "not-a-dict",
                    {"id": "s2", "type": "quiz", "questions": [{"id": "q1", "type": "weird"}]},
                ],
            }
        )
        assert [s.type for s in restored.scenes] == ["slide", "quiz"]
        assert restored.scenes[1].questions[0].type == "single"


class TestStore:
    def test_save_get_list_delete(self, tmp_path):
        store = ClassroomStore(root=tmp_path / "classrooms")
        document = _doc()
        store.save(document)
        loaded = store.get(document.id)
        assert loaded is not None and loaded.id == document.id
        cards = store.list()
        assert len(cards) == 1 and cards[0]["scene_count"] == 2
        assert store.delete(document.id) is True
        assert store.get(document.id) is None

    def test_get_missing_is_none(self, tmp_path):
        assert ClassroomStore(root=tmp_path).get("nope") is None


class TestGeneration:
    @pytest.mark.asyncio
    async def test_two_stage_generation_builds_timeline(self, tmp_path, monkeypatch):
        outlines = json.dumps(
            {
                "title": "什么是递归",
                "outlines": [
                    {
                        "id": "s1",
                        "type": "slide",
                        "title": "开场",
                        "key_points": ["定义"],
                        "minutes": 3,
                    },
                    {
                        "id": "s2",
                        "type": "quiz",
                        "title": "小测",
                        "key_points": [],
                        "minutes": 3,
                        "objective": "检查定义",
                    },
                    {
                        "id": "s3",
                        "type": "quiz",
                        "title": "小测2",
                        "key_points": [],
                        "minutes": 3,
                        "objective": "再测",
                    },
                    {
                        "id": "s4",
                        "type": "quiz",
                        "title": "小测3(超额)",
                        "key_points": [],
                        "minutes": 3,
                    },
                ],
            },
            ensure_ascii=False,
        )
        scene = json.dumps(
            {
                "title": "开场",
                "key_points": ["定义", " base case"],
                "actions": [
                    {"type": "speech", "agent_id": "teacher", "text": "递归就是自己调用自己。"},
                    {
                        "type": "speech",
                        "agent_id": "curious",
                        "text": "那如果没有终止条件呢?如果没有终止条件会怎样,这一点我总搞不清。",
                    },
                    {"type": "quiz_trigger"},
                ],
                "questions": [
                    {
                        "id": "q1",
                        "type": "single",
                        "question": "递归需要?",
                        "options": ["终止条件", "循环"],
                        "answer": "0",
                        "analysis": "必须有终止条件",
                    },
                ],
            },
            ensure_ascii=False,
        )
        _scripted_complete([outlines, scene, scene, scene], monkeypatch)
        steps: list[str] = []

        async def on_progress(step, info):
            steps.append(step)

        document = await generate_classroom(
            "什么是递归", minutes=10, language="zh", on_progress=on_progress
        )
        assert document.title == "什么是递归"
        assert teacher(document).id == "teacher"
        # The 4th quiz outline was demoted to a slide (resource discipline).
        types = [s.type for s in document.scenes]
        assert types == ["slide", "quiz", "quiz", "slide"]
        # Every scene opens with the teacher speaking.
        for scene_obj in document.scenes:
            assert scene_obj.actions[0]["type"] == ACTION_SPEECH
            assert scene_obj.actions[0]["agent_id"] == "teacher"
        assert "generating_scenes" in steps and steps[-1] == "completed"

    @pytest.mark.asyncio
    async def test_scene_failure_degrades_not_fails(self, monkeypatch):
        outlines = json.dumps(
            {
                "title": "T",
                "outlines": [
                    {"id": "s1", "type": "slide", "title": "A", "key_points": ["x"]},
                    {"id": "s2", "type": "slide", "title": "B", "key_points": ["y"]},
                ],
            },
            ensure_ascii=False,
        )
        good_scene = json.dumps(
            {
                "title": "A",
                "key_points": ["x"],
                "actions": [{"type": "speech", "agent_id": "teacher", "text": "讲 A"}],
            }
        )
        _scripted_complete([outlines, good_scene, "这不是 JSON {{{"], monkeypatch)
        document = await generate_classroom("T")
        assert len(document.scenes) == 2
        # The degraded scene still opens with the teacher (fallback card).
        assert document.scenes[1].actions[0]["agent_id"] == "teacher"


class TestDirector:
    @pytest.mark.asyncio
    async def test_no_classmates_means_teacher_then_end(self):
        document = ClassroomDocument(
            id="x",
            title="t",
            topic="t",
            agent_profiles=[AgentProfile(id="teacher", name="T", role="teacher")],
        )
        assert (
            await director_mod.pick_next_speaker(document, summaries=[], turn_count=0) == "teacher"
        )
        assert (
            await director_mod.pick_next_speaker(
                document,
                summaries=[{"agent_id": "teacher", "content": "..."}],
                turn_count=1,
            )
            == "END"
        )

    @pytest.mark.asyncio
    async def test_director_routes_and_never_repeats(self, monkeypatch):
        document = _doc()

        async def fake_complete(prompt, system_prompt="", **kwargs):
            return '{"next_agent": "teacher"}'

        import knorvia.services.llm

        monkeypatch.setattr(knorvia.services.llm, "complete", fake_complete)
        picked = await director_mod.pick_next_speaker(
            document,
            summaries=[{"agent_id": "curious", "content": "…"}],
            turn_count=2,
            pending_question="学生还没懂",
        )
        assert picked == "teacher"

        # Same-speaker rule: director says "curious" again after curious —
        # the code path flips to another member instead.
        async def fake_repeat(prompt, system_prompt="", **kwargs):
            return '{"next_agent": "curious"}'

        monkeypatch.setattr(knorvia.services.llm, "complete", fake_repeat)
        picked = await director_mod.pick_next_speaker(
            document,
            summaries=[{"agent_id": "curious", "content": "…"}],
            turn_count=3,
        )
        assert picked != "curious"

    @pytest.mark.asyncio
    async def test_speak_returns_text_and_is_capped(self, monkeypatch):
        document = _doc()

        async def fake_complete(prompt, system_prompt="", **kwargs):
            return "我觉得" + "很重要" * 500  # way over the cap

        import knorvia.services.llm

        monkeypatch.setattr(knorvia.services.llm, "complete", fake_complete)
        text = await director_mod.speak(
            document, "curious", scene_context="递归", transcript=[], user_message="为什么?"
        )
        assert 0 < len(text) <= 600
        assert text.startswith("我觉得")


class TestGrading:
    @pytest.mark.asyncio
    async def test_objective_grades_deterministically(self, tmp_path):
        document = _doc()
        scene = document.scenes[1]
        results = await grade_answers(scene, {"q1": "1"})
        assert results[0]["correct"] is True
        wrong = await grade_answers(scene, {"q1": "0"})
        assert wrong[0]["correct"] is False

    @pytest.mark.asyncio
    async def test_short_answers_go_to_llm(self, tmp_path, monkeypatch):
        document = _doc()
        document.scenes[1].questions.append(
            QuizQuestion(id="q2", type="short", question="用自己的话说递归", answer="自己调用自己")
        )

        async def fake_complete(prompt, system_prompt="", **kwargs):
            return '{"correct": true, "comment": "意思对了"}'

        import knorvia.services.llm

        monkeypatch.setattr(knorvia.services.llm, "complete", fake_complete)
        results = await grade_answers(document.scenes[1], {"q2": "函数调用它自己"})
        assert results[0]["correct"] is True
        assert results[0]["comment"] == "意思对了"
