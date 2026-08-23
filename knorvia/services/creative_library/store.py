"""SQLite store for the cross-studio creative library."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
import time
from typing import Any, Iterator
from uuid import uuid4

from PIL import Image

from knorvia.multi_user.paths import get_current_path_service

from .catalog import builtin_prompts

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  relative_path TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  deleted_at REAL
);
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  language TEXT NOT NULL DEFAULT 'en',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  deleted_at REAL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  deleted_at REAL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'agent',
  prefs_json TEXT NOT NULL DEFAULT '{}',
  brief_json TEXT NOT NULL DEFAULT '{}',
  job_json TEXT NOT NULL DEFAULT '{}',
  created_at REAL NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
CREATE TABLE IF NOT EXISTS canvas_runs (
  id TEXT PRIMARY KEY,
  studio TEXT NOT NULL,
  project_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  ops_json TEXT NOT NULL DEFAULT '[]',
  brief_json TEXT NOT NULL DEFAULT '{}',
  job_ids_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL,
  finished_at REAL
);
CREATE INDEX IF NOT EXISTS idx_lib_assets_updated ON assets(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lib_prompts_updated ON prompts(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lib_conversations_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lib_messages_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lib_runs_created ON canvas_runs(created_at DESC);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  relative_path TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  deleted_at REAL
);
CREATE INDEX IF NOT EXISTS idx_lib_entries_parent ON entries(parent_id, sort_order, title);
CREATE INDEX IF NOT EXISTS idx_lib_entries_updated ON entries(updated_at DESC);
CREATE TABLE IF NOT EXISTS library_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at REAL NOT NULL
);
"""

ASSET_KINDS = frozenset({"text", "image", "video"})
ENTRY_KINDS = frozenset(
    {
        "folder",
        "markdown",
        "csv",
        "html",
        "canvas",
        "text",
        "image",
        "video",
        "audio",
        "pdf",
        "word",
        "excel",
        "office",
        "file",
    }
)
TEXT_ENTRY_KINDS = frozenset({"markdown", "csv", "html", "canvas", "text"})
OFFICE_ENTRY_KINDS = frozenset({"word", "excel"})
IMAGE_MIMES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
VIDEO_MIMES = {"video/mp4": ".mp4", "video/webm": ".webm"}
AUDIO_MIMES = {
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
}
MAX_TEXT_CHARS = 50_000
MAX_ENTRY_TEXT = 200_000
MAX_ENTRIES = 2_000
MAX_TREE_DEPTH = 12
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_VIDEO_BYTES = 64 * 1024 * 1024
MAX_ASSETS = 500
MAX_USER_PROMPTS = 200
MAX_CONVERSATIONS = 200
MAX_MESSAGES = 200
MAX_TITLE = 160
MAX_NOTE = 2_000
MAX_IMAGE_DIMENSION = 16_384


