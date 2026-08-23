from __future__ import annotations

from pathlib import Path

import pytest

from knorvia.services.video_studio.production import (
    analyze_script,
    apply_production,
    confirm_review,
    production_readiness,
    review_is_current,
)
from knorvia.services.video_studio.store import VideoStudioStore

CHINESE_SCRIPT = """第一场 厨房 夜

林夏：别等我了。

她关上窗。雨打在玻璃上。

第二场 巷口 夜

阿澈：钥匙还在你那儿。
"""

ENGLISH_SCRIPT = """INT. KITCHEN - NIGHT

LINA
Don't wait up.

She closes the window. Rain on the glass.

INT. ALLEY - NIGHT

ARCHER
You still have the key.
"""


def test_analyze_chinese_script_extracts_scenes_cast_and_shots() -> None:
    analysis = analyze_script(CHINESE_SCRIPT, language="zh")
    names = {item["name"] for item in analysis["characters"]}
    assert "林夏" in names
    assert "阿澈" in names
    assert len(analysis["scenes"]) == 2
    assert len(analysis["shots"]) >= 2
    assert any("厨房" in shot["prompt"] or "巷口" in shot["prompt"] for shot in analysis["shots"])


def test_analyze_english_numbered_and_cues() -> None:
    analysis = analyze_script(ENGLISH_SCRIPT, language="en")
    names = {item["name"] for item in analysis["characters"]}
    assert "LINA" in names or "Lina" in names
    assert len(analysis["shots"]) >= 2


def test_review_gate_and_apply_writes_storyboard(tmp_path: Path) -> None:
    store = VideoStudioStore(tmp_path / "studio")
    project = store.create_project("Episode")
    project_id = project["id"]
    production = store.get_production(project_id)["production"]
    production["script"]["text"] = CHINESE_SCRIPT
    production["script"]["language"] = "zh"
    production["analysis"] = analyze_script(CHINESE_SCRIPT, language="zh")
    store.save_production(project_id, production)

    readiness = production_readiness(
        store.get_production(project_id)["production"],
        characters=[],
        shots=[],
    )
    assert readiness["script"] is True
    assert readiness["analysis"] is True
    assert readiness["review"] is False

    with pytest.raises(ValueError, match="Confirm"):
        apply_production(store, project_id)

    confirmed = confirm_review(
        store.get_production(project_id)["production"],
        notes="ok",
        now=1.0,
    )
    store.save_production(project_id, confirmed)
    assert review_is_current(store.get_production(project_id)["production"])

    result = apply_production(store, project_id)
    shots = result["storyboard"]["shots"]
    assert len(shots) >= 2
    assert any(shot.get("voiceover_text") for shot in shots)
    characters = store.list_characters(project_id)
    assert {item["name"] for item in characters} >= {"林夏", "阿澈"}
    assert result["readiness"]["storyboard"]["ready"] if "readiness" in result else True
    board = store.get_board(project_id)
    generates = [node for node in board.get("nodes") or [] if node.get("kind") == "generate"]
    assert generates
    bound = {node.get("storyboardShotId") for node in generates}
    assert bound & {shot["id"] for shot in shots}
