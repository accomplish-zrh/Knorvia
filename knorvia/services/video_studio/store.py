from __future__ import annotations

from contextlib import contextmanager
import json
import logging
import os
from pathlib import Path
import shutil
import sqlite3
import threading
import time
from typing import Any, BinaryIO
from uuid import uuid4

from knorvia.multi_user.paths import get_current_path_service

logger = logging.getLogger(__name__)

# Constants, exception types and pure helpers live in store_base.py
# (leaf module: no knorvia imports, safe for any consumer).
from ._store_jobs import JobsMixin
from ._store_storyboard_board import StoryboardBoardCharactersMixin
from ._store_uploads_assets import UploadsAssetsMixin
from .store_base import (  # noqa: F401
    ACTIVE_STATUSES,
    INPUT_ROLES,
    MAX_ACTIVE_UPLOAD_BYTES,
    MAX_ACTIVE_UPLOADS,
    MAX_AUDIO_BYTES,
    MAX_CHARACTERS,
    MAX_DIRECTOR_DESK_BYTES,
    MAX_IMAGE_BYTES,
    MAX_IMAGE_DIMENSION,
    MAX_IMAGE_PIXELS,
    MAX_INPUT_ASSETS,
    MAX_OUTPUT_BYTES,
    MAX_PENDING_JOBS,
    MAX_PRODUCTION_BYTES,
    MAX_PROJECT_BYTES,
    MAX_PROVIDER_INPUT_BYTES,
    MAX_STORYBOARD_BYTES,
    MAX_STORYBOARD_SHOTS,
    MAX_SUBTITLE_BYTES,
    MAX_VIDEO_BYTES,
    MIME_EXTENSIONS,
    MIME_LIMITS,
    PROJECT_BGM_DEFAULT_FADE,
    PROJECT_BGM_DEFAULT_VOLUME,
    PROJECT_BGM_FADE_RANGE,
    PROJECT_BGM_VOLUME_RANGE,
    RETRYABLE_STATUSES,
    SCHEMA,
    SUBTITLE_MIME_TYPE,
    TERMINAL_STATUSES,
    UPLOAD_CHUNK_BYTES,
    UPLOAD_TTL_SECONDS,
    BoardConflictError,
    StoryboardConflictError,
    VideoStudioQueueFullError,
    VideoStudioRetryConflictError,
    _encode_subtitle_document,
    _kind_for_mime,
    _safe_filename,
    _sha256_file,
    _sniff_mime,
    _validate_image,
)


def _dict_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def _project_dict_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    """Project row without the potentially large director-desk JSON blob.

    The blob is available through the dedicated director-desk endpoints and
    is injected into project ZIP exports explicitly; project lists and
    detail responses must stay lightweight.
    """
    data = _dict_row(row)
    if data is not None:
        data.pop("director_desk_json", None)
        data.pop("production_json", None)
    return data


