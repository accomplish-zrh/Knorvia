"""Workspace zip export/import: layout, secret stripping, round-trip."""

from __future__ import annotations

import io
import json
from pathlib import Path
import sqlite3
import zipfile

import pytest

from knorvia.services.path_service import PathService
from knorvia.services.workspace_bundle import (
    BUNDLE_ROOT,
    build_workspace_zip,
    import_workspace_zip,
    is_secret_path,
)


def test_secret_paths_are_rejected() -> None:
    assert is_secret_path(".env")
    assert is_secret_path("secrets.json")
    assert is_secret_path("foo/api_keys.json")
    assert is_secret_path("provider-token.yaml")
    assert is_secret_path("credentials.json")
    assert not is_secret_path("notes/lecture.json")
    assert not is_secret_path("conversations/abc.json")


class _BundlePaths(PathService):
    def __init__(self, root: Path) -> None:
        super().__init__(workspace_root=root)


def _seed(paths: PathService) -> None:
    db = paths.get_chat_history_db()
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE sessions (
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
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
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
    conn.execute(
        "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)",
        ("s1", "组会草稿", 1.0, 2.0),
    )
    conn.execute(
        "INSERT INTO messages (session_id, role, content, created_at) VALUES (?,?,?,?)",
        ("s1", "user", "今天讨论开题", 1.5),
    )
    conn.commit()
    conn.close()

    notes = paths.get_notebook_dir()
    notes.mkdir(parents=True, exist_ok=True)
    (notes / "nb1.json").write_text(
        json.dumps({"id": "nb1", "title": "课堂笔记"}), encoding="utf-8"
    )
    (notes / ".env").write_text("SECRET=nope", encoding="utf-8")
    (notes / "api_keys.json").write_text("{}", encoding="utf-8")

    classrooms = paths.workspace_root / "classrooms"
    classrooms.mkdir(parents=True, exist_ok=True)
    (classrooms / "lesson-1.json").write_text(
        json.dumps({"id": "lesson-1", "title": "线代提纲"}), encoding="utf-8"
    )


def test_export_skips_secrets_and_round_trips(tmp_path: Path) -> None:
    source_root = tmp_path / "src"
    source_root.mkdir()
    src = _BundlePaths(source_root)
    _seed(src)

    data = build_workspace_zip(src)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
    assert f"{BUNDLE_ROOT}/manifest.json" in names
    assert f"{BUNDLE_ROOT}/conversations/s1.json" in names
    assert f"{BUNDLE_ROOT}/notes/nb1.json" in names
    assert f"{BUNDLE_ROOT}/outlines/lesson-1.json" in names
    joined = "\n".join(names)
    assert ".env" not in joined
    assert "api_keys.json" not in joined
    assert "SECRET=nope" not in data.decode("latin1", errors="ignore")

    dest_root = tmp_path / "dst"
    dest_root.mkdir()
    dest = _BundlePaths(dest_root)
    counts = import_workspace_zip(data, dest)
    assert counts["conversations"] == 1
    assert counts["notes"] == 1
    assert counts["outlines"] == 1

    conn = sqlite3.connect(dest.get_chat_history_db())
    title = conn.execute("SELECT title FROM sessions WHERE id='s1'").fetchone()[0]
    body = conn.execute("SELECT content FROM messages WHERE session_id='s1'").fetchone()[0]
    conn.close()
    assert title == "组会草稿"
    assert "开题" in body
    assert (dest.get_notebook_dir() / "nb1.json").is_file()
    assert (dest.workspace_root / "classrooms" / "lesson-1.json").is_file()
    assert not (dest.get_notebook_dir() / ".env").exists()


def test_import_rejects_path_escape(tmp_path: Path) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("../evil.json", "{}")
    dest = _BundlePaths(tmp_path / "dst")
    with pytest.raises(Exception):
        import_workspace_zip(buffer.getvalue(), dest)
