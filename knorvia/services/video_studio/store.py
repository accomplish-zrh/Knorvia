from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import shutil
import sqlite3
import threading
import time
from typing import Any, BinaryIO, Callable, Sequence
from uuid import uuid4
import zipfile

from PIL import Image

from knorvia.multi_user.paths import get_current_path_service

from .board import (
    BOARD_MAX_BYTES,
    attach_job_output,
    empty_board,
    find_board_node,
    mark_node_running,
    normalize_board,
)
from .post_production import (
    normalize_transition,
    parse_optional_seconds,
    parse_voiceover_volume,
    validate_trim_window,
)

logger = logging.getLogger(__name__)

UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
UPLOAD_TTL_SECONDS = 24 * 60 * 60
MAX_ACTIVE_UPLOADS = 20
MAX_ACTIVE_UPLOAD_BYTES = 512 * 1024 * 1024
MAX_PROJECT_BYTES = 1024 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_VIDEO_BYTES = 256 * 1024 * 1024
MAX_AUDIO_BYTES = 64 * 1024 * 1024
MAX_SUBTITLE_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_BYTES = 512 * 1024 * 1024
MAX_PROVIDER_INPUT_BYTES = 64 * 1024 * 1024
MAX_IMAGE_DIMENSION = 16_384
MAX_IMAGE_PIXELS = 64 * 1024 * 1024
MAX_PENDING_JOBS = 30
MAX_INPUT_ASSETS = 50
MAX_STORYBOARD_BYTES = 1024 * 1024
MAX_STORYBOARD_SHOTS = 200
MAX_DIRECTOR_DESK_BYTES = 2 * 1024 * 1024
MAX_PRODUCTION_BYTES = 1024 * 1024
MAX_CHARACTERS = 50

# 搂Phase D3 project-level BGM slot bounds (mix level + fade in/out seconds).
PROJECT_BGM_VOLUME_RANGE = (0.0, 2.0)
PROJECT_BGM_FADE_RANGE = (0.0, 10.0)
PROJECT_BGM_DEFAULT_VOLUME = 0.6
PROJECT_BGM_DEFAULT_FADE = 1.0

MIME_LIMITS = {
    "image/png": MAX_IMAGE_BYTES,
    "image/jpeg": MAX_IMAGE_BYTES,
    "image/webp": MAX_IMAGE_BYTES,
    "video/mp4": MAX_VIDEO_BYTES,
    "video/webm": MAX_VIDEO_BYTES,
    "audio/mpeg": MAX_AUDIO_BYTES,
    "audio/wav": MAX_AUDIO_BYTES,
    "audio/mp4": MAX_AUDIO_BYTES,
    # Phase D2 subtitle assets (SRT documents edited in / saved by the
    # subtitle editor, plus the SRT produced by from_asr compositions).
    "application/x-subrip": MAX_SUBTITLE_BYTES,
}

MIME_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "application/x-subrip": ".srt",
}

# Asset kinds that do not follow the ``<kind>/<...>`` MIME prefix convention.
SUBTITLE_MIME_TYPE = "application/x-subrip"

