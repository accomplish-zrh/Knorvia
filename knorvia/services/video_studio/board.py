"""Video Studio board document helpers.

The board is the canvas view of a video project: a node graph persisted as
``projects/{id}/board.json`` next to the storyboard row. This module stays
pure (dict in / dict out, no store access) so the store, the router and the
agent tool all share one normalizer. Client-side ``web/lib/video-studio/
board-logic.ts`` mirrors these rules; keep both in sync.
"""

from __future__ import annotations

import json
import math
from typing import Any, Callable
from uuid import uuid4

BOARD_DOCUMENT_VERSION = 1
BOARD_NODE_KINDS = frozenset({"text", "image", "video", "audio", "generate"})
BOARD_EDGE_ROLES = frozenset({"reference", "first-frame", "last-frame", "audio", "continue-from"})
BOARD_MAX_NODES = 200
BOARD_MAX_EDGES = 400
BOARD_MAX_GROUPS = 80
BOARD_MAX_BYTES = 2 * 1024 * 1024
BOARD_MIN_SCALE = 0.15
BOARD_MAX_SCALE = 3.0
BOARD_MAX_COORDINATE = 1_000_000

NODE_DEFAULT_SIZE: dict[str, tuple[int, int]] = {
    "text": (240, 140),
    "image": (280, 280),
    "video": (320, 240),
    "audio": (240, 96),
    "generate": (320, 292),
}

# String node fields kept by the normalizer, with their trim cap.
_NODE_STRING_FIELDS = (
    "title",
    "text",
    "prompt",
    "assetId",
    "outputAssetId",
    "jobId",
    "status",
    "groupId",
    "modelKey",
    "operation",
    "ratio",
    "resolution",
    "referenceMode",
    # C4 camera control: the selected camera motion ("push", "pan-left", ...)
    # shown as the generate card's camera badge and submitted as a parameter.
    "camera",
    "templateId",
    # Storyboard strip id this generate card was imported from.
    "storyboardShotId",
)


def empty_board() -> dict[str, Any]:
    return {
        "version": BOARD_DOCUMENT_VERSION,
        "revision": 0,
        "viewport": {"x": 0.0, "y": 0.0, "scale": 1.0},
        "nodes": [],
        "edges": [],
        "groups": [],
        "updated_at": None,
    }


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _optional_string(raw: Any, limit: int) -> str | None:
    if raw is None:
        return None
    text = str(raw).strip()
    return text[:limit] if text else None


