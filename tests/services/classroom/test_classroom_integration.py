"""Organic ties: personas as classmates, KB grounding, question-bank/notebook export."""

from __future__ import annotations

import json
from typing import Any

import pytest

from knorvia.services.classroom.generator import _agent_profiles, generate_classroom
from knorvia.services.classroom.models import (
    ClassroomDocument,
    QuizQuestion,
    Scene,
    SceneOutline,
)
from knorvia.services.classroom.store import ClassroomStore


def _scripted(responses: list[str], monkeypatch, captured: list[dict[str, Any]] | None = None):
    async def fake_complete(prompt, system_prompt="", **kwargs):
        if captured is not None:
            captured.append({"prompt": prompt, "system": system_prompt})
        if len(responses) == 1:
            return responses[0]
        return responses.pop(0)

    import knorvia.services.llm

    monkeypatch.setattr(knorvia.services.llm, "complete", fake_complete)


class TestPersonaClassmates:
    def test_personas_seat_as_classmates_with_builtin_fallback(self):
        specs = [
            {"name": "苏格拉底", "description": "爱用反问引导"},
            {"name": "费曼", "description": "把复杂讲简单"},
        ]
        profiles = _agent_profiles("zh", persona_specs=specs)
        assert [p.role for p in profiles][0] == "teacher"
        classmates = [p for p in profiles if p.role == "classmate"]
        assert [p.name for p in classmates[:2]] == ["苏格拉底", "费曼"]
        assert classmates[0].persona == "爱用反问引导"
        # Remaining seats fall back to builtin archetypes.
        assert len(classmates) == 3 and classmates[2].persona

    def test_teacher_stays_builtin_even_with_personas(self):
        profiles = _agent_profiles("zh", persona_specs=[{"name": "X", "description": "d"}])
        assert profiles[0].role == "teacher" and profiles[0].name != "X"

    @pytest.mark.asyncio
    async def test_generation_uses_persona_roster(self, monkeypatch):
        outlines = json.dumps(
            {
                "title": "T",
                "outlines": [
                    {"id": "s1", "type": "slide", "title": "A", "key_points": ["x"]},
                ],
            },
            ensure_ascii=False,
        )
        scene = json.dumps(
            {
                "title": "A",
                "key_points": ["x"],
                "actions": [{"type": "speech", "agent_id": "teacher", "text": "讲 A"}],
            }
        )
        _scripted([outlines, scene], monkeypatch)
        document = await generate_classroom(
            "T", persona_specs=[{"name": "费曼", "description": "把复杂讲简单"}]
        )
        names = [p.name for p in document.agent_profiles]
        assert "费曼" in names


class TestKBGrounding:
    @pytest.mark.asyncio
    async def test_grounding_reaches_the_outline_prompt(self, monkeypatch):
        captured: list[dict[str, Any]] = []
        outlines = json.dumps(
            {
                "title": "T",
                "outlines": [
                    {"id": "s1", "type": "slide", "title": "A", "key_points": ["x"]},
                ],
            },
            ensure_ascii=False,
        )
        scene = json.dumps(
            {
                "title": "A",
                "key_points": ["x"],
                "actions": [{"type": "speech", "agent_id": "teacher", "text": "讲 A"}],
            }
        )
        _scripted([outlines, scene], monkeypatch, captured=captured)
        await generate_classroom("T", kb_context="KB 原文:递归必须有 base case,否则栈溢出。")
        assert any("递归必须有 base case" in call["prompt"] for call in captured)
        assert any("kb_grounding" in call["prompt"] for call in captured)


class TestSaveQuestionsToBank:
    @pytest.mark.asyncio
    async def test_wrong_answers_land_in_the_question_bank(self, tmp_path, monkeypatch):
        from knorvia.api.routers import classroom as classroom_router
        from knorvia.services.classroom.store import ClassroomStore
        from knorvia.services.session.sqlite_store import SQLiteSessionStore

        document = ClassroomDocument(
            id="lesson-1",
            title="递归入门",
            topic="递归",
            scenes=[
                Scene(
                    id="s1",
                    order=0,
                    type="quiz",
                    title="小测",
                    questions=[
                        QuizQuestion(
                            id="q1",
                            type="single",
                            question="递归需要什么?",
                            options=["终止条件", "全局变量"],
                            answer="0",
                            analysis="必须有终止条件",
                        )
                    ],
                )
            ],
        )
        store = ClassroomStore(root=tmp_path / "classrooms")
        store.save(document)
        monkeypatch.setattr(classroom_router, "get_classroom_store", lambda: store)

        sqlite_store = SQLiteSessionStore(db_path=tmp_path / "sessions.db")
        monkeypatch.setattr(
            "knorvia.services.session.sqlite_store.get_sqlite_session_store",
            lambda: sqlite_store,
        )

        payload = classroom_router.SaveQuestionsRequest(
            scene_id="s1",
            only_wrong=True,
            entries=[{"question_id": "q1", "user_answer": "1", "is_correct": False}],
        )
        result = await classroom_router.save_questions_to_bank("lesson-1", payload)
        assert result["saved"] == 1

        listing = await sqlite_store.list_notebook_entries(session_id="classroom:lesson-1")
        rows = listing["items"]
        assert listing["total"] == 1
        saved = rows[0]
        assert saved["question"] == "递归需要什么?"
        assert saved["correct_answer"] == "A"
        assert saved["is_correct"] is False
        assert saved["explanation"] == "必须有终止条件"

        # Correct answers are skipped under only_wrong.
        payload_ok = classroom_router.SaveQuestionsRequest(
            scene_id="s1",
            only_wrong=True,
            entries=[{"question_id": "q1", "user_answer": "0", "is_correct": True}],
        )
        result = await classroom_router.save_questions_to_bank("lesson-1", payload_ok)
        assert result["saved"] == 0


class TestNotebookExport:
    @pytest.mark.asyncio
    async def test_export_creates_default_notebook_and_record(self, tmp_path, monkeypatch):
        from knorvia.api.routers import classroom as classroom_router
        from knorvia.services.classroom.models import (
            ClassroomDocument,
        )

        class StubManager:
            def __init__(self) -> None:
                self.records: list[Any] = []
                self.created: list[str] = []

            def list_notebooks(self):
                return []

            def create_notebook(self, name, description="", color="", icon=""):
                self.created.append(name)
                return {"id": "nb-1", "name": name}

            def add_record(
                self,
                notebook_ids,
                record_type,
                title,
                user_query,
                output,
                summary="",
                metadata=None,
            ):
                self.records.append({"title": title, "output": output})
                return {"id": "rec-1"}

        stub = StubManager()
        import knorvia.services.notebook as notebook_pkg

        monkeypatch.setattr(notebook_pkg, "notebook_manager", stub)

        document = ClassroomDocument(
            id="lesson-2",
            title="递归入门",
            topic="递归",
            outlines=[SceneOutline(id="s1", type="slide", title="A", order=0)],
            scenes=[
                Scene(
                    id="s1",
                    order=0,
                    type="slide",
                    title="开场",
                    key_points=["定义", "base case"],
                    objective="理解递归",
                    actions=[{"type": "speech", "agent_id": "teacher", "text": "x"}],
                )
            ],
        )
        store = ClassroomStore(root=tmp_path / "classrooms")
        store.save(document)
        monkeypatch.setattr(classroom_router, "get_classroom_store", lambda: store)

        result = await classroom_router.export_to_notebook("lesson-2", "")
        assert stub.created == ["AI 课堂"]
        assert result["notebook_id"] == "nb-1"
        record_output = stub.records[0]["output"]
        assert "## 开场" in record_output and "- 定义" in record_output