class CreativeLibraryStore:
    def __init__(self, root: Path) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.files_root = self.root / "files"
        self.files_root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.root / "library.db"
        self._lock = threading.Lock()
        with self._connect() as db:
            db.executescript(SCHEMA)
        self.seed_builtin_prompts()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.db_path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def _row(self, row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        return dict(row)

    def seed_builtin_prompts(self) -> None:
        now = time.time()
        with self._lock, self._connect() as db:
            for item in builtin_prompts():
                existing = db.execute("SELECT id FROM prompts WHERE id=?", (item["id"],)).fetchone()
                payload = (
                    item["id"],
                    "builtin",
                    item["title"][:MAX_TITLE],
                    item["body"][:MAX_TEXT_CHARS],
                    item["category"][:80],
                    json.dumps(list(item.get("tags") or []), ensure_ascii=False),
                    item.get("language") or "en",
                    now,
                    now,
                )
                if existing:
                    continue
                db.execute(
                    """INSERT INTO prompts
                       (id,origin,title,body,category,tags_json,language,created_at,updated_at,deleted_at)
                       VALUES (?,?,?,?,?,?,?,?,?,NULL)""",
                    payload,
                )

    def _parse_tags(self, value: Any) -> list[str]:
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                value = [part.strip() for part in value.split(",")]
        if not isinstance(value, list):
            return []
        tags: list[str] = []
        for item in value:
            text = str(item or "").strip()[:40]
            if text and text not in tags:
                tags.append(text)
            if len(tags) >= 12:
                break
        return tags

    def _asset_public(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": row["id"],
            "kind": row["kind"],
            "title": row["title"],
            "tags": self._parse_tags(row.get("tags_json")),
            "source": row.get("source") or "",
            "note": row.get("note") or "",
            "mime": row.get("mime") or "",
            "size_bytes": int(row.get("size_bytes") or 0),
            "sha256": row.get("sha256") or "",
            "content": row.get("content") or "",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _prompt_public(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": row["id"],
            "origin": row["origin"],
            "title": row["title"],
            "body": row["body"],
            "category": row.get("category") or "",
            "tags": self._parse_tags(row.get("tags_json")),
            "language": row.get("language") or "en",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def list_assets(
        self,
        *,
        kind: str = "",
        keyword: str = "",
        page: int = 1,
        page_size: int = 20,
    ) -> dict[str, Any]:
        page = max(1, int(page or 1))
        page_size = min(48, max(1, int(page_size or 20)))
        clauses = ["deleted_at IS NULL"]
        args: list[Any] = []
        if kind in ASSET_KINDS:
            clauses.append("kind=?")
            args.append(kind)
        needle = str(keyword or "").strip()[:80]
        if needle:
            clauses.append("(title LIKE ? OR note LIKE ? OR content LIKE ? OR tags_json LIKE ?)")
            like = f"%{needle}%"
            args.extend([like, like, like, like])
        where = " AND ".join(clauses)
        with self._connect() as db:
            total = int(
                db.execute(f"SELECT COUNT(*) FROM assets WHERE {where}", args).fetchone()[0]  # nosec B608 - hardcoded clauses, bound args
            )
            rows = db.execute(
                f"SELECT * FROM assets WHERE {where} ORDER BY updated_at DESC LIMIT ? OFFSET ?",  # nosec B608 - hardcoded clauses, bound args
                [*args, page_size, (page - 1) * page_size],
            ).fetchall()
        return {
            "items": [self._asset_public(dict(row)) for row in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    def get_asset(self, asset_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM assets WHERE id=? AND deleted_at IS NULL",
                (asset_id,),
            ).fetchone()
        return self._asset_public(dict(row)) if row else None

    def asset_bytes(self, asset_id: str) -> tuple[bytes, str] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM assets WHERE id=? AND deleted_at IS NULL",
                (asset_id,),
            ).fetchone()
        if row is None or not row["relative_path"]:
            return None
        path = (self.root / str(row["relative_path"])).resolve()
        if self.root not in path.parents or not path.is_file():
            return None
        return path.read_bytes(), str(row["mime"] or "application/octet-stream")

    def _count_assets(self) -> int:
        with self._connect() as db:
            return int(
                db.execute("SELECT COUNT(*) FROM assets WHERE deleted_at IS NULL").fetchone()[0]
            )

    def create_text_asset(
        self,
        *,
        title: str,
        content: str,
        tags: list[str] | None = None,
        source: str = "",
        note: str = "",
    ) -> dict[str, Any]:
        body = str(content or "").strip()
        if not body or len(body) > MAX_TEXT_CHARS:
            raise ValueError("Text asset content is required")
        if self._count_assets() >= MAX_ASSETS:
            raise ValueError("Library asset limit reached")
        now = time.time()
        asset_id = f"lib_asset_{uuid4().hex}"
        with self._lock, self._connect() as db:
            db.execute(
                """INSERT INTO assets
                   (id,kind,title,tags_json,source,note,mime,size_bytes,sha256,relative_path,content,created_at,updated_at,deleted_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
                (
                    asset_id,
                    "text",
                    (title or "Untitled").strip()[:MAX_TITLE] or "Untitled",
                    json.dumps(self._parse_tags(tags), ensure_ascii=False),
                    str(source or "")[:200],
                    str(note or "")[:MAX_NOTE],
                    "text/plain",
                    len(body.encode("utf-8")),
                    hashlib.sha256(body.encode("utf-8")).hexdigest(),
                    "",
                    body,
                    now,
                    now,
                ),
            )
        return self.get_asset(asset_id) or {}

    def create_media_asset(
        self,
        data: bytes,
        mime: str,
        *,
        title: str,
        tags: list[str] | None = None,
        source: str = "",
        note: str = "",
    ) -> dict[str, Any]:
        if mime in IMAGE_MIMES:
            kind = "image"
            if not data or len(data) > MAX_IMAGE_BYTES:
                raise ValueError("Image exceeds the library limit")
            sniffed = _sniff_image(data)
            if sniffed != mime:
                mime = sniffed
            _validate_image(data)
            ext = IMAGE_MIMES[mime]
        elif mime in VIDEO_MIMES:
            kind = "video"
            if not data or len(data) > MAX_VIDEO_BYTES:
                raise ValueError("Video exceeds the library limit")
            sniffed = _sniff_video(data)
            if sniffed != mime:
                raise ValueError("Unsupported video type")
            ext = VIDEO_MIMES[mime]
        else:
            raise ValueError("Unsupported library media type")
        if self._count_assets() >= MAX_ASSETS:
            raise ValueError("Library asset limit reached")
        now = time.time()
        asset_id = f"lib_asset_{uuid4().hex}"
        relative = Path("files") / f"{asset_id}{ext}"
        target = (self.root / relative).resolve()
        if self.root not in target.parents:
            raise ValueError("Unsafe library path")
        digest = hashlib.sha256(data).hexdigest()
        target.write_bytes(data)
        try:
            with self._lock, self._connect() as db:
                db.execute(
                    """INSERT INTO assets
                       (id,kind,title,tags_json,source,note,mime,size_bytes,sha256,relative_path,content,created_at,updated_at,deleted_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
                    (
                        asset_id,
                        kind,
                        (title or "Untitled").strip()[:MAX_TITLE] or "Untitled",
                        json.dumps(self._parse_tags(tags), ensure_ascii=False),
                        str(source or "")[:200],
                        str(note or "")[:MAX_NOTE],
                        mime,
                        len(data),
                        digest,
                        relative.as_posix(),
                        "",
                        now,
                        now,
                    ),
                )
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return self.get_asset(asset_id) or {}

    def update_asset(self, asset_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        current = self.get_asset(asset_id)
        if not current:
            raise KeyError(asset_id)
        title = str(patch.get("title", current["title"])).strip()[:MAX_TITLE] or current["title"]
        tags = self._parse_tags(patch.get("tags", current["tags"]))
        source = str(patch.get("source", current["source"]))[:200]
        note = str(patch.get("note", current["note"]))[:MAX_NOTE]
        content = current["content"]
        if current["kind"] == "text" and "content" in patch:
            body = str(patch.get("content") or "").strip()
            if not body or len(body) > MAX_TEXT_CHARS:
                raise ValueError("Text asset content is required")
            content = body
        with self._lock, self._connect() as db:
            db.execute(
                """UPDATE assets SET title=?, tags_json=?, source=?, note=?, content=?, updated_at=?
                   WHERE id=? AND deleted_at IS NULL""",
                (
                    title,
                    json.dumps(tags, ensure_ascii=False),
                    source,
                    note,
                    content,
                    time.time(),
                    asset_id,
                ),
            )
        return self.get_asset(asset_id) or {}

    def delete_asset(self, asset_id: str) -> bool:
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT relative_path FROM assets WHERE id=? AND deleted_at IS NULL",
                (asset_id,),
            ).fetchone()
            if row is None:
                return False
            db.execute(
                "UPDATE assets SET deleted_at=?, updated_at=? WHERE id=?",
                (time.time(), time.time(), asset_id),
            )
        return True

    def list_prompts(
        self,
        *,
        origin: str = "",
        keyword: str = "",
        category: str = "",
        tag: str = "",
        page: int = 1,
        page_size: int = 20,
    ) -> dict[str, Any]:
        page = max(1, int(page or 1))
        page_size = min(48, max(1, int(page_size or 20)))
        clauses = ["deleted_at IS NULL"]
        args: list[Any] = []
        if origin in {"builtin", "user"}:
            clauses.append("origin=?")
            args.append(origin)
        if category:
            clauses.append("category=?")
            args.append(str(category)[:80])
        needle = str(keyword or "").strip()[:80]
        if needle:
            clauses.append("(title LIKE ? OR body LIKE ? OR tags_json LIKE ?)")
            like = f"%{needle}%"
            args.extend([like, like, like])
        if tag:
            clauses.append("tags_json LIKE ?")
            args.append(f"%{str(tag)[:40]}%")
        where = " AND ".join(clauses)
        with self._connect() as db:
            total = int(
                db.execute(f"SELECT COUNT(*) FROM prompts WHERE {where}", args).fetchone()[0]  # nosec B608 - hardcoded clauses, bound args
            )
            rows = db.execute(
                f"SELECT * FROM prompts WHERE {where} ORDER BY origin ASC, updated_at DESC LIMIT ? OFFSET ?",  # nosec B608 - hardcoded clauses, bound args
                [*args, page_size, (page - 1) * page_size],
            ).fetchall()
        return {
            "items": [self._prompt_public(dict(row)) for row in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    def get_prompt(self, prompt_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM prompts WHERE id=? AND deleted_at IS NULL",
                (prompt_id,),
            ).fetchone()
        return self._prompt_public(dict(row)) if row else None

    def create_prompt(
        self,
        *,
        title: str,
        body: str,
        category: str = "",
        tags: list[str] | None = None,
        language: str = "en",
    ) -> dict[str, Any]:
        text = str(body or "").strip()
        if not text or len(text) > MAX_TEXT_CHARS:
            raise ValueError("Prompt body is required")
        with self._connect() as db:
            count = int(
                db.execute(
                    "SELECT COUNT(*) FROM prompts WHERE origin='user' AND deleted_at IS NULL"
                ).fetchone()[0]
            )
        if count >= MAX_USER_PROMPTS:
            raise ValueError("Personal prompt limit reached")
        now = time.time()
        prompt_id = f"lib_prompt_{uuid4().hex}"
        with self._lock, self._connect() as db:
            db.execute(
                """INSERT INTO prompts
                   (id,origin,title,body,category,tags_json,language,created_at,updated_at,deleted_at)
                   VALUES (?,?,?,?,?,?,?,?,?,NULL)""",
                (
                    prompt_id,
                    "user",
                    (title or "Untitled").strip()[:MAX_TITLE] or "Untitled",
                    text,
                    str(category or "")[:80],
                    json.dumps(self._parse_tags(tags), ensure_ascii=False),
                    "zh" if str(language).lower().startswith("zh") else "en",
                    now,
                    now,
                ),
            )
        return self.get_prompt(prompt_id) or {}

    def update_prompt(self, prompt_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        current = self.get_prompt(prompt_id)
        if not current:
            raise KeyError(prompt_id)
        if current["origin"] == "builtin":
            raise PermissionError("Built-in prompts cannot be edited")
        body = str(patch.get("body", current["body"])).strip()
        if not body or len(body) > MAX_TEXT_CHARS:
            raise ValueError("Prompt body is required")
        with self._lock, self._connect() as db:
            db.execute(
                """UPDATE prompts SET title=?, body=?, category=?, tags_json=?, language=?, updated_at=?
                   WHERE id=? AND deleted_at IS NULL""",
                (
                    str(patch.get("title", current["title"])).strip()[:MAX_TITLE]
                    or current["title"],
                    body,
                    str(patch.get("category", current["category"]))[:80],
                    json.dumps(
                        self._parse_tags(patch.get("tags", current["tags"])), ensure_ascii=False
                    ),
                    "zh"
                    if str(patch.get("language", current["language"])).lower().startswith("zh")
                    else "en",
                    time.time(),
                    prompt_id,
                ),
            )
        return self.get_prompt(prompt_id) or {}

    def delete_prompt(self, prompt_id: str) -> bool:
        current = self.get_prompt(prompt_id)
        if not current:
            return False
        if current["origin"] == "builtin":
            raise PermissionError("Built-in prompts cannot be deleted")
        with self._lock, self._connect() as db:
            db.execute(
                "UPDATE prompts SET deleted_at=?, updated_at=? WHERE id=?",
                (time.time(), time.time(), prompt_id),
            )
        return True

    def list_conversations(self, *, limit: int = 40) -> list[dict[str, Any]]:
        limit = min(100, max(1, int(limit or 40)))
        with self._connect() as db:
            rows = db.execute(
                """SELECT * FROM conversations WHERE deleted_at IS NULL
                   ORDER BY updated_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM conversations WHERE id=? AND deleted_at IS NULL",
                (conversation_id,),
            ).fetchone()
        return dict(row) if row else None

    def create_conversation(self, title: str = "") -> dict[str, Any]:
        with self._connect() as db:
            count = int(
                db.execute(
                    "SELECT COUNT(*) FROM conversations WHERE deleted_at IS NULL"
                ).fetchone()[0]
            )
        if count >= MAX_CONVERSATIONS:
            raise ValueError("Create conversation limit reached")
        now = time.time()
        conversation_id = f"create_{uuid4().hex}"
        with self._lock, self._connect() as db:
            db.execute(
                "INSERT INTO conversations VALUES (?,?,?,?,NULL)",
                (
                    conversation_id,
                    (title or "New creation").strip()[:MAX_TITLE] or "New creation",
                    now,
                    now,
                ),
            )
        return self.get_conversation(conversation_id) or {}

    def touch_conversation(self, conversation_id: str, title: str | None = None) -> None:
        with self._lock, self._connect() as db:
            if title:
                db.execute(
                    "UPDATE conversations SET title=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
                    (str(title).strip()[:MAX_TITLE], time.time(), conversation_id),
                )
            else:
                db.execute(
                    "UPDATE conversations SET updated_at=? WHERE id=? AND deleted_at IS NULL",
                    (time.time(), conversation_id),
                )

    def delete_conversation(self, conversation_id: str) -> bool:
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT id FROM conversations WHERE id=? AND deleted_at IS NULL",
                (conversation_id,),
            ).fetchone()
            if row is None:
                return False
            db.execute(
                "UPDATE conversations SET deleted_at=?, updated_at=? WHERE id=?",
                (time.time(), time.time(), conversation_id),
            )
        return True

    def list_messages(self, conversation_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC",
                (conversation_id,),
            ).fetchall()
        items: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["prefs"] = _load_json(item.pop("prefs_json", "{}"), {})
            item["brief"] = _load_json(item.pop("brief_json", "{}"), {})
            item["job"] = _load_json(item.pop("job_json", "{}"), {})
            items.append(item)
        return items

    def add_message(
        self,
        conversation_id: str,
        *,
        role: str,
        content: str,
        mode: str = "agent",
        prefs: dict[str, Any] | None = None,
        brief: dict[str, Any] | None = None,
        job: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not self.get_conversation(conversation_id):
            raise KeyError(conversation_id)
        if role not in {"user", "assistant"}:
            raise ValueError("Invalid message role")
        with self._connect() as db:
            count = int(
                db.execute(
                    "SELECT COUNT(*) FROM messages WHERE conversation_id=?",
                    (conversation_id,),
                ).fetchone()[0]
            )
        if count >= MAX_MESSAGES:
            raise ValueError("Conversation is full")
        message_id = f"cmsg_{uuid4().hex}"
        now = time.time()
        with self._lock, self._connect() as db:
            db.execute(
                """INSERT INTO messages
                   (id,conversation_id,role,content,mode,prefs_json,brief_json,job_json,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    message_id,
                    conversation_id,
                    role,
                    str(content or "")[:MAX_TEXT_CHARS],
                    str(mode or "agent")[:20],
                    json.dumps(prefs or {}, ensure_ascii=False),
                    json.dumps(brief or {}, ensure_ascii=False),
                    json.dumps(job or {}, ensure_ascii=False),
                    now,
                ),
            )
        self.touch_conversation(conversation_id)
        return {
            "id": message_id,
            "conversation_id": conversation_id,
            "role": role,
            "content": str(content or "")[:MAX_TEXT_CHARS],
            "mode": str(mode or "agent")[:20],
            "prefs": prefs or {},
            "brief": brief or {},
            "job": job or {},
            "created_at": now,
        }

    def create_canvas_run(
        self,
        *,
        studio: str,
        project_id: str,
        prompt: str,
        ops: list[dict[str, Any]],
        brief: dict[str, Any],
        job_ids: list[str],
        status: str = "completed",
        error_message: str = "",
    ) -> dict[str, Any]:
        now = time.time()
        run_id = f"crun_{uuid4().hex}"
        finished = now if status in {"completed", "failed"} else None
        with self._lock, self._connect() as db:
            db.execute(
                """INSERT INTO canvas_runs
                   (id,studio,project_id,prompt,status,ops_json,brief_json,job_ids_json,error_message,created_at,finished_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    run_id,
                    studio,
                    project_id,
                    prompt[:MAX_TEXT_CHARS],
                    status,
                    json.dumps(ops, ensure_ascii=False),
                    json.dumps(brief, ensure_ascii=False),
                    json.dumps(job_ids, ensure_ascii=False),
                    error_message[:2000],
                    now,
                    finished,
                ),
            )
        return self.get_canvas_run(run_id) or {}

    def get_canvas_run(self, run_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM canvas_runs WHERE id=?", (run_id,)).fetchone()
        if row is None:
            return None
        item = dict(row)
        item["ops"] = _load_json(item.pop("ops_json", "[]"), [])
        item["brief"] = _load_json(item.pop("brief_json", "{}"), {})
        item["job_ids"] = _load_json(item.pop("job_ids_json", "[]"), [])
        return item

    def _entry_public(self, row: dict[str, Any], *, include_content: bool = True) -> dict[str, Any]:
        preview_scripts = False
        if row.get("kind") == "html":
            from knorvia.services.creative_library.welcome.pack import html_preview_scripts

            preview_scripts = html_preview_scripts(
                entry_id=str(row["id"]),
                kind=str(row["kind"]),
                sha256=str(row.get("sha256") or ""),
            )
        item = {
            "id": row["id"],
            "parent_id": row.get("parent_id") or None,
            "kind": row["kind"],
            "title": row["title"],
            "mime": row.get("mime") or "",
            "size_bytes": int(row.get("size_bytes") or 0),
            "sha256": row.get("sha256") or "",
            "preview_scripts": preview_scripts,
            "sort_order": int(row.get("sort_order") or 0),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        if include_content:
            if row.get("kind") in OFFICE_ENTRY_KINDS:
                item["content"] = self._office_extracted_text(row)
            else:
                item["content"] = row.get("content") or ""
        return item

    def _count_entries(self) -> int:
        with self._connect() as db:
            return int(
                db.execute("SELECT COUNT(*) FROM entries WHERE deleted_at IS NULL").fetchone()[0]
            )

    def _get_entry_row(self, entry_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM entries WHERE id=? AND deleted_at IS NULL",
                (entry_id,),
            ).fetchone()
        return dict(row) if row else None

    def _parent_depth(self, parent_id: str | None) -> int:
        depth = 0
        current = parent_id
        seen: set[str] = set()
        while current:
            if current in seen or depth >= MAX_TREE_DEPTH:
                raise ValueError("Folder path is too deep")
            seen.add(current)
            row = self._get_entry_row(current)
            if not row:
                raise KeyError(current)
            if row["kind"] != "folder":
                raise ValueError("Parent must be a folder")
            current = row.get("parent_id")
            depth += 1
        return depth

    def _maybe_import_legacy_assets(self) -> None:
        if self._count_entries() > 0:
            return
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM assets WHERE deleted_at IS NULL ORDER BY created_at ASC"
            ).fetchall()
        if not rows:
            return
        folder = self.create_entry(kind="folder", title="Imported assets")
        for raw in rows:
            row = dict(raw)
            kind = str(row.get("kind") or "file")
            if kind == "text":
                self.create_entry(
                    kind="text",
                    title=row.get("title") or "Untitled",
                    parent_id=folder["id"],
                    content=row.get("content") or "",
                )
                continue
            entry_kind = kind if kind in ENTRY_KINDS else "file"
            now = time.time()
            entry_id = f"lib_entry_{uuid4().hex}"
            with self._lock, self._connect() as db:
                db.execute(
                    """INSERT INTO entries
                       (id,parent_id,kind,title,mime,content,relative_path,size_bytes,sha256,sort_order,created_at,updated_at,deleted_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
                    (
                        entry_id,
                        folder["id"],
                        entry_kind,
                        str(row.get("title") or "Untitled")[:MAX_TITLE],
                        str(row.get("mime") or ""),
                        "",
                        str(row.get("relative_path") or ""),
                        int(row.get("size_bytes") or 0),
                        str(row.get("sha256") or ""),
                        0,
                        now,
                        now,
                    ),
                )

    def ensure_welcome_seed(self) -> None:
        from knorvia.services.creative_library.welcome.seed import ensure_welcome_seed

        ensure_welcome_seed(self)

    def list_tree(self) -> dict[str, Any]:
        self._maybe_import_legacy_assets()
        self.ensure_welcome_seed()
        with self._connect() as db:
            rows = db.execute(
                """SELECT * FROM entries WHERE deleted_at IS NULL
                   ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, sort_order, title"""
            ).fetchall()
        items = [self._entry_public(dict(row), include_content=False) for row in rows]
        by_parent: dict[str, list[dict[str, Any]]] = {}
        for item in items:
            by_parent.setdefault(str(item.get("parent_id") or ""), []).append(item)

        def nest(parent_key: str) -> list[dict[str, Any]]:
            children: list[dict[str, Any]] = []
            for item in by_parent.get(parent_key, []):
                node = dict(item)
                node["children"] = nest(str(node["id"])) if node["kind"] == "folder" else []
                children.append(node)
            return children

        return {"items": nest(""), "total": len(items)}

    def get_entry(self, entry_id: str, *, include_content: bool = True) -> dict[str, Any] | None:
        row = self._get_entry_row(entry_id)
        return self._entry_public(row, include_content=include_content) if row else None

    def create_entry(
        self,
        *,
        kind: str,
        title: str,
        parent_id: str | None = None,
        content: str = "",
        mime: str = "",
    ) -> dict[str, Any]:
        kind = str(kind or "").strip()
        if kind not in ENTRY_KINDS:
            raise ValueError("Unsupported library entry kind")
        if self._count_entries() >= MAX_ENTRIES:
            raise ValueError("Library entry limit reached")
        parent_key = str(parent_id or "").strip() or None
        if parent_key:
            self._parent_depth(parent_key)
        safe_title = str(title or "").strip()[:MAX_TITLE] or (
            "Untitled folder" if kind == "folder" else "Untitled"
        )
        body = ""
        relative = ""
        size_bytes = 0
        digest = ""
        now = time.time()
        entry_id = f"lib_entry_{uuid4().hex}"
        if kind in TEXT_ENTRY_KINDS:
            if kind == "canvas" and not str(content or "").strip():
                from knorvia.services.creative_library.canvas import empty_library_canvas

                body = json.dumps(empty_library_canvas(), ensure_ascii=False)
            else:
                body = str(content or "")
                if len(body) > MAX_ENTRY_TEXT:
                    raise ValueError("Document exceeds the size limit")
            if kind == "canvas":
                from knorvia.services.creative_library.canvas import normalize_library_canvas

                parsed = _load_json(body, {})
                body = json.dumps(normalize_library_canvas(parsed), ensure_ascii=False)
            size_bytes = len(body.encode("utf-8")) if body else 0
            digest = hashlib.sha256(body.encode("utf-8")).hexdigest() if body else ""
        elif kind in OFFICE_ENTRY_KINDS:
            from knorvia.services.creative_library.office import (
                encode_library_office,
                office_ext,
                office_mime,
            )

            body_text = str(content or "")
            if len(body_text) > MAX_ENTRY_TEXT:
                raise ValueError("Document exceeds the size limit")
            data = encode_library_office(kind, body_text)
            mime = mime or office_mime(kind)
            relative = self._write_entry_bytes(entry_id, office_ext(kind), data)
            size_bytes = len(data)
            digest = hashlib.sha256(data).hexdigest()
        mime = mime or {
            "markdown": "text/markdown",
            "csv": "text/csv",
            "html": "text/html",
            "canvas": "application/json",
            "text": "text/plain",
            "folder": "",
        }.get(kind, mime)
        try:
            with self._lock, self._connect() as db:
                db.execute(
                    """INSERT INTO entries
                       (id,parent_id,kind,title,mime,content,relative_path,size_bytes,sha256,sort_order,created_at,updated_at,deleted_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
                    (
                        entry_id,
                        parent_key,
                        kind,
                        safe_title,
                        mime,
                        body,
                        relative,
                        size_bytes,
                        digest,
                        0,
                        now,
                        now,
                    ),
                )
        except Exception:
            if relative:
                (self.root / relative).unlink(missing_ok=True)
            raise
        return self.get_entry(entry_id) or {}

    def upload_entry(
        self,
        data: bytes,
        filename: str,
        mime: str = "",
        *,
        parent_id: str | None = None,
        title: str = "",
    ) -> dict[str, Any]:
        if not data or len(data) > MAX_FILE_BYTES:
            raise ValueError("File exceeds the library limit")
        if self._count_entries() >= MAX_ENTRIES:
            raise ValueError("Library entry limit reached")
        parent_key = str(parent_id or "").strip() or None
        if parent_key:
            self._parent_depth(parent_key)
        kind, ext, mime = _classify_upload(filename, mime, data)
        if kind in TEXT_ENTRY_KINDS:
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ValueError("Text document must be UTF-8") from exc
            return self.create_entry(
                kind=kind,
                title=title or Path(filename).stem or "Untitled",
                parent_id=parent_id,
                content=text,
                mime=mime,
            )
        safe_title = (title or Path(filename).stem or "Untitled").strip()[:MAX_TITLE] or "Untitled"
        now = time.time()
        entry_id = f"lib_entry_{uuid4().hex}"
        relative = Path("files") / f"{entry_id}{ext}"
        target = (self.root / relative).resolve()
        if self.root not in target.parents:
            raise ValueError("Unsafe library path")
        digest = hashlib.sha256(data).hexdigest()
        target.write_bytes(data)
        try:
            with self._lock, self._connect() as db:
                db.execute(
                    """INSERT INTO entries
                       (id,parent_id,kind,title,mime,content,relative_path,size_bytes,sha256,sort_order,created_at,updated_at,deleted_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
                    (
                        entry_id,
                        parent_key,
                        kind,
                        safe_title,
                        mime,
                        "",
                        relative.as_posix(),
                        len(data),
                        digest,
                        0,
                        now,
                        now,
                    ),
                )
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return self.get_entry(entry_id) or {}

    def update_entry(self, entry_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        current = self._get_entry_row(entry_id)
        if not current:
            raise KeyError(entry_id)
        title = str(patch.get("title", current["title"])).strip()[:MAX_TITLE] or current["title"]
        content = current.get("content") or ""
        relative = str(current.get("relative_path") or "")
        size_bytes = int(current.get("size_bytes") or 0)
        digest = str(current.get("sha256") or "")
        if "content" in patch and current["kind"] in TEXT_ENTRY_KINDS:
            body = str(patch.get("content") or "")
            if len(body) > MAX_ENTRY_TEXT:
                raise ValueError("Document exceeds the size limit")
            if current["kind"] == "canvas":
                from knorvia.services.creative_library.canvas import normalize_library_canvas

                body = json.dumps(
                    normalize_library_canvas(_load_json(body, {})), ensure_ascii=False
                )
            content = body
            size_bytes = len(content.encode("utf-8")) if content else 0
            digest = hashlib.sha256(content.encode("utf-8")).hexdigest() if content else ""
        elif "content" in patch and current["kind"] in OFFICE_ENTRY_KINDS:
            from knorvia.services.creative_library.office import encode_library_office, office_ext

            body = str(patch.get("content") or "")
            if len(body) > MAX_ENTRY_TEXT:
                raise ValueError("Document exceeds the size limit")
            data = encode_library_office(current["kind"], body)
            relative = relative or f"files/{entry_id}{office_ext(current['kind'])}"
            target = (self.root / relative).resolve()
            if self.root not in target.parents:
                raise ValueError("Unsafe library path")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            content = ""
            size_bytes = len(data)
            digest = hashlib.sha256(data).hexdigest()
        with self._lock, self._connect() as db:
            db.execute(
                """UPDATE entries SET title=?, content=?, relative_path=?, size_bytes=?, sha256=?, updated_at=?
                   WHERE id=? AND deleted_at IS NULL""",
                (
                    title,
                    content,
                    relative,
                    size_bytes,
                    digest,
                    time.time(),
                    entry_id,
                ),
            )
        return self.get_entry(entry_id) or {}

    def move_entry(self, entry_id: str, parent_id: str | None) -> dict[str, Any]:
        current = self._get_entry_row(entry_id)
        if not current:
            raise KeyError(entry_id)
        parent_key = str(parent_id or "").strip() or None
        if parent_key == entry_id:
            raise ValueError("Cannot move a folder into itself")
        if parent_key:
            self._parent_depth(parent_key)
            walker = parent_key
            while walker:
                if walker == entry_id:
                    raise ValueError("Cannot move a folder into its descendant")
                row = self._get_entry_row(walker)
                walker = (row or {}).get("parent_id")
        with self._lock, self._connect() as db:
            db.execute(
                "UPDATE entries SET parent_id=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
                (parent_key, time.time(), entry_id),
            )
        return self.get_entry(entry_id) or {}

    def delete_entry(self, entry_id: str) -> bool:
        row = self._get_entry_row(entry_id)
        if not row:
            return False
        now = time.time()
        pending = [entry_id]
        removed: list[str] = []
        with self._lock, self._connect() as db:
            while pending:
                current_id = pending.pop()
                children = db.execute(
                    "SELECT id FROM entries WHERE parent_id=? AND deleted_at IS NULL",
                    (current_id,),
                ).fetchall()
                pending.extend(str(child["id"]) for child in children)
                db.execute(
                    "UPDATE entries SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
                    (now, now, current_id),
                )
                removed.append(current_id)
        return bool(removed)

    def entry_bytes(self, entry_id: str) -> tuple[bytes, str] | None:
        row = self._get_entry_row(entry_id)
        if not row:
            return None
        if row["kind"] in TEXT_ENTRY_KINDS:
            data = str(row.get("content") or "").encode("utf-8")
            return data, str(row.get("mime") or "text/plain")
        relative = str(row.get("relative_path") or "")
        if not relative:
            return None
        path = (self.root / relative).resolve()
        if self.root not in path.parents or not path.is_file():
            return None
        return path.read_bytes(), str(row.get("mime") or "application/octet-stream")

    def _write_entry_bytes(self, entry_id: str, ext: str, data: bytes) -> str:
        relative = Path("files") / f"{entry_id}{ext}"
        target = (self.root / relative).resolve()
        if self.root not in target.parents:
            raise ValueError("Unsafe library path")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return relative.as_posix()

    def _office_extracted_text(self, row: dict[str, Any]) -> str:
        from knorvia.services.creative_library.office import extract_library_office
        from knorvia.utils.document_extractor import DocumentExtractionError

        relative = str(row.get("relative_path") or "")
        if not relative:
            return ""
        path = (self.root / relative).resolve()
        if self.root not in path.parents or not path.is_file():
            return ""
        try:
            return extract_library_office(str(row.get("kind") or ""), path.read_bytes())
        except (DocumentExtractionError, ValueError):
            return ""


def _classify_upload(filename: str, mime: str, data: bytes) -> tuple[str, str, str]:
    name = str(filename or "").lower()
    mime = str(mime or "").split(";", 1)[0].strip().lower()
    suffix = Path(name).suffix
    if suffix in {".md", ".markdown"} or mime == "text/markdown":
        return "markdown", ".md", "text/markdown"
    if suffix == ".csv" or mime == "text/csv":
        return "csv", ".csv", "text/csv"
    if suffix in {".html", ".htm"} or mime == "text/html":
        return "html", ".html", "text/html"
    if suffix == ".pdf" or mime == "application/pdf":
        return "pdf", ".pdf", "application/pdf"
    if suffix == ".docx" or mime == (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ):
        return (
            "word",
            ".docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
    if suffix == ".xlsx" or mime == (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ):
        return (
            "excel",
            ".xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
    if suffix in {".doc", ".ppt", ".pptx", ".xls"}:
        return "office", suffix or ".bin", mime or "application/octet-stream"
    if mime in IMAGE_MIMES or suffix in {".png", ".jpg", ".jpeg", ".webp"}:
        sniffed = _sniff_image(data)
        return "image", IMAGE_MIMES[sniffed], sniffed
    if mime in VIDEO_MIMES or suffix in {".mp4", ".webm"}:
        sniffed = _sniff_video(data)
        return "video", VIDEO_MIMES[sniffed], sniffed
    if mime in AUDIO_MIMES or suffix in {".mp3", ".wav", ".ogg", ".m4a"}:
        ext = AUDIO_MIMES.get(mime) or suffix or ".mp3"
        return "audio", ext, mime or "audio/mpeg"
    if suffix in {".txt", ".json"} or mime.startswith("text/"):
        return "text", suffix or ".txt", mime or "text/plain"
    return "file", suffix or ".bin", mime or "application/octet-stream"


def _load_json(raw: str, default: Any) -> Any:
    try:
        value = json.loads(raw or "")
    except json.JSONDecodeError:
        return default
    return value if value or value == 0 or value is False else default


def _sniff_image(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise ValueError("Unsupported image type")


def _sniff_video(data: bytes) -> str:
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return "video/mp4"
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"
    raise ValueError("Unsupported video type")


def _validate_image(data: bytes) -> None:
    from io import BytesIO

    with Image.open(BytesIO(data)) as image:
        image.load()
        width, height = image.size
    if width <= 0 or height <= 0 or width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
        raise ValueError("Image dimensions are not allowed")
    if width * height > 64 * 1024 * 1024:
        raise ValueError("Image dimensions are not allowed")


_stores: dict[str, CreativeLibraryStore] = {}
_stores_lock = threading.Lock()


def get_creative_library_store() -> CreativeLibraryStore:
    root = (get_current_path_service().get_workspace_dir() / "creative-library").resolve()
    key = str(root)
    with _stores_lock:
        if key not in _stores:
            _stores[key] = CreativeLibraryStore(root)
        return _stores[key]
