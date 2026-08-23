"""Library-native canvas document (not Image/Video Studio boards)."""

from __future__ import annotations

import math
from typing import Any
from uuid import uuid4

CANVAS_VERSION = 1
MAX_NODES = 80
MAX_EDGES = 160
MAX_TEXT = 8_000

NODE_KINDS = frozenset({"text", "note", "image", "file"})


def empty_library_canvas() -> dict[str, Any]:
    return {
        "version": CANVAS_VERSION,
        "revision": 0,
        "viewport": {"x": 0.0, "y": 0.0, "scale": 1.0},
        "nodes": [],
        "edges": [],
    }


def normalize_library_canvas(raw: Any) -> dict[str, Any]:
    document = raw if isinstance(raw, dict) else {}
    revision = document.get("revision")
    revision = revision if isinstance(revision, int) and revision >= 0 else 0
    viewport_raw = document.get("viewport") if isinstance(document.get("viewport"), dict) else {}
    try:
        scale = float(viewport_raw.get("scale") or 1)
    except (TypeError, ValueError):
        scale = 1.0
    if not math.isfinite(scale):
        scale = 1.0
    scale = min(2.5, max(0.25, scale))
    try:
        vx = float(viewport_raw.get("x") or 0)
        vy = float(viewport_raw.get("y") or 0)
    except (TypeError, ValueError):
        vx = vy = 0.0
    nodes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in (document.get("nodes") or [])[:MAX_NODES]:
        if not isinstance(item, dict):
            continue
        node_id = str(item.get("id") or "").strip()[:80]
        kind = str(item.get("kind") or "text").strip()
        if not node_id or node_id in seen or kind not in NODE_KINDS:
            continue
        try:
            x = float(item.get("x") or 0)
            y = float(item.get("y") or 0)
            width = float(item.get("width") or 220)
            height = float(item.get("height") or 120)
        except (TypeError, ValueError):
            continue
        node = {
            "id": node_id,
            "kind": kind,
            "x": round(x, 2),
            "y": round(y, 2),
            "width": round(min(720, max(120, width)), 2),
            "height": round(min(520, max(72, height)), 2),
            "title": str(item.get("title") or "")[:160],
            "text": str(item.get("text") or "")[:MAX_TEXT],
        }
        entry_id = str(item.get("entryId") or "").strip()
        if entry_id:
            node["entryId"] = entry_id[:80]
        nodes.append(node)
        seen.add(node_id)
    edges: list[dict[str, Any]] = []
    seen_edges: set[tuple[str, str]] = set()
    node_ids = {node["id"] for node in nodes}
    for item in (document.get("edges") or [])[:MAX_EDGES]:
        if not isinstance(item, dict):
            continue
        source = str(item.get("from") or "").strip()
        target = str(item.get("to") or "").strip()
        if not source or not target or source == target:
            continue
        if source not in node_ids or target not in node_ids:
            continue
        if (source, target) in seen_edges:
            continue
        edges.append(
            {
                "id": str(item.get("id") or f"edge_{uuid4().hex[:10]}")[:80],
                "from": source,
                "to": target,
            }
        )
        seen_edges.add((source, target))
    return {
        "version": CANVAS_VERSION,
        "revision": revision,
        "viewport": {"x": round(vx, 2), "y": round(vy, 2), "scale": round(scale, 3)},
        "nodes": nodes,
        "edges": edges,
    }


def add_canvas_node(
    document: dict[str, Any],
    *,
    kind: str = "text",
    title: str = "",
    text: str = "",
    entry_id: str = "",
    x: float = 80,
    y: float = 80,
) -> dict[str, Any]:
    next_doc = normalize_library_canvas(document)
    if kind not in NODE_KINDS:
        kind = "text"
    if len(next_doc["nodes"]) >= MAX_NODES:
        raise ValueError("The library canvas is full")
    node = {
        "id": f"lnode_{uuid4().hex[:10]}",
        "kind": kind,
        "x": x,
        "y": y,
        "width": 240 if kind == "text" else 220,
        "height": 140 if kind != "image" else 180,
        "title": title[:160],
        "text": text[:MAX_TEXT],
    }
    if entry_id:
        node["entryId"] = entry_id[:80]
    next_doc["nodes"].append(node)
    next_doc["revision"] = int(next_doc.get("revision") or 0) + 1
    return next_doc
