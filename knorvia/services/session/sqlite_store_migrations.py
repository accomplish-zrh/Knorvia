"""Startup schema migrations for the SQLite session store.

Extracted from ``sqlite_store.py`` so the store keeps to its architecture
line budget; these are pure ``sqlite3.Connection`` functions, version-sensitive
and append-only by design — each migration must stay idempotent because every
process start re-runs them.
"""

from __future__ import annotations

import logging
import sqlite3

logger = logging.getLogger(__name__)


def migrate_session_fts(conn: sqlite3.Connection) -> None:
    """Full-text index over message content (FTS5) for history search.

    Kept in sync by triggers so every write path is covered without
    touching call sites. Existing rows are backfilled once; the trigger
    definitions are (re)created idempotently on every startup.
    """
    # FTS5 ships with CPython's bundled SQLite on Windows/macOS and with
    # every distro build we support; guard anyway so a exotic build only
    # loses search instead of failing startup.
    try:
        capabilities = {
            row[0]
            for row in conn.execute("SELECT * FROM pragma_compile_options").fetchall()
            if row[0]
        }
    except sqlite3.Error:
        capabilities = set()
    if any(opt == "ENABLE_FTS5" for opt in capabilities):
        has_fts = True
    else:
        try:
            conn.execute(
                'CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content="")'
            )
            conn.execute("DROP TABLE IF EXISTS messages_fts")
            has_fts = True
        except sqlite3.Error:
            logger.warning("SQLite built without FTS5; session search falls back to LIKE")
            has_fts = False
    if not has_fts:
        return

    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            content='messages',
            content_rowid='id',
            tokenize='unicode61 remove_diacritics 2'
        )
        """
    )
    # Rebuild is cheap relative to correctness here and repairs any drift
    # from a crash between a message write and its trigger.
    conn.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")

    conn.executescript(
        """
        CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content)
            VALUES ('delete', old.id, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content)
            VALUES ('delete', old.id, old.content);
            INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
        """
    )


def migrate_notebook_entries_add_turn_id(conn: sqlite3.Connection) -> None:
    """Add ``turn_id`` to legacy notebook_entries and re-scope the UNIQUE
    constraint to ``(session_id, turn_id, question_id)``.

    The old unique constraint conflated quizzes generated in the same chat
    (issue #487): regenerating a quiz with the same positional
    ``question_id`` (e.g. ``q_1``) would collide with the previous quiz's
    notebook entries and the UI hydrated stale answers. Scoping by
    ``turn_id`` keeps each quiz isolated.
    """
    notebook_cols = {
        row[1] for row in conn.execute("PRAGMA table_info(notebook_entries)").fetchall()
    }
    if not notebook_cols:
        return
    if "turn_id" not in notebook_cols:
        conn.execute("ALTER TABLE notebook_entries ADD COLUMN turn_id TEXT NOT NULL DEFAULT ''")
    # SQLite stores table-level UNIQUE constraints as auto-indexes whose
    # names start with ``sqlite_autoindex_notebook_entries_``; the columns
    # they cover live in PRAGMA index_info. Detect whether any existing
    # auto-index still covers only (session_id, question_id) and, if so,
    # rebuild the table to swap in the new scope.
    needs_rebuild = False
    for idx_row in conn.execute("PRAGMA index_list(notebook_entries)").fetchall():
        idx_name = idx_row[1]
        if not idx_name.startswith("sqlite_autoindex_notebook_entries_"):
            continue
        cols = [r[2] for r in conn.execute(f"PRAGMA index_info({idx_name})").fetchall()]
        if cols == ["session_id", "question_id"]:
            needs_rebuild = True
            break
    if not needs_rebuild:
        return
    conn.executescript(
        """
        CREATE TABLE notebook_entries_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            turn_id TEXT NOT NULL DEFAULT '',
            question_id TEXT NOT NULL,
            question TEXT NOT NULL,
            question_type TEXT DEFAULT '',
            options_json TEXT DEFAULT '{}',
            correct_answer TEXT DEFAULT '',
            explanation TEXT DEFAULT '',
            difficulty TEXT DEFAULT '',
            user_answer TEXT DEFAULT '',
            is_correct INTEGER DEFAULT 0,
            bookmarked INTEGER DEFAULT 0,
            followup_session_id TEXT DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            UNIQUE(session_id, turn_id, question_id)
        );

        INSERT INTO notebook_entries_new (
            id, session_id, turn_id, question_id, question, question_type,
            options_json, correct_answer, explanation, difficulty,
            user_answer, is_correct, bookmarked, followup_session_id,
            created_at, updated_at
        )
        SELECT
            id, session_id, COALESCE(turn_id, ''), question_id, question,
            question_type, options_json, correct_answer, explanation,
            difficulty, user_answer, is_correct, bookmarked,
            followup_session_id, created_at, updated_at
        FROM notebook_entries;

        DROP TABLE notebook_entries;
        ALTER TABLE notebook_entries_new RENAME TO notebook_entries;

        CREATE INDEX IF NOT EXISTS idx_notebook_entries_session
            ON notebook_entries(session_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_notebook_entries_bookmarked
            ON notebook_entries(bookmarked, created_at DESC);
        """
    )


def migrate_notebook_entries_add_user_answer_images(conn: sqlite3.Connection) -> None:
    """Back-fill ``user_answer_images_json`` on legacy DBs.

    The column stores a JSON array of ``{id, url, filename, mime_type}``
    records for image attachments uploaded as part of the learner's
    answer. The bytes themselves live in the AttachmentStore; we only
    keep references in the row so notebook_entries stays lean.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(notebook_entries)").fetchall()}
    if not cols:
        return
    if "user_answer_images_json" not in cols:
        conn.execute(
            "ALTER TABLE notebook_entries ADD COLUMN user_answer_images_json TEXT DEFAULT '[]'"
        )


def migrate_notebook_entries_add_ai_judgment(conn: sqlite3.Connection) -> None:
    """Back-fill ``ai_judgment`` on legacy DBs.

    Stores the latest AI-judge text per entry as plain markdown. Empty
    string means the learner has not run the AI judge for this entry
    yet.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(notebook_entries)").fetchall()}
    if not cols:
        return
    if "ai_judgment" not in cols:
        conn.execute("ALTER TABLE notebook_entries ADD COLUMN ai_judgment TEXT DEFAULT ''")


__all__ = [
    "migrate_session_fts",
    "migrate_notebook_entries_add_turn_id",
    "migrate_notebook_entries_add_user_answer_images",
    "migrate_notebook_entries_add_ai_judgment",
]
