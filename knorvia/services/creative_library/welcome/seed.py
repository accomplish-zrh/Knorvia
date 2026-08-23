"""Idempotent welcome-pack seed and lossless v1/v2 → v3 migration.

The migration marker lives in ``library_meta``, not in “is the tree empty?”.
A legacy row is upgraded only when its *content bytes* hash-equal a frozen
digest for that stable id. Edited rows, deleted rows, and title collisions are
left alone. Concurrent store objects share one ``BEGIN IMMEDIATE`` writer.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import sqlite3
import time
from typing import Any

from .pack import FOLDER_ID, FOLDER_TITLE, SEED_KEY, SEED_VERSION, built_documents
from .v1_legacy import V1_FOLDER_TITLE, V1_HTML_DIGESTS, V1_SEED_KEY
from .v2_legacy import V2_HTML_DIGESTS, V2_SEED_KEY

_MAX_TITLE = 160
_MAX_ENTRY_TEXT = 200_000
_META_TABLE = """
CREATE TABLE IF NOT EXISTS library_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at REAL NOT NULL
);
"""


def ensure_welcome_seed(store: Any) -> None:
    """Apply welcome v3; upgrade only byte-identical v1/v2 documents."""
    lock = getattr(store, "_lock", None)
    if lock is None:
        _apply(store)
        return
    with lock:
        _apply(store)


def _digest(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _is_pristine_legacy(entry_id: str, content: str) -> bool:
    actual = _digest(content)
    for evidence in (V2_HTML_DIGESTS, V1_HTML_DIGESTS):
        expected = evidence.get(entry_id)
        if expected and len(actual) == len(expected) and hmac.compare_digest(actual, expected):
            return True
    return False


def _apply(store: Any) -> None:
    db = sqlite3.connect(str(store.db_path), timeout=30, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        db.execute(_META_TABLE)
        db.execute("BEGIN IMMEDIATE")
        try:
            existing = db.execute(
                "SELECT value FROM library_meta WHERE key=?",
                (SEED_KEY,),
            ).fetchone()
            if existing:
                db.execute("COMMIT")
                return
            report = _sync_pack(db)
            db.execute(
                "INSERT INTO library_meta(key, value, updated_at) VALUES (?,?,?)",
                (
                    SEED_KEY,
                    json.dumps(
                        {
                            "version": SEED_VERSION,
                            "status": "applied",
                            "folder_id": FOLDER_ID,
                            "v1_key": V1_SEED_KEY,
                            "v2_key": V2_SEED_KEY,
                            **report,
                        },
                        ensure_ascii=False,
                    ),
                    time.time(),
                ),
            )
            db.execute("COMMIT")
        except Exception:
            db.execute("ROLLBACK")
            raise
    finally:
        db.close()


def _sync_pack(db: sqlite3.Connection) -> dict[str, Any]:
    created: list[str] = []
    updated: list[str] = []
    skipped: list[str] = []
    folder_row = db.execute(
        "SELECT id, deleted_at, title FROM entries WHERE id=?",
        (FOLDER_ID,),
    ).fetchone()
    if folder_row is not None and folder_row["deleted_at"] is not None:
        skipped.append(FOLDER_ID)
        return {
            "created": created,
            "updated": updated,
            "skipped": skipped,
            "reason": "deleted",
        }
    if folder_row is None and _title_taken(db, None, FOLDER_TITLE, FOLDER_ID):
        skipped.append(FOLDER_ID)
        return {
            "created": created,
            "updated": updated,
            "skipped": skipped,
            "reason": "title_collision",
        }

    now = time.time()
    if folder_row is None:
        db.execute(
            """INSERT INTO entries
               (id,parent_id,kind,title,mime,content,relative_path,size_bytes,sha256,sort_order,created_at,updated_at,deleted_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
            (
                FOLDER_ID,
                None,
                "folder",
                FOLDER_TITLE[:_MAX_TITLE],
                "",
                "",
                "",
                0,
                "",
                0,
                now,
                now,
            ),
        )
        created.append(FOLDER_ID)
    else:
        _maybe_rename_folder(db, dict(folder_row), now)

    for doc in built_documents():
        if len(doc.html) > _MAX_ENTRY_TEXT:
            raise ValueError(f"Welcome page exceeds size limit: {doc.entry_id}")
        action = _sync_document(db, doc, now)
        if action == "created":
            created.append(doc.entry_id)
        elif action == "updated":
            updated.append(doc.entry_id)
        else:
            skipped.append(doc.entry_id)
    return {"created": created, "updated": updated, "skipped": skipped}