def normalize_board(raw: Any) -> dict[str, Any]:
    """Sanitize an untrusted board document into canonical shape.

    Mirrors the Image Studio normalizer philosophy: invalid items are dropped
    instead of rejected so one bad node can never lock a project's canvas.
    """
    document = raw if isinstance(raw, dict) else {}
    revision_raw = document.get("revision")
    revision = revision_raw if isinstance(revision_raw, int) and revision_raw >= 0 else 0

    viewport_raw = document.get("viewport") if isinstance(document.get("viewport"), dict) else {}
    x = _finite(viewport_raw.get("x")) or 0.0
    y = _finite(viewport_raw.get("y")) or 0.0
    scale = _finite(viewport_raw.get("scale")) or 1.0
    viewport = {
        "x": _clamp(x, -BOARD_MAX_COORDINATE, BOARD_MAX_COORDINATE),
        "y": _clamp(y, -BOARD_MAX_COORDINATE, BOARD_MAX_COORDINATE),
        "scale": _clamp(scale, BOARD_MIN_SCALE, BOARD_MAX_SCALE),
    }

    nodes: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    raw_nodes = document.get("nodes") if isinstance(document.get("nodes"), list) else []
    for raw_node in raw_nodes[:BOARD_MAX_NODES]:
        if not isinstance(raw_node, dict):
            continue
        node_id = str(raw_node.get("id") or "").strip()
        kind = str(raw_node.get("kind") or "").strip()
        if not node_id or len(node_id) > 128 or node_id in seen_ids:
            continue
        if kind not in BOARD_NODE_KINDS:
            continue
        x = _finite(raw_node.get("x"))
        y = _finite(raw_node.get("y"))
        width = _finite(raw_node.get("width"))
        height = _finite(raw_node.get("height"))
        if x is None or y is None:
            continue
        default_width, default_height = NODE_DEFAULT_SIZE[kind]
        node: dict[str, Any] = {
            "id": node_id,
            "kind": kind,
            "x": round(_clamp(x, -BOARD_MAX_COORDINATE, BOARD_MAX_COORDINATE), 2),
            "y": round(_clamp(y, -BOARD_MAX_COORDINATE, BOARD_MAX_COORDINATE), 2),
            "width": round(_clamp(width if width else default_width, 80, 100_000), 2),
            "height": round(_clamp(height if height else default_height, 80, 100_000), 2),
            "z": int(raw_node.get("z") or len(nodes)),
        }
        for field in _NODE_STRING_FIELDS:
            if field == "assetId" and kind not in {"image", "video", "audio"}:
                continue
            if field == "outputAssetId" and kind != "generate":
                continue
            value = _optional_string(raw_node.get(field), 4000)
            if value is not None:
                node[field] = value
        if kind in {"video", "generate"}:
            duration = _finite(raw_node.get("duration"))
            if duration and duration > 0:
                node["duration"] = round(min(duration, 3600), 3)
        if kind == "generate":
            seconds = _finite(raw_node.get("seconds"))
            if seconds and seconds > 0:
                node["seconds"] = round(min(seconds, 3600), 3)
        nodes.append(node)
        seen_ids.add(node_id)

    node_ids = seen_ids
    edges: list[dict[str, Any]] = []
    seen_edges: set[tuple[str, str]] = set()
    raw_edges = document.get("edges") if isinstance(document.get("edges"), list) else []
    for raw_edge in raw_edges[:BOARD_MAX_EDGES]:
        if not isinstance(raw_edge, dict):
            continue
        source = str(raw_edge.get("from") or "").strip()
        target = str(raw_edge.get("to") or "").strip()
        role = str(raw_edge.get("role") or "reference").strip()
        if not source or not target or source == target:
            continue
        if source not in node_ids or target not in node_ids:
            continue
        if (source, target) in seen_edges:
            continue
        seen_edges.add((source, target))
        edges.append(
            {
                "id": str(raw_edge.get("id") or f"edge_{uuid4().hex[:10]}")[:128],
                "from": source,
                "to": target,
                "role": role if role in BOARD_EDGE_ROLES else "reference",
            }
        )

    referenced_groups = {node.get("groupId") for node in nodes if node.get("groupId")}
    groups: list[dict[str, Any]] = []
    raw_groups = document.get("groups") if isinstance(document.get("groups"), list) else []
    seen_groups: set[str] = set()
    for raw_group in raw_groups:
        if len(groups) >= BOARD_MAX_GROUPS:
            break
        if not isinstance(raw_group, dict):
            continue
        group_id = str(raw_group.get("id") or "").strip()
        # Match Image Studio: an unreferenced group never survives a save.
        if not group_id or len(group_id) > 128 or group_id in seen_groups:
            continue
        if group_id not in referenced_groups:
            continue
        seen_groups.add(group_id)
        groups.append(
            {"id": group_id, "title": _optional_string(raw_group.get("title"), 160) or "Group"}
        )
    for node in nodes:
        if node.get("groupId") and node["groupId"] not in seen_groups:
            node.pop("groupId")

    return {
        "version": BOARD_DOCUMENT_VERSION,
        "revision": revision,
        "viewport": viewport,
        "nodes": nodes,
        "edges": edges,
        "groups": groups,
        "updated_at": document.get("updated_at"),
    }


def board_too_large(document: dict[str, Any]) -> bool:
    encoded = json.dumps(normalize_board(document), ensure_ascii=False)
    return len(encoded.encode("utf-8")) > BOARD_MAX_BYTES


def summarize_board(board: dict[str, Any]) -> dict[str, Any]:
    """Compact board summary for tool results and logs."""
    document = normalize_board(board)
    return {
        "revision": document["revision"],
        "node_count": len(document["nodes"]),
        "edge_count": len(document["edges"]),
        "nodes": [
            {
                "id": node["id"],
                "kind": node["kind"],
                "title": node.get("title") or "",
                "status": node.get("status") or "",
                "jobId": node.get("jobId") or "",
                "assetId": node.get("assetId") or "",
                "storyboardShotId": node.get("storyboardShotId") or "",
            }
            for node in document["nodes"]
        ][:40],
    }


def find_board_node(board: dict[str, Any], node_id: str) -> dict[str, Any] | None:
    wanted = str(node_id or "").strip()
    if not wanted:
        return None
    for node in board.get("nodes") or []:
        if str(node.get("id") or "") == wanted:
            return node
    return None


def next_origin(board: dict[str, Any]) -> tuple[float, float]:
    """Placement origin for the next node: one column past the right edge."""
    nodes = board.get("nodes") or []
    if not nodes:
        return (0.0, 0.0)
    right = max(float(node.get("x", 0)) + float(node.get("width", 0)) for node in nodes)
    return (round(right + 64.0, 2), 0.0)


# ── Templates (spec §5.5) ────────────────────────────────────────────
# Layout constants mirrored by instantiateBoardTemplate in
# web/lib/video-studio/board-logic.ts — keep both tables in sync. Every
# offset derives from NODE_DEFAULT_SIZE + TEMPLATE_GAP so the two
# implementations cannot drift apart, except the generate column pitch
# (§5.5: "generate sits 400px right of the image").

