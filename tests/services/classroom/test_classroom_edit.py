"""T4 — course editing: atomic op set, id stability, transactional store."""

from __future__ import annotations

import json
import threading
from typing import Any

from fastapi import HTTPException
import pytest

from knorvia.api.routers import classroom as classroom_router
from knorvia.services.classroom.edit import EditError, apply_ops
from knorvia.services.classroom.models import (
    ClassroomDocument,
    QuizQuestion,
    Scene,
    SceneOutline,
)
from knorvia.services.classroom.store import ClassroomStore


def _doc() -> ClassroomDocument:
    return ClassroomDocument(
        id="lesson-edit",
        title="可编辑的课",
        topic="editing",
        version=3,
        outlines=[
            SceneOutline(id="s1", type="slide", title="开场", order=0, minutes=3),
            SceneOutline(id="s2", type="quiz", title="小测", order=1, minutes=3),
            SceneOutline(id="s3", type="slide", title="收尾", order=2, minutes=3),
        ],
        scenes=[
            Scene(
                id="s1",
                order=0,
                type="slide",
                title="开场",
                key_points=["a", "b"],
                objective="理解开场",
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
                        options=["1", "2"],
                        answer="1",
                        analysis="显然",
                    )
                ],
                actions=[{"type": "quiz_trigger"}],
            ),
            Scene(id="s3", order=2, type="slide", title="收尾", key_points=["c"]),
        ],
    )


class TestSetOp:
    def test_set_title_objective_key_points(self):
        doc = apply_ops(
            _doc(),
            [
                {"type": "set", "scene_id": "s1", "field": "title", "value": "新标题"},
                {
                    "type": "set",
                    "scene_id": "s1",
                    "field": "key_points",
                    "value": ["x", " y ", ""],
                },
                {"type": "set", "scene_id": "s1", "field": "objective", "value": "新目标"},
            ],
        )
        scene = doc.scenes[0]
        assert scene.title == "新标题"
        assert scene.key_points == ["x", "y"]
        assert scene.objective == "新目标"
        # The outline entry stays aligned (title/objective sync).
        assert doc.outlines[0].title == "新标题"
        assert doc.outlines[0].objective == "新目标"
        assert doc.version == 4

    def test_set_rejects_unknown_field_and_scene(self):
        with pytest.raises(EditError, match="op#0.*not editable"):
            apply_ops(_doc(), [{"type": "set", "scene_id": "s1", "field": "actions", "value": []}])
        with pytest.raises(EditError, match="op#0.*not found"):
            apply_ops(_doc(), [{"type": "set", "scene_id": "ghost", "field": "title", "value": "x"}])

    def test_set_minutes_updates_outline_entry(self):
        doc = apply_ops(
            _doc(), [{"type": "set", "scene_id": "s2", "field": "minutes", "value": 9}]
        )
        assert doc.outlines[1].minutes == 9

    def test_set_html_goes_through_the_safety_gate(self):
        doc = _doc()
        doc.scenes[0].type = "interactive"
        doc.scenes[0].html = "<div>old</div>"
        clean = apply_ops(
            doc,
            [
                {
                    "type": "set",
                    "scene_id": "s1",
                    "field": "html",
                    "value": "<script>localStorage.getItem('a');draw();</script>",
                }
            ],
        )
        assert "localStorage" not in clean.scenes[0].html
        assert "draw();" in clean.scenes[0].html
        with pytest.raises(EditError, match="safety scan"):
            apply_ops(
                doc,
                [
                    {
                        "type": "set",
                        "scene_id": "s1",
                        "field": "html",
                        "value": "<script src='https://x'></script>",
                    }
                ],
            )


class TestStrReplace:
    def test_single_occurrence_replaces(self):
        doc = apply_ops(
            _doc(),
            [
                {
                    "type": "str_replace",
                    "scene_id": "s1",
                    "field": "title",
                    "old": "开场",
                    "new": "引入",
                },
                {
                    "type": "str_replace",
                    "scene_id": "s1",
                    "field": "key_points",
                    "index": 0,
                    "old": "a",
                    "new": "alpha",
                },
            ],
        )
        assert doc.scenes[0].title == "引入"
        assert doc.scenes[0].key_points[0] == "alpha"

    def test_ambiguous_or_missing_match_rejects(self):
        doc = _doc()
        doc.scenes[2].title = "开场"  # second occurrence across scenes? no — per scene
        with pytest.raises(EditError, match="matches 0 times"):
            apply_ops(
                doc,
                [{"type": "str_replace", "scene_id": "s1", "field": "title", "old": "开场。", "new": "x"}],
            )
        double = _doc()
        double.scenes[0].key_points = ["same and same again"]
        with pytest.raises(EditError, match="matches 2 times"):
            apply_ops(
                double,
                [
                    {
                        "type": "str_replace",
                        "scene_id": "s1",
                        "field": "key_points",
                        "index": 0,
                        "old": "same",
                        "new": "x",
                    }
                ],
            )