TERMINAL_STATUSES = frozenset({"succeeded", "failed", "cancelled", "interrupted"})
ACTIVE_STATUSES = frozenset({"queued", "submitting", "running"})
RETRYABLE_STATUSES = frozenset({"failed", "cancelled", "interrupted"})
INPUT_ROLES = frozenset({"reference", "first-frame", "last-frame", "audio", "continue-from"})

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at REAL NOT NULL,
  updated_at REAL NOT NULL, deleted_at REAL,
  bgm_asset_id TEXT,
  bgm_volume REAL NOT NULL DEFAULT 0.6,
  bgm_fade_in REAL NOT NULL DEFAULT 1.0,
  bgm_fade_out REAL NOT NULL DEFAULT 1.0,
  director_desk_json TEXT,
  production_json TEXT
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'uploaded',
  mime_type TEXT NOT NULL, filename TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL, relative_path TEXT NOT NULL, width INTEGER,
  height INTEGER, duration REAL, created_at REAL NOT NULL, deleted_at REAL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, filename TEXT NOT NULL,
  mime_type TEXT NOT NULL, expected_size INTEGER NOT NULL,
  expected_sha256 TEXT NOT NULL, temp_path TEXT NOT NULL, created_at REAL NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id TEXT NOT NULL, part_index INTEGER NOT NULL, size_bytes INTEGER NOT NULL,
  PRIMARY KEY(upload_id, part_index),
  FOREIGN KEY(upload_id) REFERENCES uploads(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, retry_of_job_id TEXT,
  storyboard_shot_id TEXT,
  board_node_id TEXT,
  client_request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  operation TEXT NOT NULL, status TEXT NOT NULL, profile_id TEXT NOT NULL,
  model_id TEXT NOT NULL, prompt TEXT NOT NULL, parameters_json TEXT NOT NULL,
  owner_user_id TEXT NOT NULL, config_revision TEXT NOT NULL,
  provider_task_id TEXT, progress REAL NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'queued', error_code TEXT, error_message TEXT,
  created_at REAL NOT NULL, started_at REAL, finished_at REAL,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  UNIQUE(owner_user_id, client_request_id)
);
CREATE TABLE IF NOT EXISTS job_inputs (
  job_id TEXT NOT NULL, asset_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY(job_id, position), FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(asset_id) REFERENCES assets(id)
);
CREATE TABLE IF NOT EXISTS job_outputs (
  job_id TEXT NOT NULL, asset_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY(job_id, position), FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(asset_id) REFERENCES assets(id)
);
CREATE TABLE IF NOT EXISTS job_events (
  job_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at REAL NOT NULL,
  PRIMARY KEY(job_id, seq), FOREIGN KEY(job_id) REFERENCES jobs(id)
);
CREATE TABLE IF NOT EXISTS storyboards (
  project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
  document_json TEXT NOT NULL, updated_at REAL NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS session_projects (
  session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at REAL NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reference_asset_ids TEXT NOT NULL DEFAULT '[]',
  three_view_asset_id TEXT, voice_hint TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL, updated_at REAL NOT NULL, deleted_at REAL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_video_projects_updated ON projects(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_assets_project ON assets(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_jobs_project ON jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON jobs(status, created_at);
CREATE TABLE IF NOT EXISTS workspace_prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_characters_project ON characters(project_id, created_at);
"""


class VideoStudioQueueFullError(RuntimeError):
    pass


class VideoStudioRetryConflictError(ValueError):
    """Raised when a paid retry targets a job that is not safely retryable."""


class StoryboardConflictError(ValueError):
    def __init__(self, expected_revision: int, current_revision: int):
        self.expected_revision = expected_revision
        self.current_revision = current_revision
        super().__init__(
            f"Storyboard changed (expected revision {expected_revision}, current {current_revision})"
        )


class BoardConflictError(ValueError):
    """CAS mismatch on the canvas document (board.json)."""

    def __init__(self, expected_revision: int | None, current_revision: int):
        self.expected_revision = expected_revision
        self.current_revision = current_revision
        super().__init__(
            f"The board changed since it was loaded (expected revision {expected_revision}, "
            f"current {current_revision})"
        )


def _safe_filename(value: str, mime_type: str) -> str:
    name = Path(str(value or "").replace("\x00", "")).name.strip()[:180]
    if not name:
        name = f"asset{MIME_EXTENSIONS.get(mime_type, '.bin')}"
    return name


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _sniff_mime(header: bytes) -> str:
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    if len(header) >= 12 and header[4:8] == b"ftyp":
        brands = header[8:32].lower()
        if any(mark in brands for mark in (b"m4a", b"m4b", b"m4p")):
            return "audio/mp4"
        return "video/mp4"
    if header.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WAVE":
        return "audio/wav"
    if header.startswith(b"ID3") or (
        len(header) >= 2 and header[0] == 0xFF and header[1] & 0xE0 == 0xE0
    ):
        return "audio/mpeg"
    # Phase D2 subtitle assets: plain-text SRT documents. Nothing binary
    # matched above, so a timing line in the head is a strong SRT signal
    # (BOM-prefixed files included 鈥?the marker survives in the text bytes).
    if b" --> " in header:
        return SUBTITLE_MIME_TYPE
    raise ValueError("Unsupported or invalid media file")


def _kind_for_mime(mime_type: str) -> str:
    """Asset kind for a sniffed MIME type (subtitle documents are their own kind)."""
    if mime_type == SUBTITLE_MIME_TYPE:
        return "subtitle"
    return mime_type.split("/", 1)[0]


def _encode_subtitle_document(content: str) -> bytes:
    """Validate an SRT document and return its UTF-8 bytes.

    The same sniff the upload path uses guards here: the document must have a
    real ``--> `` timing line near the top and stay inside the subtitle byte
    limit, so garbage strings never become burnable subtitle assets.
    """
    data = str(content or "").encode("utf-8")
    if not data or len(data) > MAX_SUBTITLE_BYTES:
        raise ValueError("Subtitle document is empty or exceeds the size limit")
    try:
        sniffed = _sniff_mime(data[:4096])
    except ValueError:
        sniffed = ""
    if sniffed != SUBTITLE_MIME_TYPE:
        raise ValueError("Subtitle document is not a valid SRT file")
    return data


def _validate_image(path: Path, expected_mime: str) -> tuple[int | None, int | None]:
    formats = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
    try:
        with Image.open(path) as image:
            width, height = image.size
            actual = formats.get(str(image.format or "").upper(), "")
            if actual != expected_mime:
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
        with Image.open(path) as decoded:
            decoded.load()
    except ValueError:
        raise
    except (OSError, SyntaxError, Image.DecompressionBombError) as exc:
        raise ValueError("Image data is invalid or truncated") from exc
    return int(width), int(height)


class VideoStudioStore:
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
    def _dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row is not None else None

    @staticmethod
    def _project_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
        """Project row without the potentially large director-desk JSON blob.

        The blob is available through the dedicated director-desk endpoints and
        is injected into project ZIP exports explicitly; project lists and
        detail responses must stay lightweight.
        """
        data = VideoStudioStore._dict(row)
        if data is not None:
            data.pop("director_desk_json", None)
            data.pop("production_json", None)
        return data

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
                return self._project_dict(existing) or {}
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
        return self._project_dict(row)

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
        return self._project_dict(row)

    def list_projects(self, query: str = "", limit: int = 30) -> list[dict[str, Any]]:
        pattern = f"%{str(query or '').strip()}%"
        with self._connect() as db:
            rows = db.execute(
                """SELECT * FROM projects WHERE deleted_at IS NULL AND title LIKE ?
                   ORDER BY updated_at DESC LIMIT ?""",
                (pattern, max(1, min(int(limit), 100))),
            ).fetchall()
        return [self._project_dict(row) or {} for row in rows]

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

    def get_storyboard(self, project_id: str) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._connect() as db:
            row = db.execute(
                "SELECT revision,document_json,updated_at FROM storyboards WHERE project_id=?",
                (project_id,),
            ).fetchone()
        if not row:
            return {"version": 1, "revision": 0, "shots": [], "updated_at": None}
        document = json.loads(row["document_json"] or "{}")
        return {
            "version": 1,
            "revision": int(row["revision"]),
            "shots": list(document.get("shots") or []),
            "updated_at": row["updated_at"],
        }

    def _validate_storyboard(
        self, project_id: str, payload: dict[str, Any]
    ) -> list[dict[str, Any]]:
        shots = payload.get("shots")
        if not isinstance(shots, list) or len(shots) > MAX_STORYBOARD_SHOTS:
            raise ValueError("Storyboard has too many shots")
        normalized: list[dict[str, Any]] = []
        seen: set[str] = set()
        allowed = {
            "id",
            "order",
            "title",
            "prompt",
            "input_asset_ids",
            "job_id",
            "output_asset_id",
            "duration",
            "notes",
            "transition",
            "operation",
            "camera",
            "director_camera_id",
            "director_camera_json",
            "keyframe_asset_id",
            "keyframe_prompt",
            "voiceover_text",
            "voiceover_asset_id",
            "voiceover_voice",
            "voiceover_volume",
            "trim_in",
            "trim_out",
            "character_ids",
        }
        for position, raw in enumerate(shots):
            if not isinstance(raw, dict):
                raise ValueError("Storyboard shots must be objects")
            unknown = set(raw) - allowed
            if unknown:
                raise ValueError(f"Unsupported storyboard field: {sorted(unknown)[0]}")
            shot_id = str(raw.get("id") or "").strip()
            if not shot_id or len(shot_id) > 128 or shot_id in seen:
                raise ValueError("Storyboard shot ids must be unique")
            seen.add(shot_id)
            raw_input_ids = raw.get("input_asset_ids") or []
            if not isinstance(raw_input_ids, list) or len(raw_input_ids) > MAX_INPUT_ASSETS:
                raise ValueError("Storyboard has too many input assets")
            input_ids = list(dict.fromkeys(str(item) for item in raw_input_ids))
            if any(not item or len(item) > 160 for item in input_ids):
                raise ValueError("Storyboard contains an invalid asset id")
            for asset_id in [
                *input_ids,
                str(raw.get("output_asset_id") or ""),
                str(raw.get("keyframe_asset_id") or ""),
                str(raw.get("voiceover_asset_id") or ""),
            ]:
                if not asset_id:
                    continue
                asset = self.get_asset(asset_id)
                if not asset or asset["project_id"] != project_id:
                    raise ValueError("Storyboard assets must belong to the video project")
            job_id = str(raw.get("job_id") or "")
            if job_id:
                job = self.get_job(job_id)
                if not job or job["project_id"] != project_id:
                    raise ValueError("Storyboard jobs must belong to the video project")
            duration = raw.get("duration")
            if duration not in {None, ""}:
                try:
                    duration = float(duration)
                except (TypeError, ValueError) as exc:
                    raise ValueError("Storyboard duration must be numeric") from exc
                if not math.isfinite(duration) or duration <= 0 or duration > 3600:
                    raise ValueError("Storyboard duration is out of range")
            else:
                duration = None
            try:
                trim_in = parse_optional_seconds(raw.get("trim_in"), field="trim_in")
                trim_out = parse_optional_seconds(raw.get("trim_out"), field="trim_out")
                validate_trim_window(trim_in, trim_out, duration)
                voiceover_volume = parse_voiceover_volume(raw.get("voiceover_volume"))
            except ValueError as exc:
                raise ValueError(str(exc)) from exc
            keyframe_asset_id = str(raw.get("keyframe_asset_id") or "") or None
            if keyframe_asset_id and self.get_asset(keyframe_asset_id)["kind"] != "image":
                raise ValueError("A storyboard keyframe must be an image asset")
            voiceover_asset_id = str(raw.get("voiceover_asset_id") or "") or None
            if voiceover_asset_id and self.get_asset(voiceover_asset_id)["kind"] != "audio":
                raise ValueError("A storyboard voiceover must be an audio asset")
            raw_character_ids = raw.get("character_ids") or []
            if not isinstance(raw_character_ids, list) or len(raw_character_ids) > 10:
                raise ValueError("Storyboard character_ids must be a list of at most 10 ids")
            character_ids = list(
                dict.fromkeys(
                    str(item or "").strip() for item in raw_character_ids if str(item or "").strip()
                )
            )
            for character_id in character_ids:
                if len(character_id) > 160:
                    raise ValueError("Storyboard contains an invalid character id")
                if self.get_character(project_id, character_id) is None:
                    raise ValueError("Storyboard characters must belong to the video project")
            director_camera_id = str(raw.get("director_camera_id") or "").strip()[:128] or None
            director_camera_json = raw.get("director_camera_json")
            if director_camera_json is not None and not isinstance(director_camera_json, dict):
                raise ValueError("Storyboard director_camera_json must be an object")
            normalized_shot = {
                "id": shot_id,
                "order": int(raw.get("order", position)),
                "title": str(raw.get("title") or "")[:160],
                "prompt": str(raw.get("prompt") or "")[:20_000],
                "input_asset_ids": input_ids,
                "job_id": job_id or None,
                "output_asset_id": str(raw.get("output_asset_id") or "") or None,
                "duration": duration,
                "notes": str(raw.get("notes") or "")[:10_000],
                "transition": normalize_transition(raw.get("transition")),
                "keyframe_asset_id": keyframe_asset_id,
                "keyframe_prompt": str(raw.get("keyframe_prompt") or "")[:20_000],
                "voiceover_text": str(raw.get("voiceover_text") or "")[:20_000],
                "voiceover_asset_id": voiceover_asset_id,
                "voiceover_voice": str(raw.get("voiceover_voice") or "")[:160],
                "character_ids": character_ids,
            }
            if trim_in is not None:
                normalized_shot["trim_in"] = trim_in
            if trim_out is not None:
                normalized_shot["trim_out"] = trim_out
            if voiceover_volume is not None:
                normalized_shot["voiceover_volume"] = voiceover_volume
            # Board 鈫?strip exports keep the node's operation so the shot can
            # regenerate with the same pipeline; older shots stay without it.
            operation = str(raw.get("operation") or "").strip()[:64]
            if operation:
                normalized_shot["operation"] = operation
            # C4 camera control: free-form short motion label from
            # plan_episode / board exports ("push", "pan-left", ...).
            camera = str(raw.get("camera") or "").strip()[:64]
            if camera:
                normalized_shot["camera"] = camera
            if director_camera_id:
                normalized_shot["director_camera_id"] = director_camera_id
            if director_camera_json is not None:
                normalized_shot["director_camera_json"] = director_camera_json
            normalized.append(normalized_shot)
        encoded = json.dumps({"shots": normalized}, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_STORYBOARD_BYTES:
            raise ValueError("Storyboard exceeds the size limit")
        return normalized

    def save_storyboard(
        self, project_id: str, payload: dict[str, Any], *, expected_revision: int
    ) -> dict[str, Any]:
        # Validation reads jobs/assets. Hold the same RLock used by deletion
        # until the CAS write commits so a validated reference cannot vanish.
        with self._lock:
            shots = self._validate_storyboard(project_id, payload)
            document = json.dumps({"shots": shots}, ensure_ascii=False, separators=(",", ":"))
            now = time.time()
            with self._connect() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute(
                    "SELECT revision FROM storyboards WHERE project_id=?", (project_id,)
                ).fetchone()
                current = int(row[0]) if row else 0
                if current != expected_revision:
                    raise StoryboardConflictError(expected_revision, current)
                revision = current + 1
                db.execute(
                    """INSERT INTO storyboards VALUES (?,?,?,?)
                       ON CONFLICT(project_id) DO UPDATE SET
                         revision=excluded.revision,document_json=excluded.document_json,
                         updated_at=excluded.updated_at""",
                    (project_id, revision, document, now),
                )
                db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now, project_id))
        return {"version": 1, "revision": revision, "shots": shots, "updated_at": now}

    def patch_storyboard_job_output(self, project_id: str, job_id: str, asset_id: str) -> bool:
        for _ in range(5):
            board = self.get_storyboard(project_id)
            changed = False
            shots = []
            for shot in board["shots"]:
                item = dict(shot)
                if item.get("job_id") == job_id and item.get("output_asset_id") != asset_id:
                    item["output_asset_id"] = asset_id
                    changed = True
                shots.append(item)
            if not changed:
                return False
            try:
                self.save_storyboard(
                    project_id, {"shots": shots}, expected_revision=int(board["revision"])
                )
                return True
            except StoryboardConflictError:
                continue
        return False

    def patch_storyboard_shot_job(self, project_id: str, shot_id: str, job_id: str) -> bool:
        for _ in range(5):
            board = self.get_storyboard(project_id)
            found = False
            changed = False
            shots = []
            for shot in board["shots"]:
                item = dict(shot)
                if item.get("id") == shot_id:
                    found = True
                    if item.get("job_id") != job_id:
                        item["job_id"] = job_id
                        item["output_asset_id"] = None
                        changed = True
                shots.append(item)
            if not found:
                raise ValueError("Storyboard shot not found")
            if not changed:
                return False
            try:
                self.save_storyboard(
                    project_id, {"shots": shots}, expected_revision=int(board["revision"])
                )
                return True
            except StoryboardConflictError:
                continue
        raise StoryboardConflictError(-1, int(self.get_storyboard(project_id)["revision"]))

    def update_storyboard(
        self, project_id: str, mutator: Callable[[dict[str, Any]], Any]
    ) -> dict[str, Any]:
        """Atomically patch the newest storyboard 鈥?the strip twin of update_board.

        The mutator receives the current document (``version``/``revision``/
        ``shots``) and mutates the shots list in place. Validation and the CAS
        write then run via save_storyboard under the same re-entrant lock, so
        a concurrent strip edit can never be silently overwritten by an
        append (e.g. board 鈫?strip export) or vice versa.
        """
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._lock:
            current = self.get_storyboard(project_id)
            mutator(current)
            return self.save_storyboard(
                project_id,
                {"shots": current["shots"]},
                expected_revision=int(current["revision"]),
            )

    # 鈹€鈹€ Character library (cross-shot identity consistency) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    @staticmethod
    def _character_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        data = VideoStudioStore._dict(row)
        if data is None:
            return None
        try:
            ids = json.loads(data.get("reference_asset_ids") or "[]")
        except (TypeError, ValueError):
            ids = []
        data["reference_asset_ids"] = (
            [str(item) for item in ids if str(item or "").strip()] if isinstance(ids, list) else []
        )
        return data

    def list_characters(self, project_id: str) -> list[dict[str, Any]]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._connect() as db:
            rows = db.execute(
                """SELECT * FROM characters WHERE project_id=? AND deleted_at IS NULL
                   ORDER BY created_at""",
                (project_id,),
            ).fetchall()
        characters: list[dict[str, Any]] = []
        for row in rows:
            data = self._character_row(row)
            if data is not None:
                characters.append(data)
        return characters

    def get_character(self, project_id: str, character_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT * FROM characters WHERE id=? AND project_id=? AND deleted_at IS NULL""",
                (character_id, project_id),
            ).fetchone()
        return self._character_row(row)

    def create_character(
        self,
        project_id: str,
        *,
        name: str,
        description: str = "",
        reference_asset_ids: list[str] | None = None,
        voice_hint: str = "",
    ) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        safe_name = str(name or "").strip()[:160]
        if not safe_name:
            raise ValueError("A character name is required")
        ids = self._validate_character_assets(project_id, reference_asset_ids or [])
        character_id = f"character_{uuid4().hex}"
        now = time.time()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            count = db.execute(
                "SELECT COUNT(*) FROM characters WHERE project_id=? AND deleted_at IS NULL",
                (project_id,),
            ).fetchone()[0]
            if count >= MAX_CHARACTERS:
                raise ValueError("This project already has the maximum number of characters")
            db.execute(
                """INSERT INTO characters
                   (id, project_id, name, description, reference_asset_ids,
                    three_view_asset_id, voice_hint, created_at, updated_at, deleted_at)
                   VALUES (?,?,?,?,?,NULL,?,?,?,NULL)""",
                (
                    character_id,
                    project_id,
                    safe_name,
                    str(description or "").strip()[:4000],
                    json.dumps(ids),
                    str(voice_hint or "").strip()[:160],
                    now,
                    now,
                ),
            )
        return self.get_character(project_id, character_id) or {}

    def update_character(
        self,
        project_id: str,
        character_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        reference_asset_ids: list[str] | None = None,
        voice_hint: str | None = None,
    ) -> dict[str, Any] | None:
        current = self.get_character(project_id, character_id)
        if current is None:
            return None
        updates: dict[str, Any] = {"updated_at": time.time()}
        if name is not None:
            safe_name = str(name).strip()[:160]
            if not safe_name:
                raise ValueError("A character name is required")
            updates["name"] = safe_name
        if description is not None:
            updates["description"] = str(description).strip()[:4000]
        if reference_asset_ids is not None:
            updates["reference_asset_ids"] = json.dumps(
                self._validate_character_assets(project_id, reference_asset_ids)
            )
        if voice_hint is not None:
            updates["voice_hint"] = str(voice_hint).strip()[:160]
        assignments = ", ".join(f"{column}=?" for column in updates)
        with self._connect() as db:
            db.execute(
                f"UPDATE characters SET {assignments} WHERE id=? AND project_id=? AND deleted_at IS NULL",  # nosec B608 - whitelisted columns, bound args
                (*updates.values(), character_id, project_id),
            )
        return self.get_character(project_id, character_id)

    def delete_character(self, project_id: str, character_id: str) -> bool:
        with self._connect() as db:
            cursor = db.execute(
                """UPDATE characters SET deleted_at=?
                   WHERE id=? AND project_id=? AND deleted_at IS NULL""",
                (time.time(), character_id, project_id),
            )
        return cursor.rowcount > 0

    def set_character_three_view(
        self, project_id: str, character_id: str, asset_id: str
    ) -> dict[str, Any] | None:
        with self._connect() as db:
            cursor = db.execute(
                """UPDATE characters SET three_view_asset_id=?, updated_at=?
                   WHERE id=? AND project_id=? AND deleted_at IS NULL""",
                (asset_id, time.time(), character_id, project_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get_character(project_id, character_id)

    def _validate_character_assets(self, project_id: str, asset_ids: list[str]) -> list[str]:
        seen: list[str] = []
        for raw in asset_ids:
            asset_id = str(raw or "").strip()
            if not asset_id or asset_id in seen:
                continue
            asset = self.get_asset(asset_id)
            if asset is None or asset.get("project_id") != project_id:
                raise ValueError(f"Unknown character reference asset: {asset_id}")
            if asset.get("kind") != "image":
                raise ValueError("Character references must be image assets")
            seen.append(asset_id)
            if len(seen) >= MAX_INPUT_ASSETS:
                break
        return seen

    # 鈹€鈹€ Canvas board (projects/{id}/board.json + CAS revision) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    def board_path(self, project_id: str) -> Path:
        return self.projects_root / project_id / "board.json"

    def get_board(self, project_id: str) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._lock:
            return self._read_board_file(project_id)

    def _read_board_file(self, project_id: str) -> dict[str, Any]:
        path = self.board_path(project_id)
        if not path.exists():
            return empty_board()
        for candidate in (path, path.with_suffix(".json.bak")):
            if not candidate.exists():
                continue
            try:
                return normalize_board(json.loads(candidate.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        raise ValueError("The board document is corrupt.")

    def _atomic_board_write(self, path: Path, encoded: str) -> None:
        if path.exists():
            try:
                json.loads(path.read_text(encoding="utf-8"))
                shutil.copyfile(path, path.with_suffix(".json.bak"))
            except (OSError, json.JSONDecodeError):
                pass
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _write_board_locked(
        self, project_id: str, document: dict[str, Any], *, current_revision: int
    ) -> dict[str, Any]:
        cleaned = normalize_board(document)
        cleaned["revision"] = current_revision + 1
        encoded = json.dumps(cleaned, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > BOARD_MAX_BYTES:
            raise ValueError("Board document is too large")
        self._atomic_board_write(self.board_path(project_id), encoded)
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
                # First write on an empty board needs no optimistic lock.
                expected_revision = 0
            if expected_revision != current_revision:
                raise BoardConflictError(expected_revision, current_revision)
            return self._write_board_locked(project_id, document, current_revision=current_revision)

    def update_board(
        self, project_id: str, mutator: Callable[[dict[str, Any]], Any]
    ) -> dict[str, Any]:
        """Atomically patch the newest board without replacing unrelated edits."""
        if not self.get_project(project_id):
            raise KeyError(project_id)
        with self._lock:
            current = self._read_board_file(project_id)
            revision = int(current.get("revision") or 0)
            mutator(current)
            return self._write_board_locked(project_id, current, current_revision=revision)

    def patch_board_node_job(self, project_id: str, node_id: str, job_id: str) -> bool:
        """Point a generate node at its job and mark it running (conflict-safe)."""
        for _ in range(5):
            board = self.get_board(project_id)
            node = find_board_node(board, node_id)
            if not node:
                raise ValueError("Board node not found")
            if node.get("kind") != "generate":
                raise ValueError("Only a generate node can receive a video job")
            if node.get("jobId") == job_id and node.get("status") == "running":
                return False

            def mutator(document: dict[str, Any]) -> None:
                mark_node_running(document, node_id, job_id=job_id)

            try:
                self.update_board(project_id, mutator)
                return True
            except BoardConflictError:
                continue
        raise BoardConflictError(-1, int(self.get_board(project_id)["revision"]))

    def patch_board_job_output(
        self,
        project_id: str,
        job_id: str,
        *,
        status: str,
        asset_id: str | None = None,
        duration: float | None = None,
    ) -> bool:
        """Bind a finished job's output back onto its generate node."""
        for _ in range(5):
            board = self.get_board(project_id)
            if not any(node.get("jobId") == job_id for node in board.get("nodes") or []):
                return False
            changed = False

            def mutator(document: dict[str, Any]) -> None:
                nonlocal changed
                changed = (
                    attach_job_output(
                        document,
                        job_id=job_id,
                        status=status,
                        asset_id=asset_id,
                        duration=duration,
                    )
                    or changed
                )

            try:
                self.update_board(project_id, mutator)
                return changed
            except BoardConflictError:
                continue
        return False

    def export_project(self, project_id: str) -> Path:
        # Keep the project metadata and owned media stable until the archive is
        # complete. Asset/project deletion takes the same re-entrant lock, so an
        # export can never observe a half-deleted snapshot.
        with self._lock:
            project = self.get_project(project_id)
            if not project:
                raise KeyError(project_id)
            with self._connect() as db:
                assets = [
                    dict(row)
                    for row in db.execute(
                        """SELECT * FROM assets WHERE project_id=? AND deleted_at IS NULL
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
            if len(assets) > 10_000:
                raise ValueError("Video project has too many assets to export")
            total = sum(int(asset["size_bytes"]) for asset in assets)
            if total > MAX_PROJECT_BYTES:
                raise ValueError("Video project export exceeds the size limit")
            if len(job_ids) > 10_000:
                raise ValueError("Video project has too many jobs to export")
            # Bulk-load every job with its relations in one pass instead of
            # reopening the store once per job (10k jobs meant 10k+ connects).
            with self._connect() as db:
                placeholders = ",".join("?" * len(job_ids))
                rows = db.execute(
                    f"SELECT * FROM jobs WHERE id IN ({placeholders})",  # nosec B608 - placeholder string only
                    job_ids,
                ).fetchall()
                shaped = self._assemble_jobs(db, rows)
            by_id = {str(job["id"]): job for job in shaped}
            jobs = [by_id[job_id] for job_id in job_ids if job_id in by_id]
            manifest = {
                "version": 1,
                "project": project,
                "director_desk": self.get_director_desk(project_id)["director_desk"],
                "storyboard": self.get_storyboard(project_id),
                "board": self._read_board_file(project_id),
                "jobs": jobs,
                "assets": [
                    {key: value for key, value in asset.items() if key != "relative_path"}
                    for asset in assets
                ],
            }
            # Keep response files outside the project tree so a delete request
            # arriving after this snapshot is built cannot remove a FileResponse
            # before Starlette opens it. The response background task unlinks it.
            export_root = self.exports_root
            # A unique target prevents a second export from replacing the file
            # between FileResponse construction and the first response read.
            target = export_root / f"{project_id}-{uuid4().hex}.zip"
            temporary = export_root / f".{uuid4().hex}.tmp"
            try:
                with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    archive.writestr(
                        "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2)
                    )
                    for asset in assets:
                        source = self.asset_path(asset["id"])
                        archive.write(source, f"assets/{source.name}")
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
            return target

    def cleanup_expired_uploads(self) -> int:
        cutoff = time.time() - UPLOAD_TTL_SECONDS
        with self._lock, self._connect() as db:
            rows = db.execute(
                "SELECT id,temp_path FROM uploads WHERE created_at<?", (cutoff,)
            ).fetchall()
            for row in rows:
                db.execute("DELETE FROM uploads WHERE id=?", (row["id"],))
        for row in rows:
            path = Path(row["temp_path"]).resolve()
            if path.parent == self.uploads_root:
                path.unlink(missing_ok=True)
        return len(rows)

    def create_upload(
        self, project_id: str, filename: str, mime_type: str, size: int, sha256: str
    ) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        if mime_type not in MIME_LIMITS:
            raise ValueError("Unsupported media type")
        if size <= 0 or size > MIME_LIMITS[mime_type]:
            raise ValueError("Upload exceeds the limit for this media type")
        digest = str(sha256 or "").lower()
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError("A valid SHA-256 checksum is required")
        self.cleanup_expired_uploads()
        self.cleanup_deleted_files()
        upload_id = f"video_upload_{uuid4().hex}"
        target = (self.uploads_root / f"{upload_id}.part").resolve()
        now = time.time()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            count, active_bytes = db.execute(
                "SELECT COUNT(*),COALESCE(SUM(expected_size),0) FROM uploads"
            ).fetchone()
            stored = int(
                db.execute(
                    "SELECT COALESCE(SUM(size_bytes),0) FROM assets WHERE project_id=? AND deleted_at IS NULL",
                    (project_id,),
                ).fetchone()[0]
            )
            if (
                int(count) >= MAX_ACTIVE_UPLOADS
                or int(active_bytes) + size > MAX_ACTIVE_UPLOAD_BYTES
            ):
                raise ValueError("Too many active video uploads")
            if stored + size > MAX_PROJECT_BYTES:
                raise ValueError("Video project storage quota exceeded")
            with target.open("xb") as handle:
                handle.truncate(size)
            db.execute(
                "INSERT INTO uploads VALUES (?,?,?,?,?,?,?,?)",
                (
                    upload_id,
                    project_id,
                    _safe_filename(filename, mime_type),
                    mime_type,
                    size,
                    digest,
                    str(target),
                    now,
                ),
            )
        return {
            "id": upload_id,
            "part_size": UPLOAD_CHUNK_BYTES,
            "expires_at": now + UPLOAD_TTL_SECONDS,
        }

    def upload_record(self, upload_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            return self._dict(
                db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
            )

    def abort_upload(self, upload_id: str) -> bool:
        """Release an incomplete upload and its reserved quota immediately."""

        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT temp_path FROM uploads WHERE id=?", (upload_id,)).fetchone()
            if row is None:
                return False
            db.execute("DELETE FROM uploads WHERE id=?", (upload_id,))
        path = Path(row["temp_path"]).resolve()
        if path.parent == self.uploads_root:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                # The DB row is already gone, so an OS-level file lock must not
                # turn an idempotent abort into an API failure. Startup GC will
                # retry removal of orphaned .part files.
                logger.warning("Could not remove aborted video upload %s", path)
        return True

    def write_upload_part(self, upload_id: str, index: int, data: bytes) -> None:
        with self._lock:
            record = self.upload_record(upload_id)
            if not record or float(record["created_at"]) < time.time() - UPLOAD_TTL_SECONDS:
                raise KeyError(upload_id)
            size = int(record["expected_size"])
            count = (size + UPLOAD_CHUNK_BYTES - 1) // UPLOAD_CHUNK_BYTES
            if index < 0 or index >= count:
                raise ValueError("Invalid upload chunk index")
            expected = min(UPLOAD_CHUNK_BYTES, size - index * UPLOAD_CHUNK_BYTES)
            if len(data) != expected:
                raise ValueError("Upload chunk size does not match")
            target = Path(record["temp_path"]).resolve()
            if target.parent != self.uploads_root:
                raise ValueError("Unsafe upload path")
            with target.open("r+b") as handle:
                handle.seek(index * UPLOAD_CHUNK_BYTES)
                handle.write(data)
                handle.flush()
            with self._connect() as db:
                db.execute(
                    """INSERT INTO upload_parts VALUES (?,?,?)
                       ON CONFLICT(upload_id,part_index) DO UPDATE SET size_bytes=excluded.size_bytes""",
                    (upload_id, index, len(data)),
                )

    def complete_upload(self, upload_id: str) -> dict[str, Any]:
        with self._lock:
            record = self.upload_record(upload_id)
            if not record:
                raise KeyError(upload_id)
            size = int(record["expected_size"])
            expected_parts = (size + UPLOAD_CHUNK_BYTES - 1) // UPLOAD_CHUNK_BYTES
            with self._connect() as db:
                parts = db.execute(
                    "SELECT part_index FROM upload_parts WHERE upload_id=? ORDER BY part_index",
                    (upload_id,),
                ).fetchall()
            if [int(row[0]) for row in parts] != list(range(expected_parts)):
                raise ValueError("Upload is incomplete")
            source = Path(record["temp_path"]).resolve()
            if source.parent != self.uploads_root or source.stat().st_size != size:
                raise ValueError("Upload size does not match")
            if _sha256_file(source) != record["expected_sha256"]:
                raise ValueError("Upload checksum does not match")
            with source.open("rb") as handle:
                sniffed = _sniff_mime(handle.read(4096))
            if sniffed != record["mime_type"]:
                raise ValueError("Uploaded file type does not match")
            width = height = None
            if sniffed.startswith("image/"):
                width, height = _validate_image(source, sniffed)
            asset = self._adopt_asset(
                record["project_id"],
                source,
                sniffed,
                filename=record["filename"],
                kind=sniffed.split("/", 1)[0],
                width=width,
                height=height,
                sha256=record["expected_sha256"],
            )
            with self._connect() as db:
                db.execute("DELETE FROM uploads WHERE id=?", (upload_id,))
            return asset

    def _adopt_asset(
        self,
        project_id: str,
        source: Path,
        mime_type: str,
        *,
        filename: str,
        kind: str,
        width: int | None = None,
        height: int | None = None,
        duration: float | None = None,
        sha256: str | None = None,
        origin: str = "uploaded",
    ) -> dict[str, Any]:
        source = source.resolve()
        if source.parent != self.uploads_root:
            raise ValueError("Unsafe media staging path")
        size = source.stat().st_size
        limit = MAX_OUTPUT_BYTES if origin == "generated" else MIME_LIMITS.get(mime_type, 0)
        if not limit or size <= 0 or size > limit:
            raise ValueError("Media exceeds the storage limit")
        asset_id = f"video_asset_{uuid4().hex}"
        relative = (
            Path("projects") / project_id / "assets" / f"{asset_id}{MIME_EXTENSIONS[mime_type]}"
        )
        target = (self.root / relative).resolve()
        expected_parent = (self.projects_root / project_id / "assets").resolve()
        if target.parent != expected_parent or expected_parent.parent.parent != self.projects_root:
            raise ValueError("Unsafe asset path")
        now = time.time()
        try:
            with self._lock, self._connect() as db:
                db.execute("BEGIN IMMEDIATE")
                if not db.execute(
                    "SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL", (project_id,)
                ).fetchone():
                    raise KeyError(project_id)
                stored = int(
                    db.execute(
                        """SELECT COALESCE(SUM(size_bytes),0) FROM assets
                           WHERE project_id=? AND deleted_at IS NULL""",
                        (project_id,),
                    ).fetchone()[0]
                )
                if stored + size > MAX_PROJECT_BYTES:
                    raise ValueError("Video project storage quota exceeded")
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(source, target)
                db.execute(
                    """INSERT INTO assets
                       (id,project_id,kind,origin,mime_type,filename,size_bytes,sha256,relative_path,
                        width,height,duration,created_at,deleted_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
                    (
                        asset_id,
                        project_id,
                        kind,
                        origin,
                        mime_type,
                        _safe_filename(filename, mime_type),
                        size,
                        sha256 or _sha256_file(target),
                        relative.as_posix(),
                        width,
                        height,
                        duration,
                        now,
                    ),
                )
                db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now, project_id))
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return self.get_asset(asset_id) or {}

    def save_output_bytes(
        self, project_id: str, data: bytes, mime_type: str, filename: str = "result.mp4"
    ) -> dict[str, Any]:
        if len(data) > MAX_OUTPUT_BYTES:
            raise ValueError("Video output exceeds the storage limit")
        if _sniff_mime(data[:4096]) != mime_type or not mime_type.startswith("video/"):
            raise ValueError("Provider returned an invalid video file")
        temporary = (self.uploads_root / f"output_{uuid4().hex}.tmp").resolve()
        temporary.write_bytes(data)
        try:
            return self._adopt_asset(
                project_id,
                temporary,
                mime_type,
                filename=filename,
                kind="video",
                origin="generated",
            )
        finally:
            temporary.unlink(missing_ok=True)

    def save_generated_audio(
        self,
        project_id: str,
        data: bytes,
        mime_type: str,
        filename: str = "voiceover.mp3",
        *,
        duration: float | None = None,
    ) -> dict[str, Any]:
        """Adopt synthesized speech (or any generated audio) as a project asset."""
        if len(data) > MAX_OUTPUT_BYTES:
            raise ValueError("Audio output exceeds the storage limit")
        if _sniff_mime(data[:4096]) != mime_type or not mime_type.startswith("audio/"):
            raise ValueError("Provider returned an invalid audio file")
        temporary = (self.uploads_root / f"audio_{uuid4().hex}.tmp").resolve()
        temporary.write_bytes(data)
        try:
            return self._adopt_asset(
                project_id,
                temporary,
                mime_type,
                filename=filename,
                kind="audio",
                origin="generated",
                duration=duration,
            )
        finally:
            temporary.unlink(missing_ok=True)

    def save_subtitle_document(
        self,
        project_id: str,
        content: str,
        filename: str = "subtitles.srt",
        *,
        origin: str = "generated",
    ) -> dict[str, Any]:
        """Adopt an SRT document (subtitle editor save, from_asr byproduct)."""
        data = _encode_subtitle_document(content)
        temporary = (self.uploads_root / f"subtitle_{uuid4().hex}.tmp").resolve()
        temporary.write_bytes(data)
        try:
            return self._adopt_asset(
                project_id,
                temporary,
                SUBTITLE_MIME_TYPE,
                filename=filename or "subtitles.srt",
                kind="subtitle",
                origin=origin,
            )
        finally:
            temporary.unlink(missing_ok=True)

    def replace_subtitle_document(self, asset_id: str, content: str) -> dict[str, Any]:
        """Overwrite an existing subtitle asset's SRT in place (editor saves).

        Keeping the asset id stable means a composition that references the
        document picks up the edited text on the next run without any re-wiring.
        """
        asset = self.get_asset(asset_id)
        if not asset or asset["kind"] != "subtitle":
            raise ValueError("Asset is not a subtitle document")
        if asset.get("deleted_at"):
            raise ValueError("Asset is not a subtitle document")
        data = _encode_subtitle_document(content)
        temporary = (self.uploads_root / f"subtitle_{uuid4().hex}.tmp").resolve()
        temporary.write_bytes(data)
        try:
            target = self.asset_path(asset_id)
            with self._lock, self._connect() as db:
                db.execute("BEGIN IMMEDIATE")
                stored = int(
                    db.execute(
                        """SELECT COALESCE(SUM(size_bytes),0) FROM assets
                           WHERE project_id=? AND deleted_at IS NULL""",
                        (asset["project_id"],),
                    ).fetchone()[0]
                )
                if stored - int(asset["size_bytes"]) + len(data) > MAX_PROJECT_BYTES:
                    raise ValueError("Video project storage quota exceeded")
                os.replace(temporary, target)
                db.execute(
                    "UPDATE assets SET size_bytes=?, sha256=? WHERE id=? AND deleted_at IS NULL",
                    (len(data), hashlib.sha256(data).hexdigest(), asset_id),
                )
                now = time.time()
                db.execute(
                    "UPDATE projects SET updated_at=? WHERE id=?", (now, asset["project_id"])
                )
        finally:
            temporary.unlink(missing_ok=True)
        return self.get_asset(asset_id) or {}

    def import_asset_bytes(
        self, project_id: str, data: bytes, mime_type: str, filename: str
    ) -> dict[str, Any]:
        """Import a trusted caller's bytes without accepting a filesystem path."""
        limit = MIME_LIMITS.get(mime_type)
        if not limit or not data or len(data) > limit:
            raise ValueError("Media exceeds the upload limit")
        if _sniff_mime(data[:4096]) != mime_type:
            raise ValueError("Imported file type does not match")
        temporary = (self.uploads_root / f"import_{uuid4().hex}.tmp").resolve()
        temporary.write_bytes(data)
        width = height = None
        try:
            if mime_type.startswith("image/"):
                width, height = _validate_image(temporary, mime_type)
            return self._adopt_asset(
                project_id,
                temporary,
                mime_type,
                filename=filename,
                kind=mime_type.split("/", 1)[0],
                width=width,
                height=height,
            )
        finally:
            temporary.unlink(missing_ok=True)

    def adopt_output_file(
        self, project_id: str, source: Path, mime_type: str, filename: str = "result.mp4"
    ) -> dict[str, Any]:
        source = source.resolve()
        if source.parent != self.uploads_root:
            raise ValueError("Unsafe media staging path")
        with source.open("rb") as handle:
            actual = _sniff_mime(handle.read(4096))
        if actual != mime_type or not actual.startswith("video/"):
            raise ValueError("Provider returned an invalid video file")
        try:
            return self._adopt_asset(
                project_id,
                source,
                mime_type,
                filename=filename,
                kind="video",
                origin="generated",
            )
        finally:
            source.unlink(missing_ok=True)

    def get_asset(self, asset_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM assets WHERE id=? AND deleted_at IS NULL", (asset_id,)
            ).fetchone()
        return self._dict(row)

    def get_assets_by_ids(self, asset_ids: Sequence[str]) -> dict[str, dict[str, Any]]:
        """Bulk-load non-deleted assets by id in one query.

        Missing (or soft-deleted) ids are simply absent from the result —
        callers that need presence checks keep their per-item semantics.
        """
        ids = [str(item) for item in dict.fromkeys(asset_ids) if item]
        if not ids:
            return {}
        placeholders = ",".join("?" * len(ids))
        with self._connect() as db:
            rows = db.execute(
                f"SELECT * FROM assets WHERE id IN ({placeholders}) AND deleted_at IS NULL",  # nosec B608 - placeholder string only
                ids,
            ).fetchall()
        return {str(row["id"]): dict(row) for row in rows}

    def asset_path(self, asset_id: str) -> Path:
        asset = self.get_asset(asset_id)
        if not asset:
            raise KeyError(asset_id)
        path = (self.root / asset["relative_path"]).resolve()
        if self.root not in path.parents:
            raise ValueError("Unsafe asset path")
        return path

    def list_assets(
        self,
        project_id: str,
        *,
        kind: str = "",
        limit: int = 50,
        before: float | None = None,
    ) -> list[dict[str, Any]]:
        clauses = ["project_id=?", "deleted_at IS NULL"]
        args: list[Any] = [project_id]
        if kind:
            clauses.append("kind=?")
            args.append(kind)
        if before is not None:
            clauses.append("created_at<?")
            args.append(float(before))
        args.append(max(1, min(int(limit), 100)))
        with self._connect() as db:
            rows = db.execute(
                f"SELECT * FROM assets WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT ?",  # nosec B608 - hardcoded clauses, bound args
                args,
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_asset(self, asset_id: str) -> bool:
        target: Path | None = None
        with self._lock, self._connect() as db:
            used = db.execute(
                """SELECT 1 FROM job_inputs WHERE asset_id=?
                   UNION ALL SELECT 1 FROM job_outputs WHERE asset_id=? LIMIT 1""",
                (asset_id, asset_id),
            ).fetchone()
            if used:
                raise ValueError("This asset is referenced by a video job")
            asset = db.execute(
                """SELECT project_id,relative_path FROM assets
                   WHERE id=? AND deleted_at IS NULL""",
                (asset_id,),
            ).fetchone()
            # 搂Phase D3: the project's BGM slot points at this asset 鈥?deleting
            # it would silently strip the music bed from every later compose.
            if asset:
                slot = db.execute(
                    """SELECT 1 FROM projects
                       WHERE id=? AND deleted_at IS NULL AND bgm_asset_id=?""",
                    (asset["project_id"], asset_id),
                ).fetchone()
                if slot:
                    raise ValueError(
                        "This asset is the project's background music; clear the BGM slot first"
                    )
            board = (
                db.execute(
                    "SELECT document_json FROM storyboards WHERE project_id=?", (asset[0],)
                ).fetchone()
                if asset
                else None
            )
            if board:
                document = json.loads(board[0] or "{}")
                for shot in document.get("shots") or []:
                    if (
                        asset_id == shot.get("output_asset_id")
                        or asset_id == shot.get("keyframe_asset_id")
                        or asset_id == shot.get("voiceover_asset_id")
                        or asset_id in (shot.get("input_asset_ids") or [])
                    ):
                        raise ValueError("This asset is referenced by the storyboard")
            if asset:
                target = (self.root / asset["relative_path"]).resolve()
                expected_parent = (self.projects_root / asset["project_id"] / "assets").resolve()
                if (
                    target.parent != expected_parent
                    or expected_parent.parent.parent != self.projects_root
                ):
                    raise ValueError("Unsafe asset path")
            cursor = db.execute(
                "UPDATE assets SET deleted_at=? WHERE id=? AND deleted_at IS NULL",
                (time.time(), asset_id),
            )
        if cursor.rowcount and target is not None:
            try:
                target.unlink(missing_ok=True)
            except OSError:
                logger.info("Deferred cleanup of deleted video asset %s", target)
        return cursor.rowcount > 0

    def cleanup_deleted_files(self) -> int:
        """Best-effort retry for Windows file locks after logical deletion."""
        with self._lock, self._connect() as db:
            assets = db.execute(
                """SELECT project_id,relative_path FROM assets
                   WHERE deleted_at IS NOT NULL"""
            ).fetchall()
            projects = db.execute("SELECT id FROM projects WHERE deleted_at IS NOT NULL").fetchall()
            active_uploads = {
                str(Path(row[0]).resolve())
                for row in db.execute("SELECT temp_path FROM uploads").fetchall()
            }
        removed = 0
        for asset in assets:
            target = (self.root / asset["relative_path"]).resolve()
            expected_parent = (self.projects_root / asset["project_id"] / "assets").resolve()
            if (
                target.parent != expected_parent
                or expected_parent.parent.parent != self.projects_root
            ):
                continue
            try:
                existed = target.exists()
                target.unlink(missing_ok=True)
                removed += int(existed)
            except OSError:
                continue
        for project in projects:
            target = (self.projects_root / project["id"]).resolve()
            if target.parent != self.projects_root:
                continue
            try:
                existed = target.exists()
                if existed:
                    shutil.rmtree(target)
                removed += int(existed)
            except OSError:
                continue
        for target in self.uploads_root.glob("video_upload_*.part"):
            resolved = target.resolve()
            if resolved.parent != self.uploads_root or str(resolved) in active_uploads:
                continue
            try:
                resolved.unlink(missing_ok=True)
                removed += 1
            except OSError:
                continue
        stale_export_cutoff = time.time() - UPLOAD_TTL_SECONDS
        for target in self.exports_root.iterdir():
            if (
                not target.is_file()
                or target.suffix not in {".zip", ".tmp"}
                or target.stat().st_mtime >= stale_export_cutoff
            ):
                continue
            try:
                target.unlink(missing_ok=True)
                removed += 1
            except OSError:
                continue
        return removed

    @staticmethod
    def _request_hash(payload: dict[str, Any]) -> str:
        public = {
            key: payload.get(key)
            for key in (
                "project_id",
                "operation",
                "profile_id",
                "model_id",
                "prompt",
                "input_asset_ids",
                "inputs",
                "parameters",
                "retry_of_job_id",
                "storyboard_shot_id",
                "board_node_id",
            )
        }
        return hashlib.sha256(
            json.dumps(public, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()

    @staticmethod
    def _input_specs(payload: dict[str, Any]) -> list[dict[str, str]]:
        """Normalize ``inputs[]`` / ``input_asset_ids`` into [{asset_id, role}]."""
        raw_specs = payload.get("inputs")
        raw_ids = payload.get("input_asset_ids") or []
        if raw_specs is not None and not isinstance(raw_specs, list):
            raise ValueError("Video inputs must be a list")
        if not isinstance(raw_ids, list):
            raise ValueError("Video input asset ids must be a list")
        if raw_specs and raw_ids:
            raise ValueError("Pass either input_asset_ids or inputs, not both")
        specs: list[dict[str, str]] = []
        for item in raw_specs or []:
            if not isinstance(item, dict):
                raise ValueError("Video inputs must be objects with asset_id and role")
            asset_id = str(item.get("asset_id") or "")
            role = str(item.get("role") or "reference")
            specs.append({"asset_id": asset_id, "role": role})
        if not specs:
            specs = [{"asset_id": str(item), "role": "reference"} for item in raw_ids]
        deduped: list[dict[str, str]] = []
        seen: set[str] = set()
        for spec in specs:
            if spec["asset_id"] in seen:
                continue
            seen.add(spec["asset_id"])
            deduped.append(spec)
        return deduped

    def create_job(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.get_project(project_id):
            raise KeyError(project_id)
        operation = str(payload.get("operation") or "")
        operation = operation.replace("-", "_")
        if operation not in {
            "text_to_video",
            "image_to_video",
            "video_to_video",
            "extend",
            "remix",
            "edit",
            "compose",
        }:
            raise ValueError("Invalid video operation")
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt or len(prompt) > 20_000:
            raise ValueError("A valid video prompt is required")
        owner = str(payload.get("owner_user_id") or "")
        revision = str(payload.get("config_revision") or "")
        request_id = str(payload.get("client_request_id") or "").strip()
        if not owner or not revision or not request_id or len(request_id) > 128:
            raise ValueError(
                "A valid owner, authorization snapshot and client request id are required"
            )
        inputs = self._input_specs(payload)
        if len(inputs) > MAX_INPUT_ASSETS:
            raise ValueError("Too many input assets")
        if any(not spec["asset_id"] or len(spec["asset_id"]) > 160 for spec in inputs):
            raise ValueError("Invalid video input asset id")
        if any(spec["role"] not in INPUT_ROLES for spec in inputs):
            raise ValueError("Invalid video input role")
        input_asset_ids = [spec["asset_id"] for spec in inputs]
        for asset_id in input_asset_ids:
            asset = self.get_asset(asset_id)
            if not asset or asset["project_id"] != project_id:
                raise ValueError("Input assets must belong to the video project")
        retry_of = payload.get("retry_of_job_id")
        if retry_of:
            related = self.get_job(str(retry_of))
            if not related or related["project_id"] != project_id:
                raise ValueError("Retry job must belong to the same video project")
            if related["status"] not in RETRYABLE_STATUSES:
                raise VideoStudioRetryConflictError(
                    "Only failed, cancelled, or interrupted video jobs can be retried"
                )
        params = dict(payload.get("parameters") or {})
        request_payload = {
            **payload,
            "project_id": project_id,
            "input_asset_ids": input_asset_ids,
            "inputs": inputs,
            "parameters": params,
        }
        fingerprint = self._request_hash(request_payload)
        job_id, now = f"video_job_{uuid4().hex}", time.time()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute(
                "SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL", (project_id,)
            ).fetchone():
                raise KeyError(project_id)
            for asset_id in input_asset_ids:
                asset_row = db.execute(
                    """SELECT project_id FROM assets
                       WHERE id=? AND deleted_at IS NULL""",
                    (asset_id,),
                ).fetchone()
                if not asset_row or asset_row["project_id"] != project_id:
                    raise ValueError("Input assets must belong to the video project")
            if retry_of:
                retry_row = db.execute(
                    "SELECT project_id,status FROM jobs WHERE id=?", (str(retry_of),)
                ).fetchone()
                if not retry_row or retry_row["project_id"] != project_id:
                    raise ValueError("Retry job must belong to the same video project")
                if retry_row["status"] not in RETRYABLE_STATUSES:
                    raise VideoStudioRetryConflictError(
                        "Only failed, cancelled, or interrupted video jobs can be retried"
                    )
            shot_id = str(payload.get("storyboard_shot_id") or "")
            if shot_id:
                board_row = db.execute(
                    "SELECT document_json FROM storyboards WHERE project_id=?", (project_id,)
                ).fetchone()
                board = json.loads(board_row[0] or "{}") if board_row else {}
                if not any(shot.get("id") == shot_id for shot in board.get("shots") or []):
                    raise ValueError("Storyboard shot not found")
            node_id = str(payload.get("board_node_id") or "")
            if node_id:
                node = find_board_node(self.get_board(project_id), node_id)
                if not node or node.get("kind") != "generate":
                    raise ValueError("Board generate node not found")
            existing = db.execute(
                "SELECT id,request_hash FROM jobs WHERE owner_user_id=? AND client_request_id=?",
                (owner, request_id),
            ).fetchone()
            if existing:
                if existing["request_hash"] != fingerprint:
                    raise ValueError("client_request_id was already used for a different request")
                return self.get_job(str(existing["id"])) or {}
            pending = int(
                db.execute(
                    "SELECT COUNT(*) FROM jobs WHERE status IN ('queued','submitting','running')"
                ).fetchone()[0]
            )
            if pending >= MAX_PENDING_JOBS:
                raise VideoStudioQueueFullError("Video Studio already has too many active jobs")
            db.execute(
                """INSERT INTO jobs
                   (id,project_id,retry_of_job_id,storyboard_shot_id,board_node_id,client_request_id,request_hash,operation,status,
                    profile_id,model_id,prompt,parameters_json,owner_user_id,config_revision,
                    provider_task_id,progress,stage,error_code,error_message,created_at,started_at,finished_at)
                   VALUES (?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,NULL,0,'queued',NULL,NULL,?,NULL,NULL)""",
                (
                    job_id,
                    project_id,
                    retry_of,
                    payload.get("storyboard_shot_id"),
                    node_id or None,
                    request_id,
                    fingerprint,
                    operation,
                    str(payload.get("profile_id") or ""),
                    str(payload.get("model_id") or ""),
                    prompt,
                    json.dumps(params, ensure_ascii=False),
                    owner,
                    revision,
                    now,
                ),
            )
            for position, spec in enumerate(inputs):
                db.execute(
                    "INSERT INTO job_inputs (job_id,asset_id,position,role) VALUES (?,?,?,?)",
                    (job_id, spec["asset_id"], position, spec["role"]),
                )
        self.add_event(job_id, "job.queued", {"status": "queued", "progress": 0})
        return self.get_job(job_id) or {}

    def _job_inputs(self, db: Any, job_id: str) -> list[dict[str, str]]:
        return [
            {"asset_id": str(row[0]), "role": str(row[1] or "reference")}
            for row in db.execute(
                "SELECT asset_id, role FROM job_inputs WHERE job_id=? ORDER BY position",
                (job_id,),
            ).fetchall()
        ]

    def _assemble_jobs(self, db: Any, rows: list[Any]) -> list[dict[str, Any]]:
        """Shape raw ``jobs`` rows with their relations, loading in bulk.

        One connection, one query per relation table instead of three queries
        per job — listing a full page used to reopen the database N+1 times.
        Input/output ordering matches the per-job queries exactly.
        """
        if not rows:
            return []
        ids = [str(row["id"]) for row in rows]
        placeholders = ",".join("?" * len(ids))
        inputs_by_job: dict[str, list[dict[str, str]]] = {job_id: [] for job_id in ids}
        for asset_id, role, job_id in db.execute(
            f"SELECT asset_id, role, job_id FROM job_inputs WHERE job_id IN ({placeholders}) ORDER BY position",  # nosec B608 - placeholder string only
            ids,
        ):
            inputs_by_job[str(job_id)].append(
                {"asset_id": str(asset_id), "role": str(role or "reference")}
            )
        outputs_by_job: dict[str, list[str]] = {job_id: [] for job_id in ids}
        for asset_id, job_id in db.execute(
            f"SELECT asset_id, job_id FROM job_outputs WHERE job_id IN ({placeholders}) ORDER BY position",  # nosec B608 - placeholder string only
            ids,
        ):
            outputs_by_job[str(job_id)].append(str(asset_id))
        results = []
        for row in rows:
            result = dict(row)
            job_id = str(result["id"])
            result["parameters"] = json.loads(result.pop("parameters_json") or "{}")
            result["input_asset_ids"] = [item["asset_id"] for item in inputs_by_job[job_id]]
            result["inputs"] = inputs_by_job[job_id]
            result["output_asset_ids"] = outputs_by_job[job_id]
            result["error"] = (
                {
                    "code": str(result.get("error_code") or ""),
                    "message": str(result.get("error_message") or ""),
                }
                if result.get("error_code") or result.get("error_message")
                else None
            )
            result.pop("request_hash", None)
            result.pop("config_revision", None)
            result.pop("owner_user_id", None)
            result.pop("provider_task_id", None)
            results.append(result)
        return results

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return None
            return self._assemble_jobs(db, [row])[0]

    def _internal_job(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                return None
            inputs = self._job_inputs(db, job_id)
        result = dict(row)
        result["parameters"] = json.loads(result.pop("parameters_json") or "{}")
        result["input_asset_ids"] = [item["asset_id"] for item in inputs]
        result["inputs"] = inputs
        return result

    def list_jobs(
        self,
        project_id: str,
        *,
        status: str = "",
        operation: str = "",
        limit: int = 50,
        before: float | None = None,
    ) -> list[dict[str, Any]]:
        clauses, args = ["project_id=?"], [project_id]
        if status:
            clauses.append("status=?")
            args.append(status)
        if operation:
            clauses.append("operation=?")
            args.append(operation)
        if before is not None:
            clauses.append("created_at<?")
            args.append(float(before))
        args.append(max(1, min(int(limit), 100)))
        with self._connect() as db:
            rows = db.execute(
                f"SELECT * FROM jobs WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT ?",  # nosec B608 - hardcoded clauses, bound args
                args,
            ).fetchall()
            return self._assemble_jobs(db, rows)

    def list_shot_jobs(self, project_id: str, shot_id: str) -> list[dict[str, Any]]:
        """Every job ever bound to one storyboard shot, newest first (搂Phase C5).

        Retry and reroll jobs inherit ``storyboard_shot_id``, so the variant
        history of a shot is exactly this column's history 鈥?no extra linkage
        table is needed. ``id DESC`` breaks ties deterministically when jobs
        share a timestamp.
        """
        with self._connect() as db:
            rows = db.execute(
                """SELECT * FROM jobs
                   WHERE project_id=? AND storyboard_shot_id=?
                   ORDER BY created_at DESC, id DESC""",
                (project_id, shot_id),
            ).fetchall()
            return self._assemble_jobs(db, rows)

    def resumable_job_ids(self) -> list[str]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT id FROM jobs
                   WHERE status='queued' OR (status IN ('submitting','running') AND provider_task_id IS NOT NULL)
                   ORDER BY created_at"""
            ).fetchall()
        return [str(row[0]) for row in rows]

    def claim_submission(self, job_id: str) -> bool:
        with self._connect() as db:
            cursor = db.execute(
                """UPDATE jobs SET status='submitting',stage='submitting',started_at=COALESCE(started_at,?)
                   WHERE id=? AND status='queued'""",
                (time.time(), job_id),
            )
        if cursor.rowcount:
            self.add_event(
                job_id, "job.submitting", {"status": "submitting", "stage": "submitting"}
            )
        return cursor.rowcount > 0

    def record_provider_task(self, job_id: str, provider_task_id: str) -> bool:
        with self._connect() as db:
            cursor = db.execute(
                """UPDATE jobs SET provider_task_id=?,status='running',stage='rendering',progress=MAX(progress,0.01)
                   WHERE id=? AND status='submitting'""",
                (provider_task_id, job_id),
            )
        if cursor.rowcount:
            self.add_event(
                job_id,
                "job.running",
                {"status": "running", "stage": "rendering", "progress": 0.01},
            )
        return cursor.rowcount > 0

    def update_progress(self, job_id: str, progress: float, stage: str, message: str = "") -> bool:
        value = max(0.0, min(float(progress), 0.99))
        stage_value = str(stage or "rendering")[:80]
        with self._lock, self._connect() as db:
            cursor = db.execute(
                """UPDATE jobs SET progress=MAX(progress,?),stage=?
                   WHERE id=? AND status='running' AND (progress<? OR stage<>?)""",
                (value, stage_value, job_id, value, stage_value),
            )
        if cursor.rowcount:
            current = self._internal_job(job_id) or {}
            self.add_event(
                job_id,
                "job.progress",
                {
                    "status": "running",
                    "progress": float(current.get("progress") or value),
                    "stage": str(current.get("stage") or stage_value),
                    "message": message[:500],
                },
            )
        return cursor.rowcount > 0

    def cancel_active_job(self, job_id: str) -> str | None:
        """Atomically cancel an active job and return its previous status."""

        now = time.time()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()
            previous = str(row["status"]) if row and row["status"] in ACTIVE_STATUSES else ""
            if not previous:
                return None
            cursor = db.execute(
                """UPDATE jobs SET status='cancelled',stage='cancelled',finished_at=?
                   WHERE id=? AND status=?""",
                (now, job_id, previous),
            )
            if not cursor.rowcount:
                return None
            seq = int(
                db.execute(
                    "SELECT COALESCE(MAX(seq),0)+1 FROM job_events WHERE job_id=?", (job_id,)
                ).fetchone()[0]
            )
            db.execute(
                "INSERT INTO job_events VALUES (?,?,?,?,?)",
                (
                    job_id,
                    seq,
                    "job.cancelled",
                    json.dumps(
                        {
                            "status": "cancelled",
                            "progress": 0.0,
                            "stage": "cancelled",
                            "message": "",
                        }
                    ),
                    now,
                ),
            )
        return previous

    def transition_terminal(
        self, job_id: str, status: str, *, error_code: str = "", error_message: str = ""
    ) -> bool:
        if status not in TERMINAL_STATUSES:
            raise ValueError("Invalid terminal status")
        progress = 1.0 if status == "succeeded" else 0.0
        with self._connect() as db:
            cursor = db.execute(
                """UPDATE jobs SET status=?,stage=?,progress=CASE WHEN ?='succeeded' THEN 1 ELSE progress END,
                   error_code=NULLIF(?,''),error_message=NULLIF(?,''),finished_at=?
                   WHERE id=? AND status IN ('queued','submitting','running')""",
                (status, status, status, error_code, error_message[:1000], time.time(), job_id),
            )
        if cursor.rowcount:
            self.add_event(
                job_id,
                f"job.{status}",
                {
                    "status": status,
                    "progress": progress,
                    "stage": status,
                    "message": error_message[:500],
                },
            )
        return cursor.rowcount > 0

    def complete_job_with_output(self, job_id: str, asset_id: str) -> bool:
        """Atomically publish an output and move a running job to succeeded.

        The storyboard patch is part of the same transaction when the shot is
        still linked to this job. A concurrent cancellation wins cleanly and
        leaves the caller free to remove the unreferenced output asset.
        """
        now = time.time()
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """SELECT j.project_id,j.storyboard_shot_id,a.project_id AS asset_project
                   FROM jobs j JOIN assets a ON a.id=? AND a.deleted_at IS NULL
                   WHERE j.id=?""",
                (asset_id, job_id),
            ).fetchone()
            if not row or row["project_id"] != row["asset_project"]:
                raise ValueError("Video output must belong to the job project")
            cursor = db.execute(
                """UPDATE jobs SET status='succeeded',stage='succeeded',progress=1,
                   error_code=NULL,error_message=NULL,finished_at=?
                   WHERE id=? AND status='running'""",
                (now, job_id),
            )
            if not cursor.rowcount:
                return False
            db.execute(
                "INSERT INTO job_outputs(job_id,asset_id,position) VALUES (?,?,0)",
                (job_id, asset_id),
            )

            shot_id = str(row["storyboard_shot_id"] or "")
            if shot_id:
                board = db.execute(
                    "SELECT revision,document_json FROM storyboards WHERE project_id=?",
                    (row["project_id"],),
                ).fetchone()
                if board:
                    document = json.loads(board["document_json"] or "{}")
                    changed = False
                    shots: list[dict[str, Any]] = []
                    for raw_shot in document.get("shots") or []:
                        shot = dict(raw_shot)
                        if shot.get("id") == shot_id and shot.get("job_id") == job_id:
                            shot["output_asset_id"] = asset_id
                            changed = True
                        shots.append(shot)
                    if changed:
                        db.execute(
                            """UPDATE storyboards SET revision=revision+1,document_json=?,updated_at=?
                               WHERE project_id=? AND revision=?""",
                            (
                                json.dumps({"shots": shots}, ensure_ascii=False),
                                now,
                                row["project_id"],
                                int(board["revision"]),
                            ),
                        )

            next_seq = int(
                db.execute(
                    "SELECT COALESCE(MAX(seq),0)+1 FROM job_events WHERE job_id=?", (job_id,)
                ).fetchone()[0]
            )
            db.execute(
                "INSERT INTO job_events VALUES (?,?,?,?,?)",
                (
                    job_id,
                    next_seq,
                    "job.output",
                    json.dumps({"asset_id": asset_id, "position": 0}),
                    now,
                ),
            )
            db.execute(
                "INSERT INTO job_events VALUES (?,?,?,?,?)",
                (
                    job_id,
                    next_seq + 1,
                    "job.succeeded",
                    json.dumps(
                        {
                            "status": "succeeded",
                            "progress": 1.0,
                            "stage": "succeeded",
                            "message": "",
                        }
                    ),
                    now,
                ),
            )
        return True

    def add_job_output(self, job_id: str, asset_id: str, position: int = 0) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT OR IGNORE INTO job_outputs VALUES (?,?,?)", (job_id, asset_id, position)
            )
        self.add_event(job_id, "job.output", {"asset_id": asset_id, "position": position})

    def add_event(self, job_id: str, event_type: str, payload: dict[str, Any]) -> int:
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT COALESCE(MAX(seq),0)+1 FROM job_events WHERE job_id=?", (job_id,)
            ).fetchone()
            seq = int(row[0])
            db.execute(
                "INSERT INTO job_events VALUES (?,?,?,?,?)",
                (job_id, seq, event_type, json.dumps(payload, ensure_ascii=False), time.time()),
            )
        return seq

    def events_after(self, job_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM job_events WHERE job_id=? AND seq>? ORDER BY seq",
                (job_id, max(0, int(after_seq))),
            ).fetchall()
        events = []
        for row in rows:
            payload = json.loads(row["payload_json"] or "{}")
            events.append(
                {
                    "job_id": job_id,
                    "seq": int(row["seq"]),
                    "type": row["type"],
                    "created_at": row["created_at"],
                    **payload,
                }
            )
        return events


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
