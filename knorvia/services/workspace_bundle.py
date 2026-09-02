"""Local workspace zip export/import (Obsidian / Cherry style).

Zip layout::

    knorvia-workspace/
      manifest.json
      conversations/<session_id>.json
      notes/<notebook_id>.json
      outlines/<classroom_or_outline_id>.json

Never packed: ``.env``, secret/credential/api-key/token filenames, or
settings files that hold provider keys. Locations only — never values.
Fully local; no cloud account.
"""

from __future__ import annotations

import io
import json
import logging
from pathlib import Path
import re
import sqlite3
import time
from typing import Any, Iterable
import zipfile

from knorvia import __version__
from knorvia.services.path_service import PathService, get_path_service

logger = logging.getLogger(__name__)

BUNDLE_VERSION = 1
BUNDLE_ROOT = "knorvia-workspace"
MANIFEST_NAME = "manifest.json"

# Basename denylist. Values are never written into the zip.
SECRET_BASENAMES = {
    ".env",
    ".env.local",
    ".env.production",
    "credentials.json",
    "secrets.json",
    "api_keys.json",
}

# Matches a path segment that looks like a secret file. Used for zip members
# on import as well as files on disk during export.
SECRET_NAME_RE = re.compile(
    r"(^|[/\\])(\.env($|\.)|.*secret.*|.*credential.*|.*api[_-]?key.*|.*token.*)([/\\]|$)",
    re.IGNORECASE,
)

_SKIP_DIR_NAMES = {".git", "__pycache__", "node_modules", ".venv"}


def is_secret_path(path: str | Path) -> bool:
    """Return True if this path must never enter (or leave) a workspace zip.

    Only the filename and exact secret directory names are considered, so a
    parent folder that merely *mentions* the word secret (pytest tmp names)
    does not hide ordinary notes.
    """
    parts = [part.lower() for part in Path(str(path).replace("\\", "/")).parts]
    if not parts:
        return False
    base = parts[-1]
    if base in SECRET_BASENAMES or SECRET_NAME_RE.search(base):
        return True
    return any(part in {"secrets", "credentials"} for part in parts[:-1])


def _safe_member_name(name: str) -> str:
    cleaned = name.replace("\\", "/").lstrip("/")
    parts = [part for part in cleaned.split("/") if part not in ("", ".", "..")]
    return "/".join(parts)


class WorkspaceBundleError(ValueError):
    """User-facing zip layout / safety error."""


def _notebook_dir(paths: PathService) -> Path:
    return paths.get_notebook_dir()


def _classroom_dir(paths: PathService) -> Path:
    # Classroom lessons live beside the workspace root (see classroom.store).
    return (paths.workspace_root / "classrooms").resolve()


def _book_dir(paths: PathService) -> Path:
    try:
        return paths.get_workspace_feature_dir("book")
    except Exception:
        return (paths.user_data_dir / "workspace" / "book").resolve()


def _iter_json_files(folder: Path) -> Iterable[Path]:
    if not folder.is_dir():
        return []
    return [
        path
        for path in sorted(folder.glob("*.json"))
        if path.is_file() and not is_secret_path(path)
    ]