BOARD_TEMPLATE_IDS = (
    "shot-i2v",
    "first-last",
    "storyboard-6",
    "character-episode",
    "extend-chain",
    "character-card",
    # §Phase F3: seven scaffolds for the mainstream workbench plays —
    # vertical episodic cuts, product showcases, talking heads, narration
    # videos, A/B takes, step-by-step tutorials and a 3×3 composition grid.
    "vertical-series",
    "product-triptych",
    "talking-head",
    "text-to-video",
    "compare-ab",
    "tutorial-steps",
    "grid-nine",
)
TEMPLATE_GAP = 64.0
TEMPLATE_GENERATE_COLUMN_X = 400.0


def _template_node(kind: str, x: float, y: float, z: int, **fields: Any) -> dict[str, Any]:
    width, height = NODE_DEFAULT_SIZE[kind]
    node: dict[str, Any] = {
        "id": f"{kind}_{uuid4().hex[:12]}",
        "kind": kind,
        "x": round(float(x), 2),
        "y": round(float(y), 2),
        "width": width,
        "height": height,
        "z": z,
    }
    node.update(fields)
    return node


def _template_edge(source: str, target: str, role: str) -> dict[str, Any]:
    return {"id": f"edge_{uuid4().hex[:10]}", "from": source, "to": target, "role": role}


def instantiate_template(
    template_id: str, origin: tuple[float, float] | None = None
) -> dict[str, Any]:
    """Nodes+edges fragment for a template. Raises ValueError on unknown id.

    Templates only place nodes — they never create jobs, so no fragment node
    carries ``jobId`` or ``status``. Generate nodes default to the
    ``image_to_video`` operation (``extend`` for the extend chain) and leave
    ``modelKey`` empty for the user to pick.
    """
    if template_id not in BOARD_TEMPLATE_IDS:
        raise ValueError(f"Unknown board template: {template_id}")
    ox, oy = origin if origin is not None else (0.0, 0.0)
    gap = TEMPLATE_GAP
    generate_width, generate_height = NODE_DEFAULT_SIZE["generate"]

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []

    def add(kind: str, x: float, y: float, **fields: Any) -> str:
        nodes.append(
            _template_node(kind, ox + x, oy + y, len(nodes), templateId=template_id, **fields)
        )
        return nodes[-1]["id"]

    def add_generate(x: float, y: float, operation: str = "image_to_video", **fields: Any) -> str:
        return add("generate", x, y, operation=operation, **fields)

    if template_id == "shot-i2v":
        image = add("image", 0.0, 0.0)
        generate = add_generate(TEMPLATE_GENERATE_COLUMN_X, 0.0)
        edges.append(_template_edge(image, generate, "first-frame"))
    elif template_id == "first-last":
        first = add("image", 0.0, 0.0)
        last = add("image", 0.0, NODE_DEFAULT_SIZE["image"][1] + gap)
        generate = add_generate(TEMPLATE_GENERATE_COLUMN_X, 0.0)
        edges.append(_template_edge(first, generate, "first-frame"))
        edges.append(_template_edge(last, generate, "last-frame"))
    elif template_id == "storyboard-6":
        note = add("text", 0.0, 0.0)
        start_x = NODE_DEFAULT_SIZE["text"][0] + gap
        step_x = generate_width + gap
        for index in range(6):
            generate = add_generate(start_x + index * step_x, 0.0)
            edges.append(_template_edge(note, generate, "reference"))
    elif template_id == "character-episode":
        note = add("text", 0.0, 0.0)
        image = add("image", 0.0, NODE_DEFAULT_SIZE["text"][1] + gap)
        step_x = generate_width + gap
        step_y = generate_height + gap
        for row in range(2):
            for column in range(2):
                generate = add_generate(TEMPLATE_GENERATE_COLUMN_X + column * step_x, row * step_y)
                edges.append(_template_edge(note, generate, "reference"))
                edges.append(_template_edge(image, generate, "first-frame"))
    elif template_id == "character-card":
        # Phase B1: name note + reference image + three-view sheet, feeding a
        # column of four generate cards that all share the three-view reference.
        note = add("text", 0.0, 0.0)
        reference = add("image", 0.0, NODE_DEFAULT_SIZE["text"][1] + gap)
        three_view = add(
            "image",
            0.0,
            NODE_DEFAULT_SIZE["text"][1] + gap + NODE_DEFAULT_SIZE["image"][1] + gap,
        )
        step_y = generate_height + gap
        for index in range(4):
            generate = add_generate(TEMPLATE_GENERATE_COLUMN_X, index * step_y)
            edges.append(_template_edge(three_view, generate, "reference"))
    elif template_id == "vertical-series":
        # §F3 竖屏连续剧: one story note driving a 9:16 six-shot cut.
        note = add("text", 0.0, 0.0)
        start_x = NODE_DEFAULT_SIZE["text"][0] + gap
        step_x = generate_width + gap
        for index in range(6):
            generate = add_generate(start_x + index * step_x, 0.0, ratio="9:16")
            edges.append(_template_edge(note, generate, "reference"))
    elif template_id == "product-triptych":
        # §F3 产品三面: one product photo → front / detail / in-use shots.
        image = add("image", 0.0, 0.0)
        step_y = generate_height + gap
        for index in range(3):
            generate = add_generate(TEMPLATE_GENERATE_COLUMN_X, index * step_y)
            edges.append(_template_edge(image, generate, "first-frame"))
    elif template_id == "talking-head":
        # §F3 口播讲解: presenter keyframe + script note (the note doubles as
        # the caption/voiceover source at compose time).
        image = add("image", 0.0, 0.0)
        note = add("text", 0.0, NODE_DEFAULT_SIZE["image"][1] + gap)
        generate = add_generate(TEMPLATE_GENERATE_COLUMN_X, 0.0)
        edges.append(_template_edge(image, generate, "first-frame"))
        edges.append(_template_edge(note, generate, "reference"))
    elif template_id == "text-to-video":
        # §F3 图文成片: one narration note driving four voiceover-first shots.
        note = add("text", 0.0, 0.0)
        start_x = NODE_DEFAULT_SIZE["text"][0] + gap
        step_x = generate_width + gap
        for index in range(4):
            generate = add_generate(start_x + index * step_x, 0.0)
            edges.append(_template_edge(note, generate, "reference"))
    elif template_id == "compare-ab":
        # §F3 对比 A/B: same reference, two takes — keep the better cut.
        image = add("image", 0.0, 0.0)
        step_y = generate_height + gap
        first = add_generate(TEMPLATE_GENERATE_COLUMN_X, 0.0)
        second = add_generate(TEMPLATE_GENERATE_COLUMN_X, step_y)
        edges.append(_template_edge(image, first, "first-frame"))
        edges.append(_template_edge(image, second, "first-frame"))
    elif template_id == "tutorial-steps":
        # §F3 教程步骤链: extend the previous step's clip shot by shot.
        note = add("text", 0.0, 0.0)
        clip = add("video", 0.0, NODE_DEFAULT_SIZE["text"][1] + gap)
        first = add_generate(TEMPLATE_GENERATE_COLUMN_X, 0.0, operation="extend")
        second = add_generate(TEMPLATE_GENERATE_COLUMN_X, generate_height + gap, operation="extend")
        edges.append(_template_edge(clip, first, "continue-from"))
        edges.append(_template_edge(note, second, "reference"))
    elif template_id == "grid-nine":
        # §F3 九宫格构图: 3×3 composition-planning grid (LibTV-style).
        note = add("text", 0.0, 0.0)
        start_x = NODE_DEFAULT_SIZE["text"][0] + gap
        step_x = generate_width + gap
        step_y = generate_height + gap
        for row in range(3):
            for column in range(3):
                generate = add_generate(start_x + column * step_x, row * step_y)
                edges.append(_template_edge(note, generate, "reference"))
    else:  # extend-chain
        clip = add("video", 0.0, 0.0)
        generate = add_generate(TEMPLATE_GENERATE_COLUMN_X, 0.0, operation="extend")
        edges.append(_template_edge(clip, generate, "continue-from"))

    return {"nodes": nodes, "edges": edges}


