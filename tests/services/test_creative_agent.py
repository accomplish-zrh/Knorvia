from __future__ import annotations

from knorvia.services.creative_agent.ops import (
    apply_image_ops,
    apply_video_ops,
    generate_targets,
    plan_image_ops,
    plan_video_ops,
)
from knorvia.services.creative_agent.planning import (
    build_internal_brief,
    infer_creation_mode,
    parse_custom_pixels,
    public_create_reply,
)


def test_infer_mode_keeps_explicit_choice() -> None:
    assert infer_creation_mode("animate this", "image") == "image"
    assert infer_creation_mode("a quiet portrait", "video") == "video"


def test_infer_mode_from_prompt() -> None:
    assert infer_creation_mode("做一段首帧驱动的视频") == "video"
    assert infer_creation_mode("一张商品主图") == "image"
    assert infer_creation_mode("something pretty") == "image"


def test_brief_keeps_verbatim_prompt_and_skips_review() -> None:
    brief = build_internal_brief(
        "red enamel mug, three-quarter view",
        mode="image",
        reference_ids=["a1"],
    )
    assert brief["user_prompt"] == "red enamel mug, three-quarter view"
    assert brief["review"]["status"] == "skipped"
    assert brief["consistency"]["keep_subject"] is True
    assert "red enamel mug" in brief["goal"]


def test_public_reply_does_not_leak_brief() -> None:
    reply = public_create_reply(mode="image", language="en")
    assert "visual_direction" not in reply
    assert "Image Studio" in reply


def test_parse_custom_pixels() -> None:
    assert parse_custom_pixels("1536x1024") == (1536, 1024)
    assert parse_custom_pixels("12x12") is None


def test_image_plan_adds_brief_and_generate() -> None:
    board = {"nodes": [], "edges": []}
    brief = build_internal_brief("a lamp", mode="image")
    ops = plan_image_ops("a lamp", board, brief=brief)
    assert [op["type"] for op in ops] == ["add_node", "add_node", "connect", "generate"]
    assert ops[0]["kind"] == "text"
    assert ops[1]["prompt"] == "a lamp"
    next_board = apply_image_ops(board, ops)
    assert len(next_board["nodes"]) == 2
    assert generate_targets(ops) == [ops[1]["id"]]


def test_video_plan_uses_first_and_last_frames() -> None:
    board = {
        "nodes": [
            {"id": "img1", "kind": "image", "x": 0, "y": 0, "width": 100, "height": 100},
            {"id": "img2", "kind": "image", "x": 200, "y": 0, "width": 100, "height": 100},
        ],
        "edges": [],
    }
    brief = build_internal_brief("walk forward", mode="video")
    ops = plan_video_ops("walk forward", board, brief=brief, selected_ids=["img1", "img2"])
    roles = [op.get("role") for op in ops if op["type"] == "connect"]
    assert "first-frame" in roles
    assert "last-frame" in roles
    next_board = apply_video_ops(board, ops)
    generate = next(node for node in next_board["nodes"] if node["kind"] == "generate")
    assert generate["prompt"] == "walk forward"
    assert generate["operation"] == "image_to_video"
