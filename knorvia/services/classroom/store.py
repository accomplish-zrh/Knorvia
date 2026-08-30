"""Classroom document store — one JSON file per lesson.

``data/classrooms/{id}.json``, anchored to the admin workspace root (same
convention as the partners tree). Lessons are immutable once generated in
v1: create / read / list / delete only.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
import threading
import time
from typing import Any

from knorvia.multi_user.paths import get_admin_path_service
from knorvia.services.classroom.models import ClassroomDocument

logger = logging.getLogger(__name__)


class ClassroomStore:
    def __init__(self, root: Path | None = None) -> None:
        self._root = root or (get_admin_path_service().workspace_root / "classrooms")
        self._root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, classroom_id: str) -> Path:
        safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in classroom_id)
        return self._root / f"{safe}.json"

    def save(self, document: ClassroomDocument) -> None:
        document.version = max(1, document.version)
        payload = json.dumps(document.to_dict(), ensure_ascii=False, indent=2)
        path = self._path(document.id)
        with self._lock:
            temporary = path.with_suffix(f".{threading.get_ident()}.tmp")
            temporary.write_text(payload, encoding="utf-8")
            temporary.replace(path)

    def get(self, classroom_id: str) -> ClassroomDocument | None:
        path = self._path(classroom_id)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return ClassroomDocument.from_dict(data)
        except (OSError, json.JSONDecodeError):
            logger.exception("Failed to read classroom %s", classroom_id)
            return None

    def list(self) -> list[dict[str, Any]]:
        cards: list[dict[str, Any]] = []
        for path in sorted(
            self._root.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True
        ):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            cards.append(
                {
                    "id": str(data.get("id") or path.stem),
                    "title": str(data.get("title") or ""),
                    "topic": str(data.get("topic") or ""),
                    "language": str(data.get("language") or "zh"),
                    "scene_count": len(data.get("scenes") or []),
                    "created_at": float(data.get("created_at") or 0.0),
                }
            )
        return cards

    def delete(self, classroom_id: str) -> bool:
        path = self._path(classroom_id)
        existed = path.exists()
        with self._lock:
            path.unlink(missing_ok=True)
        return existed

    @staticmethod
    def now() -> float:
        return time.time()


_store: ClassroomStore | None = None


def get_classroom_store() -> ClassroomStore:
    global _store
    if _store is None:
        _store = ClassroomStore()
    return _store


__all__ = ["ClassroomStore", "get_classroom_store"]