class TestStructureOps:
    def test_retitle(self):
        doc = apply_ops(_doc(), [{"type": "retitle", "scene_id": "s3", "title": "总结页"}])
        assert doc.scenes[2].title == "总结页"
        assert doc.outlines[2].title == "总结页"
        with pytest.raises(EditError, match="non-empty"):
            apply_ops(_doc(), [{"type": "retitle", "scene_id": "s3", "title": " "}])

    def test_insert_blank_shifts_scenes_and_outlines(self):
        doc = apply_ops(_doc(), [{"type": "insert_blank", "at": 1}])
        assert [s.id for s in doc.scenes] == ["s1", doc.scenes[1].id, "s2", "s3"]
        assert [s.order for s in doc.scenes] == [0, 1, 2, 3]
        assert [o.order for o in doc.outlines] == [0, 1, 2, 3]
        assert len(doc.outlines) == len(doc.scenes)
        assert doc.scenes[1].type == "slide" and doc.scenes[1].title == ""

    def test_delete_scene_removes_scene_and_outline(self):
        doc = apply_ops(_doc(), [{"type": "delete_scene", "scene_id": "s2"}])
        assert [s.id for s in doc.scenes] == ["s1", "s3"]
        assert [o.id for o in doc.outlines] == ["s1", "s3"]
        assert [s.order for s in doc.scenes] == [0, 1]

    def test_reorder_full_permutation_only(self):
        doc = apply_ops(_doc(), [{"type": "reorder", "ordered_ids": ["s3", "s1", "s2"]}])
        assert [s.id for s in doc.scenes] == ["s3", "s1", "s2"]
        assert [o.id for o in doc.outlines] == ["s3", "s1", "s2"]
        assert [s.order for s in doc.scenes] == [0, 1, 2]
        with pytest.raises(EditError, match="permutation"):
            apply_ops(_doc(), [{"type": "reorder", "ordered_ids": ["s1", "s2"]}])
        with pytest.raises(EditError, match="permutation"):
            apply_ops(_doc(), [{"type": "reorder", "ordered_ids": ["s1", "s2", "s9"]}])


class TestQuizEdit:
    def test_valid_replacement_keeps_provided_ids(self):
        questions = [
            {"id": "q1", "type": "single", "question": "1+1=?", "options": ["1", "2"], "answer": "1", "analysis": "显然"},
            {"id": "q2", "type": "short", "question": "解释递归", "answer": "", "analysis": "自引用即递归"},
            {"type": "multiple", "question": "哪些是要素?", "options": ["终止", "递推", "全局变量"], "answer": "0,1", "analysis": "递归两要素"},
        ]
        doc = apply_ops(_doc(), [{"type": "quiz_edit", "scene_id": "s2", "questions": questions}])
        assert [q.id for q in doc.scenes[1].questions] == ["q1", "q2", doc.scenes[1].questions[2].id]
        assert doc.scenes[1].questions[1].answer == ""
        assert doc.scenes[1].questions[2].answer == "0,1"

    def test_invalid_questions_reject(self):
        base = {"type": "quiz_edit", "scene_id": "s2"}
        with pytest.raises(EditError, match="not in"):
            apply_ops(_doc(), [{**base, "questions": [{"id": "q1", "type": "bool", "question": "?"}]}])
        with pytest.raises(EditError, match=">= 2 options"):
            apply_ops(_doc(), [{**base, "questions": [{"id": "q1", "type": "single", "question": "?", "options": ["A"], "answer": "0"}]}])
        with pytest.raises(EditError, match="outside options"):
            apply_ops(_doc(), [{**base, "questions": [{"id": "q1", "type": "single", "question": "?", "options": ["A", "B"], "answer": "5"}]}])
        with pytest.raises(EditError, match="rubric|analysis"):
            apply_ops(_doc(), [{**base, "questions": [{"id": "q1", "type": "short", "question": "?", "answer": ""}]}])
        with pytest.raises(EditError, match="duplicate"):
            apply_ops(_doc(), [{**base, "questions": [
                {"id": "q1", "type": "single", "question": "a", "options": ["A", "B"], "answer": "0"},
                {"id": "q1", "type": "single", "question": "b", "options": ["A", "B"], "answer": "1"},
            ]}])
        with pytest.raises(EditError, match="not a quiz scene"):
            apply_ops(_doc(), [{**base, "scene_id": "s1", "questions": [{"id": "q1", "type": "single", "question": "a", "options": ["A", "B"], "answer": "0"}]}])


