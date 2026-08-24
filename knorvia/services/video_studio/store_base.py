"""Video Studio store: shared constants, errors and pure helpers.

Leaf module on purpose: it imports nothing from knorvia, so both the store
facade (:mod:`knorvia.services.video_studio.store`) and sibling modules can
depend on it without cycles. Extracted from store.py during the staged
decomposition tracked in scripts/architecture_guard.py.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from PIL import Image

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


def _dict_row(row):
    """sqlite3.Row -> plain dict (None passthrough). Shared row helper."""
    return dict(row) if row is not None else None