def place_template(board: dict[str, Any], template_id: str) -> int:
    """Append a template fragment at the board's next free origin, in place.

    Returns the node count placed. Raises ``ValueError`` on an unknown
    template or when the board node/edge caps would be exceeded; never
    touches job state.
    """
    fragment = instantiate_template(template_id, next_origin(board))
    if len(board.get("nodes") or []) + len(fragment["nodes"]) > BOARD_MAX_NODES:
        raise ValueError("Board has too many nodes for this template")
    if len(board.get("edges") or []) + len(fragment["edges"]) > BOARD_MAX_EDGES:
        raise ValueError("Board has too many edges for this template")
    nodes = board.setdefault("nodes", [])
    for node in fragment["nodes"]:
        node["z"] = len(nodes)
        nodes.append(node)
    board.setdefault("edges", []).extend(fragment["edges"])
    return len(fragment["nodes"])


# ── Agent board preparation (spec §10.2) ────────────────────────────


def template_generate_nodes(
    board: dict[str, Any], template_id: str, *, unbound_only: bool = False
) -> list[dict[str, Any]]:
    """Generate cards stamped by ``template_id`` (optionally still job-free)."""
    rows: list[dict[str, Any]] = []
    for node in board.get("nodes") or []:
        if node.get("kind") != "generate" or node.get("templateId") != template_id:
            continue
        if unbound_only and node.get("jobId"):
            continue
        rows.append(node)
    return rows