class VideoStudioStore(
    StoryboardBoardCharactersMixin,
    UploadsAssetsMixin,
    JobsMixin,
):
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.db_path = self.root / "studio.db"
        self.projects_root = self.root / "projects"
        self.uploads_root = self.root / ".uploads"
        self.exports_root = self.root / ".exports"
        self._lock = threading.RLock()
        self.projects_root.mkdir(parents=True, exist_ok=True)
        self.uploads_root.mkdir(parents=True, exist_ok=True)
        self.exports_root.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            # WAL is persistent per database file — set it once here instead
            # of probing the journal on every connection (job polling opens
            # many short-lived reads that would otherwise fight the writers).
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
            asset_columns = {row[1] for row in db.execute("PRAGMA table_info(assets)")}
            if "origin" not in asset_columns:
                db.execute("ALTER TABLE assets ADD COLUMN origin TEXT NOT NULL DEFAULT 'uploaded'")
            input_columns = {row[1] for row in db.execute("PRAGMA table_info(job_inputs)")}
            if "role" not in input_columns:
                # Existing rows backfill to the neutral role; explicit roles
                # arrive only through new submissions.
                db.execute(
                    "ALTER TABLE job_inputs ADD COLUMN role TEXT NOT NULL DEFAULT 'reference'"
                )
            job_columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
            if "board_node_id" not in job_columns:
                db.execute("ALTER TABLE jobs ADD COLUMN board_node_id TEXT")
            # 搂Phase D3: the project-level BGM slot (asset + mix level + fade
            # in/out). Existing rows backfill to the neutral defaults: no BGM
            # asset, the A3 mix level, and a 1 s symmetric fade.
            project_columns = {row[1] for row in db.execute("PRAGMA table_info(projects)")}
            if "bgm_asset_id" not in project_columns:
                db.execute("ALTER TABLE projects ADD COLUMN bgm_asset_id TEXT")
                db.execute("ALTER TABLE projects ADD COLUMN bgm_volume REAL NOT NULL DEFAULT 0.6")
                db.execute("ALTER TABLE projects ADD COLUMN bgm_fade_in REAL NOT NULL DEFAULT 1.0")
                db.execute("ALTER TABLE projects ADD COLUMN bgm_fade_out REAL NOT NULL DEFAULT 1.0")

            if "director_desk_json" not in project_columns:
                db.execute("ALTER TABLE projects ADD COLUMN director_desk_json TEXT")
            if "production_json" not in project_columns:
                db.execute("ALTER TABLE projects ADD COLUMN production_json TEXT")
            # A provider id makes a submitted job resumable. A submission that
            # died before persisting it cannot be safely repeated (it may bill
            # twice), so surface it as interrupted and require explicit retry.
            now = time.time()
            db.execute(
                """UPDATE jobs SET status='interrupted', stage='interrupted',
                   error_code='submission_interrupted',
                   error_message='Submission was interrupted before its provider task id was saved; retry explicitly.',
                   finished_at=? WHERE status IN ('submitting','running') AND provider_task_id IS NULL""",
                (now,),
            )
        self.cleanup_expired_uploads()
        self.cleanup_deleted_files()

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
    def _atomic_copy(source: BinaryIO, target: Path) -> int:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{uuid4().hex}.tmp")
        size = 0
        try:
            with temporary.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return size

    def ensure_default_project(self) -> dict[str, Any]:
        projects = self.list_projects(limit=1)
        return projects[0] if projects else self.create_project("Untitled Project")

    def project_for_session(
        self,
        session_id: str,
        *,
        title: str,
        legacy_title: str | None = None,
    ) -> dict[str, Any]:
        """Return the one durable project assigned to an exact chat session id.

        Mirrors Image Studio: the relation is keyed by the full session id so
        two chat sessions never share a Video Studio project, while an
        unclaimed project titled with the legacy truncated prefix is adopted
        at most once.
        """
        session_id = str(session_id or "").strip()
        if not session_id:
            raise ValueError("A session id is required.")
        safe_title = str(title or "Untitled Project").strip()[:160] or "Untitled Project"
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
                return _project_dict_row(existing) or {}
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
                created_project_id = f"video_project_{uuid4().hex}"
                db.execute(
                    """INSERT INTO projects
                       (id, title, created_at, updated_at, deleted_at)
                       VALUES (?,?,?,?,NULL)""",
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

    def get_session_project(self, session_id: str) -> dict[str, Any] | None:
        """Return the project already bound to this chat session, if any."""
        session_id = str(session_id or "").strip()
        if not session_id:
            return None
        with self._connect() as db:
            row = db.execute(
                """SELECT p.* FROM session_projects sp
                   JOIN projects p ON p.id=sp.project_id
                   WHERE sp.session_id=? AND p.deleted_at IS NULL""",
                (session_id,),
            ).fetchone()
        return _project_dict_row(row)

    def bind_session_project(self, session_id: str, project_id: str) -> dict[str, Any]:
        session_id = str(session_id or "").strip()
        project = self.get_project(project_id)
        if not session_id:
            raise ValueError("A session id is required.")
        if not project:
            raise KeyError(project_id)
        now = time.time()
        with self._lock, self._connect() as db:
            db.execute(
                """INSERT INTO session_projects(session_id,project_id,created_at)
                   VALUES (?,?,?)
                   ON CONFLICT(session_id) DO UPDATE SET
                     project_id=excluded.project_id,
                     created_at=excluded.created_at""",
                (session_id, project_id, now),
            )
        return project

    def get_active_project(self) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT value FROM workspace_prefs WHERE key='active_project_id'"
            ).fetchone()
        if row is None:
            return None
        return self.get_project(str(row["value"] or ""))

    def set_active_project(self, project_id: str) -> dict[str, Any]:
        project = self.get_project(project_id)
        if not project:
            raise KeyError(project_id)
        with self._lock, self._connect() as db:
            db.execute(
                """INSERT INTO workspace_prefs(key,value,updated_at)
                   VALUES ('active_project_id',?,?)
                   ON CONFLICT(key) DO UPDATE SET
                     value=excluded.value, updated_at=excluded.updated_at""",
                (project_id, time.time()),
            )
        return project

    def resolve_workspace_project(
        self,
        session_id: str | None,
        *,
        title: str,
        legacy_title: str | None = None,
    ) -> dict[str, Any]:
        """Bind a new chat/create session to the open Video Studio project.

        An already-mapped session keeps that project. A fresh session adopts
        ``active_project_id`` when the workbench has one; otherwise a durable
        per-session project is created. Calls without a session use the active
        project, then the default.
        """

        if session_id:
            existing = self.get_session_project(session_id)
            if existing:
                return existing
            active = self.get_active_project()
            if active:
                return self.bind_session_project(session_id, active["id"])
            return self.project_for_session(session_id, title=title, legacy_title=legacy_title)
        return self.get_active_project() or self.ensure_default_project()

    def create_project(self, title: str) -> dict[str, Any]:
        project_id = f"video_project_{uuid4().hex}"
        now = time.time()
        safe_title = str(title or "Untitled Project").strip()[:160] or "Untitled Project"
        with self._connect() as db:
            db.execute(
                """INSERT INTO projects
                   (id, title, created_at, updated_at, deleted_at,
                    bgm_asset_id, bgm_volume, bgm_fade_in, bgm_fade_out)
                   VALUES (?,?,?,?,NULL,NULL,?,?,?)""",
                (
                    project_id,
                    safe_title,
                    now,
                    now,
                    PROJECT_BGM_DEFAULT_VOLUME,
                    PROJECT_BGM_DEFAULT_FADE,
                    PROJECT_BGM_DEFAULT_FADE,
                ),
            )
        (self.projects_root / project_id / "assets").mkdir(parents=True, exist_ok=True)
        return self.get_project(project_id) or {}

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM projects WHERE id=? AND deleted_at IS NULL", (project_id,)
            ).fetchone()
        return _project_dict_row(row)

    def list_projects(self, query: str = "", limit: int = 30) -> list[dict[str, Any]]:
        pattern = f"%{str(query or '').strip()}%"
        with self._connect() as db:
            rows = db.execute(
                """SELECT * FROM projects WHERE deleted_at IS NULL AND title LIKE ?
                   ORDER BY updated_at DESC LIMIT ?""",
                (pattern, max(1, min(int(limit), 100))),
            ).fetchall()
        return [_project_dict_row(row) or {} for row in rows]

    def update_project(
        self,
        project_id: str,
        title: str | None = None,
        *,
        bgm_asset_id: str | None = None,
        bgm_volume: float | None = None,
        bgm_fade_in: float | None = None,
        bgm_fade_out: float | None = None,
    ) -> dict[str, Any] | None:
        """Update the title and/or the 搂Phase D3 project-level BGM slot.

        ``None`` leaves a field unchanged (title stays optional so a BGM-only
        PATCH works); an empty ``bgm_asset_id`` clears the slot. A non-empty
        slot must reference one of *this* project's audio assets, so a stale or
        foreign id can never become the composition's music bed.
        """
        updates: dict[str, Any] = {}
        if title is not None:
            safe_title = str(title).strip()[:160]
            if not safe_title:
                raise ValueError("A project title is required")
            updates["title"] = safe_title
        if bgm_asset_id is not None:
            slot = str(bgm_asset_id).strip()
            if slot:
                asset = self.get_asset(slot)
                if not asset or asset["project_id"] != project_id or asset["kind"] != "audio":
                    raise ValueError("The background music must be an audio asset of this project")
            updates["bgm_asset_id"] = slot or None
        for name, value, bounds in (
            ("bgm_volume", bgm_volume, PROJECT_BGM_VOLUME_RANGE),
            ("bgm_fade_in", bgm_fade_in, PROJECT_BGM_FADE_RANGE),
            ("bgm_fade_out", bgm_fade_out, PROJECT_BGM_FADE_RANGE),
        ):
            if value is None:
                continue
            try:
                number = float(value)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Project {name.replace('_', ' ')} is invalid") from exc
            if number != number or not bounds[0] <= number <= bounds[1]:
                raise ValueError(f"Project {name.replace('_', ' ')} is out of range")
            updates[name] = number
        if not updates:
            return self.get_project(project_id)
        assignments = ", ".join(f"{column}=?" for column in updates)
        with self._connect() as db:
            db.execute(
                f"UPDATE projects SET {assignments},updated_at=? WHERE id=? AND deleted_at IS NULL",  # nosec B608 - whitelisted columns, bound args
                (*updates.values(), time.time(), project_id),
            )
        return self.get_project(project_id)

    def get_director_desk(self, project_id: str) -> dict[str, Any]:
        """Return the persisted 3D director-desk project snapshot, if any."""
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._connect() as db:
            row = db.execute(
                "SELECT director_desk_json FROM projects WHERE id=? AND deleted_at IS NULL",
                (project_id,),
            ).fetchone()
        raw = str(row["director_desk_json"] or "") if row else ""
        try:
            document = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            logger.warning("Ignoring corrupt director desk JSON for project %s", project_id)
            document = None
        return {"project_id": project_id, "director_desk": document}

    def clear_director_desk(self, project_id: str) -> bool:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._connect() as db:
            db.execute(
                """UPDATE projects SET director_desk_json=NULL,updated_at=?
                   WHERE id=? AND deleted_at IS NULL""",
                (time.time(), project_id),
            )
        return True

    def save_director_desk(self, project_id: str, document: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(document, dict):
            raise ValueError("Director desk document must be a JSON object")
        encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_DIRECTOR_DESK_BYTES:
            raise ValueError("Director desk project exceeds the size limit")
        now = time.time()
        with self._lock, self._connect() as db:
            exists = db.execute(
                "SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL", (project_id,)
            ).fetchone()
            if exists is None:
                raise KeyError(project_id)
            db.execute(
                """UPDATE projects SET director_desk_json=?,updated_at=?
                   WHERE id=? AND deleted_at IS NULL""",
                (encoded, now, project_id),
            )
        return self.get_director_desk(project_id)

    def get_production(self, project_id: str) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        from knorvia.services.video_studio.production import normalize_production

        with self._connect() as db:
            row = db.execute(
                "SELECT production_json FROM projects WHERE id=? AND deleted_at IS NULL",
                (project_id,),
            ).fetchone()
        raw = str(row["production_json"] or "") if row else ""
        try:
            document = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            logger.warning("Ignoring corrupt production JSON for project %s", project_id)
            document = {}
        return {"project_id": project_id, "production": normalize_production(document)}

    def save_production(self, project_id: str, document: dict[str, Any]) -> dict[str, Any]:
        from knorvia.services.video_studio.production import normalize_production

        production = normalize_production(document)
        encoded = json.dumps(production, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_PRODUCTION_BYTES:
            raise ValueError("Production document exceeds the size limit")
        now = time.time()
        with self._lock, self._connect() as db:
            exists = db.execute(
                "SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL",
                (project_id,),
            ).fetchone()
            if exists is None:
                raise KeyError(project_id)
            db.execute(
                """UPDATE projects SET production_json=?,updated_at=?
                   WHERE id=? AND deleted_at IS NULL""",
                (encoded, now, project_id),
            )
        return self.get_production(project_id)

    def delete_project(self, project_id: str) -> bool:
        now = time.time()
        project_dir = (self.projects_root / project_id).resolve()
        if project_dir.parent != self.projects_root:
            raise ValueError("Unsafe video project path")
        upload_paths: list[Path] = []
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            active = db.execute(
                "SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','submitting','running')",
                (project_id,),
            ).fetchone()
            if active:
                raise ValueError("Cancel active video jobs before deleting this project")
            for row in db.execute(
                "SELECT temp_path FROM uploads WHERE project_id=?", (project_id,)
            ).fetchall():
                upload_path = Path(row["temp_path"]).resolve()
                if upload_path.parent != self.uploads_root:
                    raise ValueError("Unsafe video upload path")
                upload_paths.append(upload_path)
            cursor = db.execute(
                "UPDATE projects SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL",
                (now, now, project_id),
            )
            db.execute(
                "UPDATE assets SET deleted_at=? WHERE project_id=? AND deleted_at IS NULL",
                (now, project_id),
            )
            db.execute("DELETE FROM uploads WHERE project_id=?", (project_id,))
        if cursor.rowcount:
            for upload_path in upload_paths:
                try:
                    upload_path.unlink(missing_ok=True)
                except OSError:
                    logger.info("Deferred cleanup of video upload %s", upload_path)
            if project_dir.exists():
                try:
                    shutil.rmtree(project_dir)
                except OSError:
                    logger.info("Deferred cleanup of video project %s", project_dir)
        return cursor.rowcount > 0


_stores: dict[str, VideoStudioStore] = {}
_stores_lock = threading.Lock()


def get_video_studio_store() -> VideoStudioStore:
    root = (get_current_path_service().get_workspace_dir() / "video-studio").resolve()
    key = str(root)
    with _stores_lock:
        if key not in _stores:
            _stores[key] = VideoStudioStore(root)
        store = _stores[key]
    try:
        from .engine import resume_video_jobs

        resume_video_jobs(store)
    except RuntimeError:
        pass
    return store


__all__ = [
    "ACTIVE_STATUSES",
    "MAX_INPUT_ASSETS",
    "MAX_OUTPUT_BYTES",
    "MAX_PROVIDER_INPUT_BYTES",
    "MIME_LIMITS",
    "PROJECT_BGM_DEFAULT_FADE",
    "PROJECT_BGM_DEFAULT_VOLUME",
    "PROJECT_BGM_FADE_RANGE",
    "PROJECT_BGM_VOLUME_RANGE",
    "RETRYABLE_STATUSES",
    "BoardConflictError",
    "StoryboardConflictError",
    "TERMINAL_STATUSES",
    "UPLOAD_CHUNK_BYTES",
    "VideoStudioQueueFullError",
    "VideoStudioRetryConflictError",
    "VideoStudioStore",
    "get_video_studio_store",
]
