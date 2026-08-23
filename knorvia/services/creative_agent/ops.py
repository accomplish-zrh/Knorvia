"""Canvas agent operations for Image Studio and Video Studio boards.

Independent document ops — not another product's node protocol. Jobs are
started by the runner through the existing studio engines.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from .planning import compact_brief_text

IMAGE_KINDS = frozenset({"image", "generate", "text"})
VIDEO_KINDS = frozenset({"text", "image", "video", "audio", "generate"})
IMAGE_ROLES = frozenset({"reference", "mask"})
VIDEO_ROLES = frozenset({"reference", "first-frame", "last-frame", "audio", "continue-from"})
OP_TYPES = frozenset({"add_node", "update_node", "delete_node", "connect", "generate"})
MAX_OPS = 40


def _node_id(raw: Any) -> str:
    text = str(raw or "").strip()
    return text[:80] if text else f"node_{uuid4().hex[:10]}"


def _edge_id() -> str:
    return f"edge_{uuid4().hex[:10]}"


def _place(existing: list[dict[str, Any]], width: float, height: float) -> tuple[float, float]:
    x = 80.0
    y = 80.0
    for step in range(24):
        rect = {"x": x, "y": y, "width": width, "height": height}
        if not any(_overlap(rect, node) for node in existing):
            return x, y
        x += width + 48
        if step % 3 == 2:
            x = 80.0
            y += height + 48
    return x, y


def _overlap(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return not (
        float(a["x"]) + float(a["width"]) <= float(b["x"])
        or float(b["x"]) + float(b["width"]) <= float(a["x"])
        or float(a["y"]) + float(a["height"]) <= float(b["y"])
        or float(b["y"]) + float(b["height"]) <= float(a["y"])
    )


def _sizes(kind: str, studio: str) -> tuple[float, float]:
    if kind == "text":
        return 240.0, 140.0
    if kind == "generate":
        return 320.0, 292.0
    if studio == "video" and kind == "video":
        return 320.0, 240.0
    if studio == "video" and kind == "audio":
        return 240.0, 96.0
    return 280.0, 280.0


def apply_ops(
    board: dict[str, Any],
    ops: list[dict[str, Any]],
    *,
    studio: str,
) -> dict[str, Any]:
    kinds = VIDEO_KINDS if studio == "video" else IMAGE_KINDS
    roles = VIDEO_ROLES if studio == "video" else IMAGE_ROLES
    nodes = [dict(node) for node in board.get("nodes") or []]
    edges = [dict(edge) for edge in board.get("edges") or []]
    by_id = {str(node.get("id")): node for node in nodes}
    for op in (ops or [])[:MAX_OPS]:
        if not isinstance(op, dict):
            continue
        kind = str(op.get("type") or "")
        if kind == "add_node":
            node_kind = str(op.get("kind") or "generate")
            if node_kind not in kinds:
                continue
            node_id = _node_id(op.get("id"))
            if node_id in by_id:
                continue
            width, height = _sizes(node_kind, studio)
            x, y = _place(nodes, width, height)
            node = {
                "id": node_id,
                "kind": node_kind,
                "x": float(op.get("x") if op.get("x") is not None else x),
                "y": float(op.get("y") if op.get("y") is not None else y),
                "width": width,
                "height": height,
                "z": len(nodes),
            }
            for key in ("title", "prompt", "text", "assetId", "modelKey", "ratio", "quality"):
                value = op.get(key)
                if isinstance(value, str) and value.strip():
                    node[key] = value.strip()[:4000]
            if studio == "video":
                for key in ("operation", "resolution", "referenceMode"):
                    value = op.get(key)
                    if isinstance(value, str) and value.strip():
                        node[key] = value.strip()[:80]
                if op.get("seconds"):
                    try:
                        node["seconds"] = int(op["seconds"])
                    except (TypeError, ValueError):
                        pass
            for key in ("customWidth", "customHeight"):
                try:
                    number = int(op.get(key) or 0)
                except (TypeError, ValueError):
                    number = 0
                if number > 0:
                    node[key] = number
            nodes.append(node)
            by_id[node_id] = node
        elif kind == "update_node":
            node = by_id.get(str(op.get("id") or ""))
            if not node:
                continue
            patch = op.get("patch") if isinstance(op.get("patch"), dict) else {}
            for key, value in patch.items():
                if key in {"x", "y", "width", "height", "z"}:
                    continue
                if value is None:
                    node.pop(key, None)
                else:
                    node[key] = value
        elif kind == "delete_node":
            ids = {
                str(item) for item in (op.get("ids") or ([op.get("id")] if op.get("id") else []))
            }
            nodes = [node for node in nodes if node.get("id") not in ids]
            edges = [
                edge for edge in edges if edge.get("from") not in ids and edge.get("to") not in ids
            ]
            by_id = {str(node.get("id")): node for node in nodes}
        elif kind == "connect":
            start, end = str(op.get("from") or ""), str(op.get("to") or "")
            if start not in by_id or end not in by_id or start == end:
                continue
            role = str(op.get("role") or "reference")
            if role not in roles:
                role = "reference"
            if any(edge.get("from") == start and edge.get("to") == end for edge in edges):
                continue
            edges.append({"id": _edge_id(), "from": start, "to": end, "role": role})
    next_board = dict(board)
    next_board["nodes"] = nodes
    next_board["edges"] = edges
    return next_board


def apply_image_ops(board: dict[str, Any], ops: list[dict[str, Any]]) -> dict[str, Any]:
    return apply_ops(board, ops, studio="image")


def apply_video_ops(board: dict[str, Any], ops: list[dict[str, Any]]) -> dict[str, Any]:
    return apply_ops(board, ops, studio="video")


def plan_image_ops(
    prompt: str,
    board: dict[str, Any],
    *,
    brief: dict[str, Any],
    selected_ids: list[str] | None = None,
    language: str = "en",
    model_key: str = "",
    ratio: str = "",
    quality: str = "",
    custom_width: int | None = None,
    custom_height: int | None = None,
) -> list[dict[str, Any]]:
    nodes = list(board.get("nodes") or [])
    selected = [
        item for item in (selected_ids or []) if any(node.get("id") == item for node in nodes)
    ]
    generate_id = _node_id("")
    brief_id = _node_id("")
    ops: list[dict[str, Any]] = [
        {
            "type": "add_node",
            "id": brief_id,
            "kind": "text",
            "title": "Brief",
            "text": compact_brief_text(brief, language=language),
        },
        {
            "type": "add_node",
            "id": generate_id,
            "kind": "generate",
            "title": "Generate",
            "prompt": prompt,
            "modelKey": model_key,
            "ratio": ratio,
            "quality": quality,
            "customWidth": custom_width,
            "customHeight": custom_height,
        },
        {"type": "connect", "from": brief_id, "to": generate_id, "role": "reference"},
        {"type": "generate", "id": generate_id},
    ]
    for node_id in selected:
        node = next((item for item in nodes if item.get("id") == node_id), None)
        if not node:
            continue
        role = (
            "mask"
            if node.get("kind") == "image" and str(node.get("title") or "").lower() == "mask"
            else "reference"
        )
        ops.insert(-1, {"type": "connect", "from": node_id, "to": generate_id, "role": role})
    return ops


def plan_video_ops(
    prompt: str,
    board: dict[str, Any],
    *,
    brief: dict[str, Any],
    selected_ids: list[str] | None = None,
    language: str = "en",
    model_key: str = "",
    ratio: str = "",
    resolution: str = "",
    seconds: int | None = None,
    reference_mode: str = "",
) -> list[dict[str, Any]]:
    nodes = list(board.get("nodes") or [])
    selected = [
        item for item in (selected_ids or []) if any(node.get("id") == item for node in nodes)
    ]
    generate_id = _node_id("")
    brief_id = _node_id("")
    image_ids = [
        node_id
        for node_id in selected
        if next((item for item in nodes if item.get("id") == node_id), {}).get("kind") == "image"
    ]
    video_ids = [
        node_id
        for node_id in selected
        if next((item for item in nodes if item.get("id") == node_id), {}).get("kind") == "video"
    ]
    audio_ids = [
        node_id
        for node_id in selected
        if next((item for item in nodes if item.get("id") == node_id), {}).get("kind") == "audio"
    ]
    if video_ids:
        operation = "extend"
        mode = "auto"
    elif len(image_ids) >= 2 and reference_mode in {"", "auto", "first-last"}:
        operation = "image_to_video"
        mode = "first-last"
    elif image_ids:
        operation = "image_to_video"
        mode = "first-frame"
    else:
        operation = "text_to_video"
        mode = reference_mode or "auto"
    ops: list[dict[str, Any]] = [
        {
            "type": "add_node",
            "id": brief_id,
            "kind": "text",
            "title": "Brief",
            "text": compact_brief_text(brief, language=language),
        },
        {
            "type": "add_node",
            "id": generate_id,
            "kind": "generate",
            "title": "Generate",
            "prompt": prompt,
            "modelKey": model_key,
            "ratio": ratio,
            "resolution": resolution,
            "seconds": seconds,
            "operation": operation,
            "referenceMode": mode,
        },
        {"type": "connect", "from": brief_id, "to": generate_id, "role": "reference"},
    ]
    if image_ids:
        ops.append(
            {"type": "connect", "from": image_ids[0], "to": generate_id, "role": "first-frame"}
        )
        if mode == "first-last" and len(image_ids) > 1:
            ops.append(
                {"type": "connect", "from": image_ids[1], "to": generate_id, "role": "last-frame"}
            )
        for extra in image_ids[2 if mode == "first-last" else 1 :]:
            ops.append({"type": "connect", "from": extra, "to": generate_id, "role": "reference"})
    for node_id in video_ids:
        ops.append({"type": "connect", "from": node_id, "to": generate_id, "role": "continue-from"})
    for node_id in audio_ids:
        ops.append({"type": "connect", "from": node_id, "to": generate_id, "role": "audio"})
    ops.append({"type": "generate", "id": generate_id})
    return ops


def generate_targets(ops: list[dict[str, Any]]) -> list[str]:
    return [str(op.get("id") or "") for op in ops if op.get("type") == "generate" and op.get("id")]
