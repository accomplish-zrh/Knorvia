"""Session-board helpers for the Image Studio agent.

These mutate the same ``board.json`` the canvas UI persists. They do not call
image providers — jobs still go through ``agent.run_studio_image_job``.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from knorvia.services.image_studio.store import ImageStudioStore

BOARD_TEMPLATES = {
    "three-view": {
        "title": "Three-view",
        "nodes": [
            {
                "id": "ref",
                "kind": "image",
                "title": "Character reference",
                "x": 0,
                "y": 180,
                "width": 260,
                "height": 180,
            },
            {
                "id": "note",
                "kind": "text",
                "title": "Identity",
                "text": "Same character, clothing, and palette in every view.",
                "x": 0,
                "y": 0,
                "width": 280,
                "height": 160,
            },
            {
                "id": "front",
                "kind": "generate",
                "title": "Front",
                "prompt": "Front view of the same character, full body, even studio light.",
                "x": 340,
                "y": 0,
                "width": 320,
                "height": 292,
            },
            {
                "id": "side",
                "kind": "generate",
                "title": "Side",
                "prompt": "Side view of the same character, full body, matching the front view.",
                "x": 340,
                "y": 240,
                "width": 320,
                "height": 292,
            },
            {
                "id": "back",
                "kind": "generate",
                "title": "Back",
                "prompt": "Back view of the same character, full body, matching the front view.",
                "x": 340,
                "y": 480,
                "width": 320,
                "height": 292,
            },
        ],
        "edges": [
            ("note", "front"),
            ("note", "side"),
            ("note", "back"),
            ("ref", "front"),
            ("ref", "side"),
            ("ref", "back"),
        ],
    },
    "product-set": {
        "title": "Product set",
        "nodes": [
            {
                "id": "product",
                "kind": "image",
                "title": "Product photo",
                "x": 0,
                "y": 200,
                "width": 260,
                "height": 180,
            },
            {
                "id": "brief",
                "kind": "text",
                "title": "Product brief",
                "text": "Keep the product identical. Clean commercial lighting.",
                "x": 0,
                "y": 0,
                "width": 280,
                "height": 160,
            },
            {
                "id": "hero",
                "kind": "generate",
                "title": "Hero",
                "prompt": "Hero product shot, centered, soft studio light, clean background.",
                "x": 360,
                "y": 0,
                "width": 320,
                "height": 292,
            },
            {
                "id": "detail",
                "kind": "generate",
                "title": "Detail",
                "prompt": "Close-up detail of the same product, sharp materials.",
                "x": 360,
                "y": 220,
                "width": 320,
                "height": 292,
            },
            {
                "id": "lifestyle",
                "kind": "generate",
                "title": "Lifestyle",
                "prompt": "Lifestyle scene with the same product in use.",
                "x": 700,
                "y": 0,
                "width": 320,
                "height": 292,
            },
            {
                "id": "social",
                "kind": "generate",
                "title": "Social",
                "prompt": "Vertical social cover featuring the same product.",
                "x": 700,
                "y": 220,
                "width": 320,
                "height": 292,
            },
        ],
        "edges": [
            ("brief", "hero"),
            ("brief", "detail"),
            ("brief", "lifestyle"),
            ("brief", "social"),
            ("product", "hero"),
            ("product", "detail"),
            ("product", "lifestyle"),
            ("product", "social"),
        ],
    },
    "picture-book": {
        "title": "Picture book",
        "nodes": [
            {
                "id": "style",
                "kind": "text",
                "title": "Book style",
                "text": "Same picture-book style, soft color, child-friendly.",
                "x": 0,
                "y": 160,
                "width": 280,
                "height": 160,
            },
            *[
                item
                for page in range(1, 5)
                for item in (
                    {
                        "id": f"page-{page}",
                        "kind": "text",
                        "title": f"Page {page}",
                        "text": f"Page {page} narration.",
                        "x": 300,
                        "y": (page - 1) * 200,
                        "width": 280,
                        "height": 160,
                    },
                    {
                        "id": f"art-{page}",
                        "kind": "generate",
                        "title": f"Art {page}",
                        "prompt": f"Illustration for page {page}, matching the book style.",
                        "x": 620,
                        "y": (page - 1) * 200,
                        "width": 320,
                        "height": 292,
                    },
                )
            ],
        ],
        "edges": [
            *[
                item
                for page in range(1, 5)
                for item in ((f"page-{page}", f"art-{page}"), ("style", f"art-{page}"))
            ],
        ],
    },
}

TEMPLATE_ALIASES = {
    "three-view": "three-view",
    "three_view": "three-view",
    "threeview": "three-view",
    "3view": "three-view",
    "product-set": "product-set",
    "product_set": "product-set",
    "productset": "product-set",
    "ecommerce": "product-set",
    "picture-book": "picture-book",
    "picture_book": "picture-book",
    "picturebook": "picture-book",
}


def normalize_template_id(value: str | None) -> str | None:
    key = str(value or "").strip().lower().replace(" ", "-")
    if not key:
        return None
    if key not in TEMPLATE_ALIASES:
        raise ValueError("Unknown board template. Use three-view, product-set, or picture-book.")
    return TEMPLATE_ALIASES[key]


def summarize_board(board: dict[str, Any]) -> dict[str, Any]:
    nodes = []
    for node in board.get("nodes") or []:
        nodes.append(
            {
                "id": node.get("id"),
                "kind": node.get("kind"),
                "title": node.get("title") or "",
                "asset_id": node.get("assetId") or "",
                "job_id": node.get("jobId") or "",
                "status": node.get("status") or "",
                "group_id": node.get("groupId") or "",
                "parent_node_id": node.get("parentNodeId") or "",
            }
        )
    return {
        "node_count": len(nodes),
        "edge_count": len(board.get("edges") or []),
        "groups": [
            {"id": group.get("id"), "title": group.get("title")}
            for group in board.get("groups") or []
        ],
        "nodes": nodes,
    }


def find_board_node(board: dict[str, Any], token: str) -> dict[str, Any] | None:
    needle = str(token or "").strip()
    if not needle:
        return None
    nodes = list(board.get("nodes") or [])
    for node in nodes:
        if node.get("id") == needle or node.get("assetId") == needle:
            return node
    lowered = needle.lower()
    titled = [node for node in nodes if str(node.get("title") or "").strip().lower() == lowered]
    if len(titled) == 1:
        return titled[0]
    return None


def next_origin(board: dict[str, Any]) -> tuple[float, float]:
    nodes = list(board.get("nodes") or [])
    if not nodes:
        return (80.0, 80.0)
    right = max(float(node.get("x") or 0) + float(node.get("width") or 0) for node in nodes)
    top = min(float(node.get("y") or 0) for node in nodes)
    return (right + 48.0, top)


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:10]}"


def seed_asset_node(
    board: dict[str, Any],
    asset_id: str,
    *,
    origin: tuple[float, float] | None = None,
    title: str = "",
) -> tuple[dict[str, Any], dict[str, Any]]:
    existing = next(
        (node for node in board.get("nodes") or [] if node.get("assetId") == asset_id), None
    )
    if existing:
        return board, existing
    x, y = origin or next_origin(board)
    node = {
        "id": _new_id("node"),
        "kind": "image",
        "x": x,
        "y": y,
        "width": 280.0,
        "height": 280.0,
        "z": len(board.get("nodes") or []),
        "assetId": asset_id,
    }
    if title:
        node["title"] = title[:4000]
    board.setdefault("nodes", []).append(node)
    return board, node


def connect_nodes(
    board: dict[str, Any],
    from_id: str,
    to_id: str,
    role: str = "reference",
) -> dict[str, Any]:
    if from_id == to_id:
        return board
    edges = board.setdefault("edges", [])
    if any(edge.get("from") == from_id and edge.get("to") == to_id for edge in edges):
        return board
    edges.append(
        {
            "id": _new_id("edge"),
            "from": from_id,
            "to": to_id,
            "role": role if role in {"reference", "mask"} else "reference",
        }
    )
    return board


def reserve_node_for_job(
    board: dict[str, Any],
    node_id: str,
    *,
    job_id: str,
    prompt: str = "",
) -> dict[str, Any]:
    for node in board.get("nodes") or []:
        if node.get("id") != node_id:
            continue
        if node.get("kind") == "text":
            raise ValueError("A text note cannot be used as an image job target.")
        node["jobId"] = job_id
        node["status"] = "running"
        if prompt:
            node["prompt"] = prompt[:4000]
        if node.get("kind") != "image" or not node.get("assetId"):
            node["kind"] = "generate"
        return board
    raise ValueError(f"Board node {node_id} was not found.")


def iterate_from_image(
    board: dict[str, Any],
    token: str,
    *,
    prompt: str = "",
    asset_id: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    source = find_board_node(board, token)
    if source is None and asset_id:
        board, source = seed_asset_node(board, asset_id)
    if source is None:
        raise ValueError("iterate_from needs a board node id or an image already on the board.")
    if source.get("kind") == "text":
        raise ValueError("Cannot iterate from a text note. Choose an image or generate card.")
    source_asset = source.get("assetId") or asset_id
    if not source_asset:
        raise ValueError("That node has no image yet. Generate or attach one first.")
    if not source.get("assetId"):
        source["assetId"] = source_asset
        source["kind"] = "image"
    existing_child = next(
        (
            node
            for node in board.get("nodes") or []
            if node.get("parentNodeId") == source["id"]
            and node.get("kind") == "generate"
            and not node.get("assetId")
        ),
        None,
    )
    if existing_child:
        if prompt:
            existing_child["prompt"] = prompt[:4000]
        return board, source, existing_child
    child = {
        "id": _new_id("node"),
        "kind": "generate",
        "x": float(source.get("x") or 0) + float(source.get("width") or 280) + 48.0,
        "y": float(source.get("y") or 0),
        "width": 320.0,
        "height": 292.0,
        "z": len(board.get("nodes") or []),
        "parentNodeId": source["id"],
        "prompt": (prompt or source.get("prompt") or "")[:4000],
        "title": source.get("title") or "",
    }
    if not child["title"]:
        child.pop("title", None)
    board.setdefault("nodes", []).append(child)
    connect_nodes(board, source["id"], child["id"], "reference")
    return board, source, child


def apply_board_template(
    board: dict[str, Any],
    template_id: str,
    *,
    reference_asset_id: str | None = None,
    prompt: str = "",
) -> dict[str, Any]:
    spec = BOARD_TEMPLATES[template_id]
    existing = next(
        (group for group in board.get("groups") or [] if group.get("title") == spec["title"]),
        None,
    )
    if existing:
        members = [
            node for node in board.get("nodes") or [] if node.get("groupId") == existing["id"]
        ]
        if reference_asset_id:
            _bind_reference(members, reference_asset_id)
        if prompt:
            _apply_prompt_to_generate_nodes(members, prompt)
        return {
            "board": board,
            "group_id": existing["id"],
            "reused": True,
            "node_ids": [node["id"] for node in members],
            "generate_ids": [node["id"] for node in members if node.get("kind") == "generate"],
            "reference_ids": [node["id"] for node in members if node.get("kind") == "image"],
        }

    origin_x, origin_y = next_origin(board)
    group_id = _new_id("group")
    id_map: dict[str, str] = {}
    created: list[dict[str, Any]] = []
    for item in spec["nodes"]:
        node_id = _new_id("node")
        id_map[str(item["id"])] = node_id
        node = {
            "id": node_id,
            "kind": item["kind"],
            "x": origin_x + float(item["x"]),
            "y": origin_y + float(item["y"]),
            "width": float(item.get("width") or 280),
            "height": float(item.get("height") or 180),
            "z": len(board.get("nodes") or []) + len(created),
            "groupId": group_id,
            "title": str(item.get("title") or "")[:4000],
        }
        if item.get("prompt"):
            node["prompt"] = str(item["prompt"])[:4000]
        if item.get("text"):
            node["text"] = str(item["text"])[:4000]
        created.append(node)
    if prompt:
        _apply_prompt_to_generate_nodes(created, prompt)
    if reference_asset_id:
        _bind_reference(created, reference_asset_id)
    board.setdefault("nodes", []).extend(created)
    board.setdefault("groups", []).append({"id": group_id, "title": spec["title"]})
    for start, end in spec["edges"]:
        if start in id_map and end in id_map:
            connect_nodes(board, id_map[start], id_map[end], "reference")
    return {
        "board": board,
        "group_id": group_id,
        "reused": False,
        "node_ids": [node["id"] for node in created],
        "generate_ids": [node["id"] for node in created if node.get("kind") == "generate"],
        "reference_ids": [node["id"] for node in created if node.get("kind") == "image"],
    }


def _bind_reference(nodes: list[dict[str, Any]], asset_id: str) -> None:
    targets = [node for node in nodes if node.get("kind") == "image" and not node.get("assetId")]
    if not targets:
        targets = [node for node in nodes if node.get("kind") == "image"]
    if targets:
        targets[0]["assetId"] = asset_id
        targets[0]["kind"] = "image"


def _apply_prompt_to_generate_nodes(nodes: list[dict[str, Any]], prompt: str) -> None:
    text = prompt.strip()
    if not text:
        return
    for node in nodes:
        if node.get("kind") != "generate":
            continue
        title = str(node.get("title") or "").strip()
        if title and title.lower() not in text.lower():
            node["prompt"] = f"{text} {title}."[:4000]
        else:
            node["prompt"] = text[:4000]


def prepare_board_for_job(
    store: ImageStudioStore,
    project_id: str,
    *,
    board_node_id: str = "",
    iterate_from: str = "",
    template: str = "",
    prompt: str = "",
    input_asset_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Apply template / iterate / targeting, then persist. No provider calls."""
    board = store.get_board(project_id)
    inputs = [item for item in (input_asset_ids or []) if item]
    reference = inputs[0] if inputs else None
    notes: list[str] = []
    generate_ids: list[str] = []
    target_id = str(board_node_id or "").strip()
    source_asset = ""

    template_id = normalize_template_id(template) if template else None
    if template_id:
        applied = apply_board_template(
            board, template_id, reference_asset_id=reference, prompt=prompt
        )
        board = applied["board"]
        generate_ids = list(applied["generate_ids"])
        notes.append(
            f"Applied {BOARD_TEMPLATES[template_id]['title']} template"
            + (" (reused existing group)." if applied["reused"] else ".")
        )
        if not target_id and generate_ids and prompt:
            target_id = generate_ids[0]

    if iterate_from:
        asset_hint = iterate_from if store.get_asset(iterate_from) else reference
        token = iterate_from
        if find_board_node(board, token) is None and asset_hint:
            board, seeded = seed_asset_node(board, asset_hint)
            token = seeded["id"]
        board, source, child = iterate_from_image(
            board,
            token,
            prompt=prompt,
            asset_id=asset_hint,
        )
        source_asset = str(source.get("assetId") or "")
        target_id = child["id"]
        generate_ids = [child["id"]]
        prompt = prompt or str(child.get("prompt") or source.get("prompt") or "")
        notes.append(f"Created iterate card {child['id']} from {source['id']}.")

    if target_id and not iterate_from:
        node = find_board_node(board, target_id)
        if node is None:
            raise ValueError(f"Board node {target_id} was not found.")
        target_id = str(node["id"])
        if node.get("assetId") and node["assetId"] not in inputs:
            inputs.append(str(node["assetId"]))
        if node.get("prompt") and not prompt and not template_id:
            prompt = str(node["prompt"])

    if reference and reference not in inputs:
        inputs.insert(0, reference)
    if source_asset and source_asset not in inputs:
        inputs.insert(0, source_asset)

    saved = store.save_board(project_id, board)
    return {
        "board": saved,
        "summary": summarize_board(saved),
        "target_node_id": target_id,
        "generate_ids": generate_ids,
        "input_asset_ids": inputs[:4],
        "prompt": prompt,
        "notes": notes,
        "template_id": template_id,
    }


def mark_node_running(
    store: ImageStudioStore,
    project_id: str,
    node_id: str,
    *,
    job_id: str,
    prompt: str = "",
) -> dict[str, Any]:
    def reserve(board: dict[str, Any]) -> None:
        reserve_node_for_job(board, node_id, job_id=job_id, prompt=prompt)

    return store.update_board(project_id, reserve)