class TestAtomicityAndStability:
    def test_second_bad_op_leaves_document_untouched(self):
        doc = _doc()
        frozen = json.dumps(doc.to_dict(), sort_keys=True, ensure_ascii=False)
        with pytest.raises(EditError):
            apply_ops(
                doc,
                [
                    {"type": "retitle", "scene_id": "s1", "title": "改动"},
                    {"type": "delete_scene", "scene_id": "ghost"},
                ],
            )
        assert json.dumps(doc.to_dict(), sort_keys=True, ensure_ascii=False) == frozen

    def test_ids_stable_across_reorder_and_edits(self):
        doc = apply_ops(
            _doc(),
            [
                {"type": "reorder", "ordered_ids": ["s2", "s3", "s1"]},
                {"type": "retitle", "scene_id": "s2", "title": "仍是小测"},
            ],
        )
        assert sorted(s.id for s in doc.scenes) == ["s1", "s2", "s3"]
        assert doc.scenes[0].questions[0].id == "q1"

    def test_unknown_op_and_empty_ops_reject(self):
        with pytest.raises(EditError, match="unknown op type"):
            apply_ops(_doc(), [{"type": "patch_element"}])
        with pytest.raises(EditError, match="non-empty"):
            apply_ops(_doc(), [])
        with pytest.raises(EditError, match="unknown op type"):
            apply_ops(_doc(), [{"type": "set", "scene_id": "s1", "field": "title", "value": "x"}, {"type": "bogus"}])


class TestStoreSaveEdit:
    def test_save_edit_transaction_roundtrip(self, tmp_path):
        store = ClassroomStore(root=tmp_path / "classrooms")
        store.save(_doc())
        updated = store.save_edit(
            "lesson-edit",
            lambda doc: apply_ops(doc, [{"type": "retitle", "scene_id": "s1", "title": "锁定内改"}]),
        )
        assert updated is not None and updated.version == 4
        assert store.get("lesson-edit").scenes[0].title == "锁定内改"

    def test_failed_mutation_leaves_disk_untouched(self, tmp_path):
        store = ClassroomStore(root=tmp_path / "classrooms")
        store.save(_doc())
        before = (tmp_path / "classrooms" / "lesson-edit.json").read_text(encoding="utf-8")
        with pytest.raises(EditError):
            store.save_edit(
                "lesson-edit",
                lambda doc: apply_ops(doc, [{"type": "delete_scene", "scene_id": "ghost"}]),
            )
        after = (tmp_path / "classrooms" / "lesson-edit.json").read_text(encoding="utf-8")
        assert before == after

    def test_concurrent_save_edits_do_not_lose_updates(self, tmp_path):
        store = ClassroomStore(root=tmp_path / "classrooms")
        store.save(_doc())
        barrier = threading.Barrier(2)

        def edit(scene_id: str, point: str) -> None:
            barrier.wait()
            store.save_edit(
                "lesson-edit",
                lambda doc: apply_ops(
                    doc,
                    [{"type": "set", "scene_id": scene_id, "field": "objective", "value": point}],
                ),
            )

        threads = [
            threading.Thread(target=edit, args=("s1", "来自A的修改")),
            threading.Thread(target=edit, args=("s3", "来自B的修改")),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        final = store.get("lesson-edit")
        # Both edits survive (serialized under the store lock).
        assert final.scenes[0].objective == "来自A的修改"
        assert final.scenes[2].objective == "来自B的修改"
        assert final.version == 5


class TestEditApi:
    @pytest.mark.asyncio
    async def test_patch_then_get_roundtrip(self, tmp_path, monkeypatch):
        store = ClassroomStore(root=tmp_path / "classrooms")
        store.save(_doc())
        monkeypatch.setattr(classroom_router, "get_classroom_store", lambda: store)
        result = await classroom_router.edit_classroom(
            "lesson-edit",
            classroom_router.EditOpsRequest(
                ops=[{"type": "retitle", "scene_id": "s1", "title": "API 改名"}]
            ),
        )
        assert result["version"] == 4
        assert result["scenes"][0]["title"] == "API 改名"
        # Conditional refresh: same revision → lite answer; changed → full.
        unchanged = await classroom_router.get_classroom("lesson-edit", revision=4)
        assert unchanged == {"id": "lesson-edit", "version": 4, "unchanged": True}
        changed = await classroom_router.get_classroom("lesson-edit", revision=3)
        assert changed["scenes"][0]["title"] == "API 改名"

    @pytest.mark.asyncio
    async def test_patch_conflict_names_the_op(self, tmp_path, monkeypatch):
        store = ClassroomStore(root=tmp_path / "classrooms")
        store.save(_doc())
        monkeypatch.setattr(classroom_router, "get_classroom_store", lambda: store)
        with pytest.raises(HTTPException) as exc_info:
            await classroom_router.edit_classroom(
                "lesson-edit",
                classroom_router.EditOpsRequest(
                    ops=[{"type": "delete_scene", "scene_id": "ghost"}]
                ),
            )
        assert exc_info.value.status_code == 409
        assert "op#0" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    async def test_patch_missing_classroom_404(self, tmp_path, monkeypatch):
        store = ClassroomStore(root=tmp_path / "classrooms")
        monkeypatch.setattr(classroom_router, "get_classroom_store", lambda: store)
        with pytest.raises(HTTPException) as exc_info:
            await classroom_router.edit_classroom(
                "ghost",
                classroom_router.EditOpsRequest(
                    ops=[{"type": "retitle", "scene_id": "s1", "title": "x"}]
                ),
            )
        assert exc_info.value.status_code == 404