def _connect(board: dict[str, Any], from_id: str, to_id: str, role: str) -> None:
    edges = board.setdefault("edges", [])
    if from_id == to_id:
        return
    if any(edge.get("from") == from_id and edge.get("to") == to_id for edge in edges):
        return
    edges.append(
        {
            "id": f"edge_{uuid4().hex[:10]}",
            "from": from_id,
            "to": to_id,
            "role": role if role in BOARD_EDGE_ROLES else "reference",
        }
    )


def _seed_asset_node(board: dict[str, Any], asset: dict[str, Any]) -> dict[str, Any]:
    """Put an existing project asset onto the board (idempotent by asset id)."""
    asset_id = str(asset.get("id") or "")
    existing = next(
        (node for node in board.get("nodes") or [] if node.get("assetId") == asset_id),
        None,
    )
    if existing is not None:
        return existing
    kind = str(asset.get("kind") or "")
    if kind not in {"image", "video", "audio"}:
        raise ValueError("Unsupported media kind for the video canvas.")
    width, height = NODE_DEFAULT_SIZE[kind]
    x, y = next_origin(board)
    node: dict[str, Any] = {
        "id": f"{kind}_{uuid4().hex[:12]}",
        "kind": kind,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "z": len(board.get("nodes") or []),
        "assetId": asset_id,
    }
    title = str(asset.get("filename") or "").strip()
    if title:
        node["title"] = title[:160]
    board.setdefault("nodes", []).append(node)
    return node


def collect_node_inputs(
    board: dict[str, Any], node_id: str, *, store: Any, project_id: str
) -> list[dict[str, str]]:
    """Ordered ``[{asset_id, role}]`` from a generate node's incoming edges.

    Only edges whose source still resolves to a live project asset contribute,
    so a deleted reference never poisons the plan (validation stays with the
    service layer).
    """
    candidates: list[tuple[str, str]] = []
    for edge in board.get("edges") or []:
        if str(edge.get("to") or "") != str(node_id):
            continue
        source = find_board_node(board, str(edge.get("from") or ""))
        if source is None:
            continue
        asset_id = str(source.get("assetId") or "") or str(source.get("outputAssetId") or "")
        if not asset_id:
            continue
        role = str(edge.get("role") or "reference")
        candidates.append((asset_id, role))
    # One bulk load instead of one connection per incoming edge.
    assets = store.get_assets_by_ids([asset_id for asset_id, _ in candidates])
    specs: list[dict[str, str]] = []
    for asset_id, role in candidates:
        asset = assets.get(asset_id)
        if asset is None or str(asset.get("project_id") or "") != project_id:
            continue
        specs.append(
            {"asset_id": asset_id, "role": role if role in BOARD_EDGE_ROLES else "reference"}
        )
    return specs


def _iterate_from_token(
    board: dict[str, Any],
    store: Any,
    project_id: str,
    token: str,
    *,
    prompt: str = "",
) -> tuple[dict[str, Any], dict[str, Any], dict[str, str], str]:
    """Branch a fresh generate card from a video/image asset or canvas node.

    Returns ``(source, child, input_spec, operation_hint)``. Video sources link
    ``continue-from`` (extend); image sources link ``first-frame``
    (image_to_video); audio sources link ``audio``. An unbound child already
    wired from the same source with the same role is reused so a confirmation
    round-trip never stacks duplicate cards.
    """
    wanted = str(token or "").strip()
    if not wanted:
        raise ValueError("iterate_from needs a board node id or a Video Studio asset id.")
    source = find_board_node(board, wanted)
    asset: dict[str, Any] | None = None
    if source is None:
        asset = store.get_asset(wanted)
        if asset is not None and str(asset.get("project_id") or "") != project_id:
            asset = None
        if asset is None:
            raise ValueError("iterate_from needs a board node id or a Video Studio asset id.")
        source = _seed_asset_node(board, asset)
    elif source.get("kind") == "text":
        raise ValueError(
            "Cannot iterate from a text note. Choose a video, image, or generate card."
        )
    asset_id = str(source.get("assetId") or "") or str(source.get("outputAssetId") or "")
    if not asset_id and asset is not None:
        asset_id = str(asset.get("id") or "")
        source["assetId"] = asset_id
    # The unbound-node branch already fetched this exact asset — reuse it
    # instead of paying a second round-trip for the same row.
    if asset is not None and asset_id and str(asset.get("id") or "") == asset_id:
        record = asset
    else:
        record = store.get_asset(asset_id) if asset_id else None
    if record is None or str(record.get("project_id") or "") != project_id:
        raise ValueError("That card has no finished media to iterate from yet.")
    kind = str(record.get("kind") or "")
    if kind == "video":
        role, hint = "continue-from", "extend"
    elif kind == "image":
        role, hint = "first-frame", "image_to_video"
    elif kind == "audio":
        role, hint = "audio", ""
    else:
        raise ValueError("Unsupported media kind for iterate_from.")
    child: dict[str, Any] | None = None
    for edge in board.get("edges") or []:
        if edge.get("from") != source.get("id") or edge.get("role") != role:
            continue
        candidate = find_board_node(board, str(edge.get("to") or ""))
        if candidate and candidate.get("kind") == "generate" and not candidate.get("jobId"):
            child = candidate
            break
    if child is None:
        width, height = NODE_DEFAULT_SIZE["generate"]
        child = {
            "id": f"generate_{uuid4().hex[:12]}",
            "kind": "generate",
            "x": round(
                float(source.get("x") or 0) + float(source.get("width") or 0) + TEMPLATE_GAP, 2
            ),
            "y": round(float(source.get("y") or 0), 2),
            "width": width,
            "height": height,
            "z": len(board.get("nodes") or []),
        }
        if hint:
            child["operation"] = hint
        board.setdefault("nodes", []).append(child)
        _connect(board, str(source.get("id")), str(child["id"]), role)
    if prompt:
        child["prompt"] = str(prompt)[:4000]
    return source, child, {"asset_id": asset_id, "role": role}, hint