def _maybe_rename_folder(db: sqlite3.Connection, folder: dict[str, Any], now: float) -> None:
    if folder.get("title") != V1_FOLDER_TITLE:
        return
    if _title_taken(db, None, FOLDER_TITLE, FOLDER_ID):
        return
    db.execute(
        "UPDATE entries SET title=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
        (FOLDER_TITLE[:_MAX_TITLE], now, FOLDER_ID),
    )


def _sync_document(db: sqlite3.Connection, doc: Any, now: float) -> str:
    row = db.execute(
        "SELECT id, deleted_at, title, content FROM entries WHERE id=?",
        (doc.entry_id,),
    ).fetchone()
    if row is not None and row["deleted_at"] is not None:
        return "skipped"
    if row is None:
        if _title_taken(db, FOLDER_ID, doc.title, doc.entry_id):
            return "skipped"
        _insert_html(db, doc, now)
        return "created"
    current_html = str(row["content"] or "")
    current_digest = _digest(current_html)
    v3_digest = _digest(doc.html)
    if hmac.compare_digest(current_digest, v3_digest):
        return "skipped"
    if not _is_pristine_legacy(doc.entry_id, current_html):
        return "skipped"
    title = doc.title[:_MAX_TITLE]
    if _title_taken(db, FOLDER_ID, title, doc.entry_id):
        title = str(row["title"] or title)[:_MAX_TITLE]
    _update_html(db, doc.entry_id, title, doc.html, doc.sort_order, now)
    return "updated"


def _insert_html(db: sqlite3.Connection, doc: Any, now: float) -> None:
    body = doc.html
    digest = _digest(body)
    db.execute(
        """INSERT INTO entries
           (id,parent_id,kind,title,mime,content,relative_path,size_bytes,sha256,sort_order,created_at,updated_at,deleted_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)""",
        (
            doc.entry_id,
            FOLDER_ID,
            "html",
            doc.title[:_MAX_TITLE],
            "text/html",
            body,
            "",
            len(body.encode("utf-8")),
            digest,
            doc.sort_order,
            now,
            now,
        ),
    )


def _update_html(
    db: sqlite3.Connection,
    entry_id: str,
    title: str,
    body: str,
    sort_order: int,
    now: float,
) -> None:
    digest = _digest(body)
    db.execute(
        """UPDATE entries
           SET title=?, mime=?, content=?, size_bytes=?, sha256=?, sort_order=?, updated_at=?
           WHERE id=? AND deleted_at IS NULL""",
        (
            title,
            "text/html",
            body,
            len(body.encode("utf-8")),
            digest,
            sort_order,
            now,
            entry_id,
        ),
    )


def _title_taken(
    db: sqlite3.Connection,
    parent_id: str | None,
    title: str,
    entry_id: str,
) -> bool:
    if parent_id is None:
        row = db.execute(
            """SELECT id FROM entries
               WHERE parent_id IS NULL AND title=? AND deleted_at IS NULL AND id!=?""",
            (title, entry_id),
        ).fetchone()
    else:
        row = db.execute(
            """SELECT id FROM entries
               WHERE parent_id=? AND title=? AND deleted_at IS NULL AND id!=?""",
            (parent_id, title, entry_id),
        ).fetchone()
    return row is not None