def _load_json_object(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _load_json_list(raw: Any) -> list[Any]:
    if isinstance(raw, list):
        return raw
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def _export_conversations(conn: sqlite3.Connection) -> list[tuple[str, dict[str, Any]]]:
    sessions = conn.execute(
        "SELECT id, title, created_at, updated_at, preferences_json, pinned, archived_at "
        "FROM sessions ORDER BY updated_at DESC"
    ).fetchall()
    packed: list[tuple[str, dict[str, Any]]] = []
    for row in sessions:
        session_id = str(row[0])
        messages = conn.execute(
            "SELECT id, role, content, capability, attachments_json, metadata_json, "
            "created_at, parent_message_id FROM messages WHERE session_id = ? "
            "ORDER BY created_at, id",
            (session_id,),
        ).fetchall()
        payload = {
            "id": session_id,
            "title": row[1],
            "created_at": row[2],
            "updated_at": row[3],
            "preferences": _load_json_object(row[4]),
            "pinned": bool(row[5]),
            "archived_at": row[6],
            "messages": [
                {
                    "id": msg[0],
                    "role": msg[1],
                    "content": msg[2],
                    "capability": msg[3],
                    "attachments": _load_json_list(msg[4]),
                    "metadata": _load_json_object(msg[5]),
                    "created_at": msg[6],
                    "parent_message_id": msg[7],
                }
                for msg in messages
            ],
        }
        packed.append((session_id, payload))
    return packed


def build_workspace_zip(paths: PathService | None = None) -> bytes:
    """Return a zip of conversations, notes, and class outlines."""
    paths = paths or get_path_service()
    buffer = io.BytesIO()
    counts = {"conversations": 0, "notes": 0, "outlines": 0}

    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        db_path = paths.get_chat_history_db()
        if db_path.is_file():
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            try:
                for session_id, payload in _export_conversations(conn):
                    member = f"{BUNDLE_ROOT}/conversations/{session_id}.json"
                    zf.writestr(
                        member,
                        json.dumps(payload, ensure_ascii=False, indent=2),
                    )
                    counts["conversations"] += 1
            finally:
                conn.close()

        for note_path in _iter_json_files(_notebook_dir(paths)):
            member = f"{BUNDLE_ROOT}/notes/{note_path.name}"
            zf.write(note_path, arcname=member)
            counts["notes"] += 1

        book_dir = _book_dir(paths)
        if book_dir.is_dir():
            for path in sorted(book_dir.rglob("*")):
                if not path.is_file() or is_secret_path(path):
                    continue
                if any(part in _SKIP_DIR_NAMES for part in path.parts):
                    continue
                rel = path.relative_to(book_dir).as_posix()
                member = f"{BUNDLE_ROOT}/outlines/book/{rel}"
                zf.write(path, arcname=member)
                counts["outlines"] += 1
        for path in _iter_json_files(_classroom_dir(paths)):
            member = f"{BUNDLE_ROOT}/outlines/{path.name}"
            zf.write(path, arcname=member)
            counts["outlines"] += 1

        manifest = {
            "format": "knorvia-workspace",
            "version": BUNDLE_VERSION,
            "app": "Knorvia",
            "app_version": __version__,
            "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "counts": counts,
            "layout": {
                "conversations": "chat sessions (no API keys)",
                "notes": "notebook JSON",
                "outlines": "classroom lessons and book/class outlines",
            },
        }
        zf.writestr(
            f"{BUNDLE_ROOT}/{MANIFEST_NAME}",
            json.dumps(manifest, ensure_ascii=False, indent=2),
        )

    return buffer.getvalue()


def _read_json_member(zf: zipfile.ZipFile, name: str) -> Any:
    raw = zf.read(name).decode("utf-8")
    return json.loads(raw)


def _ensure_session_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT 'New conversation',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            compressed_summary TEXT DEFAULT '',
            summary_up_to_msg_id INTEGER DEFAULT 0,
            preferences_json TEXT DEFAULT '{}',
            pinned INTEGER NOT NULL DEFAULT 0,
            archived_at REAL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            capability TEXT DEFAULT '',
            events_json TEXT DEFAULT '',
            attachments_json TEXT DEFAULT '',
            metadata_json TEXT DEFAULT '{}',
            created_at REAL NOT NULL,
            parent_message_id INTEGER
        );
        """
    )


def _upsert_session(conn: sqlite3.Connection, payload: dict[str, Any]) -> None:
    session_id = str(payload["id"])
    now = time.time()
    prefs = payload.get("preferences") or {}
    conn.execute(
        """
        INSERT INTO sessions (id, title, created_at, updated_at, preferences_json, pinned, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            updated_at = excluded.updated_at,
            preferences_json = excluded.preferences_json,
            pinned = excluded.pinned,
            archived_at = excluded.archived_at
        """,
        (
            session_id,
            str(payload.get("title") or "Imported conversation"),
            float(payload.get("created_at") or now),
            float(payload.get("updated_at") or now),
            json.dumps(prefs, ensure_ascii=False),
            1 if payload.get("pinned") else 0,
            payload.get("archived_at"),
        ),
    )
    conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
    for msg in payload.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        conn.execute(
            """
            INSERT INTO messages (
                session_id, role, content, capability, attachments_json,
                metadata_json, created_at, parent_message_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                str(msg.get("role") or "user"),
                str(msg.get("content") or ""),
                str(msg.get("capability") or ""),
                json.dumps(msg.get("attachments") or [], ensure_ascii=False),
                json.dumps(msg.get("metadata") or {}, ensure_ascii=False),
                float(msg.get("created_at") or now),
                msg.get("parent_message_id"),
            ),
        )


def import_workspace_zip(data: bytes, paths: PathService | None = None) -> dict[str, int]:
    """Restore conversations/notes/outlines from a local zip. No secrets."""
    paths = paths or get_path_service()
    counts = {"conversations": 0, "notes": 0, "outlines": 0}
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise WorkspaceBundleError("Not a valid zip archive") from exc

    with zf:
        raw_names = [info.filename for info in zf.infolist() if not info.is_dir()]
        if not raw_names:
            raise WorkspaceBundleError("Empty workspace zip")
        for raw in raw_names:
            if raw.startswith("/") or raw.startswith("\\") or ".." in Path(raw.replace("\\","/")).parts:
                raise WorkspaceBundleError("Zip contains an unsafe path")
        names = [_safe_member_name(raw) for raw in raw_names]

        db_path = paths.get_chat_history_db()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(db_path)
        try:
            _ensure_session_tables(conn)
            for name in names:
                norm = name.replace("\\", "/")
                if "/conversations/" not in norm or not norm.endswith(".json"):
                    continue
                if is_secret_path(norm):
                    logger.info("Skipping secret path in workspace zip: %s", name)
                    continue
                payload = _read_json_member(zf, name)
                if not isinstance(payload, dict) or not payload.get("id"):
                    continue
                _upsert_session(conn, payload)
                counts["conversations"] += 1
            conn.commit()
        finally:
            conn.close()

        notes_dir = _notebook_dir(paths)
        notes_dir.mkdir(parents=True, exist_ok=True)
        for name in names:
            norm = name.replace("\\", "/")
            if "/notes/" not in norm or not norm.endswith(".json"):
                continue
            if is_secret_path(norm):
                continue
            dest = notes_dir / Path(norm).name
            dest.write_bytes(zf.read(name))
            counts["notes"] += 1

        outlines_root = _classroom_dir(paths)
        book_dir = _book_dir(paths)
        for name in names:
            norm = name.replace("\\", "/")
            if "/outlines/" not in norm:
                continue
            if is_secret_path(norm):
                continue
            relative = norm.split("/outlines/", 1)[1]
            if relative.startswith("book/"):
                dest = book_dir / relative[len("book/") :]
            else:
                dest = outlines_root / Path(relative).name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(name))
            counts["outlines"] += 1

    return counts
