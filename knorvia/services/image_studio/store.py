from __future__ import annotations

from contextlib import contextmanager
import hashlib
from io import BytesIO
import json
import math
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import threading
import time
from typing import Any, Callable
from uuid import uuid4
import zipfile

from PIL import Image

from knorvia.multi_user.paths import get_current_path_service

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at REAL NOT NULL,
  updated_at REAL NOT NULL, deleted_at REAL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_job_id TEXT,
  retry_of_job_id TEXT, operation TEXT NOT NULL, status TEXT NOT NULL,
  profile_id TEXT NOT NULL, model_id TEXT NOT NULL, prompt TEXT NOT NULL,
  requested_params TEXT NOT NULL, actual_params TEXT NOT NULL DEFAULT '{}',
  provider_context_id TEXT, revised_prompt TEXT, usage_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT, error_message TEXT, created_at REAL NOT NULL,
  started_at REAL, finished_at REAL, owner_user_id TEXT,
  config_revision TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
  mime TEXT NOT NULL, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  relative_path TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL, deleted_at REAL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS job_inputs (
  job_id TEXT NOT NULL, asset_id TEXT NOT NULL, role TEXT NOT NULL,
  position INTEGER NOT NULL, PRIMARY KEY(job_id, asset_id, role)
);
CREATE TABLE IF NOT EXISTS job_outputs (
  job_id TEXT NOT NULL, asset_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY(job_id, asset_id)
);
CREATE TABLE IF NOT EXISTS job_events (
  job_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, created_at REAL NOT NULL,
  PRIMARY KEY(job_id, seq)
);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, filename TEXT NOT NULL,
  mime TEXT NOT NULL, expected_size INTEGER NOT NULL, expected_sha256 TEXT,
  temp_path TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id TEXT NOT NULL, part_index INTEGER NOT NULL, size_bytes INTEGER NOT NULL,
  PRIMARY KEY(upload_id, part_index),
  FOREIGN KEY(upload_id) REFERENCES uploads(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS session_projects (
  session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE,
  created_at REAL NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_project_created ON jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_project_created ON assets(project_id, created_at DESC);
"""

MAX_STORED_IMAGE_BYTES = 50 * 1024 * 1024
MAX_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
UPLOAD_TTL_SECONDS = 24 * 60 * 60
MAX_ACTIVE_UPLOADS = 20
MAX_ACTIVE_UPLOAD_BYTES = 100 * 1024 * 1024
MAX_IMAGE_DIMENSION = 16_384
MAX_IMAGE_PIXELS = 64 * 1024 * 1024
MAX_PENDING_JOBS = 50
MAX_JOB_OUTPUTS = 4
MAX_EXPORT_BYTES = 1024 * 1024 * 1024
STORED_IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp"}
BOARD_NODE_KINDS = frozenset({"image", "generate", "text"})
BOARD_EDGE_ROLES = frozenset({"reference", "mask"})
BOARD_MAX_NODES = 200
BOARD_MAX_EDGES = 400
BOARD_MAX_BYTES = 2 * 1024 * 1024


class BoardConflictError(ValueError):
    def __init__(self, expected_revision: int | None, current_revision: int):
        super().__init__("The board changed since it was loaded.")
        self.expected_revision = expected_revision
        self.current_revision = current_revision


class ImageStudioQueueFullError(RuntimeError):
    pass


def _bounded_number(
    value: Any,
    default: float,
    *,
    minimum: float,
    maximum: float,
) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    if not math.isfinite(number):
        return default
    return min(maximum, max(minimum, number))


def parse_output_count(parameters: dict[str, Any]) -> int:
    raw = parameters.get("n", 1)
    if isinstance(raw, bool):
        raise ValueError("Invalid output count")
    if isinstance(raw, int):
        count = raw
    elif isinstance(raw, str) and raw.strip().isdigit():
        count = int(raw.strip())
    else:
        raise ValueError("Invalid output count")
    if count < 1 or count > MAX_JOB_OUTPUTS:
        raise ValueError("Invalid output count")
    return count


class ImageStudioStore:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.db_path = self.root / "studio.db"
        self.projects_root = self.root / "projects"
        self.uploads_root = self.root / ".uploads"
        self._lock = threading.RLock()
        self.root.mkdir(parents=True, exist_ok=True)
        self.projects_root.mkdir(parents=True, exist_ok=True)
        self.uploads_root.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            # WAL is persistent per database file; enabling it once at init
            # lets generation polling read concurrently with job writes
            # instead of taking a write lock on every connection.
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
            columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
            for name, definition in {
                "provider_context_id": "TEXT",
                "revised_prompt": "TEXT",
                "usage_json": "TEXT NOT NULL DEFAULT '{}'",
                "owner_user_id": "TEXT",
                "config_revision": "TEXT",
            }.items():
                if name not in columns:
                    db.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")
            asset_columns = {row[1] for row in db.execute("PRAGMA table_info(assets)")}
            for name in ("width", "height"):
                if name not in asset_columns:
                    db.execute(f"ALTER TABLE assets ADD COLUMN {name} INTEGER NOT NULL DEFAULT 0")
            db.execute(
                "UPDATE jobs SET status='interrupted', finished_at=? WHERE status='running'",
                (time.time(),),
            )
        self.cleanup_expired_uploads()

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.db_path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            yield db
            db.commit()
        finally:
            db.close()

    @staticmethod
    def _dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row is not None else None

    def ensure_default_project(self) -> dict[str, Any]:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1"
            ).fetchone()
        return self._dict(row) or self.create_project("Untitled Project")

    def create_project(self, title: str) -> dict[str, Any]:
        now, project_id = time.time(), f"project_{uuid4().hex}"
        safe_title = (title or "Untitled Project").strip()[:160] or "Untitled Project"
        with self._connect() as db:
            db.execute(
                "INSERT INTO projects VALUES (?,?,?,?,NULL)",
                (project_id, safe_title, now, now),
            )
        (self.projects_root / project_id / "assets").mkdir(parents=True, exist_ok=True)
        return self.get_project(project_id) or {}

    def project_for_session(
        self,
        session_id: str,
        *,
        title: str,
        legacy_title: str | None = None,
    ) -> dict[str, Any]:
        """Return the one durable project assigned to an exact chat session id.

        Older builds inferred this relation from a truncated title.  An unclaimed
        legacy project is adopted once; a second session with the same legacy
        prefix receives its own project instead of being merged into the first.
        """
        session_id = str(session_id or "").strip()
        if not session_id:
            raise ValueError("A session id is required.")
        safe_title = (title or "Untitled Project").strip()[:160] or "Untitled Project"
        created_project_id: str | None = None
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute(
                """SELECT p.* FROM session_projects sp
                   JOIN projects p ON p.id=sp.project_id
                   WHERE sp.session_id=? AND p.deleted_at IS NULL""",
                (session_id,),
            ).fetchone()
            if existing is not None:
                return dict(existing)

            candidate = None
            if legacy_title:
                candidate = db.execute(
                    """SELECT p.* FROM projects p
                       WHERE p.deleted_at IS NULL AND p.title=?
                         AND NOT EXISTS (
                           SELECT 1 FROM session_projects sp WHERE sp.project_id=p.id
                         )
                       ORDER BY p.created_at ASC LIMIT 1""",
                    (legacy_title,),
                ).fetchone()

            now = time.time()
            if candidate is None:
                created_project_id = f"project_{uuid4().hex}"
                db.execute(
                    "INSERT INTO projects VALUES (?,?,?,?,NULL)",
                    (created_project_id, safe_title, now, now),
                )
                project_id = created_project_id
            else:
                project_id = str(candidate["id"])

            db.execute(
                """INSERT INTO session_projects(session_id,project_id,created_at)
                   VALUES (?,?,?)
                   ON CONFLICT(session_id) DO UPDATE SET
                     project_id=excluded.project_id,
                     created_at=excluded.created_at""",
                (session_id, project_id, now),
            )

        if created_project_id:
            (self.projects_root / created_project_id / "assets").mkdir(parents=True, exist_ok=True)
        return self.get_project(project_id) or {}

    def get_project(
        self, project_id: str, *, include_deleted: bool = False
    ) -> dict[str, Any] | None:
        suffix = "" if include_deleted else " AND deleted_at IS NULL"
        with self._connect() as db:
            row = db.execute(f"SELECT * FROM projects WHERE id=?{suffix}", (project_id,)).fetchone()  # nosec B608 - suffix is a hardcoded literal
        return self._dict(row)

    def list_projects(self, query: str = "", limit: int = 30) -> list[dict[str, Any]]:
        pattern = f"%{query.strip()}%"
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM projects WHERE deleted_at IS NULL AND title LIKE ? ORDER BY updated_at DESC LIMIT ?",
                (pattern, max(1, min(limit, 100))),
            ).fetchall()
        return [dict(row) for row in rows]

    def update_project(self, project_id: str, title: str) -> dict[str, Any] | None:
        with self._connect() as db:
            db.execute(
                "UPDATE projects SET title=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
                ((title or "Untitled Project").strip()[:160], time.time(), project_id),
            )
        return self.get_project(project_id)

    def delete_project(self, project_id: str) -> bool:
        with self._connect() as db:
            cur = db.execute(
                "UPDATE projects SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
                (time.time(), time.time(), project_id),
            )
        return cur.rowcount > 0

    def board_path(self, project_id: str) -> Path:
        return self.projects_root / project_id / "board.json"

    def empty_board(self) -> dict[str, Any]:
        return {
            "version": 1,
            "revision": 0,
            "viewport": {"x": 0, "y": 0, "scale": 1},
            "nodes": [],
            "edges": [],
            "groups": [],
        }

    def _read_board_file(self, project_id: str) -> dict[str, Any]:
        path = self.board_path(project_id)
        if not path.exists():
            return self.empty_board()
        for candidate in (path, path.with_suffix(".json.bak")):
            if not candidate.exists():
                continue
            try:
                return self.normalize_board(json.loads(candidate.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        raise ValueError("The board document is corrupt.")

    @staticmethod
    def _atomic_write(path: Path, encoded: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        temp_path = Path(temp_name)
        backup = path.with_suffix(".json.bak")
        backup_temp = backup.with_suffix(".bak.tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(encoded)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            if path.exists():
                try:
                    json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    pass
                else:
                    shutil.copy2(path, backup_temp)
                    os.replace(backup_temp, backup)
            os.replace(temp_path, path)
        finally:
            temp_path.unlink(missing_ok=True)
            backup_temp.unlink(missing_ok=True)

    @staticmethod
    def _atomic_write_bytes(path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        temp_path = Path(temp_name)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, path)
        finally:
            temp_path.unlink(missing_ok=True)

    def get_board(self, project_id: str) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._lock:
            return self._read_board_file(project_id)

    def _write_board_locked(
        self,
        project_id: str,
        document: dict[str, Any],
        *,
        current_revision: int,
    ) -> dict[str, Any]:
        cleaned = self.normalize_board(document)
        cleaned["revision"] = current_revision + 1
        encoded = json.dumps(cleaned, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > BOARD_MAX_BYTES:
            raise ValueError("Board document is too large")
        path = self.board_path(project_id)
        self._atomic_write(path, encoded)
        with self._connect() as db:
            db.execute(
                "UPDATE projects SET updated_at=? WHERE id=? AND deleted_at IS NULL",
                (time.time(), project_id),
            )
        return cleaned

    def save_board(
        self,
        project_id: str,
        document: dict[str, Any],
        *,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        if expected_revision is None and isinstance(document.get("revision"), int):
            expected_revision = int(document["revision"])
        with self._lock:
            current = self._read_board_file(project_id)
            current_revision = int(current.get("revision") or 0)
            if expected_revision is None and current_revision == 0:
                expected_revision = 0
            if expected_revision != current_revision:
                raise BoardConflictError(expected_revision, current_revision)
            return self._write_board_locked(
                project_id,
                document,
                current_revision=current_revision,
            )

    def update_board(
        self,
        project_id: str,
        mutator: Callable[[dict[str, Any]], None],
    ) -> dict[str, Any]:
        """Atomically patch the newest board without replacing unrelated edits."""
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._lock:
            current = self._read_board_file(project_id)
            revision = int(current.get("revision") or 0)
            mutator(current)
            return self._write_board_locked(
                project_id,
                current,
                current_revision=revision,
            )

    def normalize_board(self, raw: Any) -> dict[str, Any]:
        source = raw if isinstance(raw, dict) else {}
        viewport = source.get("viewport") if isinstance(source.get("viewport"), dict) else {}
        scale_value = _bounded_number(viewport.get("scale"), 1.0, minimum=0.15, maximum=3.0)
        nodes: list[dict[str, Any]] = []
        node_ids: set[str] = set()
        for item in source.get("nodes") or []:
            if not isinstance(item, dict) or item.get("kind") not in BOARD_NODE_KINDS:
                continue
            geometry = [item.get(key) for key in ("x", "y", "width", "height")]
            if not all(
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value))
                for value in geometry
            ):
                continue
            node_id = str(item.get("id") or f"node_{uuid4().hex[:8]}")[:200]
            if not node_id or node_id in node_ids:
                continue
            node_ids.add(node_id)
            node = {
                "id": node_id,
                "kind": item["kind"],
                "x": _bounded_number(item["x"], 0.0, minimum=-1_000_000, maximum=1_000_000),
                "y": _bounded_number(item["y"], 0.0, minimum=-1_000_000, maximum=1_000_000),
                "width": _bounded_number(item["width"], 280.0, minimum=80.0, maximum=100_000.0),
                "height": _bounded_number(item["height"], 280.0, minimum=80.0, maximum=100_000.0),
                "z": int(
                    _bounded_number(
                        item.get("z"),
                        float(len(nodes)),
                        minimum=-1_000_000,
                        maximum=1_000_000,
                    )
                ),
            }
            for key in (
                "title",
                "prompt",
                "text",
                "assetId",
                "jobId",
                "status",
                "groupId",
                "parentNodeId",
                "modelKey",
                "ratio",
                "quality",
            ):
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    node[key] = value.strip()[:4000]
            for key in ("customWidth", "customHeight"):
                value = item.get(key)
                if (
                    isinstance(value, (int, float))
                    and not isinstance(value, bool)
                    and math.isfinite(float(value))
                    and value > 0
                ):
                    node[key] = int(min(float(value), 100_000))
            nodes.append(node)
            if len(nodes) >= BOARD_MAX_NODES:
                break
        ids = {node["id"] for node in nodes}
        edges: list[dict[str, Any]] = []
        edge_ids: set[str] = set()
        for item in source.get("edges") or []:
            if not isinstance(item, dict):
                continue
            start, end = str(item.get("from") or ""), str(item.get("to") or "")
            if start not in ids or end not in ids or start == end:
                continue
            edge_id = str(item.get("id") or f"edge_{uuid4().hex[:8]}")[:200]
            if not edge_id or edge_id in edge_ids:
                continue
            edge_ids.add(edge_id)
            edges.append(
                {
                    "id": edge_id,
                    "from": start,
                    "to": end,
                    "role": item["role"] if item.get("role") in BOARD_EDGE_ROLES else "reference",
                }
            )
            if len(edges) >= BOARD_MAX_EDGES:
                break
        used_groups = {str(node.get("groupId")) for node in nodes if node.get("groupId")}
        groups: list[dict[str, Any]] = []
        for item in source.get("groups") or []:
            if not isinstance(item, dict):
                continue
            group_id = str(item.get("id") or "")[:200]
            if not group_id or group_id not in used_groups:
                continue
            title = item.get("title")
            groups.append(
                {
                    "id": group_id,
                    "title": str(title).strip()[:200]
                    if isinstance(title, str) and title.strip()
                    else "Group",
                }
            )
            if len(groups) >= 80:
                break
        try:
            revision = min(2**63 - 1, max(0, int(source.get("revision") or 0)))
        except (TypeError, ValueError, OverflowError):
            revision = 0
        return {
            "version": 1,
            "revision": revision,
            "viewport": {
                "x": _bounded_number(viewport.get("x"), 0.0, minimum=-1_000_000, maximum=1_000_000),
                "y": _bounded_number(viewport.get("y"), 0.0, minimum=-1_000_000, maximum=1_000_000),
                "scale": scale_value,
            },
            "nodes": nodes,
            "edges": edges,
            "groups": groups,
        }

    def place_job_on_board(
        self,
        project_id: str,
        job: dict[str, Any],
        *,
        target_node_id: str | None = None,
    ) -> dict[str, Any]:
        outputs = [
            {"assetId": str(item.get("asset_id") or "")}
            for item in job.get("outputs") or []
            if item.get("asset_id")
        ]

        def place(board: dict[str, Any]) -> None:
            origin_x = 80.0
            if board["nodes"]:
                origin_x = max(node["x"] + node["width"] for node in board["nodes"]) + 48
            existing_job = None
            if target_node_id:
                existing_job = next(
                    (node for node in board["nodes"] if node.get("id") == target_node_id),
                    None,
                )
                if existing_job is None:
                    raise ValueError(f"Board node {target_node_id!r} was not found.")
                if existing_job is not None and existing_job.get("kind") == "text":
                    raise ValueError("A text note cannot receive an image job result.")
            if existing_job is None:
                existing_job = next(
                    (node for node in board["nodes"] if node.get("jobId") == job.get("id")),
                    None,
                )
            if existing_job and outputs:
                existing_job["assetId"] = outputs[0]["assetId"]
                existing_job["kind"] = "image"
                existing_job["status"] = str(job.get("status") or "succeeded")
                existing_job["prompt"] = str(job.get("prompt") or existing_job.get("prompt") or "")
                extras = outputs[1:]
            elif existing_job:
                existing_job["status"] = str(job.get("status") or "")
                extras = []
            else:
                extras = outputs or [{"assetId": ""}]
            for index, output in enumerate(extras):
                node = {
                    "id": f"node_{uuid4().hex[:10]}",
                    "kind": "image" if output.get("assetId") else "generate",
                    "x": origin_x + index * 320,
                    "y": 80.0,
                    "width": 280.0,
                    "height": 280.0,
                    "z": len(board["nodes"]),
                    "jobId": str(job.get("id") or ""),
                    "status": str(job.get("status") or ""),
                }
                if output.get("assetId"):
                    node["assetId"] = output["assetId"]
                if job.get("prompt"):
                    node["prompt"] = str(job["prompt"])[:4000]
                if existing_job and existing_job.get("id"):
                    node["parentNodeId"] = str(existing_job["id"])
                board["nodes"].append(node)

        return self.update_board(project_id, place)

    def restore_project(self, project_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            db.execute(
                "UPDATE projects SET deleted_at=NULL, updated_at=? WHERE id=?",
                (time.time(), project_id),
            )
        return self.get_project(project_id)

    def cleanup_expired_uploads(self, *, now: float | None = None) -> int:
        cutoff = (now if now is not None else time.time()) - UPLOAD_TTL_SECONDS
        with self._lock, self._connect() as db:
            rows = db.execute(
                "SELECT id,temp_path FROM uploads WHERE created_at<?", (cutoff,)
            ).fetchall()
            for row in rows:
                try:
                    path = Path(row["temp_path"]).resolve()
                    if path.parent == self.uploads_root.resolve():
                        path.unlink(missing_ok=True)
                except OSError:
                    pass
                db.execute("DELETE FROM uploads WHERE id=?", (row["id"],))
        return len(rows)

    def create_upload(
        self,
        project_id: str,
        filename: str,
        mime: str,
        size: int,
        sha256: str,
    ) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        if mime not in STORED_IMAGE_MIMES:
            raise ValueError("Unsupported image type")
        if size <= 0 or size > MAX_UPLOAD_IMAGE_BYTES:
            raise ValueError("Image exceeds the upload limit")
        normalized_digest = str(sha256 or "").strip().lower()
        if len(normalized_digest) != 64 or any(
            char not in "0123456789abcdef" for char in normalized_digest
        ):
            raise ValueError("A valid SHA-256 checksum is required")
        self.cleanup_expired_uploads()
        upload_id = f"upload_{uuid4().hex}"
        temp_path = self.uploads_root / f"{upload_id}.part"
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            count, total = db.execute(
                "SELECT COUNT(*),COALESCE(SUM(expected_size),0) FROM uploads"
            ).fetchone()
            if int(count) >= MAX_ACTIVE_UPLOADS or int(total) + size > MAX_ACTIVE_UPLOAD_BYTES:
                raise ValueError("Too many active image uploads")
            try:
                temp_path.touch(exist_ok=False)
                db.execute(
                    """INSERT INTO uploads
                       (id,project_id,filename,mime,expected_size,expected_sha256,temp_path,created_at)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (
                        upload_id,
                        project_id,
                        filename[:255],
                        mime,
                        size,
                        normalized_digest,
                        str(temp_path),
                        time.time(),
                    ),
                )
            except Exception:
                temp_path.unlink(missing_ok=True)
                raise
        return {
            "upload_id": upload_id,
            "chunk_size": UPLOAD_CHUNK_BYTES,
            "expires_in": UPLOAD_TTL_SECONDS,
        }

    def upload_record(self, upload_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
        return self._dict(row)

    def write_upload_part(self, upload_id: str, index: int, data: bytes) -> None:
        with self._lock:
            record = self.upload_record(upload_id)
            if not record:
                raise KeyError(upload_id)
            if float(record["created_at"]) < time.time() - UPLOAD_TTL_SECONDS:
                self.cleanup_expired_uploads()
                raise KeyError(upload_id)
            expected_size = int(record["expected_size"])
            part_count = (expected_size + UPLOAD_CHUNK_BYTES - 1) // UPLOAD_CHUNK_BYTES
            if index < 0 or index >= part_count:
                raise ValueError("Invalid upload chunk index")
            expected_part_size = min(
                UPLOAD_CHUNK_BYTES,
                expected_size - index * UPLOAD_CHUNK_BYTES,
            )
            if len(data) != expected_part_size:
                raise ValueError("Upload chunk size does not match")
            target = Path(record["temp_path"]).resolve()
            if target.parent != self.uploads_root.resolve():
                raise ValueError("Unsafe upload path")
            with open(target, "r+b") as handle:
                handle.seek(index * UPLOAD_CHUNK_BYTES)
                handle.write(data)
                handle.flush()
            with self._connect() as db:
                db.execute(
                    """INSERT INTO upload_parts(upload_id,part_index,size_bytes)
                       VALUES (?,?,?)
                       ON CONFLICT(upload_id,part_index) DO UPDATE SET
                         size_bytes=excluded.size_bytes""",
                    (upload_id, index, len(data)),
                )

    @staticmethod
    def sniff_mime(data: bytes) -> str:
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if data.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return "image/webp"
        raise ValueError("Unsupported or invalid image file")

    @classmethod
    def validate_image_bytes(
        cls,
        data: bytes,
        expected_mime: str = "",
    ) -> tuple[str, int, int]:
        if not data or len(data) > MAX_STORED_IMAGE_BYTES:
            raise ValueError("Image exceeds the storage limit")
        sniffed = cls.sniff_mime(data)
        if expected_mime and sniffed != expected_mime:
            raise ValueError("Uploaded file type does not match")
        formats = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
        try:
            with Image.open(BytesIO(data)) as image:
                actual_mime = formats.get(str(image.format or "").upper(), "")
                width, height = image.size
                if actual_mime != sniffed:
                    raise ValueError("Uploaded file type does not match")
                if (
                    width <= 0
                    or height <= 0
                    or width > MAX_IMAGE_DIMENSION
                    or height > MAX_IMAGE_DIMENSION
                    or width * height > MAX_IMAGE_PIXELS
                ):
                    raise ValueError("Image dimensions exceed the safety limit")
                image.verify()
            # verify() validates structure without decoding pixels. Reopen and
            # load once under the pixel ceiling to reject truncated payloads.
            with Image.open(BytesIO(data)) as decoded:
                decoded.load()
        except ValueError:
            raise
        except (OSError, SyntaxError, Image.DecompressionBombError) as exc:
            raise ValueError("Image data is invalid or truncated") from exc
        return sniffed, int(width), int(height)

    @classmethod
    def image_dimensions(cls, data: bytes, mime: str) -> tuple[int, int]:
        try:
            _, width, height = cls.validate_image_bytes(data, mime)
        except ValueError:
            return 0, 0
        return width, height

    def complete_upload(self, upload_id: str, *, kind: str = "input") -> dict[str, Any]:
        with self._lock:
            record = self.upload_record(upload_id)
            if not record:
                raise KeyError(upload_id)
            if float(record["created_at"]) < time.time() - UPLOAD_TTL_SECONDS:
                self.cleanup_expired_uploads()
                raise KeyError(upload_id)
            expected_size = int(record["expected_size"])
            expected_parts = (expected_size + UPLOAD_CHUNK_BYTES - 1) // UPLOAD_CHUNK_BYTES
            with self._connect() as db:
                parts = db.execute(
                    """SELECT part_index,size_bytes FROM upload_parts
                       WHERE upload_id=? ORDER BY part_index""",
                    (upload_id,),
                ).fetchall()
            if [int(row["part_index"]) for row in parts] != list(range(expected_parts)):
                raise ValueError("Upload is incomplete")
            source = Path(record["temp_path"]).resolve()
            if source.parent != self.uploads_root.resolve():
                raise ValueError("Unsafe upload path")
            try:
                actual_size = source.stat().st_size
            except OSError as exc:
                raise ValueError("Upload data is missing") from exc
            if actual_size != expected_size or actual_size > MAX_UPLOAD_IMAGE_BYTES:
                raise ValueError("Upload size does not match")
            data = source.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if digest != record["expected_sha256"]:
                raise ValueError("Upload checksum does not match")
            mime, _, _ = self.validate_image_bytes(data, str(record["mime"]))
            asset = self.save_asset(record["project_id"], data, mime, kind=kind)
            with self._connect() as db:
                db.execute("DELETE FROM uploads WHERE id=?", (upload_id,))
            source.unlink(missing_ok=True)
            return asset

    def save_asset(self, project_id: str, data: bytes, mime: str, *, kind: str) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        if mime not in STORED_IMAGE_MIMES:
            raise ValueError("Unsupported image type")
        if not data or len(data) > MAX_STORED_IMAGE_BYTES:
            raise ValueError("Image exceeds the storage limit")
        _, width, height = self.validate_image_bytes(data, mime)
        ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(mime, ".bin")
        asset_id = f"asset_{uuid4().hex}"
        relative = Path("projects") / project_id / "assets" / f"{asset_id}{ext}"
        target = (self.root / relative).resolve()
        if self.root not in target.parents:
            raise ValueError("Unsafe asset path")
        now = time.time()
        try:
            self._atomic_write_bytes(target, data)
            with self._connect() as db:
                db.execute(
                    "INSERT INTO assets (id,project_id,kind,mime,width,height,size_bytes,sha256,relative_path,favorite,created_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)",
                    (
                        asset_id,
                        project_id,
                        kind,
                        mime,
                        width,
                        height,
                        len(data),
                        hashlib.sha256(data).hexdigest(),
                        relative.as_posix(),
                        0,
                        now,
                    ),
                )
                db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now, project_id))
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return self.get_asset(asset_id) or {}

    def get_asset(self, asset_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM assets WHERE id=? AND deleted_at IS NULL", (asset_id,)
            ).fetchone()
        return self._dict(row)

    def asset_path(self, asset_id: str) -> Path:
        asset = self.get_asset(asset_id)
        if not asset:
            raise KeyError(asset_id)
        path = (self.root / asset["relative_path"]).resolve()
        if self.root not in path.parents:
            raise ValueError("Unsafe asset path")
        return path

    def list_assets(self, project_id: str, limit: int = 100) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM assets WHERE project_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
                (project_id, max(1, min(limit, 200))),
            ).fetchall()
        return [dict(row) for row in rows]

    def set_favorite(self, asset_id: str, favorite: bool) -> dict[str, Any] | None:
        with self._connect() as db:
            db.execute("UPDATE assets SET favorite=? WHERE id=?", (int(favorite), asset_id))
        return self.get_asset(asset_id)

    def delete_asset(self, asset_id: str) -> bool:
        with self._connect() as db:
            cur = db.execute(
                "UPDATE assets SET deleted_at=? WHERE id=? AND deleted_at IS NULL",
                (time.time(), asset_id),
            )
        return cur.rowcount > 0

    def restore_asset(self, asset_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT a.id FROM assets a
                   JOIN projects p ON p.id=a.project_id
                   WHERE a.id=? AND p.deleted_at IS NULL""",
                (asset_id,),
            ).fetchone()
            if not row:
                return None
            db.execute("UPDATE assets SET deleted_at=NULL WHERE id=?", (asset_id,))
        return self.get_asset(asset_id)

    def export_project(self, project_id: str) -> Path:
        project = self.get_project(project_id)
        if not project:
            raise KeyError(project_id)
        with self._connect() as db:
            assets = [
                dict(row)
                for row in db.execute(
                    """SELECT * FROM assets
                       WHERE project_id=? AND deleted_at IS NULL
                       ORDER BY created_at DESC""",
                    (project_id,),
                ).fetchall()
            ]
            job_ids = [
                str(row[0])
                for row in db.execute(
                    "SELECT id FROM jobs WHERE project_id=? ORDER BY created_at DESC",
                    (project_id,),
                ).fetchall()
            ]
        jobs = [item for job_id in job_ids if (item := self.get_job(job_id))]
        total_asset_bytes = sum(int(asset.get("size_bytes") or 0) for asset in assets)
        if total_asset_bytes > MAX_EXPORT_BYTES:
            raise ValueError("Project export exceeds the size limit")
        export_dir = self.projects_root / project_id / "exports"
        export_dir.mkdir(parents=True, exist_ok=True)
        target = export_dir / f"{project_id}.zip"
        manifest = {
            "version": 1,
            "project": project,
            "jobs": jobs,
            "assets": [
                {key: value for key, value in asset.items() if key != "relative_path"}
                for asset in assets
            ],
        }
        temporary = export_dir / f".export-{uuid4().hex[:8]}.tmp"
        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(
                    "manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False)
                )
                board_path = self.board_path(project_id)
                if board_path.exists():
                    archive.write(board_path, "board.json")
                for asset in assets:
                    source = self.asset_path(asset["id"])
                    archive.write(source, f"assets/{source.name}")
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return target

    def create_job(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        job_id, now = f"job_{uuid4().hex}", time.time()
        params = dict(payload.get("parameters") or {})
        params["n"] = parse_output_count(params)
        if payload.get("operation") not in {"generate", "edit", "inpaint"}:
            raise ValueError("Invalid image operation")
        if (
            not str(payload.get("profile_id") or "").strip()
            or not str(payload.get("model_id") or "").strip()
        ):
            raise ValueError("An image profile and model are required")
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt or len(prompt) > 20_000:
            raise ValueError("A valid image prompt is required")
        input_asset_ids = list(dict.fromkeys(payload.get("input_asset_ids") or []))
        if len(input_asset_ids) > 4:
            raise ValueError("Too many input images")
        mask_asset_id = payload.get("mask_asset_id")
        for asset_id in [*input_asset_ids, *([mask_asset_id] if mask_asset_id else [])]:
            asset = self.get_asset(str(asset_id or ""))
            if not asset or asset.get("project_id") != project_id:
                raise ValueError("Input assets must belong to the image project")
        for field in ("parent_job_id", "retry_of_job_id"):
            related_id = payload.get(field)
            if not related_id:
                continue
            related = self.get_job(str(related_id))
            if not related or related.get("project_id") != project_id:
                raise ValueError("Related image jobs must belong to the image project")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            pending = int(
                db.execute(
                    "SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')"
                ).fetchone()[0]
            )
            if pending >= MAX_PENDING_JOBS:
                raise ImageStudioQueueFullError("Image Studio already has too many queued jobs.")
            db.execute(
                """INSERT INTO jobs
                   (id,project_id,parent_job_id,retry_of_job_id,operation,status,
                    profile_id,model_id,prompt,requested_params,created_at,
                    owner_user_id,config_revision)
                   VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?,?)""",
                (
                    job_id,
                    project_id,
                    payload.get("parent_job_id"),
                    payload.get("retry_of_job_id"),
                    payload["operation"],
                    payload["profile_id"],
                    payload["model_id"],
                    prompt,
                    json.dumps(params),
                    now,
                    payload.get("owner_user_id"),
                    payload.get("config_revision"),
                ),
            )
            for position, asset_id in enumerate(input_asset_ids):
                db.execute(
                    "INSERT INTO job_inputs VALUES (?,?,?,?)",
                    (job_id, asset_id, "reference", position),
                )
            if mask_asset_id:
                db.execute(
                    "INSERT INTO job_inputs VALUES (?,?,?,?)",
                    (job_id, mask_asset_id, "mask", 0),
                )
        self.add_event(job_id, "job.queued", {"status": "queued"})
        return self.get_job(job_id) or {}

    def _assemble_jobs(self, db: Any, rows: list[Any]) -> list[dict[str, Any]]:
        """Shape raw ``jobs`` rows with their relations, loading in bulk.

        One connection and one query per relation table instead of three
        queries plus a fresh connection per job.
        """
        if not rows:
            return []
        ids = [str(row["id"]) for row in rows]
        placeholders = ",".join("?" * len(ids))
        inputs_by_job: dict[str, list[dict[str, Any]]] = {job_id: [] for job_id in ids}
        for row in db.execute(
            f"SELECT job_id, asset_id, role, position FROM job_inputs WHERE job_id IN ({placeholders}) ORDER BY role, position",  # nosec B608 - placeholder string only
            ids,
        ):
            inputs_by_job[str(row["job_id"])].append(
                {"asset_id": row["asset_id"], "role": row["role"], "position": row["position"]}
            )
        outputs_by_job: dict[str, list[dict[str, Any]]] = {job_id: [] for job_id in ids}
        for row in db.execute(
            f"SELECT job_id, asset_id, position FROM job_outputs WHERE job_id IN ({placeholders}) ORDER BY position",  # nosec B608 - placeholder string only
            ids,
        ):
            outputs_by_job[str(row["job_id"])].append(
                {"asset_id": row["asset_id"], "position": row["position"]}
            )
        results = []
        for row in rows:
            item = dict(row)
            job_id = str(item["id"])
            item["requested_params"] = json.loads(item["requested_params"] or "{}")
            item["actual_params"] = json.loads(item["actual_params"] or "{}")
            item["usage"] = json.loads(item.pop("usage_json", "{}") or "{}")
            item["inputs"] = inputs_by_job[job_id]
            item["outputs"] = outputs_by_job[job_id]
            results.append(item)
        return results

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return None
            return self._assemble_jobs(db, [row])[0]

    def list_jobs(
        self,
        project_id: str,
        limit: int = 50,
        *,
        before: float | None = None,
        status: str = "",
        model_id: str = "",
        query: str = "",
        favorite: bool = False,
    ) -> list[dict[str, Any]]:
        clauses = ["project_id=?"]
        values: list[Any] = [project_id]
        if before is not None:
            clauses.append("created_at<?")
            values.append(before)
        if status:
            clauses.append("status=?")
            values.append(status)
        if model_id:
            clauses.append("model_id=?")
            values.append(model_id)
        if query:
            clauses.append("prompt LIKE ?")
            values.append(f"%{query.strip()}%")
        if favorite:
            clauses.append(
                "EXISTS (SELECT 1 FROM job_outputs jo JOIN assets a ON a.id=jo.asset_id "
                "WHERE jo.job_id=jobs.id AND a.favorite=1 AND a.deleted_at IS NULL)"
            )
        values.append(max(1, min(limit, 100)))
        with self._connect() as db:
            rows = db.execute(
                f"SELECT * FROM jobs WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT ?",  # nosec B608 - hardcoded clauses, bound args
                values,
            ).fetchall()
            return self._assemble_jobs(db, rows)

    def queued_job_ids(self) -> list[str]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT id FROM jobs WHERE status='queued' ORDER BY created_at"
            ).fetchall()
        return [str(row[0]) for row in rows]

    def claim_job(self, job_id: str) -> bool:
        """Atomically transition one queued job to running."""
        now = time.time()
        with self._lock, self._connect() as db:
            cursor = db.execute(
                """UPDATE jobs SET status='running',started_at=?
                   WHERE id=? AND status='queued'""",
                (now, job_id),
            )
        if cursor.rowcount <= 0:
            return False
        self.add_event(job_id, "job.running", {"status": "running"})
        return True

    def update_job(
        self,
        job_id: str,
        status: str,
        *,
        actual: dict[str, Any] | None = None,
        provider_context_id: str | None = None,
        revised_prompt: str | None = None,
        usage: dict[str, Any] | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
        from_statuses: tuple[str, ...] | None = None,
    ) -> bool:
        now = time.time()
        fields = ["status=?"]
        values: list[Any] = [status]
        if status == "running":
            fields.append("started_at=?")
            values.append(now)
        if status in {"succeeded", "partial", "failed", "cancelled", "interrupted"}:
            fields.append("finished_at=?")
            values.append(now)
        if actual is not None:
            fields.append("actual_params=?")
            values.append(json.dumps(actual))
        if provider_context_id is not None:
            fields.append("provider_context_id=?")
            values.append(provider_context_id)
        if revised_prompt is not None:
            fields.append("revised_prompt=?")
            values.append(revised_prompt[:20_000])
        if usage is not None:
            fields.append("usage_json=?")
            values.append(json.dumps(usage))
        if error_code is not None:
            fields.append("error_code=?")
            values.append(error_code)
        if error_message is not None:
            fields.append("error_message=?")
            values.append(error_message[:1000])
        values.append(job_id)
        where = "id=?"
        if from_statuses:
            where += f" AND status IN ({','.join('?' for _ in from_statuses)})"
            values.extend(from_statuses)
        with self._connect() as db:
            cursor = db.execute(f"UPDATE jobs SET {','.join(fields)} WHERE {where}", values)  # nosec B608 - hardcoded columns, bound args
        if cursor.rowcount <= 0:
            return False
        self.add_event(
            job_id,
            f"job.{status}",
            {"status": status, "error_code": error_code, "message": error_message},
        )
        return True

    def add_job_output(self, job_id: str, asset_id: str, position: int) -> None:
        if position < 0 or position >= MAX_JOB_OUTPUTS:
            raise ValueError("Invalid output position")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            count = int(
                db.execute("SELECT COUNT(*) FROM job_outputs WHERE job_id=?", (job_id,)).fetchone()[
                    0
                ]
            )
            if count >= MAX_JOB_OUTPUTS:
                raise ValueError("Image job output limit exceeded")
            db.execute("INSERT INTO job_outputs VALUES (?,?,?)", (job_id, asset_id, position))
        self.add_event(job_id, "job.output", {"asset_id": asset_id, "position": position})

    def add_event(self, job_id: str, event_type: str, payload: dict[str, Any]) -> int:
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT COALESCE(MAX(seq),0)+1 FROM job_events WHERE job_id=?", (job_id,)
            ).fetchone()
            seq = int(row[0])
            db.execute(
                "INSERT INTO job_events VALUES (?,?,?,?,?)",
                (job_id, seq, event_type, json.dumps(payload), time.time()),
            )
        return seq

    def events_after(self, job_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM job_events WHERE job_id=? AND seq>? ORDER BY seq",
                (job_id, after_seq),
            ).fetchall()
        return [{**dict(row), "payload": json.loads(row["payload"])} for row in rows]


_stores: dict[str, ImageStudioStore] = {}
_stores_lock = threading.Lock()


def get_image_studio_store() -> ImageStudioStore:
    root = (get_current_path_service().get_workspace_dir() / "image-studio").resolve()
    key = str(root)
    with _stores_lock:
        if key not in _stores:
            _stores[key] = ImageStudioStore(root)
        store = _stores[key]
    # Store construction also happens in synchronous migrations and tests.  If
    # an event loop is available, make persisted queued jobs live immediately
    # on the first request after a restart.
    try:
        from .engine import resume_queued_jobs

        resume_queued_jobs(store)
    except RuntimeError:
        pass
    return store