def _prepare_board_document(
    board: dict[str, Any],
    store: Any,
    project_id: str,
    *,
    board_node_id: str = "",
    iterate_from: str = "",
    template: str = "",
    prompt: str = "",
    input_specs: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Mutate ``board`` in place for one videogen call. Pure board logic.

    Raises ``ValueError`` (before any write) for unknown templates, missing
    nodes, or sources without media. Never creates jobs.
    """
    notes: list[str] = []
    generate_ids: list[str] = []
    target_id = str(board_node_id or "").strip()
    specs = [dict(item) for item in (input_specs or []) if item.get("asset_id")]
    operation_hint = ""
    template_id = ""

    if template:
        template_id = str(template).strip()
        if template_id not in BOARD_TEMPLATE_IDS:
            raise ValueError(
                "Unknown board template. Use one of: " + ", ".join(BOARD_TEMPLATE_IDS) + "."
            )
        reusable = template_generate_nodes(board, template_id, unbound_only=True)
        if reusable:
            generate_ids = [str(node["id"]) for node in reusable]
            notes.append(f"Reused the {template_id} cards already on the canvas.")
        else:
            place_template(board, template_id)
            generate_ids = [str(node["id"]) for node in template_generate_nodes(board, template_id)]
            notes.append(f"Placed the {template_id} template (free; no jobs were created).")

    if iterate_from:
        source, child, spec, hint = _iterate_from_token(
            board, store, project_id, iterate_from, prompt=prompt
        )
        target_id = str(child["id"])
        generate_ids = [target_id]
        operation_hint = hint
        if not any(item["asset_id"] == spec["asset_id"] for item in specs):
            specs.insert(0, spec)
        notes.append(
            f"Created generate card {target_id} linked from {source.get('id')} ({spec['role']})."
        )

    if target_id and not iterate_from:
        node = find_board_node(board, target_id)
        if node is None:
            raise ValueError(f"Board node {target_id} was not found.")
        if node.get("kind") != "generate":
            raise ValueError("Only a canvas generate card can run a video job.")
        target_id = str(node["id"])
        for spec in collect_node_inputs(board, target_id, store=store, project_id=project_id):
            if not any(item["asset_id"] == spec["asset_id"] for item in specs):
                specs.append(spec)
        if node.get("prompt") and not prompt and not template_id:
            prompt = str(node["prompt"])
        operation_hint = operation_hint or str(node.get("operation") or "")

    if template_id and not target_id and generate_ids:
        target_id = generate_ids[0]

    return {
        "target_node_id": target_id,
        "generate_ids": generate_ids,
        "input_specs": specs,
        "prompt": prompt,
        "notes": notes,
        "template_id": template_id,
        "operation_hint": operation_hint,
    }


def prepare_board_for_video_job(
    store: Any,
    project_id: str,
    *,
    board_node_id: str = "",
    iterate_from: str = "",
    template: str = "",
    prompt: str = "",
    input_specs: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Apply template / iterate / target resolution, then persist. No jobs.

    The mutation lands through the store's CAS ``update_board`` so concurrent
    canvas edits are merged rather than clobbered. Returns the saved board,
    its summary, the resolved target node, placed generate ids, board-derived
    input specs, an operation hint, and human-readable notes.
    """
    info: dict[str, Any] = {}

    def mutator(document: dict[str, Any]) -> None:
        info.clear()
        info.update(
            _prepare_board_document(
                document,
                store,
                project_id,
                board_node_id=board_node_id,
                iterate_from=iterate_from,
                template=template,
                prompt=prompt,
                input_specs=input_specs,
            )
        )

    saved = store.update_board(project_id, mutator)
    info["board"] = saved
    info["summary"] = summarize_board(saved)
    return info


# ── Strip ↔ board interop (spec §7.3) ────────────────────────────────


def import_storyboard_shots(
    board: dict[str, Any], shots: list[dict[str, Any]] | None, *, force: bool = False
) -> tuple[int, int]:
    """Append storyboard shots as one horizontal row of generate nodes.

    Mutates ``board`` in place and returns ``(imported, skipped)``. Shots
    without a prompt are skipped; unless ``force`` is set, a shot is also
    skipped when the board already holds a generate node with the same
    title+prompt, which makes repeated imports idempotent. A shot whose id is
    already linked to a canvas node (``storyboardShotId``) refreshes that
    card in place instead — title/prompt/output edits made in the storyboard
    propagate on re-import rather than stacking duplicate nodes.
    """
    existing_keys: set[tuple[str, str]] = set()
    linked_by_shot: dict[str, dict[str, Any]] = {}
    for node in board.get("nodes") or []:
        if node.get("kind") != "generate":
            continue
        existing_keys.add((str(node.get("title") or ""), str(node.get("prompt") or "")))
        shot_link = str(node.get("storyboardShotId") or "")
        if shot_link:
            linked_by_shot.setdefault(shot_link, node)
    origin_x, origin_y = next_origin(board)
    step_x = NODE_DEFAULT_SIZE["generate"][0] + TEMPLATE_GAP
    imported = 0
    skipped = 0
    nodes = board.setdefault("nodes", [])
    edges = board.setdefault("edges", [])
    for position, shot in enumerate(shots or []):
        prompt = str(shot.get("prompt") or "").strip()[:4000]
        if not prompt:
            skipped += 1
            continue
        title = str(shot.get("title") or "").strip()[:160] or f"Shot {position + 1}"
        key = (title, prompt)
        shot_id = str(shot.get("id") or "").strip()
        linked = linked_by_shot.get(shot_id) if shot_id else None
        if not force:
            if key in existing_keys:
                skipped += 1
                continue
            if linked is not None:
                # Same shot, edited in the storyboard: sync the linked card's
                # editable fields in place instead of duplicating it.
                linked["title"] = title
                linked["prompt"] = prompt
                has_inputs = bool(shot.get("input_asset_ids"))
                linked["operation"] = (
                    "image_to_video"
                    if (has_inputs or shot.get("keyframe_asset_id"))
                    else "text_to_video"
                )
                output_asset = str(shot.get("output_asset_id") or "").strip()
                if output_asset:
                    linked["outputAssetId"] = output_asset[:160]
                else:
                    linked.pop("outputAssetId", None)
                camera = str(shot.get("camera") or "").strip()
                if camera:
                    linked["camera"] = camera[:64]
                else:
                    linked.pop("camera", None)
                skipped += 1
                continue
        if len(nodes) >= BOARD_MAX_NODES:
            skipped += 1
            continue
        # Keyframe (first-frame) above, voiceover below the generate card.
        keyframe_asset = str(shot.get("keyframe_asset_id") or "").strip()
        voiceover_asset = str(shot.get("voiceover_asset_id") or "").strip()
        has_inputs = bool(shot.get("input_asset_ids"))
        node: dict[str, Any] = {
            "id": f"generate_{uuid4().hex[:12]}",
            "kind": "generate",
            "x": round(origin_x + imported * step_x, 2),
            "y": round(origin_y, 2),
            "width": NODE_DEFAULT_SIZE["generate"][0],
            "height": NODE_DEFAULT_SIZE["generate"][1],
            "z": len(nodes),
            "title": title,
            "prompt": prompt,
            "operation": "image_to_video" if (has_inputs or keyframe_asset) else "text_to_video",
        }
        output_asset = str(shot.get("output_asset_id") or "").strip()
        if output_asset:
            node["outputAssetId"] = output_asset[:160]
        camera = str(shot.get("camera") or "").strip()
        if camera:
            node["camera"] = camera[:64]
        if shot_id:
            node["storyboardShotId"] = shot_id[:128]
        nodes.append(node)
        if keyframe_asset and len(nodes) < BOARD_MAX_NODES:
            image_node = {
                "id": f"image_{uuid4().hex[:12]}",
                "kind": "image",
                "x": node["x"],
                "y": round(node["y"] - NODE_DEFAULT_SIZE["image"][1] - TEMPLATE_GAP, 2),
                "width": NODE_DEFAULT_SIZE["image"][0],
                "height": NODE_DEFAULT_SIZE["image"][1],
                "z": len(nodes),
                "title": f"{title} · keyframe",
                "assetId": keyframe_asset[:160],
            }
            nodes.append(image_node)
            if len(edges) < BOARD_MAX_EDGES:
                edges.append(
                    {
                        "id": f"edge_{uuid4().hex[:10]}",
                        "from": image_node["id"],
                        "to": node["id"],
                        "role": "first-frame",
                    }
                )
        if voiceover_asset and len(nodes) < BOARD_MAX_NODES:
            audio_node = {
                "id": f"audio_{uuid4().hex[:12]}",
                "kind": "audio",
                "x": node["x"],
                "y": round(node["y"] + node["height"] + TEMPLATE_GAP, 2),
                "width": NODE_DEFAULT_SIZE["audio"][0],
                "height": NODE_DEFAULT_SIZE["audio"][1],
                "z": len(nodes),
                "title": f"{title} · voiceover",
                "assetId": voiceover_asset[:160],
            }
            nodes.append(audio_node)
            if len(edges) < BOARD_MAX_EDGES:
                edges.append(
                    {
                        "id": f"edge_{uuid4().hex[:10]}",
                        "from": audio_node["id"],
                        "to": node["id"],
                        "role": "audio",
                    }
                )
        existing_keys.add(key)
        imported += 1
    return imported, skipped


def export_board_to_shots(
    board: dict[str, Any], *, max_shots: int = 200
) -> tuple[list[dict[str, Any]], int]:
    """Build storyboard shots (fresh ids) from generate nodes that hold a prompt.

    Returns ``(shots, exported)``. Callers append the list to the current
    storyboard document under its own lock and re-base ``order``; the node's
    ``operation``, ``camera`` and output asset are preserved on the shot.
    """
    shots: list[dict[str, Any]] = []
    for node in board.get("nodes") or []:
        if node.get("kind") != "generate":
            continue
        prompt = str(node.get("prompt") or "").strip()
        if not prompt:
            continue
        if len(shots) >= max_shots:
            break
        shot: dict[str, Any] = {
            "id": f"shot_{uuid4().hex}",
            "order": len(shots),
            "title": str(node.get("title") or "")[:160],
            "prompt": prompt[:20_000],
            "input_asset_ids": [],
            "job_id": None,
            "output_asset_id": str(node.get("outputAssetId") or "") or None,
            "duration": None,
            "notes": "",
            "transition": "",
        }
        operation = str(node.get("operation") or "").strip()
        if operation:
            shot["operation"] = operation[:64]
        camera = str(node.get("camera") or "").strip()
        if camera:
            shot["camera"] = camera[:64]
        duration = _finite(node.get("duration"))
        if duration and duration > 0:
            shot["duration"] = round(min(duration, 3600), 3)
        shots.append(shot)
    return shots, len(shots)


def mark_node_running(
    board: dict[str, Any], node_id: str, *, job_id: str, prompt: str = ""
) -> None:
    node = find_board_node(board, node_id)
    if not node:
        raise ValueError("Board node not found")
    node["jobId"] = job_id
    node["status"] = "running"
    if prompt and not node.get("prompt"):
        node["prompt"] = str(prompt)[:4000]


def attach_job_output(
    board: dict[str, Any],
    *,
    job_id: str,
    status: str,
    asset_id: str | None = None,
    duration: float | None = None,
) -> bool:
    """Bind a finished job back onto its generate node. True when changed."""
    changed = False
    for node in board.get("nodes") or []:
        if node.get("jobId") != job_id or node.get("kind") != "generate":
            continue
        if node.get("status") != status:
            node["status"] = status
            changed = True
        if asset_id and node.get("outputAssetId") != asset_id:
            node["outputAssetId"] = asset_id
            changed = True
        if duration and not node.get("duration"):
            node["duration"] = round(min(float(duration), 3600), 3)
            changed = True
    return changed


def apply_board_mutation(
    store: Any, project_id: str, mutator: Callable[[dict[str, Any]], Any]
) -> dict[str, Any]:
    """Atomically patch the newest board via the store's CAS write."""
    return store.update_board(project_id, mutator)


__all__ = [
    "BOARD_DOCUMENT_VERSION",
    "BOARD_EDGE_ROLES",
    "BOARD_MAX_BYTES",
    "BOARD_MAX_EDGES",
    "BOARD_MAX_GROUPS",
    "BOARD_MAX_NODES",
    "BOARD_NODE_KINDS",
    "BOARD_TEMPLATE_IDS",
    "NODE_DEFAULT_SIZE",
    "TEMPLATE_GAP",
    "TEMPLATE_GENERATE_COLUMN_X",
    "attach_job_output",
    "board_too_large",
    "collect_node_inputs",
    "empty_board",
    "export_board_to_shots",
    "find_board_node",
    "import_storyboard_shots",
    "instantiate_template",
    "mark_node_running",
    "next_origin",
    "normalize_board",
    "place_template",
    "prepare_board_for_video_job",
    "summarize_board",
    "template_generate_nodes",
]
